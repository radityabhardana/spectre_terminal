import { config } from "./config.js";

const commandCooldowns = new Map();
const qwenCooldowns = new Map();
const duplicateCooldowns = new Map();
const qwenInFlight = new Map();

const FREE_COMMANDS = new Set(["/start", "/help", "/version", "/example"]);
const QWEN_COMMANDS = new Set([
  "/analyze",
  "/shortanalyze",
  "/analyzebest",
  "/analyzeall",
  "/analyzequeue",
  "/eventmarket",
  "/eventbest",
  "/eventall",
  "/shortcondition",
  "/shortvibe"
]);

function cleanup(map, cutoff) {
  for (const [key, value] of map.entries()) {
    const time = typeof value === "number" ? value : value?.startedAt;
    if (!time || time < cutoff) map.delete(key);
  }
}

function chatScope(message, ctx) {
  const chatId = message?.chat?.id || ctx?.chatId || "global";
  const userId = message?.from?.id || message?.from?.username || "";
  return userId ? `${chatId}:${userId}` : String(chatId);
}

function waitText(ms) {
  const seconds = Math.max(1, Math.ceil(ms / 1000));
  if (seconds < 60) return `${seconds} detik`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest ? `${minutes} menit ${rest} detik` : `${minutes} menit`;
}

function cooldownMessage(reason, waitMs) {
  return [
    "ANTI-SPAM GUARD",
    reason,
    `Tunggu ${waitText(waitMs)} lagi sebelum kirim command berikutnya.`,
    "",
    "Ini sengaja dipasang supaya API/Qwen token tidak cepat habis.",
  ].join("\n");
}

function normalizedCommandKey(command, arg) {
  return `${String(command || "").trim().toLowerCase()} ${String(arg || "").trim().toLowerCase()}`
    .replace(/\s+/g, " ")
    .slice(0, 500);
}

export function enterCommandGuard({ command, arg, message, ctx }) {
  const normalizedCommand = String(command || "").trim().toLowerCase();
  if (FREE_COMMANDS.has(normalizedCommand)) return { allowed: true };

  const now = Date.now();
  const staleCutoff = now - 60 * 60 * 1000;
  cleanup(commandCooldowns, staleCutoff);
  cleanup(qwenCooldowns, staleCutoff);
  cleanup(duplicateCooldowns, staleCutoff);
  cleanup(qwenInFlight, now - 30 * 60 * 1000);

  const scope = chatScope(message, ctx);
  const commandKey = `${scope}:${normalizedCommandKey(command, arg)}`;
  const hasArg = Boolean(String(arg || "").trim());
  
  // For standard commands, require hasArg. For commands that don't need args, just check the set.
  const isQwenCommand = QWEN_COMMANDS.has(normalizedCommand) &&
    (hasArg || ["/shortcondition", "/shortvibe"].includes(normalizedCommand));

  const lastCommandAt = commandCooldowns.get(scope) || 0;
  const commandWaitMs = config.commandCooldownMs - (now - lastCommandAt);
  if (commandWaitMs > 0) {
    return {
      allowed: false,
      message: cooldownMessage("Command terlalu cepat.", commandWaitMs),
    };
  }

  if (isQwenCommand) {
    const active = qwenInFlight.get(scope);
    if (active) {
      return {
        allowed: false,
        message: [
          "ANTI-SPAM GUARD",
          "Masih ada analisis AI yang sedang berjalan.",
          "Tunggu hasil sebelumnya selesai dulu sebelum memanggil Qwen lagi.",
          "",
          "Ini sengaja dipasang supaya Qwen token tidak cepat habis.",
        ].join("\n"),
      };
    }

    const lastQwenAt = qwenCooldowns.get(scope) || 0;
    const qwenWaitMs = config.qwenCommandCooldownMs - (now - lastQwenAt);
    if (qwenWaitMs > 0) {
      return {
        allowed: false,
        message: cooldownMessage("Command AI/Qwen sedang cooldown.", qwenWaitMs),
      };
    }
  }

  const lastDuplicateAt = duplicateCooldowns.get(commandKey) || 0;
  const duplicateWaitMs = config.duplicateCommandCooldownMs - (now - lastDuplicateAt);
  if (duplicateWaitMs > 0) {
    return {
      allowed: false,
      message: cooldownMessage("Command yang sama baru saja dikirim.", duplicateWaitMs),
    };
  }

  commandCooldowns.set(scope, now);
  duplicateCooldowns.set(commandKey, now);

  if (isQwenCommand) {
    const lock = {
      command: normalizedCommand,
      startedAt: now,
    };
    qwenInFlight.set(scope, lock);
    return {
      allowed: true,
      release: () => {
        if (qwenInFlight.get(scope) === lock) {
          qwenCooldowns.set(scope, Date.now());
          qwenInFlight.delete(scope);
        }
      },
    };
  }

  return {
    allowed: true,
  };
}

export function releaseCommandGuard(guard) {
  if (typeof guard?.release === "function") guard.release();
}

export function getCooldownState(scope = "web") {
  const now = Date.now();
  
  const lastCommandAt = commandCooldowns.get(scope) || 0;
  const commandWaitMs = Math.max(0, config.commandCooldownMs - (now - lastCommandAt));
  
  const lastQwenAt = qwenCooldowns.get(scope) || 0;
  const qwenWaitMs = Math.max(0, config.qwenCommandCooldownMs - (now - lastQwenAt));
  
  const activeQwen = qwenInFlight.get(scope);
  
  return {
    commandWaitMs,
    qwenWaitMs,
    qwenInFlight: Boolean(activeQwen),
  };
}
