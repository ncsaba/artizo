/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import vscodeMock from "../__mocks__/vscode";

vi.mock("vscode", () => ({ default: vscodeMock, ...vscodeMock }));

vi.mock("../../src/utils/logger", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import {
  buildAuthorityAndOpen,
  __setPendingOpenSchedulerForTests,
  PENDING_OPEN_WATCHDOG_DELAY_MS,
} from "../../src/workflows/postLaunch";
import {
  writePendingOpen,
  readFreshPendingOpen,
  clearPendingOpen,
} from "../../src/workflows/pendingRemoteOpen";
import type { WorkflowUI } from "../../src/workflows/types";

/** Fresh temp dir standing in for the local workspace folder. */
async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "postLaunchPendingOpen-test-"));
}

/** Captures the watchdog callback instead of arming a real timer. */
const scheduled: { cb: () => void | Promise<void>; delayMs: number }[] = [];
function armCaptureScheduler(): void {
  scheduled.length = 0;
  __setPendingOpenSchedulerForTests((cb, delayMs) => {
    scheduled.push({ cb, delayMs });
  });
}

function createMockUI() {
  return {
    showProgress: vi.fn(),
    showError: vi.fn().mockResolvedValue(undefined),
    showInfo: vi.fn().mockResolvedValue(undefined),
    showWarning: vi.fn().mockResolvedValue(undefined),
    openWindow: vi.fn().mockResolvedValue(undefined),
    promptCreateConfig: vi.fn().mockResolvedValue(false),
    showBuildLog: vi.fn(),
  };
}

/** Dev-container-shaped params, mirroring the openFolder.ts call site. */
function devContainerParams(tmp: string, ui: ReturnType<typeof createMockUI>) {
  return {
    deps: {
      dockerPath: "docker",
      folderHistory: { addFolders: vi.fn().mockResolvedValue(undefined) },
    } as any,
    ui: ui as unknown as WorkflowUI,
    scheme: "artizo-container" as const,
    id: tmp,
    containerId: "abc123def456",
    containerPort: 7000,
    installPath: "/tmp/.vscodium-server/1.140.0",
    connectionToken: undefined,
    workspaceFolder: tmp,
    workspacePath: "/workspaces/project",
    uriPath: "/workspaces/project",
    windowOptions: { forceReuseWindow: true },
  };
}

