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
  writeRebuildMarker,
  readFreshRebuildMarker,
  clearRebuildMarker,
} from "../../src/workflows/rebuildRequest";

/** Fresh temp dir standing in for a workspace folder (host or container side). */
async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "rebuildRequest-test-"));
}

function markerFile(dir: string): string {
  return path.join(dir, MARKER_REL_PATH);
}

describe("MARKER_REL_PATH", () => {
  it("lives under .devcontainer so the bind mount relays it to the host", () => {
    expect(MARKER_REL_PATH).toBe(".devcontainer/.jvp-rebuild-request.json");
  });
});

describe("writeRebuildMarker + readFreshRebuildMarker", () => {
  it("writes a payload that reads back fresh", async () => {
    const tmp = await makeTmpDir();
    await writeRebuildMarker({ fsPath: tmp }, { noCache: false });
    const payload = await readFreshRebuildMarker({ fsPath: tmp });
    expect(payload).not.toBeNull();
    expect(payload?.noCache).toBe(false);
    expect(typeof payload?.requestedAt).toBe("string");
    expect(Number.isFinite(Date.parse(payload?.requestedAt ?? ""))).toBe(true);
  });

  it("round-trips the noCache flag", async () => {
    const tmp = await makeTmpDir();
    await writeRebuildMarker({ fsPath: tmp }, { noCache: true });
    const payload = await readFreshRebuildMarker({ fsPath: tmp });
    expect(payload?.noCache).toBe(true);
  });

  it("returns null for an expired (older than TTL) marker", async () => {
    const tmp = await makeTmpDir();
    await writeRebuildMarker({ fsPath: tmp }, { noCache: false });
    const stale = {
      requestedAt: new Date(Date.now() - 11 * 60_000).toISOString(),
      noCache: false,
    };
    await fs.writeFile(markerFile(tmp), JSON.stringify(stale), "utf8");
    expect(await readFreshRebuildMarker({ fsPath: tmp })).toBeNull();
  });

  it("honors a custom ttlMs", async () => {
    const tmp = await makeTmpDir();
    await writeRebuildMarker({ fsPath: tmp }, { noCache: true });
    const almostStale = {
      requestedAt: new Date(Date.now() - 2_000).toISOString(),
      noCache: true,
    };
    await fs.writeFile(markerFile(tmp), JSON.stringify(almostStale), "utf8");
    expect(await readFreshRebuildMarker({ fsPath: tmp }, 1_000)).toBeNull();
    expect(
      await readFreshRebuildMarker({ fsPath: tmp }, 60_000),
    ).not.toBeNull();
  });

  it("returns null for unparsable JSON (treated as absent)", async () => {
    const tmp = await makeTmpDir();
    await fs.mkdir(path.dirname(markerFile(tmp)), { recursive: true });
    await fs.writeFile(markerFile(tmp), "{not json at all", "utf8");
    expect(await readFreshRebuildMarker({ fsPath: tmp })).toBeNull();
  });

  it("returns null for a marker with a bogus requestedAt", async () => {
    const tmp = await makeTmpDir();
    await fs.mkdir(path.dirname(markerFile(tmp)), { recursive: true });
    await fs.writeFile(
      markerFile(tmp),
      JSON.stringify({ requestedAt: "not-a-date", noCache: false }),
      "utf8",
    );
    expect(await readFreshRebuildMarker({ fsPath: tmp })).toBeNull();
  });

  it("returns null when no marker exists", async () => {
    const tmp = await makeTmpDir();
    expect(await readFreshRebuildMarker({ fsPath: tmp })).toBeNull();
  });
});

describe("clearRebuildMarker", () => {
  it("removes the marker so a subsequent read returns null", async () => {
    const tmp = await makeTmpDir();
    await writeRebuildMarker({ fsPath: tmp }, { noCache: false });
    expect(await readFreshRebuildMarker({ fsPath: tmp })).not.toBeNull();
    await clearRebuildMarker({ fsPath: tmp });
    expect(await readFreshRebuildMarker({ fsPath: tmp })).toBeNull();
    await expect(fs.access(markerFile(tmp))).rejects.toThrow();
  });

  it("does not throw when no marker exists", async () => {
    const tmp = await makeTmpDir();
    await expect(clearRebuildMarker({ fsPath: tmp })).resolves.toBeUndefined();
  });
});
