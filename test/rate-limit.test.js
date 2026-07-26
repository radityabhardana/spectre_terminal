import test from "node:test";
import assert from "node:assert/strict";

import { config } from "../src/config.js";
import { enterCommandGuard, releaseCommandGuard } from "../src/rate-limit.js";

test("argumentless evaluate is treated as an AI command", () => {
  const originalCooldowns = [config.commandCooldownMs, config.duplicateCommandCooldownMs, config.qwenCommandCooldownMs];
  config.commandCooldownMs = 0;
  config.duplicateCommandCooldownMs = 0;
  config.qwenCommandCooldownMs = 0;
  try {
    const scope = `rate-test-${Date.now()}-${Math.random()}`;
    const first = enterCommandGuard({
      command: "/evaluate",
      arg: "",
      message: { chat: { id: scope } },
      ctx: { chatId: scope },
    });
    assert.equal(first.allowed, true);

    const overlapping = enterCommandGuard({
      command: "/evaluate",
      arg: "",
      message: { chat: { id: scope } },
      ctx: { chatId: scope },
    });
    assert.equal(overlapping.allowed, false);
    assert.match(overlapping.message, /analisis AI yang sedang berjalan/);
    releaseCommandGuard(first);
  } finally {
    [config.commandCooldownMs, config.duplicateCommandCooldownMs, config.qwenCommandCooldownMs] = originalCooldowns;
  }
});
