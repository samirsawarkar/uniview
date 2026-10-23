import { describe, expect, it } from "vitest";
import { shouldRetryAfterTransportError } from "../../shared/remote-client.mjs";

describe("shouldRetryAfterTransportError", () => {
  it("returns true for fast failures under 2000 ms", () => {
    expect(shouldRetryAfterTransportError(500)).toBe(true);
    expect(shouldRetryAfterTransportError(1999)).toBe(true);
  });

  it("returns false for slow failures at or above 2000 ms", () => {
    expect(shouldRetryAfterTransportError(2000)).toBe(false);
    expect(shouldRetryAfterTransportError(8000)).toBe(false);
  });
});
