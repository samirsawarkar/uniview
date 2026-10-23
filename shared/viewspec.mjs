import { registerSchema, validate } from "@hyperjump/json-schema/draft-2020-12";
import { BASIC } from "@hyperjump/json-schema/experimental";

export const VIEW_SPEC_LIMITS = Object.freeze({
  MAX_FILE_BYTES: 2 * 1024 * 1024,
  MAX_DEPTH: 32,
  MAX_NODES: 50000,
  MAX_TITLE_LENGTH: 200,
  MAX_AGENT_NAME_LENGTH: 80,
  MAX_AGENT_MODEL_LENGTH: 80,
  MAX_HEADING_TEXT_LENGTH: 300,
  MIN_HEADING_LEVEL: 1,
  MAX_HEADING_LEVEL: 4,
  MAX_MARKDOWN_LENGTH: 256 * 1024,
  MAX_CALLOUT_TITLE_LENGTH: 200,
  MIN_KEY_VALUE_ITEMS: 1,
  MAX_KEY_VALUE_ITEMS: 500,
  MAX_KEY_VALUE_KEY_LENGTH: 200,
  MAX_KEY_VALUE_VALUE_LENGTH: 4096,
  MIN_TABLE_COLUMNS: 1,
  MAX_TABLE_COLUMNS: 50,
  MAX_TABLE_ROWS: 10000,
  MAX_TABLE_CELL_LENGTH: 4096,
  MAX_TABLE_COLUMN_KEY_LENGTH: 64,
  MIN_LIST_ITEMS: 1,
  MAX_LIST_ITEMS: 1000,
  MAX_TREE_ENTRIES: 20000,
  MAX_TREE_LABEL_LENGTH: 300,
  MAX_TREE_DETAIL_LENGTH: 1024,
  MAX_CODE_LENGTH: 512 * 1024,
  MAX_DIFF_LENGTH: 512 * 1024,
  MAX_DIFF_LINES: 20000,
  MAX_IMAGE_ALT_LENGTH: 300,
  MAX_IMAGE_CAPTION_LENGTH: 300,
  MAX_PATH_LENGTH: 4096,
  MAX_REL_PATH_LENGTH: 1024,
  MAX_FILE_REF_LABEL_LENGTH: 200,
  MIN_CHART_X: 1,
  MAX_CHART_X: 500,
  MIN_CHART_SERIES: 1,
  MAX_CHART_SERIES: 10,
  MIN_COLUMNS: 2,
  MAX_COLUMNS: 3
});

export const SCHEMA_URI = "https://uniview.app/schemas/view-1.json";

