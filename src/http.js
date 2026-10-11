import http from "node:http";
import fs from "node:fs";
import { timingSafeEqual } from "node:crypto";
import path from "node:path";
import { loadConfig, loadEnvFile } from "./env.js";
import { handleMcp, submitTask } from "./mcp.js";
import { createOAuth, publicBaseFrom } from "./oauth.js";
import { isDirectRun, projectRoot } from "./stdio.js";
import { progressStatus } from "./grok-status.js";
import { taskService } from "./lifecycle.js";

const MAX_BODY = 64 * 1024;

export function createRequestListener(config, fetchImpl = fetch) {
  const storePath = Object.prototype.hasOwnProperty.call(config, "oauthStorePath")
    ? config.oauthStorePath
    : path.join(config.dataDir || path.join(projectRoot(), "data"), "oauth-grants.json");
  const oauth = createOAuth({ ...config, oauthStorePath: storePath });
  return async function listener(req, res) {
    try {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      const base = publicBaseFrom(req, config);
      if (isOAuthRoute(url.pathname)) {
        return handleOAuth(req, res, url, base, oauth);
      }
      if (!hostAllowed(req, config) || !originAllowed(req, config)) {
        return sendJson(res, 403, { error: "Origin or host is not allowed." });
      }

      if (url.pathname === "/executor/tasks") {
        if (!bearerMatches(req, config.botReportKey)) return sendJson(res, 401, { error: "Unauthorized." });
        if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed." });
        const service = taskService(config);
        if (!service) return sendJson(res, 503, { error: "Task lifecycle is not configured." });
        return sendJson(res, 200, { tasks: service.inbox() });
      }
      const executor = url.pathname.match(/^\/executor\/tasks\/([a-f0-9-]{36})\/(manifest|report|claim|progress)$/);
      if (executor) {
        if (!bearerMatches(req, config.botReportKey)) return sendJson(res, 401, { error: "Unauthorized." });
        if (req.method === "POST" && executor[2] === "progress") {
          const body = JSON.parse(await readBody(req));
          const service = taskService(config);
          if (service?.records.get(executor[1])) {
            const outcome = await service.progress(executor[1], body);
            return sendJson(res, outcome.status, outcome.body);
          }
          if (config.statusDir) {
            const outcome = progressStatus(config, executor[1], body);
            return sendJson(res, outcome.status, outcome.body);
          }
          return sendJson(res, 503, { error: "Task status is not configured." });
        }
        const service = taskService(config);
        if (!service) return sendJson(res, 503, { error: "Task lifecycle is not configured." });
        const record = service.records.get(executor[1]);
        if (!record) return sendJson(res, 404, { error: "Task not found." });
        if (req.method === "POST" && executor[2] === "claim") {
          const outcome = service.claim(executor[1], JSON.parse(await readBody(req)));
          return sendJson(res, outcome.status, outcome.body);
        }
        if (req.method === "GET" && executor[2] === "manifest") {
          return sendJson(res, 200, { relay_task_id: record.relayTaskId, ...record.task });
        }
        if (req.method === "POST" && executor[2] === "report") {
          const report = JSON.parse(await readBody(req));
          const outcome = await service.report(executor[1], report);
          return sendJson(res, outcome.status, outcome.body);
        }
        return sendJson(res, 405, { error: "Method not allowed." });
      }
      const taskRoute = url.pathname.match(/^\/tasks\/([a-f0-9-]{36})(?:\/(result|notify))?$/);
      if (taskRoute) {
        const owner = caller(req, config, oauth);
        if (owner === null) return sendJson(res, 401, { error: "Unauthorized." });
        const service = taskService(config);
        if (!service) return sendJson(res, 503, { error: "Task lifecycle is not configured." });
        const record = service.get(taskRoute[1], owner);
        if (!record) return sendJson(res, 404, { error: "Task not found." });
        if (req.method === "POST" && taskRoute[2] === "notify") {
          const outcome = await service.notify(record.relayTaskId, owner);
          return sendJson(res, outcome.status, outcome.body);
        }
        if (req.method === "GET" && taskRoute[2] !== "notify") return sendJson(res, 200, service.view(record));
        return sendJson(res, 405, { error: "Method not allowed." });
      }
      if (req.method === "GET" && url.pathname === "/health") {
        return sendJson(res, 200, {
          status: "up",
          deliveryMode: config.deliveryMode || "webhook",
          webhookConfigured: Boolean(config.webhookUrl && config.webhookKey),
        });
      }

      if ((url.pathname === "/mcp" || url.pathname === "/") && caller(req, config, oauth) === null) {
        return sendJson(res, 401, { error: "Unauthorized." }, {
          "www-authenticate": oauth.authenticateHeader(base),
          ...corsHeaders(),
        });
      }

      if (req.method === "GET" && url.pathname === "/release.tgz") {
        if (!authorized(req, config, oauth)) return sendJson(res, 401, { error: "Unauthorized." });
        return sendRelease(res);
      }

      if (req.method === "GET" && url.pathname === "/deploy.md") {
        if (!authorized(req, config, oauth)) return sendJson(res, 401, { error: "Unauthorized." });
        return sendTextFile(res, path.join(projectRoot(), "deploy", "TASK.md"), "text/markdown; charset=utf-8");
      }

      if (req.method === "GET" || req.method === "DELETE") {
        return sendJson(res, 405, { error: "This relay is stateless. Use POST." });
      }
      if (req.method !== "POST") {
        return sendJson(res, 405, { error: "Method not allowed." });
      }
      if (!authorized(req, config, oauth)) {
        return sendJson(res, 401, { error: "Unauthorized." });
      }

      const raw = await readBody(req);
      const body = raw ? JSON.parse(raw) : {};

      if (url.pathname === "/submit-task") {
        const outcome = await submitTask(body, config, fetchImpl, caller(req, config, oauth));
        return sendJson(res, relayStatus(outcome.result), outcome.result);
      }

      if (url.pathname === "/mcp" || url.pathname === "/") {
        const response = await handleMcp(body, config, fetchImpl, caller(req, config, oauth));
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
  if (!config.relayApiKey && !Object.keys(config.clientKeys || {}).length) {
    throw new Error("RELAY_API_KEY is missing. Add it to .env before starting the HTTP relay.");
  }
  taskService(config);
  const server = http.createServer(createRequestListener(config, fetchImpl));
  return new Promise((resolve) => {
    server.listen(config.port, config.host, () => resolve(server));
  });
}

function authorized(req, config, oauth) {
  return caller(req, config, oauth) !== null;
}

function caller(req, config, oauth) {
  if (bearerMatches(req, config.relayApiKey)) return "default";
  for (const [owner, key] of Object.entries(config.clientKeys || {})) {
    if (bearerMatches(req, key)) return owner;
  }
  const header = String(req.headers.authorization || "");
  const match = header.match(/^Bearer\s+(\S+)\s*$/i);
  if (match && oauth && oauth.hasAccessToken(match[1])) return "default";
  return null;
}

async function handleOAuth(req, res, url, base, oauth) {
  if (req.method === "GET" && isProtectedResourcePath(url.pathname)) {
    return sendJson(res, 200, oauth.metadata(base).protectedResource, corsHeaders());
  }
  if (req.method === "GET" && isAuthorizationServerPath(url.pathname)) {
    return sendJson(res, 200, oauth.metadata(base).authorizationServer, corsHeaders());
  }
  if (url.pathname === "/register" && req.method === "POST") {
    const body = parseBody(await readBody(req), req.headers["content-type"]);
    const result = oauth.register(body);
    return sendJson(res, result.status, result.body);
  }
  if (url.pathname === "/authorize" && req.method === "GET") {
    const result = oauth.authorizePage(Object.fromEntries(url.searchParams), base);
    return sendHtml(res, result.status, result.html);
  }
  if (url.pathname === "/authorize" && req.method === "POST") {
    const form = parseBody(await readBody(req), req.headers["content-type"]);
    const result = oauth.authorizeSubmit(form);
    if (result.location) {
      res.writeHead(result.status, { location: result.location });
      res.end();
      return;
    }
    return sendHtml(res, result.status, result.html);
  }
  if (url.pathname === "/token" && req.method === "POST") {
    const form = parseBody(await readBody(req), req.headers["content-type"]);
    const result = oauth.token(form);
    return sendJson(res, result.status, result.body);
  }
  return sendJson(res, 405, { error: "Method not allowed." });
}

function isOAuthRoute(pathname) {
  return (
    isProtectedResourcePath(pathname) ||
    isAuthorizationServerPath(pathname) ||
    pathname === "/authorize" ||
    pathname === "/token" ||
    pathname === "/register"
  );
}

function isProtectedResourcePath(pathname) {
  return (
    pathname === "/.well-known/oauth-protected-resource" ||
    pathname === "/.well-known/oauth-protected-resource/mcp"
  );
}

function isAuthorizationServerPath(pathname) {
  return (
    pathname === "/.well-known/oauth-authorization-server" ||
    pathname === "/.well-known/oauth-authorization-server/mcp"
  );
}

function corsHeaders() {
  return { "access-control-allow-origin": "*" };
}

function parseBody(raw, contentType) {
  if (!raw) return {};
  if (String(contentType || "").includes("application/json")) return JSON.parse(raw);
  return Object.fromEntries(new URLSearchParams(raw));
}

function sendHtml(res, status, html) {
  const payload = Buffer.from(html);
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": payload.length,
    "cache-control": "no-store",
  });
  res.end(payload);
}

function bearerMatches(req, key) {
  const header = String(req.headers.authorization || "");
  const match = header.match(/^Bearer\s+(\S+)\s*$/i);
  if (!match || !key) return false;
  return safeEqual(match[1], key);
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

function originAllowed(req, config) {
  const origin = req.headers.origin;
  if (!origin) return true;
  const allowed = new Set([
    `http://127.0.0.1:${config.port}`,
    `http://localhost:${config.port}`,
    ...(config.allowedOrigins || []),
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
  if (result.status === "queued" || (result.deliveryMode === "pull" && result.status === "dry_run")) return 202;
  if (result.accepted && result.deliveryMode === "pull") return 200;
  if (result.deduplicated && result.status === "submitting") return 202;
  if (result.submitted) return 200;
  if (result.error && result.error.startsWith("Webhook URL")) return 503;
  if (result.error && result.error.includes("failed before")) return 502;
  return 400;
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    ...extraHeaders,
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
