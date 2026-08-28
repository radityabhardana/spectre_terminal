export const AI_TRIGGER_SECONDS = Object.freeze({ "5m": 150, "15m": 450, "1h": 1800, "4h": 7200 });

export function shortAiTriggerSeconds(item) {
  return AI_TRIGGER_SECONDS[item?.duration_type || item?.durationType] ?? null;
}

export function isSupportedShortAiItem(item) {
  const text = String(item?.question || item?.title || "");
  return shortAiTriggerSeconds(item) != null
    && /\b(?:bitcoin|btc|ethereum|eth|dogecoin|doge)\b/i.test(text)
    && /\bup or down\b/i.test(text);
}

export function shouldTriggerShortAiAnalysis(item, remainingSeconds) {
  const trigger = shortAiTriggerSeconds(item);
  return isSupportedShortAiItem(item) && remainingSeconds > 0 && remainingSeconds <= trigger
    && !item.aiAnalysisTriggered && !item.aiAnalysisInFlight;
}

export function markShortAiAnalysisTriggered(item, remainingSeconds) {
  item.aiAnalysisTriggered = true;
  item.aiAnalysisInFlight = true;
  item.aiAnalysisTriggeredAtRemainingSeconds = remainingSeconds;
  return item;
}
