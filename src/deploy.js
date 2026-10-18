const MAX_HEALTH_BYTES = 64 * 1024;

// Resolve a model-chosen target name against operator configuration. The model never
// supplies hosts, commands or health URLs; it only names a registered target.
export function resolveTarget(config, name, owner) {
  const target = config.deployTargets?.[name];
  if (!target) return { error: `Deploy target "${name}" is not registered. Call listDeployTargets.` };
  const owners = Array.isArray(target.owners) ? target.owners : [target.owner ?? "default"];
  if (!owners.includes(owner)) return { error: `Deploy target "${name}" is not registered for this caller.` };
  return {
    target: {
      name,
      repo: target.repo,
      environment: target.environment || name,
      health_url: target.health_url || null,
      health_sha_field: target.health_sha_field || "commit",
      requires_approval: target.requires_approval === true,
      description: target.description || "",
    },
  };
}

export function listTargets(config, owner) {
  return Object.keys(config.deployTargets || {})
    .map((name) => resolveTarget(config, name, owner).target)
    .filter(Boolean)
    .map(({ name, repo, environment, health_url, requires_approval, description }) =>
      ({ name, repo, environment, health_check: Boolean(health_url), requires_approval, description }));
}

// A normal task built from structured deploy input, so it shares idempotency and reports.
export function deployTask(input, target) {
  const sha = String(input.commit_sha || "").toLowerCase();
  const short = sha.slice(0, 12);
  const criteria = [
    `${target.environment} runs commit ${sha} from ${target.repo}.`,
    "Report deployed_sha with the commit that is actually running.",
  ];
  if (target.health_url) criteria.push(`${target.health_url} reports ${target.health_sha_field} = ${sha}.`);
  criteria.push("If the deploy fails, leave the previous version running and report failed.");
  const task = {
    schema_version: "1",
    title: `Deploy ${target.repo}@${short} to ${target.name}`,
    objective: `Deploy commit ${sha} of ${target.repo} to the ${target.environment} environment (target ${target.name}).`,
    completion_criteria: criteria,
    source: input.source,
    priority: input.priority,
    source_thread: input.source_thread,
    client_request_id: input.client_request_id || `deploy:${target.name}:${sha}`,
    deploy: {
      target: target.name,
      commit_sha: sha,
      ...(input.pr_number !== undefined ? { pr_number: input.pr_number } : {}),
      ...(input.rollback_sha !== undefined ? { rollback_sha: input.rollback_sha } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    },
    ...(input.dry_run !== undefined ? { dry_run: input.dry_run } : {}),
    ...(input.callback_target !== undefined ? { callback_target: input.callback_target } : {}),
  };
  for (const key of Object.keys(task)) if (task[key] === undefined) delete task[key];
  return task;
}

// Envelope fields Grok Bot needs to run the deploy. These come from config, not the caller.
export function deployEnvelope(task, target) {
  return {
    kind: "deploy",
    deploy: {
      target: target.name,
      repo: target.repo,
      environment: target.environment,
      commit_sha: task.deploy.commit_sha,
      ...(task.deploy.pr_number ? { pr_number: task.deploy.pr_number } : {}),
      ...(task.deploy.rollback_sha ? { rollback_sha: task.deploy.rollback_sha } : {}),
      ...(target.health_url ? { health_url: target.health_url, health_sha_field: target.health_sha_field } : {}),
      report_deployed_sha: true,
    },
  };
}

// Read the target's health endpoint and compare the reported revision with the request.
export async function verifyDeployment(target, expectedSha, fetchImpl, { attempts = 3, delayMs = 2000, timeoutMs = 10000 } = {}) {
  if (!target?.health_url) return { status: "skipped", checkedAt: new Date().toISOString(), observedSha: null, httpStatus: null };
  let last;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt++) {
    last = await probe(target, expectedSha, fetchImpl, timeoutMs);
    last.attempts = attempt;
    if (last.status === "verified") return last;
    if (attempt < attempts && delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return last;
}

async function probe(target, expectedSha, fetchImpl, timeoutMs) {
  const checkedAt = new Date().toISOString();
  let response;
  try {
    response = await fetchImpl(target.health_url, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/json", "cache-control": "no-cache" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return { status: "unreachable", checkedAt, observedSha: null, httpStatus: null };
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return { status: "unreachable", checkedAt, observedSha: null, httpStatus: response.status };
  }
  let body;
  try {
    const text = await readLimited(response);
    body = JSON.parse(text);
  } catch {
    return { status: "unreachable", checkedAt, observedSha: null, httpStatus: response.status };
  }
  const value = target.health_sha_field.split(".").reduce((node, key) => (node && typeof node === "object" ? node[key] : undefined), body);
  const observed = typeof value === "string" ? value.trim().toLowerCase().slice(0, 64) : null;
  const matches = observed && observed.length >= 7 && expectedSha.startsWith(observed);
  return { status: matches ? "verified" : "mismatch", checkedAt, observedSha: observed, httpStatus: response.status };
}

async function readLimited(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HEALTH_BYTES) {
        await reader.cancel();
        throw new Error("Health response is too large.");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks, size).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}
