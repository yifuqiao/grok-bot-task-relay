import http from "node:http";
import fs from "node:fs";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { loadConfig, loadEnvFile } from "./env.js";
import { handleMcp, submitTask } from "./mcp.js";
import { isDirectRun, projectRoot } from "./stdio.js";

const MAX_BODY = 64 * 1024;

export function createRequestListener(config, fetchImpl = fetch) {
  return async function listener(req, res) {
    try {
      if (!hostAllowed(req, config) || !originAllowed(req, config, authorized(req, config))) {
        return sendJson(res, 403, { error: "Origin or host is not allowed." });
      }

      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, {
          status: "up",
          webhookConfigured: Boolean(config.webhookUrl && config.webhookKey),
        });
      }

      if (req.method === "GET" && url.pathname === "/release.tgz") {
        if (!authorized(req, config)) return sendJson(res, 401, { error: "Unauthorized." });
        return sendRelease(res);
      }

      if (req.method === "GET" && url.pathname === "/deploy.md") {
        if (!authorized(req, config)) return sendJson(res, 401, { error: "Unauthorized." });
        return sendTextFile(res, path.join(projectRoot(), "deploy", "TASK.md"), "text/markdown; charset=utf-8");
      }

      if (req.method === "GET" || req.method === "DELETE") {
        return sendJson(res, 405, { error: "This relay is stateless. Use POST." });
      }
      if (req.method !== "POST") {
        return sendJson(res, 405, { error: "Method not allowed." });
      }
      if (!authorized(req, config)) {
        return sendJson(res, 401, { error: "Unauthorized." });
      }

      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};

      if (url.pathname === "/submit-task") {
        const outcome = await submitTask(body, config, fetchImpl);
        return sendJson(res, relayStatus(outcome.result), outcome.result);
      }

      if (url.pathname === "/mcp" || url.pathname === "/") {
        const response = await handleMcp(body, config, fetchImpl);
        if (!response) {
          res.writeHead(202);
          res.end();
          return;
        }
        return sendJson(res, response.error ? 400 : 200, response);
      }

      return sendJson(res, 404, { error: "Not found." });
    } catch (error) {
      const status = error && error.status ? error.status : 400;
      sendJson(res, status, { error: status === 413 ? "Body too large." : "Invalid JSON request." });
    }
  };
}

export function startServer(config, fetchImpl = fetch) {
  if (!config.relayApiKey) {
    throw new Error("RELAY_API_KEY is missing. Add it to .env before starting the HTTP relay.");
  }
  const server = http.createServer(createRequestListener(config, fetchImpl));
  return new Promise((resolve) => {
    server.listen(config.port, config.host, () => resolve(server));
  });
}

function authorized(req, config) {
  const header = String(req.headers.authorization || "");
  const match = header.match(/^Bearer\s+(\S+)\s*$/i);
  if (!match || !config.relayApiKey) return false;
  return safeEqual(match[1], config.relayApiKey);
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function hostAllowed(req, config) {
  if (config.host !== "127.0.0.1" && config.host !== "localhost") return true;
  const host = String(req.headers.host || "");
  if (
    host === `127.0.0.1:${config.port}` ||
    host === `localhost:${config.port}` ||
    host === `[::1]:${config.port}`
  ) {
    return true;
  }
  // Cloudflare Tunnel connects from this machine but keeps the public Host name.
  const peer = req.socket?.remoteAddress || "";
  return peer === "127.0.0.1" || peer === "::1" || peer === "::ffff:127.0.0.1";
}

function originAllowed(req, config, isAuthorized) {
  const origin = req.headers.origin;
  if (!origin || isAuthorized) return true;
  const allowed = new Set([
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
    ...config.allowedOrigins,
  ]);
  return allowed.has(origin);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("Body too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function sendTextFile(res, filePath, contentType) {
  if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: "File is not available." });
  const data = fs.readFileSync(filePath);
  res.writeHead(200, {
    "content-type": contentType,
    "content-length": data.length,
  });
  res.end(data);
}

function sendRelease(res) {
  const filePath = path.join(projectRoot(), "release.tgz");
  if (!fs.existsSync(filePath)) return sendJson(res, 404, { error: "Release archive is not available." });
  const data = fs.readFileSync(filePath);
  res.writeHead(200, {
    "content-type": "application/gzip",
    "content-length": data.length,
    "content-disposition": "attachment; filename=\"grok-bot-task-relay.tgz\"",
  });
  res.end(data);
}

function relayStatus(result) {
  if (result.submitted) return 200;
  if (result.error && result.error.startsWith("Webhook URL")) return 503;
  if (result.error && result.error.includes("failed before")) return 502;
  return 400;
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

if (isDirectRun(import.meta.url)) {
  loadEnvFile(path.join(projectRoot(), ".env"));
  const config = loadConfig();
  startServer(config)
    .then((server) => {
      const address = server.address();
      const port = address && typeof address === "object" ? address.port : config.port;
      console.error(`Grok Bot task relay listening on http://${config.host}:${port}/mcp`);
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : "Failed to start.");
      process.exit(1);
    });
}
