/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/utils/logger", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import {
  MARKER_REL_PATH,
  writePendingOpen,
  readFreshPendingOpen,
  clearPendingOpen,
} from "../../src/workflows/pendingRemoteOpen";

/** Fresh temp dir standing in for a workspace folder (host side). */
async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "pendingRemoteOpen-test-"));
}

function markerFile(dir: string): string {
  return path.join(dir, MARKER_REL_PATH);
}

describe("MARKER_REL_PATH", () => {
  it("lives under .devcontainer, distinct from the rebuild-request marker", () => {
    expect(MARKER_REL_PATH).toBe(".devcontainer/.jvp-pending-remote-open.json");
  });
});

describe("writePendingOpen + readFreshPendingOpen", () => {
  it("writes a payload that reads back fresh", async () => {
    const tmp = await makeTmpDir();
    await writePendingOpen({ fsPath: tmp }, { authority: "artizo-container+ab", attempt: 1 });
    const payload = await readFreshPendingOpen({ fsPath: tmp });
    expect(payload).not.toBeNull();
    expect(payload?.authority).toBe("artizo-container+ab");
    expect(payload?.attempt).toBe(1);
    expect(typeof payload?.issuedAt).toBe("string");
    expect(Number.isFinite(Date.parse(payload?.issuedAt ?? ""))).toBe(true);
  });

  it("round-trips the attempt field (watchdog cap arithmetic depends on it)", async () => {
    const tmp = await makeTmpDir();
    await writePendingOpen({ fsPath: tmp }, { authority: "x", attempt: 2 });
    const payload = await readFreshPendingOpen({ fsPath: tmp });
    expect(payload?.attempt).toBe(2);
  });

  it("returns null for an expired (older than TTL) marker", async () => {
    const tmp = await makeTmpDir();
    await writePendingOpen({ fsPath: tmp }, { authority: "x", attempt: 1 });
    const stale = {
      issuedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
      authority: "x",
      attempt: 1,
    };
    await fs.writeFile(markerFile(tmp), JSON.stringify(stale), "utf8");
    expect(await readFreshPendingOpen({ fsPath: tmp })).toBeNull();
  });

  it("honors a custom ttlMs", async () => {
    const tmp = await makeTmpDir();
    await writePendingOpen({ fsPath: tmp }, { authority: "x", attempt: 1 });
    const almostStale = {
      issuedAt: new Date(Date.now() - 2_000).toISOString(),
      authority: "x",
      attempt: 1,
    };
    await fs.writeFile(markerFile(tmp), JSON.stringify(almostStale), "utf8");
    expect(await readFreshPendingOpen({ fsPath: tmp }, 1_000)).toBeNull();
    expect(
      await readFreshPendingOpen({ fsPath: tmp }, 60_000),
    ).not.toBeNull();
  });

  it("returns null for unparsable JSON (treated as absent)", async () => {
    const tmp = await makeTmpDir();
    await fs.mkdir(path.dirname(markerFile(tmp)), { recursive: true });
    await fs.writeFile(markerFile(tmp), "{not json at all", "utf8");
    expect(await readFreshPendingOpen({ fsPath: tmp })).toBeNull();
  });

  it("returns null for a wrong-shape payload (treated as absent)", async () => {
    const tmp = await makeTmpDir();
    await fs.mkdir(path.dirname(markerFile(tmp)), { recursive: true });
    await fs.writeFile(
      markerFile(tmp),
      JSON.stringify({ issuedAt: "not-a-date", authority: 42, attempt: "one" }),
      "utf8",
    );
    expect(await readFreshPendingOpen({ fsPath: tmp })).toBeNull();
  });

  it("returns null when no marker exists", async () => {
    const tmp = await makeTmpDir();
    expect(await readFreshPendingOpen({ fsPath: tmp })).toBeNull();
  });
});

describe("clearPendingOpen", () => {
  it("removes the marker so a subsequent read returns null", async () => {
    const tmp = await makeTmpDir();
    await writePendingOpen({ fsPath: tmp }, { authority: "x", attempt: 1 });
    expect(await readFreshPendingOpen({ fsPath: tmp })).not.toBeNull();
    await clearPendingOpen({ fsPath: tmp });
    expect(await readFreshPendingOpen({ fsPath: tmp })).toBeNull();
    await expect(fs.access(markerFile(tmp))).rejects.toThrow();
  });

  it("does not throw when no marker exists", async () => {
    const tmp = await makeTmpDir();
    await expect(clearPendingOpen({ fsPath: tmp })).resolves.toBeUndefined();
  });
});