export const VIEW_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: SCHEMA_URI,
  title: "UniView View Spec v1",
  type: "object",
  required: ["uniview", "title", "body"],
  additionalProperties: false,
  properties: {
    uniview: {
      const: "view/1"
    },
    title: {
      type: "string",
      maxLength: VIEW_SPEC_LIMITS.MAX_TITLE_LENGTH
    },
    agent: {
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: {
        name: {
          type: "string",
          maxLength: VIEW_SPEC_LIMITS.MAX_AGENT_NAME_LENGTH
        },
        model: {
          type: "string",
          maxLength: VIEW_SPEC_LIMITS.MAX_AGENT_MODEL_LENGTH
        }
      }
    },
    body: {
      type: "array",
      items: {
        $ref: "#/$defs/Node"
      }
    }
  },
  $defs: {
    Node: {
      oneOf: [
        { $ref: "#/$defs/HeadingNode" },
        { $ref: "#/$defs/MarkdownNode" },
        { $ref: "#/$defs/CalloutNode" },
        { $ref: "#/$defs/KeyValueNode" },
        { $ref: "#/$defs/TableNode" },
        { $ref: "#/$defs/ListNode" },
        { $ref: "#/$defs/TreeNode" },
        { $ref: "#/$defs/CodeNode" },
        { $ref: "#/$defs/DiffNode" },
        { $ref: "#/$defs/ImageNode" },
        { $ref: "#/$defs/ChartNode" },
        { $ref: "#/$defs/SectionNode" },
        { $ref: "#/$defs/ColumnsNode" },
        { $ref: "#/$defs/FileRefNode" }
      ]
    },
    HeadingNode: {
      type: "object",
      required: ["type", "text"],
      additionalProperties: false,
      properties: {
        type: { const: "heading" },
        text: { type: "string", maxLength: VIEW_SPEC_LIMITS.MAX_HEADING_TEXT_LENGTH },
        level: {
          type: "integer",
          minimum: VIEW_SPEC_LIMITS.MIN_HEADING_LEVEL,
          maximum: VIEW_SPEC_LIMITS.MAX_HEADING_LEVEL
        }
      }
    },
    MarkdownNode: {
      type: "object",
      required: ["type", "text"],
      additionalProperties: false,
      properties: {
        type: { const: "markdown" },
        text: { type: "string", maxLength: VIEW_SPEC_LIMITS.MAX_MARKDOWN_LENGTH }
      }
    },
    CalloutNode: {
      type: "object",
      required: ["type", "tone", "text"],
      additionalProperties: false,
      properties: {
        type: { const: "callout" },
        tone: { type: "string", enum: ["info", "success", "warning", "danger"] },
        text: { type: "string" },
        title: { type: "string", maxLength: VIEW_SPEC_LIMITS.MAX_CALLOUT_TITLE_LENGTH }
      }
    },
    KeyValueNode: {
      type: "object",
      required: ["type", "items"],
      additionalProperties: false,
      properties: {
        type: { const: "keyValue" },
        items: {
          type: "array",
          minItems: VIEW_SPEC_LIMITS.MIN_KEY_VALUE_ITEMS,
          maxItems: VIEW_SPEC_LIMITS.MAX_KEY_VALUE_ITEMS,
          items: {
            type: "object",
            required: ["key", "value"],
            additionalProperties: false,
            properties: {
              key: { type: "string", maxLength: VIEW_SPEC_LIMITS.MAX_KEY_VALUE_KEY_LENGTH },
              value: { type: "string", maxLength: VIEW_SPEC_LIMITS.MAX_KEY_VALUE_VALUE_LENGTH }
            }
          }
        }
      }
    },
    TableNode: {
      type: "object",
      required: ["type", "columns"],
      additionalProperties: false,
      properties: {
        type: { const: "table" },
        columns: {
          type: "array",
          minItems: VIEW_SPEC_LIMITS.MIN_TABLE_COLUMNS,
          maxItems: VIEW_SPEC_LIMITS.MAX_TABLE_COLUMNS,
          items: {
            type: "object",
            required: ["key", "label"],
            additionalProperties: false,
            properties: {
              key: {
                type: "string",
                maxLength: VIEW_SPEC_LIMITS.MAX_TABLE_COLUMN_KEY_LENGTH,
                pattern: "^[A-Za-z0-9_.-]{1,64}$"
              },
              label: { type: "string", maxLength: 200 },
              align: { type: "string", enum: ["left", "right", "center"] }
            }
          }
        },
        rows: {
          type: "array",
          maxItems: VIEW_SPEC_LIMITS.MAX_TABLE_ROWS,
          items: {
            type: "object",
            additionalProperties: {
              anyOf: [
                { type: "string", maxLength: VIEW_SPEC_LIMITS.MAX_TABLE_CELL_LENGTH },
                { type: "number" },
                { type: "boolean" },
                { type: "null" }
              ]
            }
          }
        }
      }
    },
    ListNode: {
      type: "object",
      required: ["type", "items"],
      additionalProperties: false,
      properties: {
        type: { const: "list" },
        ordered: { type: "boolean" },
        items: {
          type: "array",
          minItems: VIEW_SPEC_LIMITS.MIN_LIST_ITEMS,
          maxItems: VIEW_SPEC_LIMITS.MAX_LIST_ITEMS,
          items: {
            oneOf: [
              { type: "string" },
              { $ref: "#/$defs/Node" }
            ]
          }
        }
      }
    },
    TreeNode: {
      type: "object",
      required: ["type", "nodes"],
      additionalProperties: false,
      properties: {
        type: { const: "tree" },
        nodes: {
          type: "array",
          items: { $ref: "#/$defs/TreeEntry" }
        }
      }
    },
    TreeEntry: {
      type: "object",
      required: ["label"],
      additionalProperties: false,
      properties: {
        label: { type: "string", maxLength: VIEW_SPEC_LIMITS.MAX_TREE_LABEL_LENGTH },
        detail: { type: "string", maxLength: VIEW_SPEC_LIMITS.MAX_TREE_DETAIL_LENGTH },
        children: {
          type: "array",
          items: { $ref: "#/$defs/TreeEntry" }
        }
      }
    },
    CodeNode: {
      type: "object",
      required: ["type", "text"],
      additionalProperties: false,
      properties: {
        type: { const: "code" },
        text: { type: "string", maxLength: VIEW_SPEC_LIMITS.MAX_CODE_LENGTH },
        language: { type: "string", maxLength: 80 },
        highlightLines: {
          type: "array",
          items: {
            type: "array",
            prefixItems: [
              { type: "integer", minimum: 1 },
              { type: "integer", minimum: 1 }
            ],
            items: false,
            minItems: 2,
            maxItems: 2
          }
        }
      }
    },
    DiffNode: {
      type: "object",
      required: ["type"],
      additionalProperties: false,
      properties: {
        type: { const: "diff" },
        title: { type: "string", maxLength: 200 },
        language: { type: "string", maxLength: 80 },
        unified: { type: "string", maxLength: VIEW_SPEC_LIMITS.MAX_DIFF_LENGTH },
        before: { type: "string", maxLength: VIEW_SPEC_LIMITS.MAX_DIFF_LENGTH },
        after: { type: "string", maxLength: VIEW_SPEC_LIMITS.MAX_DIFF_LENGTH }
      },
      oneOf: [
        {
          required: ["unified"],
          not: {
            anyOf: [
              { required: ["before"] },
              { required: ["after"] }
            ]
          }
        },
        {
          required: ["before", "after"],
          not: {
            required: ["unified"]
          }
        }
      ]
    },
    ImageNode: {
      type: "object",
      required: ["type", "path", "alt"],
      additionalProperties: false,
      properties: {
        type: { const: "image" },
        path: { type: "string", maxLength: VIEW_SPEC_LIMITS.MAX_PATH_LENGTH },
        relPath: { type: "string", maxLength: VIEW_SPEC_LIMITS.MAX_REL_PATH_LENGTH },
        alt: { type: "string", maxLength: VIEW_SPEC_LIMITS.MAX_IMAGE_ALT_LENGTH },
        caption: { type: "string", maxLength: VIEW_SPEC_LIMITS.MAX_IMAGE_CAPTION_LENGTH }
      }
    },
    ChartNode: {
      type: "object",
      required: ["type", "kind", "x", "series"],
      additionalProperties: false,
      properties: {
        type: { const: "chart" },
        kind: { type: "string", enum: ["bar", "line"] },
        x: {
          type: "array",
          minItems: VIEW_SPEC_LIMITS.MIN_CHART_X,
          maxItems: VIEW_SPEC_LIMITS.MAX_CHART_X,
          items: { type: "string" }
        },
        series: {
          type: "array",
          minItems: VIEW_SPEC_LIMITS.MIN_CHART_SERIES,
          maxItems: VIEW_SPEC_LIMITS.MAX_CHART_SERIES,
          items: {
            type: "object",
            required: ["name", "values"],
            additionalProperties: false,
            properties: {
              name: { type: "string", maxLength: 200 },
              values: {
                type: "array",
                items: { type: "number" }
              }
            }
          }
        }
      }
    },
    SectionNode: {
      type: "object",
      required: ["type", "children"],
      additionalProperties: false,
      properties: {
        type: { const: "section" },
        title: { type: "string", maxLength: 200 },
        collapsed: { type: "boolean" },
        children: {
          type: "array",
          items: { $ref: "#/$defs/Node" }
        }
      }
    },
    ColumnsNode: {
      type: "object",
      required: ["type", "columns"],
      additionalProperties: false,
      properties: {
        type: { const: "columns" },
        columns: {
          type: "array",
          minItems: VIEW_SPEC_LIMITS.MIN_COLUMNS,
          maxItems: VIEW_SPEC_LIMITS.MAX_COLUMNS,
          items: {
            type: "array",
            items: { $ref: "#/$defs/Node" }
          }
        }
      }
    },
    FileRefNode: {
      type: "object",
      required: ["type", "path"],
      additionalProperties: false,
      properties: {
        type: { const: "fileRef" },
        path: { type: "string", maxLength: VIEW_SPEC_LIMITS.MAX_PATH_LENGTH },
        relPath: { type: "string", maxLength: VIEW_SPEC_LIMITS.MAX_REL_PATH_LENGTH },
        label: { type: "string", maxLength: VIEW_SPEC_LIMITS.MAX_FILE_REF_LABEL_LENGTH }
      }
    }
  }
};

