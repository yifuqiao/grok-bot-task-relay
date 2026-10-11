import fs from "node:fs";

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
  const scheme = process.env.GROK_BOT_WEBHOOK_AUTH_SCHEME;
  return {
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
  };
}
