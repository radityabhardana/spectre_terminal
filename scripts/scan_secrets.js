import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SECRET_PATTERNS = [
  { type: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { type: "openai-style-key", pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { type: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/ },
  { type: "slack-token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/ },
  { type: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { type: "telegram-bot-token", pattern: /\b\d{8,12}:[A-Za-z0-9_-]{35}\b/ },
  {
    type: "assigned-api-secret",
    pattern: /(?<![A-Za-z0-9])(?:api[_-]?key|api[_-]?secret|access[_-]?token|client[_-]?secret|password)[ \t]*[:=][ \t]*["'`]?((?!process\.env\b|import\.meta\.env\b|\$\{|\{\{)[A-Za-z0-9+/_=.:-]{20,})/i,
  },
];

export function detectSecretTypes(source) {
  const text = String(source || "");
  return [...new Set(SECRET_PATTERNS
    .filter(({ pattern }) => pattern.test(text))
    .map(({ type }) => type))];
}

function trackedCheckoutFiles() {
  try {
    const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
    return output.toString("utf8").split("\0").filter(Boolean);
  } catch {
    throw new Error("Secret scan could not enumerate repository files");
  }
}

export function scanCheckout(root = process.cwd()) {
  const findings = [];
  for (const relativePath of trackedCheckoutFiles()) {
    const absolutePath = path.resolve(root, relativePath);
    if (!fs.existsSync(absolutePath)) continue;
    let contents;
    try {
      contents = fs.readFileSync(absolutePath);
    } catch {
      findings.push({ path: relativePath, type: "unreadable-file" });
      continue;
    }
    if (contents.includes(0)) continue;
    for (const type of detectSecretTypes(contents.toString("utf8"))) {
      findings.push({ path: relativePath, type });
    }
  }
  return findings;
}

export function main() {
  const findings = scanCheckout();
  if (!findings.length) {
    console.log("Secret scan passed: no known secret patterns found.");
    return 0;
  }
  for (const finding of findings) console.error(`${finding.path}: ${finding.type}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = main();
}
