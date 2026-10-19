/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import vscodeMock from "../__mocks__/vscode";

vi.mock("vscode", () => ({ default: vscodeMock, ...vscodeMock }));

import { checkContainerConfig } from "../../src/remote/configCheck";
import type { ContainerInfo } from "../../src/utils/dockerUtils";

const mockShowWarning = vscodeMock.window.showWarningMessage as ReturnType<
  typeof vi.fn
>;
const mockExecuteCommand = vscodeMock.commands.executeCommand as ReturnType<
  typeof vi.fn
>;

function makeInfo(labels: Record<string, string>): ContainerInfo {
  return {
    config: { labels },
    state: { status: "running", running: true },
  } as unknown as ContainerInfo;
}

describe("checkContainerConfig", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips foreign containers without a config_file label", async () => {
    const result = await checkContainerConfig(makeInfo({}));
    expect(result).toBe("ok");
    expect(mockShowWarning).not.toHaveBeenCalled();
    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });

  it("missing config_hash label + Rebuild → runs the RECONNECT rebuild (rebuildAndReopen)", async () => {
    // Regression guard: this dialog fires mid-resolve in a window that is
    // trying to connect. It must trigger the rebuild+reopen command; the
    // no-reconnect artizo.rebuildContainer leaves the window stranded.
    mockShowWarning.mockResolvedValue("Rebuild");
    const result = await checkContainerConfig(
      makeInfo({ "artizo.config_file": "/w/.devcontainer/devcontainer.json" }),
    );
    expect(result).toBe("rebuild");
    expect(mockExecuteCommand).toHaveBeenCalledTimes(1);
    expect(mockExecuteCommand).toHaveBeenCalledWith(
      "artizo.rebuildAndReopen",
    );
  });

  it("missing config_hash label + Continue anyway → ok, no rebuild", async () => {
    mockShowWarning.mockResolvedValue("Continue anyway");
    const result = await checkContainerConfig(
      makeInfo({ "artizo.config_file": "/w/.devcontainer/devcontainer.json" }),
    );
    expect(result).toBe("ok");
    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });

  it("missing config_hash label + dismissed dialog → ok, no rebuild", async () => {
    mockShowWarning.mockResolvedValue(undefined);
    const result = await checkContainerConfig(
      makeInfo({ "artizo.config_file": "/w/.devcontainer/devcontainer.json" }),
    );
    expect(result).toBe("ok");
    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });
});
