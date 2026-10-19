/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Rebuild-from-inside marker relay.
 *
 * A managed (container-side) window cannot run a container rebuild (no
 * docker inside the container), but the workspace folder is bind-mounted
 * from the host. This module implements the relay protocol: the container
 * window drops a rebuild request file into the workspace, triggers the
 * existing reopen-in-host flow, and the host window that opens picks the
 * request up during activation, clears it (loop safety), and runs the
 * rebuild + reconnect.
 *
 * Pure node:fs on top of a structural `{ fsPath }` workspace URI — no
 * vscode import, so the module is unit-testable against real temp dirs.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { getLogger } from "../utils/logger";

/** Marker location, relative to the workspace root (shared via bind mount). */
export const MARKER_REL_PATH = ".devcontainer/.jvp-rebuild-request.json";

/** Default freshness window: markers older than this are ignored. */
const DEFAULT_TTL_MS = 10 * 60_000;

/** Minimal shape of vscode.Uri this module depends on. */
export interface WorkspaceFolderUri {
  fsPath: string;
}

/** Payload written by the container window and read back by the host. */
export interface RebuildMarkerPayload {
  requestedAt: string;
  noCache: boolean;
}

function markerPath(workspaceUri: WorkspaceFolderUri): string {
  return path.join(workspaceUri.fsPath, MARKER_REL_PATH);
}

/**
 * Write a rebuild request marker into the workspace. Never throws:
 * failures are logged so a relay attempt can still fall back to the
 * plain reopen-in-host flow.
 */
export async function writeRebuildMarker(
  workspaceUri: WorkspaceFolderUri,
  { noCache }: { noCache: boolean },
): Promise<void> {
  const logger = getLogger();
  const target = markerPath(workspaceUri);
  const payload: RebuildMarkerPayload = {
    requestedAt: new Date().toISOString(),
    noCache,
  };
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify(payload, null, 2), "utf8");
    logger.info(`[rebuildRequest] marker written: ${target}`);
  } catch (err: unknown) {
    logger.error(
      `[rebuildRequest] failed to write marker ${target}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Read the rebuild request marker, or null when it is missing, unparsable,
 * malformed, or older than ttlMs. Parse problems are treated as absent.
 */
export async function readFreshRebuildMarker(
  workspaceUri: WorkspaceFolderUri,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<RebuildMarkerPayload | null> {
  const target = markerPath(workspaceUri);
  let raw: string;
  try {
    raw = await fs.readFile(target, "utf8");
  } catch {
    return null; // missing / unreadable → treat as absent
  }

  let payload: RebuildMarkerPayload;
  try {
    const parsed = JSON.parse(raw) as Partial<RebuildMarkerPayload>;
    if (
      typeof parsed.requestedAt !== "string" ||
      typeof parsed.noCache !== "boolean"
    ) {
      return null; // malformed payload → treat as absent
    }
    payload = { requestedAt: parsed.requestedAt, noCache: parsed.noCache };
  } catch {
    return null; // unparsable JSON → treat as absent
  }

  const requestedMs = Date.parse(payload.requestedAt);
  if (!Number.isFinite(requestedMs) || Date.now() - requestedMs > ttlMs) {
    return null; // bogus or stale timestamp → treat as absent
  }
  return payload;
}

/**
 * Remove the rebuild request marker. Never throws; a missing marker is
 * already the desired state.
 */
export async function clearRebuildMarker(
  workspaceUri: WorkspaceFolderUri,
): Promise<void> {
  const logger = getLogger();
  const target = markerPath(workspaceUri);
  try {
    await fs.rm(target, { force: true });
  } catch (err: unknown) {
    logger.error(
      `[rebuildRequest] failed to clear marker ${target}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
