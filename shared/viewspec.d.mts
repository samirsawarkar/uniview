export interface ViewSpecLimits {
  readonly MAX_FILE_BYTES: number;
  readonly MAX_DEPTH: number;
  readonly MAX_NODES: number;
  readonly MAX_TITLE_LENGTH: number;
  readonly MAX_AGENT_NAME_LENGTH: number;
  readonly MAX_AGENT_MODEL_LENGTH: number;
  readonly MAX_HEADING_TEXT_LENGTH: number;
  readonly MIN_HEADING_LEVEL: number;
  readonly MAX_HEADING_LEVEL: number;
  readonly MAX_MARKDOWN_LENGTH: number;
  readonly MAX_CALLOUT_TITLE_LENGTH: number;
  readonly MIN_KEY_VALUE_ITEMS: number;
  readonly MAX_KEY_VALUE_ITEMS: number;
  readonly MAX_KEY_VALUE_KEY_LENGTH: number;
  readonly MAX_KEY_VALUE_VALUE_LENGTH: number;
  readonly MIN_TABLE_COLUMNS: number;
  readonly MAX_TABLE_COLUMNS: number;
  readonly MAX_TABLE_ROWS: number;
  readonly MAX_TABLE_CELL_LENGTH: number;
  readonly MAX_TABLE_COLUMN_KEY_LENGTH: number;
  readonly MIN_LIST_ITEMS: number;
  readonly MAX_LIST_ITEMS: number;
  readonly MAX_TREE_ENTRIES: number;
  readonly MAX_TREE_LABEL_LENGTH: number;
  readonly MAX_TREE_DETAIL_LENGTH: number;
  readonly MAX_CODE_LENGTH: number;
  readonly MAX_DIFF_LENGTH: number;
  readonly MAX_DIFF_LINES: number;
  readonly MAX_IMAGE_ALT_LENGTH: number;
  readonly MAX_IMAGE_CAPTION_LENGTH: number;
  readonly MAX_PATH_LENGTH: number;
  readonly MAX_REL_PATH_LENGTH: number;
  readonly MAX_FILE_REF_LABEL_LENGTH: number;
  readonly MIN_CHART_X: number;
  readonly MAX_CHART_X: number;
  readonly MIN_CHART_SERIES: number;
  readonly MAX_CHART_SERIES: number;
  readonly MIN_COLUMNS: number;
  readonly MAX_COLUMNS: number;
}

export declare const VIEW_SPEC_LIMITS: ViewSpecLimits;
export declare const SCHEMA_URI: string;
export declare const VIEW_SCHEMA: Record<string, unknown>;

export interface HeadingNode {
  type: "heading";
  text: string;
  level?: 1 | 2 | 3 | 4;
}

export interface MarkdownNode {
  type: "markdown";
  text: string;
}

export interface CalloutNode {
  type: "callout";
  tone: "info" | "success" | "warning" | "danger";
  text: string;
  title?: string;
}

export interface KeyValueItem {
  key: string;
  value: string;
}

export interface KeyValueNode {
  type: "keyValue";
  items: KeyValueItem[];
}

export interface TableColumn {
  key: string;
  label: string;
  align?: "left" | "right" | "center";
}

export interface TableNode {
  type: "table";
  columns: TableColumn[];
  rows?: Record<string, string | number | boolean | null>[];
}

export interface ListNode {
  type: "list";
  ordered?: boolean;
  items: (string | ViewNode)[];
}

export interface TreeEntry {
  label: string;
  detail?: string;
  children?: TreeEntry[];
}

export interface TreeNode {
  type: "tree";
  nodes: TreeEntry[];
}

export interface CodeNode {
  type: "code";
  text: string;
  language?: string;
  highlightLines?: [number, number][];
}

export interface DiffUnifiedNode {
  type: "diff";
  title?: string;
  language?: string;
  unified: string;
}

export interface DiffSplitNode {
  type: "diff";
  title?: string;
  language?: string;
  before: string;
  after: string;
}

export type DiffNode = DiffUnifiedNode | DiffSplitNode;

export interface ImageNode {
  type: "image";
  path: string;
  relPath?: string;
  alt: string;
  caption?: string;
}

export interface ChartSeries {
  name: string;
  values: number[];
}

export interface ChartNode {
  type: "chart";
  kind: "bar" | "line";
  x: string[];
  series: ChartSeries[];
}

export interface SectionNode {
  type: "section";
  title?: string;
  collapsed?: boolean;
  children: ViewNode[];
}

export interface ColumnsNode {
  type: "columns";
  columns: ViewNode[][];
}

export interface FileRefNode {
  type: "fileRef";
  path: string;
  relPath?: string;
  label?: string;
}

export type ViewNode =
  | HeadingNode
  | MarkdownNode
  | CalloutNode
  | KeyValueNode
  | TableNode
  | ListNode
  | TreeNode
  | CodeNode
  | DiffNode
  | ImageNode
  | ChartNode
  | SectionNode
  | ColumnsNode
  | FileRefNode;

export interface ViewAgent {
  name: string;
  model?: string;
}

export interface ViewSpec {
  uniview: "view/1";
  title: string;
  agent?: ViewAgent;
  body: ViewNode[];
}

export interface ValidationError {
  code: string;
  path: string;
  message: string;
}

export type ValidationResult =
  | { ok: true; spec: ViewSpec }
  | { ok: false; errors: ValidationError[] };

export declare function maxDepth(value: unknown): number;
export declare function countNodes(spec: unknown): number;
export declare function ensureSchemaRegistered(): void;
export declare function validateViewSpec(input: string | unknown): Promise<ValidationResult>;
