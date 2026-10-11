import path from "node:path";
import { loadConfig, loadEnvFile } from "./env.js";
import { projectRoot } from "./stdio.js";

loadEnvFile(path.join(projectRoot(), ".env"));
const config = loadConfig();

console.log(
  JSON.stringify({
    webhookUrl: config.webhookUrl ? "set" : "missing",
    webhookKey: config.webhookKey ? "set" : "missing",
    relayApiKey: config.relayApiKey ? "set" : "missing",
    authHeader: config.authHeader,
    authScheme: config.authScheme || "(raw key, no scheme)",
    host: config.host,
    port: config.port,
  }),
);
