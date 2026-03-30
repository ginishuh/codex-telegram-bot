import { Codex } from "@openai/codex-sdk";

import { buildCodexChildEnv } from "./child-env.js";

let codexClient = null;
let codexClientEnvKey = "";

function getCodexClient() {
  const env = buildCodexChildEnv();
  const envKey = JSON.stringify(env);

  if (!codexClient || codexClientEnvKey !== envKey) {
    codexClient = new Codex({
      env,
    });
    codexClientEnvKey = envKey;
  }

  return codexClient;
}

function buildThreadOptions(session, { model = "", fullAuto = false, skipGitRepoCheck = false } = {}) {
  const options = {
    workingDirectory: session.cwd,
    skipGitRepoCheck,
  };

  if (model) {
    options.model = model;
  }

  if (fullAuto) {
    options.approvalPolicy = "on-request";
    options.sandboxMode = "workspace-write";
  }

  return options;
}

function getThread(session, options) {
  const client = getCodexClient();
  const threadOptions = buildThreadOptions(session, options);

  if (session.threadId) {
    return client.resumeThread(session.threadId, threadOptions);
  }

  return client.startThread(threadOptions);
}

export async function runCodexSdkTurn(
  session,
  prompt,
  { onEvent = () => {}, signal, model = "", fullAuto = false, skipGitRepoCheck = false } = {},
) {
  const thread = getThread(session, {
    model,
    fullAuto,
    skipGitRepoCheck,
  });
  const { events } = await thread.runStreamed(prompt, { signal });

  let lastAgentMessage = "";
  let usage = null;

  for await (const event of events) {
    onEvent(event, thread);

    if (
      event.type === "item.completed" &&
      event.item?.type === "agent_message" &&
      typeof event.item.text === "string"
    ) {
      lastAgentMessage = event.item.text;
    }

    if (event.type === "turn.completed") {
      usage = event.usage;
    }
  }

  return {
    threadId: thread.id,
    text: lastAgentMessage.trim(),
    usage,
  };
}
