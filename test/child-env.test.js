import test from "node:test";
import assert from "node:assert/strict";

import { buildCodexChildEnv, buildGitChildEnv } from "../src/child-env.js";
import { UserVisibleError, toUserMessage } from "../src/errors.js";

function withEnv(patch, fn) {
  const previous = new Map();
  for (const key of Object.keys(patch)) {
    previous.set(key, process.env[key]);
    const nextValue = patch[key];
    if (nextValue === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = nextValue;
    }
  }

  try {
    return fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

test("buildCodexChildEnv excludes telegram secrets and keeps codex/openai env", () => {
  withEnv(
    {
      TELEGRAM_BOT_TOKEN: "secret-bot-token",
      OPENAI_API_KEY: "openai-key",
      CODEX_HOME: "/tmp/codex-home",
      PATH: "/usr/bin",
    },
    () => {
      const env = buildCodexChildEnv();

      assert.equal(env.TELEGRAM_BOT_TOKEN, undefined);
      assert.equal(env.OPENAI_API_KEY, "openai-key");
      assert.equal(env.CODEX_HOME, "/tmp/codex-home");
      assert.equal(env.PATH, "/usr/bin");
    },
  );
});

test("buildGitChildEnv excludes codex/openai specific env", () => {
  withEnv(
    {
      OPENAI_API_KEY: "openai-key",
      CODEX_HOME: "/tmp/codex-home",
      GIT_SSH_COMMAND: "ssh -i ~/.ssh/id_rsa",
      PATH: "/usr/bin",
    },
    () => {
      const env = buildGitChildEnv();

      assert.equal(env.OPENAI_API_KEY, undefined);
      assert.equal(env.CODEX_HOME, undefined);
      assert.equal(env.GIT_SSH_COMMAND, "ssh -i ~/.ssh/id_rsa");
      assert.equal(env.PATH, "/usr/bin");
    },
  );
});

test("toUserMessage keeps explicit user-visible errors and hides internal ones", () => {
  assert.equal(
    toUserMessage(new UserVisibleError("세션을 찾지 못했습니다."), "실패"),
    "세션을 찾지 못했습니다.",
  );
  assert.equal(
    toUserMessage(new Error("/home/ginis/private/path exploded"), "실패"),
    "실패\n\n서비스 로그를 확인해주세요.",
  );
});
