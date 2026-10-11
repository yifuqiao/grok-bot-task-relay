const SECRET_KEY = /authorization|api[-_]?key|token|secret|password|credential/i;

export async function forwardTask(task, config, fetchImpl = fetch) {
  if (!config.webhookUrl || !config.webhookKey) {
    return {
      submitted: false,
      transportAccepted: false,
      botAcknowledged: false,
      acknowledgment: "none",
      httpStatus: null,
      taskId: null,
      dry_run: task.dry_run === true,
      response: null,
      error:
        "Webhook URL or key is not configured. Add both to the local .env file. Do not paste the webhook key into chat.",
    };
  }

  const headerName = config.authHeader || "authorization";
  const headerValue = config.authScheme
    ? `${config.authScheme} ${config.webhookKey}`
    : config.webhookKey;
  const secrets = [config.webhookKey, config.relayApiKey, headerValue].filter(Boolean);

  let response;
  try {
    response = await fetchImpl(config.webhookUrl, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        [headerName]: headerValue,
      },
      body: JSON.stringify(task),
      signal: AbortSignal.timeout(config.timeoutMs || 30000),
    });
  } catch (error) {
    return baseResult(task, {
      submitted: false,
      transportAccepted: false,
      httpStatus: null,
      error: `Webhook request failed before a response: ${redact(errorMessage(error), secrets)}`,
    });
  }

  if (response.status >= 300 && response.status < 400) {
    return baseResult(task, {
      submitted: true,
      transportAccepted: false,
      httpStatus: response.status,
      error: "Webhook returned a redirect. The redirect was not followed, and the task was not retried.",
    });
  }

  const text = await response.text();
  const body = sanitizeBody(text, secrets);
  const ack = detectAck(body);
  const accepted = response.status >= 200 && response.status < 300;
  return baseResult(task, {
    submitted: true,
    transportAccepted: accepted,
    botAcknowledged: ack.acknowledged,
    acknowledgment: ack.acknowledgment,
    httpStatus: response.status,
    taskId: ack.taskId,
    response: body,
    error: accepted ? null : `Webhook rejected the task with HTTP ${response.status}.`,
  });
}

function baseResult(task, overrides) {
  return {
    submitted: false,
    transportAccepted: false,
    botAcknowledged: false,
    acknowledgment: "none",
    httpStatus: null,
    taskId: null,
    dry_run: task.dry_run === true,
    response: null,
    error: null,
    ...overrides,
  };
}

export function detectAck(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { acknowledged: false, acknowledgment: "none", taskId: null };
  }
  const rawId = value.task_id ?? value.taskId;
  const taskId = typeof rawId === "string" && rawId.trim() ? rawId.trim().slice(0, 120) : null;
  const flagged =
    value.acknowledged === true || value.bot_acknowledged === true || value.ack === true;
  if (flagged) return { acknowledged: true, acknowledgment: "flag", taskId };
  if (taskId) return { acknowledged: true, acknowledgment: "task_id", taskId };
  return { acknowledged: false, acknowledgment: "none", taskId: null };
}

export function sanitizeBody(text, secrets) {
  const cleaned = redact(text || "", secrets).trim();
  if (!cleaned) return null;
  try {
    return redactValue(JSON.parse(cleaned), secrets);
  } catch {
    return cleaned.slice(0, 2000);
  }
}

function redactValue(value, secrets) {
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactValue(item, secrets));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? "[redacted]" : redactValue(item, secrets);
    }
    return out;
  }
  if (typeof value === "string") return redact(value, secrets).slice(0, 2000);
  return value;
}

export function redact(text, secrets) {
  let out = String(text);
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join("[redacted]");
  }
  return out;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
