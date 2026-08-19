import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  assertSecureWebBinding,
  getSecurityHeaders,
  normalizeWalletAddress,
  resolvePublicPath,
  validateMutationRequest,
  validateRequestHost,
} from "../src/web-security.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("web responses use a script-safe CSP and baseline security headers", () => {
  const headers = getSecurityHeaders();

  assert.match(headers["content-security-policy"], /script-src 'self'/);
  assert.doesNotMatch(headers["content-security-policy"], /script-src[^;]*'unsafe-inline'/);
  assert.match(headers["content-security-policy"], /frame-ancestors 'none'/);
  assert.equal(headers["x-content-type-options"], "nosniff");
  assert.equal(headers["x-frame-options"], "DENY");
  assert.equal(headers["referrer-policy"], "no-referrer");
});

test("non-loopback web bindings require authentication", () => {
  assert.doesNotThrow(() => assertSecureWebBinding("127.0.0.1", ""));
  assert.doesNotThrow(() => assertSecureWebBinding("::1", ""));
  assert.doesNotThrow(() => assertSecureWebBinding("0.0.0.0", "configured"));
  assert.throws(
    () => assertSecureWebBinding("0.0.0.0", ""),
    /WEB_PASSWORD is required/,
  );
});

test("static files cannot escape into a sibling path with the same prefix", () => {
  const root = path.resolve("/tmp/public");

  assert.equal(resolvePublicPath(root, "/app.js"), path.join(root, "app.js"));
  assert.equal(resolvePublicPath(root, "/../publicity/secret.txt"), null);
  assert.equal(resolvePublicPath(root, "/../../etc/passwd"), null);
});

test("wallet profile accepts only canonical EVM addresses", () => {
  assert.equal(
    normalizeWalletAddress("0x0123456789abcdef0123456789ABCDEF01234567"),
    "0x0123456789abcdef0123456789abcdef01234567",
  );
  assert.equal(normalizeWalletAddress("0x1234"), null);
  assert.equal(normalizeWalletAddress("0x0123456789abcdef0123456789abcdef01234567&limit=999"), null);
});

test("strict CSP has no inline event-handler dependency", () => {
  for (const relativePath of ["public/index.html", "public/app.js", "public/market-summary.js"]) {
    const source = readFileSync(path.join(root, relativePath), "utf8");
    assert.doesNotMatch(source, /\bon(?:click|dblclick|focus|blur|change|input|mouse\w+|drag\w+|key\w+)=/i, relativePath);
  }
});

test("whale notifications do not inject tracker data through HTML", () => {
  const source = readFileSync(path.join(root, "public/app.js"), "utf8");
  assert.doesNotMatch(source, /toast\.innerHTML/);
  assert.match(source, /market\.textContent = String\(whale\.market_question/);
});

test("state-changing API requests require JSON and reject cross-site browsers", () => {
  const request = (headers) => ({ method: "POST", url: "/api/command", headers });

  assert.doesNotThrow(() => validateMutationRequest(request({
    host: "127.0.0.1:8787",
    origin: "http://127.0.0.1:8787",
    "content-type": "application/json; charset=utf-8",
    "sec-fetch-site": "same-origin",
  })));
  assert.throws(
    () => validateMutationRequest(request({ host: "127.0.0.1:8787", "content-type": "text/plain" })),
    (error) => error.status === 415,
  );
  assert.throws(
    () => validateMutationRequest(request({
      host: "127.0.0.1:8787",
      origin: "https://attacker.example",
      "content-type": "application/json",
      "sec-fetch-site": "cross-site",
    })),
    (error) => error.status === 403,
  );
});

test("loopback binding rejects DNS-rebinding Host headers", () => {
  assert.doesNotThrow(() => validateRequestHost({ headers: { host: "127.0.0.1:8787" } }, "127.0.0.1"));
  assert.doesNotThrow(() => validateRequestHost({ headers: { host: "localhost:8787" } }, "127.0.0.1"));
  assert.throws(
    () => validateRequestHost({ headers: { host: "attacker.example" } }, "127.0.0.1"),
    (error) => error.status === 421,
  );
});
