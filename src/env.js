import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

export function loadConfig() {
  const deliveryMode = (process.env.RELAY_DELIVERY_MODE || "webhook").trim();
  if (!["webhook", "pull"].includes(deliveryMode)) throw new Error("RELAY_DELIVERY_MODE must be webhook or pull.");
  if (deliveryMode === "pull" && !process.env.RELAY_DATA_DIR) throw new Error("Pull mode requires RELAY_DATA_DIR.");
  const scheme = process.env.GROK_BOT_WEBHOOK_AUTH_SCHEME;
  return {
    deliveryMode,
    webhookUrl: (process.env.GROK_BOT_WEBHOOK_URL || "").trim(),
    webhookKey: (process.env.GROK_BOT_WEBHOOK_KEY || "").trim(),
    authHeader: (process.env.GROK_BOT_WEBHOOK_AUTH_HEADER || "authorization")
      .trim()
      .toLowerCase(),
    authScheme: scheme === undefined ? "Bearer" : scheme.trim(),
    relayApiKey: (process.env.RELAY_API_KEY || "").trim(),
    port: Number(process.env.PORT || 8787),
    host: (process.env.HOST || "127.0.0.1").trim(),
    timeoutMs: Number(process.env.GROK_BOT_WEBHOOK_TIMEOUT_MS || 30000),
    allowedOrigins: (process.env.RELAY_ALLOWED_ORIGINS || "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    dataDir: process.env.RELAY_DATA_DIR
      ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", process.env.RELAY_DATA_DIR)
      : "",
    publicBaseUrl: (process.env.RELAY_PUBLIC_BASE_URL || "").trim(),
    botReportKey: (process.env.BOT_REPORT_KEY || "").trim(),
    statusDir: process.env.GROK_STATUS_DIR === ""
      ? ""
      : path.resolve(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        process.env.GROK_STATUS_DIR || path.join("data", "grok-status"),
      ),
    clientKeys: jsonSetting("RELAY_CLIENT_KEYS"),
    callbackTargets: jsonSetting("RELAY_CALLBACK_TARGETS"),
  };
}

function jsonSetting(name) {
  try {
    const value = JSON.parse(process.env[name] || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    if (name === "RELAY_CLIENT_KEYS") {
      for (const [owner, key] of Object.entries(value)) {
        if (!owner || owner === "default" || typeof key !== "string" || !key.trim() || key.trim() !== key || /\s/.test(key)) throw new Error();
      }
      const keys = Object.values(value);
      if (new Set(keys).size !== keys.length || keys.includes((process.env.RELAY_API_KEY || "").trim())) throw new Error();
    } else {
      for (const target of Object.values(value)) {
        const url = new URL(target.url);
        if (url.protocol !== "https:" || url.username || url.password ||
          typeof target.owner !== "string" || !target.owner ||
          (target.apiKey !== undefined && typeof target.apiKey !== "string")) throw new Error();
      }
    }
    return value;
  } catch {
    throw new Error(`${name} has invalid configuration. Values are not printed.`);
  }
}