describe("buildAuthorityAndOpen pending-open marker + watchdog", () => {
  let ui: ReturnType<typeof createMockUI>;

  beforeEach(() => {
    ui = createMockUI();
    armCaptureScheduler();
  });

  afterEach(() => {
    __setPendingOpenSchedulerForTests(null);
  });

  it("writes an attempt=1 marker before opening, then re-issues openWindow when the watchdog still sees it", async () => {
    const tmp = await makeTmpDir();
    let markerSeenDuringOpen: { attempt: number } | null = null;
    ui.openWindow.mockImplementation(async () => {
      // The marker must already be on disk by the time the open is issued.
      markerSeenDuringOpen = await readFreshPendingOpen({ fsPath: tmp });
    });

    await buildAuthorityAndOpen(devContainerParams(tmp, ui));

    // Marker written before the open, with attempt=1 and the built authority.
    expect(markerSeenDuringOpen).not.toBeNull();
    expect((markerSeenDuringOpen as { attempt: number }).attempt).toBe(1);
    const expectedAuthority = `artizo-container+${Buffer.from(tmp, "utf-8").toString("hex")}`;
    expect(
      (await readFreshPendingOpen({ fsPath: tmp }))?.authority,
    ).toBe(expectedAuthority);

    // Watchdog armed with the documented delay.
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].delayMs).toBe(PENDING_OPEN_WATCHDOG_DELAY_MS);
    expect(PENDING_OPEN_WATCHDOG_DELAY_MS).toBe(10_000);

    // Open silently no-oped: resolve() never cleared the marker → re-issue.
    expect(ui.openWindow).toHaveBeenCalledTimes(1);
    await scheduled[0].cb();
    expect(ui.openWindow).toHaveBeenCalledTimes(2);
    expect(ui.showWarning).not.toHaveBeenCalled();
    // Re-issue is not "giving up": the marker stays for the resolver to clear.
    expect(await readFreshPendingOpen({ fsPath: tmp })).not.toBeNull();
  });

  it("does not re-issue when the marker was cleared (resolve ran → open took effect)", async () => {
    const tmp = await makeTmpDir();
    await buildAuthorityAndOpen(devContainerParams(tmp, ui));

    // Simulate the resolver in the newly opened window confirming the open.
    await clearPendingOpen({ fsPath: tmp });

    await scheduled[0].cb();
    expect(ui.openWindow).toHaveBeenCalledTimes(1);
    expect(ui.showWarning).not.toHaveBeenCalled();
  });

  it("bumps a fresh attempt=1 marker to attempt=2", async () => {
    const tmp = await makeTmpDir();
    await writePendingOpen(
      { fsPath: tmp },
      { authority: "artizo-container+stale", attempt: 1 },
    );

    await buildAuthorityAndOpen(devContainerParams(tmp, ui));

    const payload = await readFreshPendingOpen({ fsPath: tmp });
    expect(payload?.attempt).toBe(2);
  });

  it("caps attempts at 2: escalates via showWarning, clears the marker, re-opens on Reopen", async () => {
    const tmp = await makeTmpDir();
    await writePendingOpen(
      { fsPath: tmp },
      { authority: "artizo-container+stale", attempt: 2 },
    );
    ui.showWarning.mockResolvedValue("Reopen");

    await buildAuthorityAndOpen(devContainerParams(tmp, ui));
    await scheduled[0].cb();

    expect(ui.showWarning).toHaveBeenCalledTimes(1);
    expect(ui.showWarning).toHaveBeenCalledWith(
      expect.stringContaining("Workspace was NOT reopened"),
      "Reopen",
    );
    expect(ui.openWindow).toHaveBeenCalledTimes(2);
    // Giving up clears the marker so stale attempts don't accumulate.
    expect(await readFreshPendingOpen({ fsPath: tmp })).toBeNull();
  });

  it("does not re-open when the escalation warning is dismissed", async () => {
    const tmp = await makeTmpDir();
    await writePendingOpen(
      { fsPath: tmp },
      { authority: "artizo-container+stale", attempt: 2 },
    );
    ui.showWarning.mockResolvedValue(undefined);

    await buildAuthorityAndOpen(devContainerParams(tmp, ui));
    await scheduled[0].cb();

    expect(ui.showWarning).toHaveBeenCalledTimes(1);
    expect(ui.openWindow).toHaveBeenCalledTimes(1);
    expect(await readFreshPendingOpen({ fsPath: tmp })).toBeNull();
  });

  it("never breaks the open when the marker cannot be written", async () => {
    const tmp = await makeTmpDir();
    // A regular file where the workspace folder should be → mkdir/write fail.
    const blocked = path.join(tmp, "not-a-dir");
    await fs.writeFile(blocked, "file", "utf8");

    await expect(
      buildAuthorityAndOpen(devContainerParams(blocked, ui)),
    ).resolves.toBeUndefined();
    expect(ui.openWindow).toHaveBeenCalledTimes(1);

    // The watchdog (if armed) finds no readable marker and must not re-issue.
    if (scheduled[0]?.cb) {
      await scheduled[0].cb();
    }
    expect(ui.openWindow).toHaveBeenCalledTimes(1);
  });

  it("skips marker + watchdog when the authority id is not the workspace folder (attach / state-4 shapes)", async () => {
    const tmp = await makeTmpDir();
    const params = {
      ...devContainerParams(tmp, ui),
      id: "abc123def456", // attached-container style: id is a container id
    };

    await buildAuthorityAndOpen(params);

    expect(await readFreshPendingOpen({ fsPath: tmp })).toBeNull();
    expect(scheduled).toHaveLength(0);
    expect(ui.openWindow).toHaveBeenCalledTimes(1);
  });
});
