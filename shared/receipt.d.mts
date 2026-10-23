export type FileState =
  | "unchanged"
  | "changed"
  | "replaced"
  | "missing"
  | "unreadable"
  | "too_large";

export type ReceiptFileRole = "created" | "modified" | "input";

export interface ReceiptFile {
  path: string;
  relPath?: string;
  sha256: string;
  role: ReceiptFileRole;
}

export type ReceiptCheckStatus = "pass" | "fail" | "skip";

export interface ReceiptCheck {
  name: string;
  status: ReceiptCheckStatus;
  evidence?: string;
}

export interface ReceiptSource {
  title: string;
  ref: string;
}

export interface ReceiptAgent {
  name: string;
  model?: string;
  run?: string;
}

export interface Receipt {
  uniview: "receipt/1";
  createdAt: string;
  agent: ReceiptAgent;
  task: string;
  summary: string;
  files: ReceiptFile[];
  checks?: ReceiptCheck[];
  sources?: ReceiptSource[];
  view?: string;
  viewRelPath?: string;
}

export interface DecisionFile {
  path: string;
  expectedSha256: string;
  observedSha256: string | null;
  state: FileState;
}

export type DecisionChoice = "approved" | "changes_requested" | "dismissed";

export interface Decision {
  uniview: "decision/1";
  reviewId: string;
  receiptDigest: string;
  decision: DecisionChoice;
  comment: string;
  decidedAt: string;
  verifiedAt: string;
  persisted: boolean;
  files: DecisionFile[];
}

export type ReceiptErrorCode =
  | "too_large"
  | "invalid_json"
  | "too_deep"
  | "unsupported_version"
  | "schema"
  | "bad_path";

export interface ReceiptValidationError {
  code: ReceiptErrorCode;
  path: string;
  message: string;
}

export interface ReceiptValidationSuccess {
  ok: true;
  receipt: Receipt;
}

export interface DecisionValidationSuccess {
  ok: true;
  decision: Decision;
}

export interface ValidationFailure {
  ok: false;
  errors: ReceiptValidationError[];
}

export type ReceiptValidationResult = ReceiptValidationSuccess | ValidationFailure;
export type DecisionValidationResult = DecisionValidationSuccess | ValidationFailure;

export declare const RECEIPT_LIMITS: {
  readonly MAX_FILE_BYTES: number;
  readonly MAX_DEPTH: number;
  readonly MAX_ERRORS: number;
  readonly MAX_AGENT_NAME_LENGTH: number;
  readonly MAX_AGENT_MODEL_LENGTH: number;
  readonly MAX_AGENT_RUN_LENGTH: number;
  readonly MAX_TASK_BYTES: number;
  readonly MAX_SUMMARY_BYTES: number;
  readonly MIN_FILES: number;
  readonly MAX_FILES: number;
  readonly MAX_PATH_LENGTH: number;
  readonly MAX_REL_PATH_LENGTH: number;
  readonly MAX_CHECKS: number;
  readonly MAX_CHECK_NAME_LENGTH: number;
  readonly MAX_CHECK_EVIDENCE_BYTES: number;
  readonly MAX_SOURCES: number;
  readonly MAX_SOURCE_TITLE_LENGTH: number;
  readonly MAX_SOURCE_REF_BYTES: number;
  readonly MAX_VIEW_LENGTH: number;
  readonly MAX_VIEW_REL_PATH_LENGTH: number;
  readonly MAX_DECISION_COMMENT_BYTES: number;
};

export declare function validateReceipt(input: string | unknown): Promise<ReceiptValidationResult>;
export declare function validateDecision(value: string | unknown): Promise<DecisionValidationResult>;
export declare function sha256Hex(bytes: Uint8Array): Promise<string>;
export declare function receiptDigest(bytes: Uint8Array): Promise<string>;
export declare function fileState(
  expected: string,
  observed: string | null,
  opts?: { replaced?: boolean; missing?: boolean; unreadable?: boolean; tooLarge?: boolean }
): FileState;
export declare function canDecide(
  shown: Array<{ state: FileState; observedSha256: string | null; path?: string }>,
  current: Array<{ state: FileState; observedSha256: string | null; path?: string }>
): boolean;