let schemaRegistered = false;
export function ensureSchemaRegistered() {
  if (!schemaRegistered) {
    try {
      registerSchema(VIEW_SCHEMA, SCHEMA_URI);
    } catch {
      // already registered
    }
    schemaRegistered = true;
  }
}

export function maxDepth(value) {
  if (value === null || typeof value !== "object") {
    return 1;
  }
  let max = 1;
  const stack = [[value, 1]];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (!entry) continue;
    const [curr, depth] = entry;
    if (depth > max) {
      max = depth;
    }
    if (curr !== null && typeof curr === "object") {
      if (Array.isArray(curr)) {
        for (let i = 0; i < curr.length; i++) {
          stack.push([curr[i], depth + 1]);
        }
      } else {
        const keys = Object.keys(curr);
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i];
          if (k !== undefined) {
            stack.push([curr[k], depth + 1]);
          }
        }
      }
    }
  }
  return max;
}

export function countNodes(spec) {
  if (!spec || typeof spec !== "object" || !Array.isArray(spec.body)) {
    return 0;
  }
  let total = 0;
  const stack = [...spec.body];

  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;

    total++;

    const type = node.type;
    if (type === "table") {
      const cols = Array.isArray(node.columns) ? node.columns.length : 0;
      const rows = Array.isArray(node.rows) ? node.rows.length : 0;
      total += cols * rows;
    } else if (type === "chart") {
      const xLen = Array.isArray(node.x) ? node.x.length : 0;
      const seriesLen = Array.isArray(node.series) ? node.series.length : 0;
      total += xLen * seriesLen;
    } else if (type === "tree") {
      if (Array.isArray(node.nodes)) {
        const treeStack = [...node.nodes];
        while (treeStack.length > 0) {
          const entry = treeStack.pop();
          if (entry && typeof entry === "object") {
            total++;
            if (Array.isArray(entry.children)) {
              for (let i = 0; i < entry.children.length; i++) {
                treeStack.push(entry.children[i]);
              }
            }
          }
        }
      }
    } else if (type === "list") {
      if (Array.isArray(node.items)) {
        total += node.items.length;
        for (let i = 0; i < node.items.length; i++) {
          const item = node.items[i];
          if (item && typeof item === "object" && typeof item.type === "string") {
            stack.push(item);
          }
        }
      }
    } else if (type === "section") {
      if (Array.isArray(node.children)) {
        for (let i = 0; i < node.children.length; i++) {
          stack.push(node.children[i]);
        }
      }
    } else if (type === "columns") {
      if (Array.isArray(node.columns)) {
        for (let i = 0; i < node.columns.length; i++) {
          const col = node.columns[i];
          if (Array.isArray(col)) {
            for (let j = 0; j < col.length; j++) {
              stack.push(col[j]);
            }
          }
        }
      }
    }
  }

  return total;
}

