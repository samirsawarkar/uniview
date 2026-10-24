import { registerSchema, validate } from "@hyperjump/json-schema/draft-2020-12";
import { BASIC } from "@hyperjump/json-schema/experimental";

export const RECEIPT_LIMITS = Object.freeze({
  MAX_FILE_BYTES: 2 * 1024 * 1024,
  MAX_DEPTH: 16,
  MAX_ERRORS: 100,
  MAX_AGENT_NAME_LENGTH: 80,
  MAX_AGENT_MODEL_LENGTH: 80,
  MAX_AGENT_RUN_LENGTH: 200,
  MAX_TASK_BYTES: 2 * 1024,
  MAX_SUMMARY_BYTES: 256 * 1024,
  MIN_FILES: 1,
  MAX_FILES: 200,
  MAX_PATH_LENGTH: 4096,
  MAX_REL_PATH_LENGTH: 1024,
  MAX_CHECKS: 200,
  MAX_CHECK_NAME_LENGTH: 200,
  MAX_CHECK_EVIDENCE_BYTES: 16 * 1024,
  MAX_SOURCES: 200,
  MAX_SOURCE_TITLE_LENGTH: 300,
  MAX_SOURCE_REF_BYTES: 2 * 1024,
  MAX_VIEW_LENGTH: 4096,
  MAX_VIEW_REL_PATH_LENGTH: 1024,
  MAX_DECISION_COMMENT_BYTES: 8 * 1024
});

export const RECEIPT_SCHEMA_URI = "https://uniview.app/schemas/receipt-1.json";
export const DECISION_SCHEMA_URI = "https://uniview.app/schemas/decision-1.json";

export const RECEIPT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: RECEIPT_SCHEMA_URI,
  title: "UniView Review Receipt v1",
  type: "object",
  required: [
    "uniview",
    "createdAt",
    "agent",
    "task",
    "summary",
    "files"
  ],
  additionalProperties: false,
  properties: {
    uniview: {
      const: "receipt/1"
    },
    createdAt: {
      type: "string",
      format: "date-time",
      pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$"
    },
    agent: {
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: {
        name: {
          type: "string",
          maxLength: RECEIPT_LIMITS.MAX_AGENT_NAME_LENGTH
        },
        model: {
          type: "string",
          maxLength: RECEIPT_LIMITS.MAX_AGENT_MODEL_LENGTH
        },
        run: {
          type: "string",
          maxLength: RECEIPT_LIMITS.MAX_AGENT_RUN_LENGTH
        }
      }
    },
    task: {
      type: "string",
      maxLength: RECEIPT_LIMITS.MAX_TASK_BYTES
    },
    summary: {
      type: "string",
      maxLength: RECEIPT_LIMITS.MAX_SUMMARY_BYTES
    },
    files: {
      type: "array",
      minItems: RECEIPT_LIMITS.MIN_FILES,
      maxItems: RECEIPT_LIMITS.MAX_FILES,
      items: {
        type: "object",
        required: ["path", "sha256", "role"],
        additionalProperties: false,
        properties: {
          path: {
            type: "string",
            maxLength: RECEIPT_LIMITS.MAX_PATH_LENGTH
          },
          relPath: {
            type: "string",
            maxLength: RECEIPT_LIMITS.MAX_REL_PATH_LENGTH
          },
          sha256: {
            type: "string",
            pattern: "^[0-9a-f]{64}$"
          },
          role: {
            enum: ["created", "modified", "input"]
          }
        }
      }
    },
    checks: {
      type: "array",
      minItems: 0,
      maxItems: RECEIPT_LIMITS.MAX_CHECKS,
      items: {
        type: "object",
        required: ["name", "status"],
        additionalProperties: false,
        properties: {
          name: {
            type: "string",
            maxLength: RECEIPT_LIMITS.MAX_CHECK_NAME_LENGTH
          },
          status: {
            enum: ["pass", "fail", "skip"]
          },
          evidence: {
            type: "string",
            maxLength: RECEIPT_LIMITS.MAX_CHECK_EVIDENCE_BYTES
          }
        }
      }
    },
    sources: {
      type: "array",
      minItems: 0,
      maxItems: RECEIPT_LIMITS.MAX_SOURCES,
      items: {
        type: "object",
        required: ["title", "ref"],
        additionalProperties: false,
        properties: {
          title: {
            type: "string",
            maxLength: RECEIPT_LIMITS.MAX_SOURCE_TITLE_LENGTH
          },
          ref: {
            type: "string",
            maxLength: RECEIPT_LIMITS.MAX_SOURCE_REF_BYTES
          }
        }
      }
    },
    view: {
      type: "string",
      maxLength: RECEIPT_LIMITS.MAX_VIEW_LENGTH
    },
    viewRelPath: {
      type: "string",
      maxLength: RECEIPT_LIMITS.MAX_VIEW_REL_PATH_LENGTH
    }
  }
};

