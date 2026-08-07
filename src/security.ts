import * as net from "node:net";

const hardDeniedHosts = [
  "api." + "openai.com",
  "chat" + "gpt.com",
  "platform." + "openai.com",
  "developers." + "openai.com",
];

export function validateServerUrl(rawUrl: string, allowedHosts: string[]): URL {
  if (!rawUrl.trim()) {
    throw new Error("사내 LLM 서버 URL이 설정되지 않았습니다.");
  }

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("사내 LLM 서버 URL 형식이 올바르지 않습니다.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("사내 LLM 서버 URL은 http 또는 https를 사용해야 합니다.");
  }

  const hostname = normalizeHostname(url.hostname);
  if (isHardDeniedHost(hostname)) {
    throw new Error("설정한 서버 호스트는 정책상 명시적으로 차단되어 있습니다.");
  }

  if (!isAllowedHost(hostname, allowedHosts)) {
    throw new Error(`서버 호스트 '${hostname}'가 companyCodeAI.allowedServerHosts에 포함되어 있지 않습니다.`);
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
    throw new Error("경로에 null byte가 포함되어 있습니다.");
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
