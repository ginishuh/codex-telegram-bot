import test from "node:test";
import assert from "node:assert/strict";

import {
  compactCwdLabel,
  compactTimestamp,
  formatSessionState,
  sanitizeSegment,
  shortThreadId,
  splitLabel,
  splitTelegramText,
} from "../src/lib/utils.js";

test("splitTelegramText normalizes CRLF and splits long payloads", () => {
  const chunks = splitTelegramText(`line1\r\n${"a".repeat(4000)}`);

  assert.equal(chunks.length, 2);
  assert.ok(chunks.every((chunk) => chunk.length <= 3500));
  assert.ok(chunks[0].includes("\n"));
  assert.ok(!chunks[0].includes("\r\n"));
});

test("compactCwdLabel keeps only the trailing path segments", () => {
  assert.equal(
    compactCwdLabel("/home/ginis/codex-telegram-bot/src"),
    "ginis/codex-telegram-bot/src",
  );
  assert.equal(compactCwdLabel(""), "unknown");
});

test("formatSessionState combines lifecycle and run state", () => {
  assert.equal(formatSessionState({ lifecycle: "open", runState: "running" }), "open/running");
  assert.equal(formatSessionState({ lifecycle: "archived", runState: "idle" }), "archived/idle");
});

test("shortThreadId truncates ids and handles empty input", () => {
  assert.equal(shortThreadId("1234567890abcdef"), "12345678");
  assert.equal(shortThreadId(""), "없음");
});

test("splitLabel separates the label and remainder", () => {
  assert.deepEqual(splitLabel("bugfix /home/ginis/project"), {
    label: "bugfix",
    remainder: "/home/ginis/project",
  });
  assert.deepEqual(splitLabel(""), { label: "", remainder: "" });
});

test("sanitizeSegment and compactTimestamp build filesystem-safe values", () => {
  assert.equal(sanitizeSegment(" Feature Branch #1 "), "feature-branch-1");
  assert.equal(sanitizeSegment("!!!"), "session");
  assert.equal(
    compactTimestamp(new Date("2026-03-29T10:11:12.999Z")),
    "20260329101112",
  );
});