export const DECISION_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: DECISION_SCHEMA_URI,
  title: "UniView Review Decision v1",
  type: "object",
  required: [
    "uniview",
    "reviewId",
    "receiptDigest",
    "decision",
    "comment",
    "decidedAt",
    "verifiedAt",
    "persisted",
    "files"
  ],
  additionalProperties: false,
  properties: {
    uniview: {
      const: "decision/1"
    },
    reviewId: {
      type: "string",
      pattern: "^[0-9a-f]{32}$"
    },
    receiptDigest: {
      type: "string",
      pattern: "^[0-9a-f]{64}$"
    },
    decision: {
      enum: ["approved", "changes_requested", "dismissed"]
    },
    comment: {
      type: "string",
      maxLength: RECEIPT_LIMITS.MAX_DECISION_COMMENT_BYTES
    },
    decidedAt: {
      type: "string",
      format: "date-time",
      pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$"
    },
    verifiedAt: {
      type: "string",
      format: "date-time",
      pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$"
    },
    persisted: {
      type: "boolean"
    },
    files: {
      type: "array",
      minItems: 1,
      maxItems: RECEIPT_LIMITS.MAX_FILES,
      items: {
        type: "object",
        required: [
          "path",
          "expectedSha256",
          "observedSha256",
          "state"
        ],
        additionalProperties: false,
        properties: {
          path: {
            type: "string",
            maxLength: RECEIPT_LIMITS.MAX_PATH_LENGTH
          },
          expectedSha256: {
            type: "string",
            pattern: "^[0-9a-f]{64}$"
          },
          observedSha256: {
            oneOf: [
              {
                type: "string",
                pattern: "^[0-9a-f]{64}$"
              },
              {
                type: "null"
              }
            ]
          },
          state: {
            enum: [
              "unchanged",
              "changed",
              "replaced",
              "missing",
              "unreadable",
              "too_large"
            ]
          }
        }
      }
    }
  }
};

try {
  registerSchema(RECEIPT_SCHEMA, RECEIPT_SCHEMA_URI);
} catch {
  // Already registered
}

try {
  registerSchema(DECISION_SCHEMA, DECISION_SCHEMA_URI);
} catch {
  // Already registered
}

let compiledReceiptValidator = null;
let compiledDecisionValidator = null;

async function getReceiptValidator() {
  if (!compiledReceiptValidator) {
    compiledReceiptValidator = await validate(RECEIPT_SCHEMA_URI);
  }
  return compiledReceiptValidator;
}

async function getDecisionValidator() {
  if (!compiledDecisionValidator) {
    compiledDecisionValidator = await validate(DECISION_SCHEMA_URI);
  }
  return compiledDecisionValidator;
}

function checkDepth(value, maxDepth) {
  function traverse(val, current) {
    if (current > maxDepth) return false;
    if (typeof val !== "object" || val === null) return true;
    for (const key of Object.keys(val)) {
      const child = val[key];
      if (typeof child === "object" && child !== null) {
        if (!traverse(child, current + 1)) return false;
      }
    }
    return true;
  }
  return traverse(value, 1);
}

function isAbsolutePath(p) {
  if (typeof p !== "string" || p.length === 0) return false;
  if (p.startsWith("/")) return true;
  if (/^[a-zA-Z]:[\\/]/.test(p)) return true;
  if (p.startsWith("\\\\")) return true;
  return false;
}

function isValidRelativePath(p) {
  if (typeof p !== "string" || p.length === 0) return false;
  if (/^[a-zA-Z]:/.test(p)) return false;
  if (p.startsWith("/") || p.startsWith("\\")) return false;
  const segments = p.split(/[\\/]/);
  for (const seg of segments) {
    if (seg === "..") return false;
  }
  return true;
}

