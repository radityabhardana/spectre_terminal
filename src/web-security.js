import path from "node:path";

const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self' https://clob.polymarket.com https://hermes.pyth.network wss://hermes.pyth.network https://edns.ip-api.com https://*.edns.ip-api.com",
  "frame-src https://embed.polymarket.com",
].join("; ");

export function getSecurityHeaders() {
  return {
    "content-security-policy": CONTENT_SECURITY_POLICY,
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
  };
}

export function assertSecureWebBinding(webHost, webPassword) {
  if (!isLoopbackHost(webHost) && !String(webPassword || "").trim()) {
    throw new Error("WEB_PASSWORD is required when WEB_HOST is not loopback.");
  }
}

function normalizedHost(value) {
  return String(value || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
}

function isLoopbackHost(value) {
  return new Set(["127.0.0.1", "::1", "localhost"]).has(normalizedHost(value));
}

export function validateRequestHost(req, webHost) {
  const binding = normalizedHost(webHost);
  if (binding === "0.0.0.0" || binding === "::") return;

  let requestHost;
  try {
    requestHost = new URL(`http://${String(req?.headers?.host || "")}`).hostname;
  } catch {
    throw Object.assign(new Error("Invalid Host header"), { status: 400 });
  }
  const valid = isLoopbackHost(binding)
    ? isLoopbackHost(requestHost)
    : normalizedHost(requestHost) === binding;
  if (!valid) throw Object.assign(new Error("Misdirected request"), { status: 421 });
}

export function resolvePublicPath(root, requestPath) {
  try {
    const pathname = decodeURIComponent(String(requestPath || "/"));
    const relativePath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = path.resolve(root, relativePath);
    return filePath === root || filePath.startsWith(`${root}${path.sep}`) ? filePath : null;
  } catch {
    return null;
  }
}

export function normalizeWalletAddress(value) {
  try {
    const address = decodeURIComponent(String(value || "").trim()).toLowerCase();
    return /^0x[a-f0-9]{40}$/.test(address) ? address : null;
  } catch {
    return null;
  }
}

export function validateMutationRequest(req) {
  const method = String(req?.method || "GET").toUpperCase();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method) || !String(req?.url || "").startsWith("/api/")) return;

  const headers = req?.headers || {};
  const fetchSite = String(headers["sec-fetch-site"] || "").toLowerCase();
  if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite)) {
    throw Object.assign(new Error("Cross-site API request rejected"), { status: 403 });
  }

  const origin = String(headers.origin || "").trim();
  if (origin) {
    try {
      if (new URL(origin).host.toLowerCase() !== String(headers.host || "").toLowerCase()) {
        throw Object.assign(new Error("Cross-origin API request rejected"), { status: 403 });
      }
    } catch (error) {
      if (error.status === 403) throw error;
      throw Object.assign(new Error("Invalid Origin header"), { status: 403 });
    }
  }

  if (["POST", "PUT", "PATCH"].includes(method)) {
    const contentType = String(headers["content-type"] || "").toLowerCase();
    if (!contentType.startsWith("application/json")) {
      throw Object.assign(new Error("Content-Type must be application/json"), { status: 415 });
    }
  }
}
