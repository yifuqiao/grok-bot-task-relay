import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { loadConfig, loadEnvFile } from "./env.js";
import { handleMcp } from "./mcp.js";

export function projectRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

export function isDirectRun(metaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === path.resolve(fileURLToPath(metaUrl));
}

if (isDirectRun(import.meta.url)) {
  loadEnvFile(path.join(projectRoot(), ".env"));
  const config = loadConfig();
  if (config.deliveryMode === "pull") {
    console.error("Pull mode requires the HTTP service. Run src/http.js and connect MCP callers to /mcp; stdio cannot expose executor endpoints.");
    process.exit(1);
  }
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      return;
    }
    handleMcp(message, config)
      .then((response) => {
        if (response) write(response);
      })
      .catch((error) => {
        const id = message && typeof message === "object" ? message.id ?? null : null;
        write({
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: "Internal error" },
        });
        console.error(error instanceof Error ? error.message : "Internal error");
      });
  });
}

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