function isAbsolutePath(p) {
  if (typeof p !== "string") return false;
  if (p.startsWith("/")) return true;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  return false;
}

function isValidRelPath(relPath) {
  if (typeof relPath !== "string") return false;
  if (/^[A-Za-z]:/.test(relPath)) return false;
  if (relPath.startsWith("/") || relPath.startsWith("\\")) return false;
  const segments = relPath.split(/[\\/]/);
  if (segments.includes("..")) return false;
  return true;
}

function mapKeywordToMessage(keyword, path) {
  switch (keyword) {
    case "maxLength":
      return "too long";
    case "minLength":
      return "too short";
    case "additionalProperties":
      return "unknown field";
    case "type":
      return "wrong type";
    case "required":
      return "required field missing";
    case "oneOf":
      return "not one of the allowed node types";
    case "minItems":
      return "too few items";
    case "maxItems":
      return "too many items";
    case "minimum":
      return "value too small";
    case "maximum":
      return "value too large";
    case "pattern":
      return "pattern mismatch";
    case "enum":
    case "const":
      return "invalid value";
    default:
      return keyword ? `validation failed (${keyword})` : "validation failed";
  }
}

function countTreeNodesTotal(nodes) {
  if (!Array.isArray(nodes)) return 0;
  let count = 0;
  const stack = [...nodes];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry && typeof entry === "object") {
      count++;
      if (Array.isArray(entry.children)) {
        for (let i = 0; i < entry.children.length; i++) {
          stack.push(entry.children[i]);
        }
      }
    }
  }
  return count;
}

