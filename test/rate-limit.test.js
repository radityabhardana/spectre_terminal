import test from "node:test";
import assert from "node:assert/strict";

import { config } from "../src/config.js";
import { enterCommandGuard, releaseCommandGuard } from "../src/rate-limit.js";

test("argumentless resolve is not treated as an AI command", () => {
  const originalCooldowns = [config.commandCooldownMs, config.duplicateCommandCooldownMs, config.qwenCommandCooldownMs];
  config.commandCooldownMs = 0;
  config.duplicateCommandCooldownMs = 0;
  config.qwenCommandCooldownMs = 0;
  try {
    const scope = `rate-test-${Date.now()}-${Math.random()}`;
    const first = enterCommandGuard({
      command: "/resolve",
      arg: "",
      message: { chat: { id: scope } },
      ctx: { chatId: scope },
    });
    assert.equal(first.allowed, true);

    const overlapping = enterCommandGuard({
      command: "/resolve",
      arg: "",
      message: { chat: { id: scope } },
      ctx: { chatId: scope },
    });
    assert.equal(overlapping.allowed, true);
    releaseCommandGuard(first);
  } finally {
    [config.commandCooldownMs, config.duplicateCommandCooldownMs, config.qwenCommandCooldownMs] = originalCooldowns;
  }
});
