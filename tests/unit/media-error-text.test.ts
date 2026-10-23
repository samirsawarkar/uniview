import { describe, expect, it } from "vitest";
import { mediaErrorText } from "../../src/viewers/MediaViewer";

describe("mediaErrorText", () => {
  it("handles code 1 (aborted)", () => {
    expect(mediaErrorText(1)).toEqual({
      message: "Playback was stopped.",
      decoderNote: false,
    });
  });

  it("handles code 2 (network / read failure)", () => {
    expect(mediaErrorText(2)).toEqual({
      message: "Reading the file failed. If it is on another computer, it may no longer be shared or the computer may be off.",
      decoderNote: false,
    });
  });

  it("handles code 3 (decode failure) with decoder note", () => {
    expect(mediaErrorText(3)).toEqual({
      message: "This file is damaged or uses an encoding this device cannot decode.",
      decoderNote: true,
    });
  });

  it("handles code 4 (format not supported) with decoder note", () => {
    expect(mediaErrorText(4)).toEqual({
      message: "This device has no decoder for this format or codec.",
      decoderNote: true,
    });
  });
});
