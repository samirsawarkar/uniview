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
  if (/^[a-zA-Z]:/.test(p) || p.includes("\\")) {
    return p.replace(/\\/g, "/").toLowerCase();
  }
  return p;
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
      if (Array.isArray(output.errors) && output.errors.length > 0) {
        for (const err of output.errors) {
          if (err.instanceLocation !== undefined && err.error) {
            errors.push({
              code: "schema",
              path: err.instanceLocation,
              message: err.error
            });
          }
        }
      }
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

  if (parsed.agent && typeof parsed.agent === "object") {
    checkUtf8Limit(parsed.agent.name, RECEIPT_LIMITS.MAX_AGENT_NAME_LENGTH, "/agent/name", "agent.name");
    checkUtf8Limit(parsed.agent.model, RECEIPT_LIMITS.MAX_AGENT_MODEL_LENGTH, "/agent/model", "agent.model");
    checkUtf8Limit(parsed.agent.run, RECEIPT_LIMITS.MAX_AGENT_RUN_LENGTH, "/agent/run", "agent.run");
  }

  checkUtf8Limit(parsed.task, RECEIPT_LIMITS.MAX_TASK_BYTES, "/task", "task");
  checkUtf8Limit(parsed.summary, RECEIPT_LIMITS.MAX_SUMMARY_BYTES, "/summary", "summary");
  checkUtf8Limit(parsed.view, RECEIPT_LIMITS.MAX_VIEW_LENGTH, "/view", "view");
  checkUtf8Limit(parsed.viewRelPath, RECEIPT_LIMITS.MAX_VIEW_REL_PATH_LENGTH, "/viewRelPath", "viewRelPath");

  if (Array.isArray(parsed.checks)) {
    for (let i = 0; i < parsed.checks.length; i++) {
      const c = parsed.checks[i];
      if (c && typeof c === "object") {
        checkUtf8Limit(c.name, RECEIPT_LIMITS.MAX_CHECK_NAME_LENGTH, `/checks/${i}/name`, `checks[${i}].name`);
        checkUtf8Limit(c.evidence, RECEIPT_LIMITS.MAX_CHECK_EVIDENCE_BYTES, `/checks/${i}/evidence`, `checks[${i}].evidence`);
      }
    }
  }

  if (Array.isArray(parsed.sources)) {
    for (let i = 0; i < parsed.sources.length; i++) {
      const s = parsed.sources[i];
      if (s && typeof s === "object") {
        checkUtf8Limit(s.title, RECEIPT_LIMITS.MAX_SOURCE_TITLE_LENGTH, `/sources/${i}/title`, `sources[${i}].title`);
        checkUtf8Limit(s.ref, RECEIPT_LIMITS.MAX_SOURCE_REF_BYTES, `/sources/${i}/ref`, `sources[${i}].ref`);
      }
    }
  }

  if (Array.isArray(parsed.files)) {
    const seenPaths = new Set();
    for (let i = 0; i < parsed.files.length; i++) {
      const f = parsed.files[i];
      if (f && typeof f === "object") {
        checkUtf8Limit(f.path, RECEIPT_LIMITS.MAX_PATH_LENGTH, `/files/${i}/path`, `files[${i}].path`);
        checkUtf8Limit(f.relPath, RECEIPT_LIMITS.MAX_REL_PATH_LENGTH, `/files/${i}/relPath`, `files[${i}].relPath`);

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
              errors.push({
                code: "schema",
                path: `/files/${i}/path`,
                message: `Duplicate file path: ${f.path}`
              });
            } else {
              seenPaths.add(normalized);
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
      if (Array.isArray(output.errors) && output.errors.length > 0) {
        for (const err of output.errors) {
          if (err.instanceLocation !== undefined && err.error) {
            errors.push({
              code: "schema",
              path: err.instanceLocation,
              message: err.error
            });
          }
        }
      }
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

  if (parsed && typeof parsed.comment === "string") {
    const commentBytes = utf8ByteCount(parsed.comment);
    if (commentBytes > RECEIPT_LIMITS.MAX_DECISION_COMMENT_BYTES) {
      errors.push({
        code: "schema",
        path: "/comment",
        message: `comment exceeds byte limit of ${RECEIPT_LIMITS.MAX_DECISION_COMMENT_BYTES} bytes (got ${commentBytes})`
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
    decision: parsed
  };
}
