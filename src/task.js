const PRIORITIES = new Set(["low", "normal", "high", "urgent"]);
const APPROVAL_HINTS = new Set(["spend", "send_external", "delete", "other"]);

export function validateAndNormalize(input) {
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
  copyOptionalJson(input, task, "context", errors);
  copyOptionalJson(input, task, "constraints", errors);

  if (input.approval_hints !== undefined) {
    if (!Array.isArray(input.approval_hints)) {
      errors.push("approval_hints must be an array.");
    } else if (input.approval_hints.some((item) => !APPROVAL_HINTS.has(item))) {
      errors.push("approval_hints may only contain spend, send_external, delete, or other.");
    } else {
      task.approval_hints = input.approval_hints;
    }
  }

  if (!errors.length && Buffer.byteLength(JSON.stringify(task)) > 3000) {
    errors.push("Task JSON is over 3000 bytes. Put the plan in a markdown file and pass brief_url.");
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, task };
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