function runSemanticChecks(spec, errors) {
  const columnKeyPattern = /^[A-Za-z0-9_.-]{1,64}$/;

  function checkNode(node, nodePath) {
    if (!node || typeof node !== "object" || errors.length >= 100) return;

    const type = node.type;

    if (type === "table") {
      const declaredKeys = new Set();
      if (Array.isArray(node.columns)) {
        for (let c = 0; c < node.columns.length; c++) {
          if (errors.length >= 100) break;
          const col = node.columns[c];
          if (!col || typeof col !== "object") continue;
          if (typeof col.key === "string") {
            if (!columnKeyPattern.test(col.key)) {
              errors.push({
                code: "schema",
                path: `${nodePath}/columns/${c}/key`,
                message: "Column key does not match required pattern"
              });
            }
            if (declaredKeys.has(col.key)) {
              errors.push({
                code: "schema",
                path: `${nodePath}/columns/${c}/key`,
                message: `Duplicate column key '${col.key}'`
              });
            } else {
              declaredKeys.add(col.key);
            }
          }
        }
      }

      if (Array.isArray(node.rows)) {
        for (let r = 0; r < node.rows.length; r++) {
          if (errors.length >= 100) break;
          const row = node.rows[r];
          if (!row || typeof row !== "object") continue;
          const rowKeys = Object.keys(row);
          for (let k = 0; k < rowKeys.length; k++) {
            if (errors.length >= 100) break;
            const key = rowKeys[k];
            if (key !== undefined && !declaredKeys.has(key)) {
              errors.push({
                code: "schema",
                path: `${nodePath}/rows/${r}/${key}`,
                message: `Row key '${key}' is not a declared column key`
              });
            }
          }
        }
      }
    } else if (type === "chart") {
      const xLen = Array.isArray(node.x) ? node.x.length : 0;
      if (Array.isArray(node.series)) {
        for (let s = 0; s < node.series.length; s++) {
          if (errors.length >= 100) break;
          const ser = node.series[s];
          if (!ser || typeof ser !== "object") continue;
          if (Array.isArray(ser.values)) {
            if (ser.values.length !== xLen) {
              errors.push({
                code: "schema",
                path: `${nodePath}/series/${s}/values`,
                message: `Series values length (${ser.values.length}) does not match x length (${xLen})`
              });
            }
            for (let v = 0; v < ser.values.length; v++) {
              if (errors.length >= 100) break;
              if (typeof ser.values[v] === "number" && !Number.isFinite(ser.values[v])) {
                errors.push({
                  code: "schema",
                  path: `${nodePath}/series/${s}/values/${v}`,
                  message: "Chart value must be a finite number"
                });
              }
            }
          }
        }
      }
    } else if (type === "code") {
      if (Array.isArray(node.highlightLines)) {
        for (let h = 0; h < node.highlightLines.length; h++) {
          if (errors.length >= 100) break;
          const pair = node.highlightLines[h];
          if (Array.isArray(pair) && pair.length === 2) {
            const [from, to] = pair;
            if (typeof from === "number" && typeof to === "number" && from > to) {
              errors.push({
                code: "schema",
                path: `${nodePath}/highlightLines/${h}`,
                message: `highlightLines range from (${from}) must be <= to (${to})`
              });
            }
          }
        }
      }
    } else if (type === "image" || type === "fileRef") {
      if (typeof node.path === "string" && !isAbsolutePath(node.path)) {
        errors.push({
          code: "bad_path",
          path: `${nodePath}/path`,
          message: "Path must be absolute"
        });
      }
      if (node.relPath !== undefined && !isValidRelPath(node.relPath)) {
        errors.push({
          code: "bad_path",
          path: `${nodePath}/relPath`,
          message: "relPath must be relative with no drive letter, no leading slash, and no '..' segment"
        });
      }
    } else if (type === "tree") {
      const treeCount = countTreeNodesTotal(node.nodes);
      if (treeCount > VIEW_SPEC_LIMITS.MAX_TREE_ENTRIES) {
        errors.push({
          code: "schema",
          path: `${nodePath}/nodes`,
          message: `Tree entries count (${treeCount}) exceeds maximum of ${VIEW_SPEC_LIMITS.MAX_TREE_ENTRIES}`
        });
      }
    } else if (type === "section") {
      if (Array.isArray(node.children)) {
        for (let i = 0; i < node.children.length; i++) {
          checkNode(node.children[i], `${nodePath}/children/${i}`);
        }
      }
    } else if (type === "columns") {
      if (Array.isArray(node.columns)) {
        for (let c = 0; c < node.columns.length; c++) {
          const col = node.columns[c];
          if (Array.isArray(col)) {
            for (let i = 0; i < col.length; i++) {
              checkNode(col[i], `${nodePath}/columns/${c}/${i}`);
            }
          }
        }
      }
    } else if (type === "list") {
      if (Array.isArray(node.items)) {
        for (let i = 0; i < node.items.length; i++) {
          const item = node.items[i];
          if (item && typeof item === "object" && typeof item.type === "string") {
            checkNode(item, `${nodePath}/items/${i}`);
          }
        }
      }
    }
  }

  if (Array.isArray(spec.body)) {
    for (let i = 0; i < spec.body.length; i++) {
      checkNode(spec.body[i], `/body/${i}`);
    }
  }
}

