import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SHA = /^[a-f0-9]{40}$/;
let cached;
const projectRoot = () => path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// The commit this process runs. Deploy targets compare it with the requested sha.
// Order: RELAY_GIT_SHA, a REVISION file written at deploy time, then the .git checkout.
export function currentRevision(root = projectRoot()) {
  if (cached !== undefined && root === projectRoot()) return cached;
  const found = fromEnv() || fromFile(path.join(root, "REVISION")) || fromGit(path.join(root, ".git"));
  if (root === projectRoot()) cached = found;
  return found;
}

function fromEnv() {
  const value = (process.env.RELAY_GIT_SHA || "").trim().toLowerCase();
  return SHA.test(value) ? value : null;
}

function fromFile(file) {
  try {
    const value = fs.readFileSync(file, "utf8").trim().toLowerCase();
    return SHA.test(value) ? value : null;
  } catch {
    return null;
  }
}

function fromGit(gitDir) {
  const head = fromFile(path.join(gitDir, "HEAD"));
  if (head) return head;
  let ref;
  try {
    ref = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim().match(/^ref: (refs\/[^\s]+)$/)?.[1];
  } catch {
    return null;
  }
  if (!ref || ref.includes("..")) return null;
  const loose = fromFile(path.join(gitDir, ref));
  if (loose) return loose;
  try {
    for (const line of fs.readFileSync(path.join(gitDir, "packed-refs"), "utf8").split("\n")) {
      const [sha, name] = line.trim().split(" ");
      if (name === ref && SHA.test(sha)) return sha;
    }
  } catch {
    return null;
  }
  return null;
}
