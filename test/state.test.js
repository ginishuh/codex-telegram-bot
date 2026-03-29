import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { loadStateFile, normalizeState, writeJsonAtomic } from "../src/lib/state.js";

async function withTempDir(fn) {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "codex-telegram-bot-test-"));
  try {
    await fn(tempDir);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

test("loadStateFile creates a fresh state file when missing", async () => {
  await withTempDir(async (tempDir) => {
    const statePath = path.join(tempDir, "state.json");

    const state = await loadStateFile(statePath, "/home/ginis");

    assert.deepEqual(state, {
      version: 1,
      lastUpdateId: 0,
      chats: {},
    });

    const saved = JSON.parse(await fs.readFile(statePath, "utf8"));
    assert.deepEqual(saved, state);
  });
});

test("normalizeState backfills chat and session defaults", () => {
  const normalized = normalizeState(
    {
      chats: {
        "50492701": {
          sessions: {
            bugfix: {
              lifecycle: "closed",
              worktree: { path: "/tmp/worktree" },
            },
          },
        },
      },
    },
    "/home/ginis/default",
  );

  assert.equal(normalized.version, 1);
  assert.equal(normalized.lastUpdateId, 0);
  assert.equal(normalized.chats["50492701"].defaultCwd, "/home/ginis/default");
  assert.equal(normalized.chats["50492701"].activeSessionKey, null);
  assert.equal(normalized.chats["50492701"].pendingInput, null);
  assert.deepEqual(normalized.chats["50492701"].newSessionChoices, []);
  assert.deepEqual(normalized.chats["50492701"].recentSessionChoices, []);

  const session = normalized.chats["50492701"].sessions.bugfix;
  assert.equal(session.lifecycle, "closed");
  assert.equal(session.runState, "idle");
  assert.equal(session.threadId, null);
  assert.equal(session.cwd, "/home/ginis/default");
  assert.equal(session.worktree.relativeSubdir, "");
  assert.equal(session.lastAssistantMessage, "");
  assert.equal(session.lastUserMessage, "");
});

test("writeJsonAtomic writes newline-terminated JSON", async () => {
  await withTempDir(async (tempDir) => {
    const statePath = path.join(tempDir, "state.json");

    await writeJsonAtomic(statePath, { ok: true });

    const raw = await fs.readFile(statePath, "utf8");
    assert.ok(raw.endsWith("\n"));
    assert.deepEqual(JSON.parse(raw), { ok: true });
  });
});
