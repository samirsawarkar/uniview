import { computeLineDiff } from "./viewspec-diff";

self.onmessage = (
  e: MessageEvent<{
    id: number;
    before: string;
    after: string;
    opts: { timeoutMs: number; maxLines?: number };
  }>
) => {
  const { id, before, after, opts } = e.data;
  try {
    const result = computeLineDiff(before, after, opts);
    self.postMessage({ id, result });
  } catch {
    self.postMessage({ id, result: { kind: "too_big" } });
  }
};
