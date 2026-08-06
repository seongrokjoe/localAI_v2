import * as net from "node:net";

const hardDeniedHosts = [
  "api." + "openai.com",
  "chat" + "gpt.com",
  "platform." + "openai.com",
  "developers." + "openai.com",
];

export function validateServerUrl(rawUrl: string, allowedHosts: string[]): URL {
  if (!rawUrl.trim()) {
    throw new Error("Internal LLM server URL is not configured.");
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("Internal LLM server URL is invalid.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Internal LLM server URL must use http or https.");
  }

  const hostname = normalizeHostname(url.hostname);
  if (isHardDeniedHost(hostname)) {
    throw new Error("The configured server host is explicitly blocked by policy.");
  }

  if (!isAllowedHost(hostname, allowedHosts)) {
    throw new Error(`Server host '${hostname}' is not in companyCodeAI.allowedServerHosts.`);
  }

  return url;
}

export function isHardDeniedHost(hostname: string): boolean {
  const normalized = normalizeHostname(hostname);
  return hardDeniedHosts.some((denied) => normalized === denied || normalized.endsWith(`.${denied}`));
}

export function isAllowedHost(hostname: string, allowedHosts: string[]): boolean {
  const normalized = normalizeHostname(hostname);
  if (normalized === "localhost" || normalized === "::1") {
    return allowedHosts.some((entry) => normalizeRule(entry) === "localhost" || normalizeRule(entry) === "::1");
  }

  for (const rawRule of allowedHosts) {
    const rule = normalizeRule(rawRule);
    if (!rule) {
      continue;
    }
    if (rule.startsWith(".")) {
      if (normalized.endsWith(rule)) {
        return true;
      }
      continue;
    }
    if (rule.includes("/")) {
      if (matchesIpv4Cidr(normalized, rule)) {
        return true;
      }
      continue;
    }
    if (normalized === rule) {
      return true;
    }
  }

  return false;
}

export function assertSafePathSegment(value: string): void {
  if (value.includes("\0")) {
    throw new Error("Path contains a null byte.");
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.trim().replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
}

function normalizeRule(rule: string): string {
  return rule.trim().toLowerCase();
}

function matchesIpv4Cidr(hostname: string, cidr: string): boolean {
  if (net.isIP(hostname) !== 4) {
    return false;
  }

  const [range, bitsText] = cidr.split("/");
  const bits = Number(bitsText);
  if (net.isIP(range) !== 4 || !Number.isInteger(bits) || bits < 0 || bits > 32) {
    return false;
  }

  const hostNumber = ipv4ToNumber(hostname);
  const rangeNumber = ipv4ToNumber(range);
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (hostNumber & mask) === (rangeNumber & mask);
}

function ipv4ToNumber(value: string): number {
  return value
    .split(".")
    .map((part) => Number(part))
    .reduce((acc, part) => ((acc << 8) + part) >>> 0, 0);
}
