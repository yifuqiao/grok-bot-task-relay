const PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const APPROVAL_HINTS = new Set(["spend", "send_external", "delete", "other"]);

export function validateAndNormalize(input, { maxBytes = 3000 } = {}) {
  const errors = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, errors: ["Task must be a JSON object."] };
  }

  const title = requiredText(input.title, "title", 200, errors);
  const objective = requiredText(input.objective, "objective", 8000, errors);
  const source = requiredText(input.source, "source", 80, errors);
  const completion = normalizeCriteria(input.completion_criteria, errors);

  let priority = "normal";
  if (input.priority !== undefined) {
    if (!PRIORITIES.has(input.priority)) {
      errors.push("priority must be low, normal, high, or urgent.");
    } else {
      priority = input.priority;
    }
  }

  let dryRun = false;
  if (input.dry_run !== undefined) {
    if (typeof input.dry_run !== "boolean") errors.push("dry_run must be a boolean.");
    else dryRun = input.dry_run;
  }

  const task = {
    schema_version: input.schema_version === undefined ? "1" : input.schema_version,
    title,
    objective,
    completion_criteria: completion,
    priority,
    source,
    dry_run: dryRun,
  };

  if (input.schema_version !== undefined && input.schema_version !== "1") {
    errors.push('schema_version must be "1".');
  }

  copyOptionalText(input, task, "task_id", 120, errors);
  copyOptionalText(input, task, "source_thread", 200, errors);
  copyOptionalText(input, task, "brief_url", 500, errors);
  copyOptionalText(input, task, "markdown", 32000, errors);
  copyOptionalText(input, task, "client_request_id", 120, errors);
  copyOptionalText(input, task, "callback_target", 80, errors);
  copyOptionalJson(input, task, "context", errors);
  copyOptionalJson(input, task, "constraints", errors);
  if (input.attachments !== undefined) {
    task.attachments = normalizeAttachments(input.attachments, errors);
  }

  if (input.approval_hints !== undefined) {
    if (!Array.isArray(input.approval_hints)) {
      errors.push("approval_hints must be an array.");
    } else if (input.approval_hints.some((item) => !APPROVAL_HINTS.has(item))) {
      errors.push("approval_hints may only contain spend, send_external, delete, or other.");
    } else {
      task.approval_hints = input.approval_hints;
    }
  }

  if (!errors.length && Buffer.byteLength(JSON.stringify(task)) > maxBytes) {
    errors.push(`Task JSON is over ${maxBytes} bytes. Put the plan in a markdown file and pass brief_url.`);
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, task };
}

export function normalizeAttachments(value, errors) {
  if (!Array.isArray(value) || value.length > 20) {
    errors.push("attachments must be a list of at most 20 file references.");
    return [];
  }
  return value.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      errors.push("Each attachment must be an object.");
      return {};
    }
    const file = {};
    for (const [name, max] of [["name", 200], ["url", 2000], ["mime_type", 120]]) {
      file[name] = requiredText(item[name], `attachment.${name}`, max, errors);
    }
    try {
      const url = new URL(file.url);
      if (url.protocol !== "https:" || url.username || url.password) throw new Error();
    } catch {
      errors.push("Attachment URLs must use HTTPS without embedded credentials.");
    }
    if (item.size_bytes !== undefined) {
      if (!Number.isSafeInteger(item.size_bytes) || item.size_bytes < 0) {
        errors.push("attachment.size_bytes must be a non-negative safe integer.");
      } else file.size_bytes = item.size_bytes;
    }
    if (item.sha256 !== undefined) {
      if (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(item.sha256)) {
        errors.push("attachment.sha256 must be a SHA-256 hex digest.");
      } else file.sha256 = item.sha256.toLowerCase();
    }
    return file;
  });
}

function requiredText(value, name, max, errors) {
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${name} is required.`);
    return "";
  }
  if (value.trim().length > max) errors.push(`${name} is too long.`);
  return value.trim();
}

function copyOptionalText(input, task, name, max, errors) {
  if (input[name] === undefined) return;
  if (typeof input[name] !== "string" || !input[name].trim()) {
    errors.push(`${name} must be a non-empty string when provided.`);
    return;
  }
  if (input[name].trim().length > max) errors.push(`${name} is too long.`);
  task[name] = input[name].trim();
}

function copyOptionalJson(input, task, name, errors) {
  if (input[name] === undefined) return;
  const value = input[name];
  const allowed =
    typeof value === "string" ||
    (Array.isArray(value) && value.every((item) => typeof item === "string" || isPlainObject(item))) ||
    isPlainObject(value);
  if (!allowed) {
    errors.push(`${name} must be a string, string array, or object.`);
    return;
  }
  if (JSON.stringify(value).length > 16000) {
    errors.push(`${name} is too long.`);
    return;
  }
  task[name] = value;
}

function normalizeCriteria(value, errors) {
  if (typeof value === "string" && value.trim()) value = [value];
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    errors.push("completion_criteria must be a non-empty list of checkable strings.");
    return [];
  }
  if (value.some((item) => typeof item !== "string" || !item.trim())) {
    errors.push("completion_criteria must contain only non-empty strings.");
    return [];
  }
  if (value.some((item) => item.trim().length > 500)) {
    errors.push("Each completion criterion must be at most 500 characters. Put longer details in brief_url.");
    return [];
  }
  return value.map((item) => item.trim());
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
