/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, it, expect, vi } from "vitest";
import vscodeMock from "../__mocks__/vscode";

vi.mock("vscode", () => ({ default: vscodeMock, ...vscodeMock }));

vi.mock("../../src/utils/logger", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import {
  buildLookupLabels,
  buildIdentityLabels,
} from "../../src/workflows/postLaunch";

const baseParams = {
  platformTarget: "linux",
  workspaceFolder: "/home/dev/project",
};

/** Fresh temp dir so config hashing has a realistic configPath to anchor to. */
async function makeTmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "postLaunchLabels-test-"));
}

function imageConfig(): Record<string, unknown> {
  return {
    image: "mcr.microsoft.com/devcontainers/base",
    remoteUser: "vscode",
  };
}

describe("buildLookupLabels", () => {
  it("returns only stable identity labels (target + local folder)", async () => {
    const labels = await buildLookupLabels({ ...baseParams });
    expect(labels).toEqual([
      "artizo.target=linux",
      "artizo.local_folder=/home/dev/project",
      "devcontainer.local_folder=/home/dev/project",
    ]);
  });

  it("includes config_file labels only when configPath is provided", async () => {
    const configPath = "/ws/.devcontainer/devcontainer.json";
    const labels = await buildLookupLabels({ ...baseParams, configPath });
    expect(labels).toContain(`artizo.config_file=${configPath}`);
    expect(labels).toContain(`devcontainer.config_file=${configPath}`);
    expect(labels).toHaveLength(5);
  });

  it("never includes volatile labels (config_hash, remote_user)", async () => {
    const tmp = await makeTmpDir();
    const labels = await buildLookupLabels({
      ...baseParams,
      configPath: path.join(tmp, "devcontainer.json"),
      config: imageConfig(),
    });
    expect(labels.some((l) => l.startsWith("artizo.config_hash="))).toBe(false);
    expect(labels.some((l) => l.startsWith("artizo.remote_user="))).toBe(false);
    expect(labels).toHaveLength(5);
  });
});

describe("buildIdentityLabels", () => {
  it("is a superset of buildLookupLabels plus config_hash and remote_user", async () => {
    const tmp = await makeTmpDir();
    const params = {
      ...baseParams,
      configPath: path.join(tmp, "devcontainer.json"),
      config: imageConfig(),
    };
    const lookup = await buildLookupLabels(params);
    const identity = await buildIdentityLabels(params);
    for (const label of lookup) {
      expect(identity).toContain(label);
    }
    expect(identity.some((l) => l.startsWith("artizo.config_hash="))).toBe(
      true,
    );
    expect(identity).toContain("artizo.remote_user=vscode");
  });

  it("equals the lookup label set when no config is given (no hash label)", async () => {
    const params = {
      ...baseParams,
      configPath: "/ws/.devcontainer/devcontainer.json",
    };
    const lookup = await buildLookupLabels(params);
    const identity = await buildIdentityLabels(params);
    expect(identity).toEqual(lookup);
    expect(identity.some((l) => l.startsWith("artizo.config_hash="))).toBe(
      false,
    );
  });
});