function normalizePathForComparison(p) {
  if (typeof p !== "string") return p;

  const isWindows = /^[a-zA-Z]:([\\/]|$)/.test(p) || p.startsWith("\\\\");
  let normalized = p;
  if (isWindows) {
    normalized = normalized.replace(/\\/g, "/").toLowerCase();
  }

  let root = "";
  let rest = normalized;

  if (isWindows) {
    const driveMatch = rest.match(/^[a-zA-Z]:(?:\/|$)/);
    if (driveMatch) {
      root = driveMatch[0].endsWith("/") ? driveMatch[0] : driveMatch[0] + "/";
      rest = rest.slice(driveMatch[0].length);
    } else {
      const uncMatch = rest.match(/^\/\/([^/]+)\/([^/]+)(?:\/|$)/);
      if (uncMatch) {
        root = uncMatch[0].endsWith("/") ? uncMatch[0] : uncMatch[0] + "/";
        rest = rest.slice(uncMatch[0].length);
      }
    }
  }

  if (!root && rest.startsWith("/")) {
    root = "/";
    rest = rest.replace(/^\/+/, "");
  }

  const rawSegments = rest.split("/");
  const stack = [];
  for (const seg of rawSegments) {
    if (seg === "" || seg === ".") {
      continue;
    }
    if (seg === "..") {
      if (stack.length > 0) {
        stack.pop();
      }
    } else {
      stack.push(seg);
    }
  }

  const joined = stack.join("/");
  if (!root) {
    return joined;
  }
  if (stack.length === 0) {
    return root;
  }
  return root === "/" ? "/" + joined : root + joined;
}

/**
 * Hyperjump's BASIC output lists failures as { keyword, instanceLocation: "#/a/b" };
 * report each with its JSON Pointer and the failing keyword's name.
 */
function pushSchemaErrors(output, errors) {
  if (!Array.isArray(output.errors)) return;
  for (const err of output.errors) {
    if (errors.length >= 100) return;
    const keyword = String(err.keyword ?? "").split("/").pop() || "schema";
    errors.push({
      code: "schema",
      path: String(err.instanceLocation ?? "").replace(/^#/, ""),
      message: `validation failed (${keyword})`
    });
  }
}

function isValidDateTime(val) {
  if (typeof val !== "string") return false;
  const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?(Z|[+-]([0-9]{2}):([0-9]{2}))$/.exec(val);
  if (!match) return false;

  const year = parseInt(match[1], 10);
  const month = parseInt(match[2], 10);
  const day = parseInt(match[3], 10);
  const hour = parseInt(match[4], 10);
  const minute = parseInt(match[5], 10);
  const second = parseInt(match[6], 10);

  if (month < 1 || month > 12) return false;

  const isLeap = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
  const daysInMonths = [31, isLeap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  const maxDay = daysInMonths[month - 1];
  if (day < 1 || day > maxDay) return false;

  if (hour < 0 || hour > 23) return false;
  if (minute < 0 || minute > 59) return false;
  if (second < 0 || second > 60) return false;

  if (match[7] !== "Z") {
    const offsetHour = parseInt(match[8], 10);
    const offsetMinute = parseInt(match[9], 10);
    if (offsetHour < 0 || offsetHour > 23) return false;
    if (offsetMinute < 0 || offsetMinute > 59) return false;
  }

  return true;
}

function checkCalendarDateTime(val, path, errors) {
  if (typeof val === "string") {
    const shapePattern = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]+)?(?:Z|[+-][0-9]{2}:[0-9]{2})$/;
    if (shapePattern.test(val) && !isValidDateTime(val)) {
      errors.push({
        code: "schema",
        path,
        message: "not a valid date-time"
      });
    }
  }
}

function utf8ByteCount(str) {
  return new TextEncoder().encode(str).byteLength;
}

