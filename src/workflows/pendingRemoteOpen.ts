/*
 * Copyright (c) 2026 Aergic Labs, LLC
 * SPDX-License-Identifier: AGPL-3.0-only
 */

/**
 * Pending-remote-open marker (silent-abandon watchdog protocol).
 *
 * VSCodium's `vscode.openFolder` + forceReuseWindow path can silently
 * abandon the window reload at the main-process unload handshake and still
 * resolve successfully (observed on 1.140): the command returns, no window
 * reloads, resolveAuthority never runs, and the user is left with a
 * focused, frozen window and no error anywhere. This marker closes that
 * gap with a three-step protocol:
 *
 *  1. buildAuthorityAndOpen (src/workflows/postLaunch.ts) drops this
 *     marker into the workspace folder right before it opens the remote
 *     window, then arms a delayed check.
 *  2. The remote window's resolver — the proof the open took effect —
 *     clears the marker the moment resolve() starts for the workspace's
 *     authority (src/remote/authorityResolver.ts).
 *  3. When the delayed check still sees the marker, the open silently
 *     no-oped: the watchdog re-issues the open once (attempt 1) and then
 *     escalates to the user (attempt 2), clearing the marker on give-up.
 *
 * Pure node:fs on top of a structural `{ fsPath }` workspace URI — no
 * vscode import, so the module is unit-testable against real temp dirs.
 */

import * as path from "node:path";
import * as fs from "node:fs/promises";
import { getLogger } from "../utils/logger";

/** Marker location, relative to the workspace root. */
export const MARKER_REL_PATH = ".devcontainer/.jvp-pending-remote-open.json";

/** Default freshness window: markers older than this are ignored. */
const DEFAULT_TTL_MS = 10 * 60_000;

/** Minimal shape of vscode.Uri this module depends on. */
export interface WorkspaceFolderUri {
  fsPath: string;
}

/** Payload written before opening the remote window and read by the watchdog. */
export interface PendingOpenMarkerPayload {
  issuedAt: string;
  authority: string;
  attempt: number;
}

function markerPath(workspaceUri: WorkspaceFolderUri): string {
  return path.join(workspaceUri.fsPath, MARKER_REL_PATH);
}

/**
 * Write a pending-open marker into the workspace. Never throws: failures
 * are logged so the open flow proceeds exactly as it would without the
 * watchdog.
 */
export async function writePendingOpen(
  workspaceUri: WorkspaceFolderUri,
  { authority, attempt }: { authority: string; attempt: number },
): Promise<void> {
  const logger = getLogger();
  const target = markerPath(workspaceUri);
  const payload: PendingOpenMarkerPayload = {
    issuedAt: new Date().toISOString(),
    authority,
    attempt,
  };
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, JSON.stringify(payload, null, 2), "utf8");
    logger.info(`[pendingRemoteOpen] marker written: ${target}`);
  } catch (err: unknown) {
    logger.error(
      `[pendingRemoteOpen] failed to write marker ${target}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Read the pending-open marker, or null when it is missing, unparsable,
 * malformed, or older than ttlMs. Parse problems are treated as absent.
 */
export async function readFreshPendingOpen(
  workspaceUri: WorkspaceFolderUri,
  ttlMs: number = DEFAULT_TTL_MS,
): Promise<PendingOpenMarkerPayload | null> {
  const target = markerPath(workspaceUri);
  let raw: string;
  try {
    raw = await fs.readFile(target, "utf8");
  } catch {
    return null; // missing / unreadable → treat as absent
  }

  let payload: PendingOpenMarkerPayload;
  try {
    const parsed = JSON.parse(raw) as Partial<PendingOpenMarkerPayload>;
    if (
      typeof parsed.issuedAt !== "string" ||
      typeof parsed.authority !== "string" ||
      typeof parsed.attempt !== "number"
    ) {
      return null; // malformed payload → treat as absent
    }
    payload = {
      issuedAt: parsed.issuedAt,
      authority: parsed.authority,
      attempt: parsed.attempt,
    };
  } catch {
    return null; // unparsable JSON → treat as absent
  }

  const issuedMs = Date.parse(payload.issuedAt);
  if (!Number.isFinite(issuedMs) || Date.now() - issuedMs > ttlMs) {
    return null; // bogus or stale timestamp → treat as absent
  }
  return payload;
}

/**
 * Remove the pending-open marker. Never throws; a missing marker is
 * already the desired state.
 */
export async function clearPendingOpen(
  workspaceUri: WorkspaceFolderUri,
): Promise<void> {
  const logger = getLogger();
  const target = markerPath(workspaceUri);
  try {
    await fs.rm(target, { force: true });
  } catch (err: unknown) {
    logger.error(
      `[pendingRemoteOpen] failed to clear marker ${target}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
