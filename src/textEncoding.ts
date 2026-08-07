import * as iconv from "iconv-lite";

export interface TextEncodingInfo {
  name: string;
  addBom: boolean;
}

const commonEncodings = [
  "utf8",
  "utf16le",
  "utf16be",
  "cp949",
  "euc-kr",
  "shiftjis",
  "windows1252",
  "iso-8859-1",
  "gbk",
  "big5",
];

const encodingAliases: Record<string, string> = {
  utf8bom: "utf8",
  utf16le: "utf16le",
  utf16be: "utf16be",
  windows949: "cp949",
  euckr: "euc-kr",
  shiftjis: "shiftjis",
  windows1252: "windows1252",
  iso88591: "iso-8859-1",
};

export function detectTextEncoding(bytes: Uint8Array, expectedText: string, configuredEncoding = "utf8"): TextEncodingInfo {
  const buffer = toBuffer(bytes);
  const bom = detectBom(buffer);
  const configured = normalizeEncoding(configuredEncoding);
  const candidates = unique([
    bom?.name,
    configured,
    ...commonEncodings,
  ]).filter((encoding) => iconv.encodingExists(encoding));

  for (const name of candidates) {
    const decoded = stripLeadingBom(iconv.decode(buffer, name, { stripBOM: true }));
    if (decoded === expectedText) {
      return {
        name,
        addBom: Boolean(bom && bom.name === name),
      };
    }
  }

  throw new Error("원본 파일의 문자 인코딩을 안전하게 판별하지 못했습니다.");
}

export function encodingForNewFile(configuredEncoding = "utf8"): TextEncodingInfo {
  const name = normalizeEncoding(configuredEncoding);
  if (!iconv.encodingExists(name)) {
    throw new Error(`새 파일 인코딩 '${configuredEncoding}'을 지원하지 않습니다.`);
  }
  return { name, addBom: configuredEncoding.toLowerCase() === "utf8bom" };
}

export function encodeText(text: string, encoding: TextEncodingInfo): Uint8Array {
  return iconv.encode(text, encoding.name, { addBOM: encoding.addBom });
}

export function decodeText(bytes: Uint8Array, encoding: TextEncodingInfo): string {
  return stripLeadingBom(iconv.decode(toBuffer(bytes), encoding.name, { stripBOM: true }));
}

function normalizeEncoding(encoding: string): string {
  const normalized = encoding.toLowerCase().replace(/[\s_-]/g, "");
  return encodingAliases[normalized] ?? encoding.toLowerCase();
}

function detectBom(buffer: Buffer): TextEncodingInfo | undefined {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { name: "utf8", addBom: true };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { name: "utf16le", addBom: true };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { name: "utf16be", addBom: true };
  }
  return undefined;
}

function stripLeadingBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function unique(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function toBuffer(bytes: Uint8Array): Buffer {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
