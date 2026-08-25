import assert from "node:assert/strict";
import test from "node:test";

import { detectSecretTypes } from "../scripts/scan_secrets.js";

test("secret scanner reports types without exposing matched values", () => {
  const fakeSecret = `sk-${"a".repeat(24)}`;
  const findings = detectSecretTypes(`OMNI_API_KEY=${fakeSecret}`);

  assert.deepEqual(findings, ["openai-style-key", "assigned-api-secret"]);
  assert.equal(findings.some((finding) => finding.includes(fakeSecret)), false);
});

test("secret scanner ignores environment references and empty examples", () => {
  assert.deepEqual(detectSecretTypes([
    "OMNI_API_KEY=",
    "const key = process.env.OMNI_API_KEY;",
    "Authorization: `Bearer ${config.qwenApiKey}`",
  ].join("\n")), []);
});
