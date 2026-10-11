import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env");

if (fs.existsSync(envPath)) {
  console.log("env-exists");
  process.exit(0);
}

const yamlCandidates = [
  process.argv[2],
  path.join(
    process.env.USERPROFILE || "",
    "Documents",
    "Codex",
    "2026-10-11",
    "referenced-chatgpt-conversation-this-is-an-2",
    "outputs",
    "chatgpt-actions-openapi.filled.yaml",
  ),
].filter(Boolean);

let webhookUrl = "";
for (const candidate of yamlCandidates) {
  if (!fs.existsSync(candidate)) continue;
  const yaml = fs.readFileSync(candidate, "utf8");
  const server = yaml.match(/url:\s*(https:\/\/\S+)/)?.[1];
  const hook = yaml.match(/(\/automations\/webhook\/[0-9a-f-]+)/)?.[1];
  if (server && hook) {
    webhookUrl = server + hook;
    break;
  }
}

const relay = crypto.randomBytes(24).toString("hex");
const body = [
  "# Local only. Do not commit. Do not paste the webhook key into chat.",
  `GROK_BOT_WEBHOOK_URL=${webhookUrl}`,
  "GROK_BOT_WEBHOOK_KEY=",
  "GROK_BOT_WEBHOOK_AUTH_HEADER=authorization",
  "GROK_BOT_WEBHOOK_AUTH_SCHEME=Bearer",
  `RELAY_API_KEY=${relay}`,
  "PORT=8787",
  "HOST=127.0.0.1",
  "RELAY_ALLOWED_ORIGINS=",
  "",
].join("\n");

fs.writeFileSync(envPath, body);
console.log(webhookUrl ? "env-written url-set key-missing" : "env-written url-missing key-missing");
