import assert from "node:assert/strict";
import test from "node:test";

import { helpText, renderError, renderProgress, renderReply } from "../src/menu.js";

test("renderProgress includes status, thread id, and recent steps", () => {
  const text = renderProgress("bugfix", {
    threadId: "thread-123",
    statusText: "실행 중",
    steps: [
      "요청 전달 완료",
      "Codex 준비 중",
      "요청 분석 중",
      "명령 실행 중: pwd",
    ],
  });

  assert.match(text, /\*\\\[bugfix\\\] 진행 상황\*/);
  assert.match(text, /\*상태\* 실행 중/);
  assert.match(text, /\*thread\* `thread\\-123`/);
  assert.match(text, /1\\\. 요청 전달 완료/);
  assert.match(text, /4\\\. 명령 실행 중: pwd/);
});

test("helpText separates codex core and telegram extras", () => {
  const text = helpText();

  assert.match(text, /Codex Core/);
  assert.match(text, /Telegram Extras/);
  assert.match(text, /\/thread : 현재 thread 상태 보기/);
  assert.match(text, /\/threads : 열린 세션 목록 보기/);
  assert.match(text, /\/cwd : 현재 cwd, thread_id, branch 확인/);
  assert.match(text, /\/resume 세션명 : 닫힌 세션 다시 열기/);
});

test("renderReply and renderError escape telegram markdown safely", () => {
  const reply = renderReply("bug_fix", "path: /tmp/a-b (ok)", "thr_123", {
    branch: "bot/50492701/511-20260329214558",
    usage: {
      input_tokens: 28323,
      cached_input_tokens: 3456,
      output_tokens: 30,
    },
  });
  const error = renderError("bug_fix", "failed: a_b-c");

  assert.match(reply, /\*\\\[bug\\_fix\\\] 결과\*/);
  assert.match(reply, /`thr\\_123`/);
  assert.match(reply, /\*branch\* `bot\/50492701\/511\\-20260329214558`/);
  assert.match(reply, /\*usage\* in 28\\.3k \\| cached 3\\.5k \\| out 30/);
  assert.match(reply, /path: \/tmp\/a\\-b \\\(ok\\\)/);
  assert.match(error, /\*\\\[bug\\_fix\\\] 오류\*/);
  assert.match(error, /failed: a\\_b\\-c/);
});
