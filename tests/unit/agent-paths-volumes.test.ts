import { describe, expect, it, vi } from "vitest";
// @ts-expect-error plain ESM module without types
import { createLocalVolumeClassifier, openAgentPath } from "../../electron/lib/agent-paths.mjs";

describe("createLocalVolumeClassifier - per-volume exclusion (P22)", () => {
  it("one failing local drive does not affect the others", async () => {
    // Catches mutation: failing closed for all drives when a single local volume statDev fails (one bad volume disables all)
    let statDevCalls: string[] = [];
    const listDrives = async () => [
      { letter: "C", driveType: 3 },
      { letter: "G", driveType: 3 },
    ];

    const statDev = async (drivePath: string) => {
      statDevCalls.push(drivePath);
      if (drivePath === "C:\\") {
        return 10n;
      }
      if (drivePath === "G:\\") {
        throw new Error("Device not ready / unreadable volume");
      }
      return 99n;
    };

    const classifier = createLocalVolumeClassifier({
      listDrives,
      statDev,
      ttlMs: 60_000,
      timeoutMs: 3000,
    });

    // C: is valid and statDev succeeded -> 10n is local
    expect(await classifier(10n)).toBe(true);
    expect(statDevCalls).toContain("C:\\");
    expect(statDevCalls).toContain("G:\\");
  });

  it("the failing drive's files are rejected", async () => {
    // Catches mutation: failing open or accepting handles from excluded/un-stat'able volumes
    const listDrives = async () => [
      { letter: "C", driveType: 3 },
      { letter: "G", driveType: 3 },
    ];

    const statDev = async (drivePath: string) => {
      if (drivePath === "C:\\") return 10n;
      throw new Error("G: drive unreadable");
    };

    const classifier = createLocalVolumeClassifier({
      listDrives,
      statDev,
      ttlMs: 60_000,
      timeoutMs: 3000,
    });

    // 20n represents a device on G:, which was excluded because statDev failed
    expect(await classifier(20n)).toBe(false);

    // Verify through openAgentPath that a handle with dev 20n is rejected as network_drive
    let handleClosed = false;
    const fakeHandle = {
      close: async () => {
        handleClosed = true;
      },
      stat: async () => ({
        isFile: () => true,
        size: 512n,
        dev: 20n,
        ino: 101n,
      }),
    };

    const fakeFs = {
      open: async () => fakeHandle,
      realpath: {
        native: async () => "G:\\data\\report.pdf",
      },
    };

    const res = await openAgentPath("G:\\data\\report.pdf", {
      platform: "win32",
      fs: fakeFs,
      classifyDrive: async () => "allowed",
      isLocalDev: classifier,
    });

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("network_drive");
    }
    expect(handleClosed).toBe(true);
  });

  it("listDrives timeout still rejects all", async () => {
    // Catches mutation: failing open or not rejecting all devices when listDrives hangs/times out
    vi.useFakeTimers();
    try {
      const neverResolvingListDrives = () => new Promise<any>(() => {});
      const classifier = createLocalVolumeClassifier({
        listDrives: neverResolvingListDrives,
        statDev: async () => 10n,
        timeoutMs: 1000,
      });

      const checkPromise = classifier(10n);
      await vi.advanceTimersByTimeAsync(1100);
      const res = await checkPromise;
      expect(res).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("all drives failing rejects all", async () => {
    // Catches mutation: returning ok: true or allowing access when all local drives fail statDev (empty usable set)
    const listDrives = async () => [
      { letter: "C", driveType: 3 },
      { letter: "D", driveType: 2 },
    ];

    const statDev = async (drivePath: string) => {
      throw new Error(`statDev failed on ${drivePath}`);
    };

    const classifier = createLocalVolumeClassifier({
      listDrives,
      statDev,
      ttlMs: 60_000,
      timeoutMs: 3000,
    });

    // When all local drives fail, the usable local set is empty and fails closed for everything
    expect(await classifier(10n)).toBe(false);
    expect(await classifier(20n)).toBe(false);
    expect(await classifier(0n)).toBe(false);
  });

  it("network drive with same serial scenario documented as accepted residual risk", async () => {
    // Catches mutation: including DriveType 4 (network) in statDev/localDevs, or not matching handle dev strictly against stat'ed local roots
    // Residual risk (Phase 1 spec, Codex review 14): Node cannot inspect remote protocol info on handle,
    // so handle dev matching local volume dev is accepted even if forged by remote SMB.
    let statDevCalls: string[] = [];
    const listDrives = async () => [
      { letter: "C", driveType: 3 },
      { letter: "Z", driveType: 4 }, // Network share
      { letter: "E", driveType: 5 }, // Optical drive
      { letter: "R", driveType: 6 }, // RAM disk / unknown
    ];

    const statDev = async (drivePath: string) => {
      statDevCalls.push(drivePath);
      if (drivePath === "C:\\") return 10n;
      return 99n;
    };

    const classifier = createLocalVolumeClassifier({
      listDrives,
      statDev,
      ttlMs: 60_000,
      timeoutMs: 3000,
    });

    // 1. Types 4, 5, 6 are not local volumes and statDev must never be called for them
    expect(await classifier(10n)).toBe(true);
    expect(statDevCalls).toEqual(["C:\\"]);

    // 2. An un-stat'ed remote dev 99n is rejected
    expect(await classifier(99n)).toBe(false);

    // 3. Accepted residual risk: if an attacker on SMB share Z: forged volume serial 10n,
    // the classifier strictly checks the device ID set, so 10n matches the stat'ed local C: volume.
    // This is the accepted residual risk documented in phase-1-agent-workspace.md item 3.
    expect(await classifier(10n)).toBe(true);
  });

  it("a drive that starts failing after a successful refresh is excluded at the next refresh (ttl) and a recovered drive is included", async () => {
    // Catches mutation: not re-evaluating volume health across TTL refreshes (failing drive remains included or recovered drive remains excluded)
    let fakeNow = 1000;
    const now = () => fakeNow;

    let driveGFails = false;

    const listDrives = async () => [
      { letter: "C", driveType: 3 },
      { letter: "G", driveType: 3 },
    ];

    const statDev = async (drivePath: string) => {
      if (drivePath === "C:\\") return 10n;
      if (drivePath === "G:\\") {
        if (driveGFails) throw new Error("G: drive unreadable");
        return 20n;
      }
      return 99n;
    };

    const classifier = createLocalVolumeClassifier({
      listDrives,
      statDev,
      now,
      ttlMs: 60_000,
      timeoutMs: 3000,
    });

    // Phase 1: both drives healthy
    expect(await classifier(10n)).toBe(true);
    expect(await classifier(20n)).toBe(true);

    // Within TTL (30s): cache is still valid even if drive G fails in the background
    fakeNow += 30_000;
    driveGFails = true;
    expect(await classifier(20n)).toBe(true);

    // Refresh after TTL (61s total): drive G fails statDev and is now excluded
    fakeNow += 31_001;
    expect(await classifier(10n)).toBe(true);
    expect(await classifier(20n)).toBe(false);

    // Drive G recovers
    driveGFails = false;

    // Within TTL: G is still excluded because cache is valid
    fakeNow += 30_000;
    expect(await classifier(20n)).toBe(false);

    // Refresh after TTL: G recovers and is included again
    fakeNow += 31_001;
    expect(await classifier(10n)).toBe(true);
    expect(await classifier(20n)).toBe(true);
  });
});