export async function sha256Hex(bytes) {
  const buffer = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  const hashArray = new Uint8Array(buffer);
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
 * Computes the SHA-256 receipt digest over the exact receipt bytes.
 * Note: Inline receipts use the UTF-8 bytes of the received text.
 *
 * @param {Uint8Array} bytes
 * @returns {Promise<string>}
 */
export async function receiptDigest(bytes) {
  return sha256Hex(bytes);
}

export function fileState(expected, observed, opts = {}) {
  if (opts.missing) return "missing";
  if (opts.unreadable) return "unreadable";
  if (opts.tooLarge) return "too_large";
  if (opts.replaced) return "replaced";
  return observed === expected ? "unchanged" : "changed";
}

function sameIdentity(a, b) {
  const x = a ?? null;
  const y = b ?? null;
  if (x === null || y === null) return x === y;
  return String(x.dev) === String(y.dev) && String(x.ino) === String(y.ino);
}

/**
 * A decision is allowed only when the states being decided on are exactly the states that were shown:
 * same files in the same order, same state and observed hash, and the same file identity (dev, ino).
 * Identity matters because a file replaced a second time with identical bytes looks identical otherwise.
 */
export function canDecide(shown, current) {
  if (!Array.isArray(shown) || !Array.isArray(current)) {
    return false;
  }
  if (shown.length !== current.length) {
    return false;
  }
  for (let i = 0; i < shown.length; i++) {
    const s = shown[i];
    const c = current[i];
    if (!s || !c) return false;
    if (s.state !== c.state) return false;
    if (s.observedSha256 !== c.observedSha256) return false;
    if (!sameIdentity(s.identity, c.identity)) return false;
    if (s.path !== undefined && c.path !== undefined && s.path !== c.path) {
      return false;
    }
  }
  return true;
}

export async function validateReceipt(input) {
  const errors = [];
  let parsed = null;

  if (typeof input === "string") {
    const byteLength = new TextEncoder().encode(input).byteLength;
    if (byteLength > RECEIPT_LIMITS.MAX_FILE_BYTES) {
      return {
        ok: false,
        errors: [
          {
            code: "too_large",
            path: "",
            message: `Receipt size (${byteLength} bytes) exceeds limit of ${RECEIPT_LIMITS.MAX_FILE_BYTES} bytes`
          }
        ]
      };
    }
    try {
      parsed = JSON.parse(input);
    } catch (err) {
      return {
        ok: false,
        errors: [
          {
            code: "invalid_json",
            path: "",
            message: err instanceof Error ? err.message : "Invalid JSON"
          }
        ]
      };
    }
  } else if (input instanceof Uint8Array) {
    if (input.byteLength > RECEIPT_LIMITS.MAX_FILE_BYTES) {
      return {
        ok: false,
        errors: [
          {
            code: "too_large",
            path: "",
            message: `Receipt size (${input.byteLength} bytes) exceeds limit of ${RECEIPT_LIMITS.MAX_FILE_BYTES} bytes`
          }
        ]
      };
    }
    try {
      const text = new TextDecoder().decode(input);
      parsed = JSON.parse(text);
    } catch (err) {
      return {
        ok: false,
        errors: [
          {
            code: "invalid_json",
            path: "",
            message: err instanceof Error ? err.message : "Invalid JSON"
          }
        ]
      };
    }
  } else if (typeof input === "object" && input !== null) {
    parsed = input;
  } else {
    return {
      ok: false,
      errors: [
        {
          code: "schema",
          path: "",
          message: "Receipt must be an object or JSON string"
        }
      ]
    };
  }

  if (!checkDepth(parsed, RECEIPT_LIMITS.MAX_DEPTH)) {
    return {
      ok: false,
      errors: [
        {
          code: "too_deep",
          path: "",
          message: `JSON depth exceeds maximum allowed depth of ${RECEIPT_LIMITS.MAX_DEPTH}`
        }
      ]
    };
  }

  if (typeof parsed === "object" && parsed !== null && "uniview" in parsed && parsed.uniview !== "receipt/1") {
    return {
      ok: false,
      errors: [
        {
          code: "unsupported_version",
          path: "/uniview",
          message: `Unsupported version: ${String(parsed.uniview)}`
        }
      ]
    };
  }

  try {
    const validator = await getReceiptValidator();
    const output = await validator(parsed, BASIC);
    if (!output.valid) {
      pushSchemaErrors(output, errors);
      if (errors.length === 0) {
        errors.push({
          code: "schema",
          path: "",
          message: "Schema validation failed"
        });
      }
    }
  } catch (err) {
    errors.push({
      code: "schema",
      path: "",
      message: err instanceof Error ? err.message : "Schema validation failed"
    });
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {
      ok: false,
      errors: errors.slice(0, RECEIPT_LIMITS.MAX_ERRORS)
    };
  }

  const checkUtf8Limit = (val, maxBytes, path, label) => {
    if (typeof val === "string") {
      const b = utf8ByteCount(val);
      if (b > maxBytes) {
        errors.push({
          code: "schema",
          path,
          message: `${label} exceeds UTF-8 byte limit of ${maxBytes} bytes (got ${b})`
        });
      }
    }
  };

  if (parsed.createdAt !== undefined) {
    checkCalendarDateTime(parsed.createdAt, "/createdAt", errors);
  }

  checkUtf8Limit(parsed.task, RECEIPT_LIMITS.MAX_TASK_BYTES, "/task", "task");
  checkUtf8Limit(parsed.summary, RECEIPT_LIMITS.MAX_SUMMARY_BYTES, "/summary", "summary");

  if (Array.isArray(parsed.checks)) {
    for (let i = 0; i < parsed.checks.length; i++) {
      const c = parsed.checks[i];
      if (c && typeof c === "object") {
        checkUtf8Limit(c.evidence, RECEIPT_LIMITS.MAX_CHECK_EVIDENCE_BYTES, `/checks/${i}/evidence`, `checks[${i}].evidence`);
      }
    }
  }

  if (Array.isArray(parsed.sources)) {
    for (let i = 0; i < parsed.sources.length; i++) {
      const s = parsed.sources[i];
      if (s && typeof s === "object") {
        checkUtf8Limit(s.ref, RECEIPT_LIMITS.MAX_SOURCE_REF_BYTES, `/sources/${i}/ref`, `sources[${i}].ref`);
      }
    }
  }

  if (Array.isArray(parsed.files)) {
    const seenPaths = new Map();
    for (let i = 0; i < parsed.files.length; i++) {
      const f = parsed.files[i];
      if (f && typeof f === "object") {
        if (typeof f.path === "string") {
          if (!isAbsolutePath(f.path)) {
            errors.push({
              code: "bad_path",
              path: `/files/${i}/path`,
              message: `Path must be absolute (POSIX or Windows drive): ${f.path}`
            });
          } else {
            const normalized = normalizePathForComparison(f.path);
            if (seenPaths.has(normalized)) {
              const prevIdx = seenPaths.get(normalized);
              errors.push({
                code: "schema",
                path: `/files/${i}/path`,
                message: `duplicate of /files/${prevIdx}/path`
              });
            } else {
              seenPaths.set(normalized, i);
            }
          }
        }

        if (f.relPath !== undefined && typeof f.relPath === "string") {
          if (!isValidRelativePath(f.relPath)) {
            errors.push({
              code: "bad_path",
              path: `/files/${i}/relPath`,
              message: `relPath must be relative without drive, leading slash, or '..': ${f.relPath}`
            });
          }
        }
      }
    }
  }

  if (parsed.view !== undefined && typeof parsed.view === "string") {
    if (!isAbsolutePath(parsed.view)) {
      errors.push({
        code: "bad_path",
        path: "/view",
        message: `view must be absolute (POSIX or Windows drive): ${parsed.view}`
      });
    }
  }

  if (parsed.viewRelPath !== undefined && typeof parsed.viewRelPath === "string") {
    if (!isValidRelativePath(parsed.viewRelPath)) {
      errors.push({
        code: "bad_path",
        path: "/viewRelPath",
        message: `viewRelPath must be relative without drive, leading slash, or '..': ${parsed.viewRelPath}`
      });
    }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors: errors.slice(0, RECEIPT_LIMITS.MAX_ERRORS)
    };
  }

  return {
    ok: true,
    receipt: parsed
  };
}

