// Print UniView's detection for a file as JSON. Used by the AES golden eval suite (evals/detect.json).
import { openSync, readSync, closeSync } from "node:fs";
import { basename } from "node:path";
import { detect, DETECT_HEAD_BYTES } from "../src/core/detect.ts";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/detect-cli.mjs <file>");
  process.exit(2);
}
const fd = openSync(file, "r");
const head = Buffer.alloc(DETECT_HEAD_BYTES);
const n = readSync(fd, head, 0, head.length, 0);
closeSync(fd);
console.log(JSON.stringify(detect(basename(file), new Uint8Array(head.buffer, head.byteOffset, n))));
