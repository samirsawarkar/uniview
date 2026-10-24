import { fileState } from "../../shared/receipt.mjs";
import type { FileState, ReceiptFileRole } from "../../shared/receipt.d.mts";

export const WEB_HASH_LIMITS = Object.freeze({
  MAX_FILE_BYTES: 256 * 1024 * 1024, // 256 MiB = 268,435,456 bytes
  MAX_RECEIPT_BYTES: 512 * 1024 * 1024, // 512 MiB = 536,870,912 bytes
});

export interface WebVerifyFile {
  path: string;
  expectedSha256: string;
  role: ReceiptFileRole;
  relPath?: string;
}

export interface WebVerifySource {
  size: number;
  readAll(): Promise<ArrayBuffer>;
  /** Optional custom digest function for testing large files without memory exhaustion */
  digestHex?(): Promise<string>;
}

export interface WebVerifiedFile {
  path: string;
  expectedSha256: string;
  observedSha256: string | null;
  state: FileState;
  role: ReceiptFileRole;
}

export interface WebVerifyReceiptResult {
  files: WebVerifiedFile[];
  totalBytesHashed: number;
}

/**
 * Computes SHA-256 hex digest using WebCrypto SubtleCrypto on the whole file.
 */
export async function sha256HexWeb(bytes: Uint8Array | ArrayBuffer): Promise<string> {
  const buf: BufferSource = bytes instanceof Uint8Array
    ? (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
    : bytes;
  const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", buf);
  const hashArray = new Uint8Array(hashBuffer);
  let hex = "";
  for (let i = 0; i < hashArray.length; i++) {
    const val = hashArray[i];
    if (val !== undefined) {
      hex += val.toString(16).padStart(2, "0");
    }
  }
  return hex;
}

/**
 * Verifies receipt files on phone and web:
 * - Whole-file WebCrypto digest
 * - <= 256 MiB per file (over limit -> too_large)
 * - Sequentially one file at a time
 * - <= 512 MiB cumulative per receipt (over limit -> too_large)
 * - States unchanged/changed/missing/unreadable/too_large reuse shared/receipt.mjs
 */
export async function verifyReceiptWeb(
  files: WebVerifyFile[],
  resolver: (file: WebVerifyFile) => Promise<WebVerifySource | null | undefined>
): Promise<WebVerifyReceiptResult> {
  let cumulativeBytes = 0;
  const verifiedFiles: WebVerifiedFile[] = [];

  for (const file of files) {
    let source: WebVerifySource | null | undefined = null;
    try {
      source = await resolver(file);
    } catch {
      verifiedFiles.push({
        path: file.path,
        expectedSha256: file.expectedSha256,
        observedSha256: null,
        state: fileState(file.expectedSha256, null, { unreadable: true }),
        role: file.role,
      });
      continue;
    }

    if (!source) {
      verifiedFiles.push({
        path: file.path,
        expectedSha256: file.expectedSha256,
        observedSha256: null,
        state: fileState(file.expectedSha256, null, { missing: true }),
        role: file.role,
      });
      continue;
    }

    const reportedSize = source.size;
    if (reportedSize > WEB_HASH_LIMITS.MAX_FILE_BYTES) {
      verifiedFiles.push({
        path: file.path,
        expectedSha256: file.expectedSha256,
        observedSha256: null,
        state: fileState(file.expectedSha256, null, { tooLarge: true }),
        role: file.role,
      });
      continue;
    }

    if (reportedSize >= 0 && cumulativeBytes + reportedSize > WEB_HASH_LIMITS.MAX_RECEIPT_BYTES) {
      verifiedFiles.push({
        path: file.path,
        expectedSha256: file.expectedSha256,
        observedSha256: null,
        state: fileState(file.expectedSha256, null, { tooLarge: true }),
        role: file.role,
      });
      continue;
    }

    try {
      let observedSha256: string;
      let actualSize = reportedSize;

      if (source.digestHex) {
        observedSha256 = await source.digestHex();
      } else {
        const buffer = await source.readAll();
        actualSize = buffer.byteLength;
        if (actualSize > WEB_HASH_LIMITS.MAX_FILE_BYTES) {
          verifiedFiles.push({
            path: file.path,
            expectedSha256: file.expectedSha256,
            observedSha256: null,
            state: fileState(file.expectedSha256, null, { tooLarge: true }),
            role: file.role,
          });
          continue;
        }
        if (cumulativeBytes + actualSize > WEB_HASH_LIMITS.MAX_RECEIPT_BYTES) {
          verifiedFiles.push({
            path: file.path,
            expectedSha256: file.expectedSha256,
            observedSha256: null,
            state: fileState(file.expectedSha256, null, { tooLarge: true }),
            role: file.role,
          });
          continue;
        }
        observedSha256 = await sha256HexWeb(buffer);
      }

      cumulativeBytes += actualSize > 0 ? actualSize : 0;
      const state = fileState(file.expectedSha256, observedSha256);
      verifiedFiles.push({
        path: file.path,
        expectedSha256: file.expectedSha256,
        observedSha256,
        state,
        role: file.role,
      });
    } catch {
      verifiedFiles.push({
        path: file.path,
        expectedSha256: file.expectedSha256,
        observedSha256: null,
        state: fileState(file.expectedSha256, null, { unreadable: true }),
        role: file.role,
      });
    }
  }

  return {
    files: verifiedFiles,
    totalBytesHashed: cumulativeBytes,
  };
}