export async function validateDecision(value) {
  const errors = [];
  let parsed = null;

  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch (err) {
      return {
        ok: false,
        errors: [
          {
            code: "schema",
            path: "",
            message: err instanceof Error ? err.message : "Invalid JSON"
          }
        ]
      };
    }
  } else if (typeof value === "object" && value !== null) {
    parsed = value;
  } else {
    return {
      ok: false,
      errors: [
        {
          code: "schema",
          path: "",
          message: "Decision must be an object or JSON string"
        }
      ]
    };
  }

  try {
    const validator = await getDecisionValidator();
    const output = await validator(parsed, BASIC);
    if (!output.valid) {
      pushSchemaErrors(output, errors);
      if (errors.length === 0) {
        errors.push({
          code: "schema",
          path: "",
          message: "Decision schema validation failed"
        });
      }
    }
  } catch (err) {
    errors.push({
      code: "schema",
      path: "",
      message: err instanceof Error ? err.message : "Decision schema validation failed"
    });
  }

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    if (parsed.decidedAt !== undefined) {
      checkCalendarDateTime(parsed.decidedAt, "/decidedAt", errors);
    }
    if (parsed.verifiedAt !== undefined) {
      checkCalendarDateTime(parsed.verifiedAt, "/verifiedAt", errors);
    }
    if (typeof parsed.comment === "string") {
      const commentBytes = utf8ByteCount(parsed.comment);
      if (commentBytes > RECEIPT_LIMITS.MAX_DECISION_COMMENT_BYTES) {
        errors.push({
          code: "schema",
          path: "/comment",
          message: `comment exceeds byte limit of ${RECEIPT_LIMITS.MAX_DECISION_COMMENT_BYTES} bytes (got ${commentBytes})`
        });
      }
    }
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors: errors.slice(0, RECEIPT_LIMITS.MAX_ERRORS)
    };
  }

  return {
    ok: true,
    decision: parsed
  };
}