export async function validateViewSpec(input) {
  if (typeof input === "string") {
    const byteLength = new TextEncoder().encode(input).byteLength;
    if (byteLength > VIEW_SPEC_LIMITS.MAX_FILE_BYTES) {
      return {
        ok: false,
        errors: [{ code: "too_large", path: "", message: `File size exceeds limit (${byteLength} > ${VIEW_SPEC_LIMITS.MAX_FILE_BYTES})` }]
      };
    }
  }

  let parsed;
  if (typeof input === "string") {
    try {
      parsed = JSON.parse(input);
    } catch (err) {
      return {
        ok: false,
        errors: [{ code: "invalid_json", path: "", message: err instanceof Error ? err.message : "Invalid JSON" }]
      };
    }
  } else {
    parsed = input;
  }

  const depth = maxDepth(parsed);
  if (depth > VIEW_SPEC_LIMITS.MAX_DEPTH) {
    return {
      ok: false,
      errors: [{ code: "too_deep", path: "", message: `Nesting depth ${depth} exceeds limit ${VIEW_SPEC_LIMITS.MAX_DEPTH}` }]
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.uniview !== "view/1") {
    return {
      ok: false,
      errors: [{ code: "unsupported_version", path: "/uniview", message: "Missing or unsupported uniview version (expected 'view/1')" }]
    };
  }

  const nodes = countNodes(parsed);
  if (nodes > VIEW_SPEC_LIMITS.MAX_NODES) {
    return {
      ok: false,
      errors: [{ code: "too_many_nodes", path: "", message: `Node count ${nodes} exceeds limit ${VIEW_SPEC_LIMITS.MAX_NODES}` }]
    };
  }

  const errors = [];
  ensureSchemaRegistered();
  const schemaResult = await validate(SCHEMA_URI, parsed, BASIC);

  if (!schemaResult.valid && Array.isArray(schemaResult.errors)) {
    for (const err of schemaResult.errors) {
      if (errors.length >= 100) break;
      const path = (err.instanceLocation || "").replace(/^#/, "");
      errors.push({
        code: "schema",
        path,
        message: mapKeywordToMessage(err.keyword, path)
      });
    }
  }

  if (errors.length < 100) {
    runSemanticChecks(parsed, errors);
  }

  if (errors.length > 0) {
    return {
      ok: false,
      errors: errors.slice(0, 100)
    };
  }

  return {
    ok: true,
    spec: parsed
  };
}
