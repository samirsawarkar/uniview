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
  /**
   * The file was already hashed (and its bytes charged to the budget) to tell duplicates apart:
   * the cached `digestHex` is used and the bytes are not charged a second time.
   */
  prehashed?: boolean;
}

/** Bytes hashed so far in one verification pass; shared with the resolver that hashes duplicates. */
export interface ByteBudget {
  used: number;
}

export interface WebVerifyOptions {
  /** Stops the pass before the next file is resolved or read. */
  signal?: AbortSignal;
  budget?: ByteBudget;
  /** Called as each file's state is known, in receipt order. */
  onFile?: (file: WebVerifiedFile, index: number) => void;
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
  resolver: (file: WebVerifyFile, index: number) => Promise<WebVerifySource | null | undefined>,
  opts: WebVerifyOptions = {}
): Promise<WebVerifyReceiptResult> {
  const budget: ByteBudget = opts.budget ?? { used: 0 };
  const verifiedFiles: WebVerifiedFile[] = [];
  const push = (f: WebVerifiedFile) => {
    verifiedFiles.push(f);
    opts.onFile?.(f, verifiedFiles.length - 1);
  };

  for (const [index, file] of files.entries()) {
    if (opts.signal?.aborted) break;
    let source: WebVerifySource | null | undefined = null;
    try {
      source = await resolver(file, index);
    } catch {
      push({
        path: file.path,
        expectedSha256: file.expectedSha256,
        observedSha256: null,
        state: fileState(file.expectedSha256, null, { unreadable: true }),
        role: file.role,
      });
      continue;
    }

    if (!source) {
      push({
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
      push({
        path: file.path,
        expectedSha256: file.expectedSha256,
        observedSha256: null,
        state: fileState(file.expectedSha256, null, { tooLarge: true }),
        role: file.role,
      });
      continue;
    }

    if (!source.prehashed && reportedSize >= 0 && budget.used + reportedSize > WEB_HASH_LIMITS.MAX_RECEIPT_BYTES) {
      push({
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
        // A cancelled pass drops the bytes it just read instead of hashing them.
        if (opts.signal?.aborted) break;
        actualSize = buffer.byteLength;
        if (actualSize > WEB_HASH_LIMITS.MAX_FILE_BYTES) {
          push({
            path: file.path,
            expectedSha256: file.expectedSha256,
            observedSha256: null,
            state: fileState(file.expectedSha256, null, { tooLarge: true }),
            role: file.role,
          });
          continue;
        }
        if (budget.used + actualSize > WEB_HASH_LIMITS.MAX_RECEIPT_BYTES) {
          push({
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

      if (!source.prehashed) budget.used += actualSize > 0 ? actualSize : 0;
      const state = fileState(file.expectedSha256, observedSha256);
      push({
        path: file.path,
        expectedSha256: file.expectedSha256,
        observedSha256,
        state,
        role: file.role,
      });
    } catch {
      push({
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
    totalBytesHashed: budget.used,
  };
}
