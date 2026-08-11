export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function formatLimitedRichText(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<strong>$1</strong>")
    .replace(/_(.*?)_/g, "<em>$1</em>");
}

export function sanitizeHttpUrl(value) {
  const input = String(value ?? "").trim();
  if (!input || /["'<>`\u0000-\u001f]/.test(input)) return null;
  try {
    const url = new URL(input);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function polymarketEventUrl(slug) {
  const value = String(slug ?? "").trim();
  return value ? `https://polymarket.com/event/${encodeURIComponent(value)}` : null;
}
