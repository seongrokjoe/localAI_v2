import assert from "node:assert/strict";
import iconv from "iconv-lite";
import { decodeText, detectTextEncoding, encodeText } from "../dist/textEncoding.js";

const samples = [
  { encoding: "utf8", configured: "utf8", addBom: false },
  { encoding: "utf8", configured: "utf8bom", addBom: true },
  { encoding: "utf8", configured: "utf8bom", addBom: false },
  { encoding: "utf16le", configured: "utf16le", addBom: true },
  { encoding: "cp949", configured: "windows949", addBom: false },
];

for (const sample of samples) {
  const original = "한글 설명\r\nconst value = 1;\r\n";
  const bytes = iconv.encode(original, sample.encoding, { addBOM: sample.addBom });
  const detected = detectTextEncoding(bytes, original, sample.configured);
  const replacement = original.replace("value = 1", "value = 2");
  const encoded = encodeText(replacement, detected);

  assert.equal(decodeText(encoded, detected), replacement);
  assert.equal(detected.addBom, sample.addBom);
  assert.ok(encoded.length > 0);
}

console.log("text encoding tests passed");
