import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import readline from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

loadDotEnv(path.resolve(process.cwd(), ".env"));

const BOT_TOKEN = requiredEnv("TELEGRAM_BOT_TOKEN");
const TELEGRAM_API = `https://api.telegram.org/bot${BOT_TOKEN}`;
const ALLOWED_CHAT_IDS = parseIdSet(process.env.ALLOWED_CHAT_IDS ?? "");
const DEFAULT_CWD = path.resolve(process.env.DEFAULT_CWD ?? process.cwd());
const STATE_PATH = path.resolve(process.env.STATE_PATH ?? "./data/state.json");
const CODEX_SESSIONS_ROOT = path.resolve(
  process.env.CODEX_SESSIONS_ROOT ?? path.join(os.homedir(), ".codex", "sessions"),
);
const WORKTREE_ROOT = path.resolve(process.env.WORKTREE_ROOT ?? "./data/worktrees");
const POLL_TIMEOUT_SECONDS = Number.parseInt(
  process.env.POLL_TIMEOUT_SECONDS ?? "30",
  10,
);
const CODEX_MODEL = process.env.CODEX_MODEL?.trim() || "";
const CODEX_FULL_AUTO = isTruthy(process.env.CODEX_FULL_AUTO);
const CODEX_SKIP_GIT_REPO_CHECK = isTruthy(
  process.env.CODEX_SKIP_GIT_REPO_CHECK ?? "1",
);
const BOT_DRY_RUN = isTruthy(process.env.BOT_DRY_RUN);
const RECENT_MENU_PAGE_SIZE = 6;
let saveChain = Promise.resolve();
const runningSessionProcesses = new Map();

const state = await loadState();
const backgroundJobs = new Set();

console.log(`[boot] state=${STATE_PATH}`);
console.log(`[boot] default cwd=${DEFAULT_CWD}`);
if (BOT_DRY_RUN) {
  console.log("[boot] dry run complete");
  process.exit(0);
}

console.log("[boot] polling telegram updates");

await ensureTelegramCommandMenu();
await pollLoop();

async function pollLoop() {
  while (true) {
    try {
      const updates = await telegram("getUpdates", {
        offset: state.lastUpdateId + 1,
        timeout: POLL_TIMEOUT_SECONDS,
        allowed_updates: ["message", "callback_query"],
      });

      for (const update of updates) {
        await handleUpdate(update);
        state.lastUpdateId = update.update_id;
        await saveState();
      }
    } catch (error) {
      console.error(`[poll] ${error.stack || error.message}`);
      await delay(3000);
    }
  }
}

async function handleUpdate(update) {
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query);
    return;
  }

  const message = update.message;
  if (!message?.text) {
    return;
  }

  const chatId = String(message.chat.id);
  if (!isChatAllowed(chatId)) {
    await sendText(chatId, "허용되지 않은 chat_id 입니다.");
    return;
  }

  const chat = ensureChat(chatId);
  const text = message.text.trim();

  if (text.startsWith("/")) {
    await handleCommand(chatId, chat, message, text);
    return;
  }

  const session = getActiveSession(chat);
  if (!session) {
    await sendText(
      chatId,
      "활성 세션이 없습니다. `/new 작업명`으로 세션을 만든 뒤 메시지를 보내세요.",
    );
    return;
  }

  if (session.lifecycle === "closed") {
    await sendText(
      chatId,
      `현재 활성 세션 "${chat.activeSessionKey}" 은 닫힌 상태입니다. /reopen ${chat.activeSessionKey} 또는 /use 다른세션 을 먼저 실행하세요.`,
    );
    return;
  }

  if (session.runState === "running") {
    await sendText(
      chatId,
      `세션 \`${chat.activeSessionKey}\` 이 아직 작업 중입니다. 완료 후 다시 보내주세요.`,
    );
    return;
  }

  session.runState = "running";
  session.updatedAt = now();
  session.lastUserMessage = text;
  await saveState();
  await sendText(chatId, `세션 \`${chat.activeSessionKey}\` 작업을 시작합니다.`);

  const job = processSessionPrompt(chatId, chat.activeSessionKey, text).finally(
    () => backgroundJobs.delete(job),
  );
  backgroundJobs.add(job);
}

async function handleCommand(chatId, chat, message, text) {
  const [rawCommand, ...parts] = text.split(/\s+/);
  const command = rawCommand.split("@")[0].toLowerCase();
  const rest = text.slice(rawCommand.length).trim();

  switch (command) {
    case "/start":
    case "/menu":
      await sendMainMenu(chatId);
      return;
    case "/help":
      await sendText(chatId, helpText());
      return;
    case "/sessions":
      await sendText(chatId, formatSessions(chat));
      return;
    case "/recent": {
      const limit = clampRecentLimit(parts[0]);
      const recentSessions = await listRecentCodexSessions(limit);
      chat.recentSessionChoices = recentSessions.map((entry, index) => ({
        index: index + 1,
        id: entry.id,
        cwd: entry.cwd,
        timestamp: entry.timestamp,
        source: entry.source,
      }));
      await saveState();
      await sendText(chatId, formatRecentSessions(recentSessions, limit));
      return;
    }
    case "/status":
      await sendText(chatId, formatStatus(chat));
      return;
    case "/cancel": {
      const label = parts[0] || chat.activeSessionKey;
      const message = await cancelSession(chatId, chat, label);
      await sendText(chatId, message);
      return;
    }
    case "/whoami":
      await sendText(chatId, formatWhoAmI(message));
      return;
    case "/attach": {
      const [label, target, ...cwdParts] = parts;
      if (!label || !target) {
        await sendText(chatId, "사용법: `/attach 세션명 session_id|recent번호 [cwd]`");
        return;
      }
      if (chat.sessions[label]) {
        await sendText(chatId, `세션 \`${label}\` 이 이미 있습니다.`);
        return;
      }

      const recentChoice = resolveRecentChoice(chat, target);
      const sessionId = recentChoice?.id ?? target;
      let cwd = cwdParts.join(" ").trim();
      if (!cwd) {
        if (recentChoice?.cwd) {
          cwd = recentChoice.cwd;
        }
      }
      if (!cwd) {
        const meta = await findCodexSessionMeta(sessionId);
        if (!meta?.cwd) {
          await sendText(
            chatId,
            "세션 메타에서 cwd를 찾지 못했습니다. `/attach 세션명 session_id /absolute/path` 형식으로 다시 입력해주세요.",
          );
          return;
        }
        cwd = meta.cwd;
      }

      let workspace;
      try {
        workspace = await provisionSessionWorkspace(chatId, label, path.resolve(cwd));
      } catch (error) {
        await sendText(
          chatId,
          `기존 세션 \`${label}\` 연결 실패\n\n${String(error.message || error)}`,
        );
        return;
      }

      chat.sessions[label] = {
        threadId: sessionId,
        cwd: workspace.cwd,
        worktree: workspace.worktree,
        lifecycle: "open",
        runState: "idle",
        createdAt: now(),
        updatedAt: now(),
        lastAssistantMessage: "",
        lastUserMessage: "",
      };
      chat.activeSessionKey = label;
      await saveState();
      const lines = [
        "기존 Codex 세션을 붙였습니다.",
        `- key: ${label}`,
        `- thread_id: ${sessionId}`,
        `- cwd: ${workspace.cwd}`,
      ];
      if (workspace.worktree) {
        lines.push(`- repo: ${workspace.worktree.repoRoot}`);
        lines.push(`- worktree: ${workspace.worktree.path}`);
        lines.push(`- branch: ${workspace.worktree.branch}`);
      }
      await sendText(chatId, lines.join("\n"));
      return;
    }
    case "/setcwd": {
      if (!rest) {
        await sendText(chatId, "사용법: `/setcwd /absolute/path`");
        return;
      }
      chat.defaultCwd = path.resolve(rest);
      await saveState();
      await sendText(chatId, `기본 cwd를 \`${chat.defaultCwd}\` 로 저장했습니다.`);
      return;
    }
    case "/new": {
      const { label, remainder } = splitLabel(rest);
      if (!label) {
        await sendText(chatId, "사용법: `/new 세션명 [cwd]`");
        return;
      }
      if (chat.sessions[label]) {
        await sendText(chatId, `세션 \`${label}\` 이 이미 있습니다.`);
        return;
      }

      const requestedCwd = path.resolve(remainder || chat.defaultCwd || DEFAULT_CWD);
      let workspace;
      try {
        workspace = await provisionSessionWorkspace(chatId, label, requestedCwd);
      } catch (error) {
        await sendText(
          chatId,
          `세션 \`${label}\` 생성 실패\n\n${String(error.message || error)}`,
        );
        return;
      }
      chat.sessions[label] = {
        threadId: null,
        cwd: workspace.cwd,
        worktree: workspace.worktree,
        lifecycle: "open",
        runState: "idle",
        createdAt: now(),
        updatedAt: now(),
        lastAssistantMessage: "",
        lastUserMessage: "",
      };
      chat.activeSessionKey = label;
      await saveState();
      const lines = [
        `세션 \`${label}\` 을 만들었습니다.`,
        `- cwd: \`${workspace.cwd}\``,
      ];
      if (workspace.worktree) {
        lines.push(`- repo: \`${workspace.worktree.repoRoot}\``);
        lines.push(`- worktree: \`${workspace.worktree.path}\``);
        lines.push(`- branch: \`${workspace.worktree.branch}\``);
      }
      lines.push("- 첫 일반 메시지가 오면 그때 실제 Codex 세션을 생성합니다.");
      await sendText(chatId, lines.join("\n"));
      return;
    }
    case "/use": {
      const label = parts[0];
      if (!label) {
        await sendText(chatId, "사용법: `/use 세션명`");
        return;
      }
      const message = await activateSession(chat, label);
      await sendText(chatId, message);
      return;
    }
    case "/close": {
      const label = parts[0] || chat.activeSessionKey;
      const message = await closeSession(chat, label);
      await sendText(chatId, message);
      return;
    }
    case "/drop": {
      const label = parts[0] || chat.activeSessionKey;
      const message = await dropSession(chat, label);
      await sendText(chatId, message);
      return;
    }
    case "/reopen": {
      const label = parts[0];
      if (!label || !chat.sessions[label]) {
        await sendText(chatId, "사용법: `/reopen 세션명`");
        return;
      }
      const session = chat.sessions[label];
      session.lifecycle = "open";
      session.updatedAt = now();
      chat.activeSessionKey = label;
      await saveState();
      await sendText(chatId, `세션 \`${label}\` 을 다시 열고 활성 세션으로 지정했습니다.`);
      return;
    }
    case "/where": {
      const session = getActiveSession(chat);
      if (!session) {
        await sendText(chatId, "활성 세션이 없습니다.");
        return;
      }
      await sendText(
        chatId,
        [
          `활성 세션: \`${chat.activeSessionKey}\``,
          `- cwd: \`${session.cwd}\``,
          `- thread_id: \`${session.threadId ?? "아직 없음"}\``,
          ...(session.worktree
            ? [
                `- repo: \`${session.worktree.repoRoot}\``,
                `- worktree: \`${session.worktree.path}\``,
                `- branch: \`${session.worktree.branch}\``,
              ]
            : []),
        ].join("\n"),
      );
      return;
    }
    default:
      await sendText(chatId, "알 수 없는 명령입니다. `/help` 를 확인하세요.");
  }
}

async function handleCallbackQuery(query) {
  const chatId = String(query.message?.chat?.id ?? query.from?.id ?? "");
  if (!chatId) {
    return;
  }
  if (!isChatAllowed(chatId)) {
    await answerCallback(query.id, "허용되지 않은 chat_id 입니다.", true);
    return;
  }

  const chat = ensureChat(chatId);
  const data = query.data ?? "";

  try {
    if (data === "menu:home") {
      await updateMenuMessage(query, menuHomeText(), buildMainMenuKeyboard());
      await answerCallback(query.id);
      return;
    }
    if (data === "menu:help") {
      await updateMenuMessage(query, helpText(), buildBackToMenuKeyboard());
      await answerCallback(query.id);
      return;
    }
    if (data === "menu:status") {
      await updateMenuMessage(query, formatStatus(chat), buildBackToMenuKeyboard());
      await answerCallback(query.id);
      return;
    }
    if (data.startsWith("menu:sessions:")) {
      const page = Number.parseInt(data.split(":")[2] ?? "0", 10) || 0;
      await showSessionMenu(query, chat, page);
      await answerCallback(query.id);
      return;
    }
    if (data.startsWith("menu:recent:")) {
      const page = Number.parseInt(data.split(":")[2] ?? "0", 10) || 0;
      await showRecentMenu(query, chat, page);
      await answerCallback(query.id);
      return;
    }
    if (data.startsWith("recent:page:")) {
      const page = Number.parseInt(data.split(":")[2] ?? "0", 10) || 0;
      await showRecentMenu(query, chat, page);
      await answerCallback(query.id);
      return;
    }
    if (data.startsWith("recent:open:")) {
      const [, , pageRaw, sessionId] = data.split(":");
      const page = Number.parseInt(pageRaw ?? "0", 10) || 0;
      const message = await buildRecentSessionDetail(chat, sessionId);
      await updateMenuMessage(
        query,
        message,
        buildRecentSessionDetailKeyboard(sessionId, page, chat),
      );
      await answerCallback(query.id);
      return;
    }
    if (data.startsWith("recent:attach:")) {
      const [, , pageRaw, sessionId] = data.split(":");
      const page = Number.parseInt(pageRaw ?? "0", 10) || 0;
      const message = await attachRecentSession(chatId, chat, sessionId);
      await updateMenuMessage(query, message, buildRecentSessionAfterAttachKeyboard(page));
      await answerCallback(query.id, "세션을 불러왔습니다.");
      return;
    }
    if (data.startsWith("session:page:")) {
      const page = Number.parseInt(data.split(":")[2] ?? "0", 10) || 0;
      await showSessionMenu(query, chat, page);
      await answerCallback(query.id);
      return;
    }
    if (data.startsWith("session:detail:")) {
      const [, , pageRaw, label] = data.split(":");
      const page = Number.parseInt(pageRaw ?? "0", 10) || 0;
      await updateMenuMessage(
        query,
        buildSessionDetailText(chat, label),
        buildSessionDetailKeyboard(label, page, chat),
      );
      await answerCallback(query.id);
      return;
    }
    if (data.startsWith("session:use:")) {
      const [, , pageRaw, label] = data.split(":");
      const page = Number.parseInt(pageRaw ?? "0", 10) || 0;
      const message = await activateSession(chat, label);
      await updateMenuMessage(query, message, buildSessionAfterActionKeyboard(page));
      await answerCallback(query.id, "활성 세션으로 전환했습니다.");
      return;
    }
    if (data.startsWith("session:close:")) {
      const [, , pageRaw, label] = data.split(":");
      const page = Number.parseInt(pageRaw ?? "0", 10) || 0;
      const message = await closeSession(chat, label);
      await updateMenuMessage(query, message, buildSessionAfterActionKeyboard(page));
      await answerCallback(query.id, "봇 연결을 닫았습니다.");
      return;
    }
    if (data.startsWith("session:drop:")) {
      const [, , pageRaw, label] = data.split(":");
      const page = Number.parseInt(pageRaw ?? "0", 10) || 0;
      const message = await dropSession(chat, label);
      await updateMenuMessage(query, message, buildSessionAfterActionKeyboard(page));
      await answerCallback(query.id, "봇 연결을 삭제했습니다.");
      return;
    }
    if (data.startsWith("session:cancel:")) {
      const [, , pageRaw, label] = data.split(":");
      const page = Number.parseInt(pageRaw ?? "0", 10) || 0;
      const message = await cancelSession(chatId, chat, label);
      await updateMenuMessage(query, message, buildSessionAfterActionKeyboard(page));
      await answerCallback(query.id, "실행 취소를 요청했습니다.");
      return;
    }

    await answerCallback(query.id, "알 수 없는 메뉴 동작입니다.", true);
  } catch (error) {
    await answerCallback(query.id, String(error.message || error), true);
  }
}

async function processSessionPrompt(chatId, label, prompt) {
  const chat = ensureChat(chatId);
  const session = chat.sessions[label];
  if (!session) {
    return;
  }

  try {
    const result = await runCodexSession(chatId, label, session, prompt);
    session.threadId = result.threadId ?? session.threadId;
    session.runState = "idle";
    session.updatedAt = now();
    session.lastAssistantMessage = result.text;
    await saveState();
    await sendText(chatId, renderReply(label, result.text, session.threadId));
  } catch (error) {
    session.runState = "idle";
    session.updatedAt = now();
    await saveState();
    if (error instanceof SessionCanceledError) {
      await sendText(chatId, `세션 "${label}" 실행을 취소했습니다.`);
      return;
    }
    await sendText(chatId, `세션 \`${label}\` 실행 실패\n\n${String(error.message || error)}`);
  }
}

async function attachRecentSession(chatId, chat, sessionId) {
  const existingEntry = Object.entries(chat.sessions).find(
    ([, session]) => session.threadId === sessionId,
  );
  if (existingEntry) {
    const [label, session] = existingEntry;
    session.lifecycle = "open";
    session.updatedAt = now();
    chat.activeSessionKey = label;
    await saveState();
    return [
      "이미 붙어 있는 세션입니다.",
      `- key: ${label}`,
      `- thread_id: ${sessionId}`,
      `- cwd: ${session.cwd}`,
    ].join("\n");
  }

  const meta = await findCodexSessionMeta(sessionId);
  if (!meta?.cwd) {
    throw new Error("세션 메타에서 cwd를 찾지 못했습니다.");
  }

  const autoLabel = generateSessionLabel(chat, meta);
  const workspace = await provisionSessionWorkspace(chatId, autoLabel, path.resolve(meta.cwd));
  chat.sessions[autoLabel] = {
    threadId: sessionId,
    cwd: workspace.cwd,
    worktree: workspace.worktree,
    lifecycle: "open",
    runState: "idle",
    createdAt: now(),
    updatedAt: now(),
    lastAssistantMessage: "",
    lastUserMessage: "",
  };
  chat.activeSessionKey = autoLabel;
  await saveState();

  const lines = [
    "최근 세션을 붙였습니다.",
    `- key: ${autoLabel}`,
    `- thread_id: ${sessionId}`,
    `- cwd: ${workspace.cwd}`,
  ];
  if (workspace.worktree) {
    lines.push(`- repo: ${workspace.worktree.repoRoot}`);
    lines.push(`- worktree: ${workspace.worktree.path}`);
    lines.push(`- branch: ${workspace.worktree.branch}`);
  }
  return lines.join("\n");
}

async function buildRecentSessionDetail(chat, sessionId) {
  const meta = await findCodexSessionMeta(sessionId);
  if (!meta) {
    throw new Error("세션 메타를 찾지 못했습니다.");
  }

  const attached = findAttachedSessionByThreadId(chat, sessionId);
  return [
    "최근 세션 상세",
    `- session_id: ${meta.id}`,
    `- cwd: ${meta.cwd ?? "알 수 없음"}`,
    `- at: ${meta.timestamp ?? "알 수 없음"}`,
    `- source: ${meta.source ?? "알 수 없음"}`,
    `- attached: ${attached ? `yes (${attached[0]})` : "no"}`,
  ].join("\n");
}

async function runCodexSession(chatId, label, session, prompt) {
  const outputPath = path.join(
    os.tmpdir(),
    `codex-telegram-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`,
  );
  const args = buildCodexArgs(session, prompt, outputPath);
  const child = spawn("codex", args, {
    cwd: session.cwd,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  const runtimeKey = sessionRuntimeKey(chatId, label);
  runningSessionProcesses.set(runtimeKey, {
    child,
    cancelRequested: false,
  });

  let threadId = session.threadId;
  let lastAgentMessage = "";
  let stderr = "";

  const stdoutRl = readline.createInterface({ input: child.stdout });
  stdoutRl.on("line", (line) => {
    try {
      const event = JSON.parse(line);
      if (event.type === "thread.started" && event.thread_id) {
        threadId = event.thread_id;
      }
      if (
        event.type === "item.completed" &&
        event.item?.type === "agent_message" &&
        typeof event.item.text === "string"
      ) {
        lastAgentMessage = event.item.text;
      }
    } catch {
      // Ignore non-JSON lines from the CLI.
    }
  });

  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  const runtime = runningSessionProcesses.get(runtimeKey);
  runningSessionProcesses.delete(runtimeKey);

  stdoutRl.close();

  let finalText = "";
  try {
    finalText = (await fs.readFile(outputPath, "utf8")).trim();
  } catch {
    finalText = lastAgentMessage.trim();
  } finally {
    await fs.rm(outputPath, { force: true });
  }

  if (runtime?.cancelRequested) {
    throw new SessionCanceledError();
  }

  if (exitCode !== 0) {
    throw new Error((stderr || finalText || `exit code ${exitCode}`).trim());
  }

  if (!threadId) {
    throw new Error("Codex thread_id를 추출하지 못했습니다.");
  }

  if (!finalText) {
    finalText = "(빈 응답)";
  }

  return {
    threadId,
    text: finalText,
  };
}

function buildCodexArgs(session, prompt, outputPath) {
  const shared = [];
  if (CODEX_MODEL) {
    shared.push("-m", CODEX_MODEL);
  }
  if (CODEX_FULL_AUTO) {
    shared.push("--full-auto");
  }
  if (CODEX_SKIP_GIT_REPO_CHECK) {
    shared.push("--skip-git-repo-check");
  }

  if (session.threadId) {
    return [
      "exec",
      "resume",
      "--json",
      ...shared,
      "-o",
      outputPath,
      session.threadId,
      prompt,
    ];
  }

  return [
    "exec",
    "--json",
    ...shared,
    "-C",
    session.cwd,
    "-o",
    outputPath,
    prompt,
  ];
}

async function telegram(method, payload) {
  let lastError = null;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`${TELEGRAM_API}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!body.ok) {
        throw new Error(`${method} failed: ${JSON.stringify(body)}`);
      }
      return body.result;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await delay(500 * attempt);
        continue;
      }
    }
  }

  throw lastError;
}

async function ensureTelegramCommandMenu() {
  try {
    await telegram("setMyCommands", {
      commands: buildTelegramCommands(),
    });
  } catch (error) {
    console.error(`[boot] setMyCommands failed: ${error.message || error}`);
  }
}

async function sendText(chatId, text, extra = {}) {
  const chunks = splitTelegramText(text);
  for (const [index, chunk] of chunks.entries()) {
    await telegram("sendMessage", {
      chat_id: Number(chatId),
      text: chunk,
      disable_web_page_preview: true,
      ...(index === chunks.length - 1 ? extra : {}),
    });
  }
}

async function editText(chatId, messageId, text, extra = {}) {
  return telegram("editMessageText", {
    chat_id: Number(chatId),
    message_id: messageId,
    text,
    disable_web_page_preview: true,
    ...extra,
  });
}

async function answerCallback(callbackQueryId, text = "", showAlert = false) {
  const payload = {
    callback_query_id: callbackQueryId,
  };
  if (text) {
    payload.text = text.slice(0, 180);
  }
  if (showAlert) {
    payload.show_alert = true;
  }
  return telegram("answerCallbackQuery", payload);
}

async function sendMainMenu(chatId) {
  await sendText(chatId, menuHomeText(), {
    reply_markup: buildMainMenuKeyboard(),
  });
}

async function updateMenuMessage(query, text, replyMarkup) {
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  if (chatId && messageId) {
    await editText(chatId, messageId, text, { reply_markup: replyMarkup });
    return;
  }
  await sendText(String(query.from?.id ?? ""), text, { reply_markup: replyMarkup });
}

async function showRecentMenu(query, chat, page) {
  const safePage = Math.max(0, page);
  const offset = safePage * RECENT_MENU_PAGE_SIZE;
  const entries = await listRecentCodexSessions(RECENT_MENU_PAGE_SIZE, offset);
  chat.recentSessionChoices = entries.map((entry, index) => ({
    index: offset + index + 1,
    id: entry.id,
    cwd: entry.cwd,
    timestamp: entry.timestamp,
    source: entry.source,
  }));
  await saveState();

  const text = formatRecentMenuText(entries, safePage);
  const keyboard = buildRecentMenuKeyboard(entries, safePage, chat);
  await updateMenuMessage(query, text, keyboard);
}

async function showSessionMenu(query, chat, page) {
  const safePage = Math.max(0, page);
  const labels = Object.keys(chat.sessions).sort();
  const pageSize = 8;
  const start = safePage * pageSize;
  const pageLabels = labels.slice(start, start + pageSize);

  const text = formatSessionMenuText(chat, pageLabels, safePage);
  const keyboard = buildSessionMenuKeyboard(chat, pageLabels, safePage, labels.length > start + pageSize);
  await updateMenuMessage(query, text, keyboard);
}

async function activateSession(chat, label) {
  if (!label || !chat.sessions[label]) {
    throw new Error("세션을 찾지 못했습니다.");
  }
  chat.activeSessionKey = label;
  chat.sessions[label].updatedAt = now();
  await saveState();
  return `활성 세션을 "${label}" 로 전환했습니다.`;
}

async function closeSession(chat, label) {
  if (!label || !chat.sessions[label]) {
    throw new Error("닫을 세션을 찾지 못했습니다.");
  }
  const session = chat.sessions[label];
  if (session.runState === "running") {
    throw new Error(`세션 "${label}" 은 현재 작업 중이라 봇 연결을 닫을 수 없습니다.`);
  }
  session.lifecycle = "closed";
  session.updatedAt = now();
  if (chat.activeSessionKey === label) {
    chat.activeSessionKey = firstOpenSessionKey(chat);
  }
  await saveState();
  const suffix = session.worktree
    ? "\n- 원본 Codex 세션은 유지됩니다.\n- worktree는 유지됩니다. 완전히 정리하려면 /drop 세션명"
    : "";
  return `세션 "${label}" 의 봇 연결을 닫았습니다.${suffix}`;
}

async function dropSession(chat, label) {
  if (!label || !chat.sessions[label]) {
    throw new Error("삭제할 봇 연결을 찾지 못했습니다.");
  }
  const session = chat.sessions[label];
  if (session.runState === "running") {
    throw new Error(`세션 "${label}" 은 현재 작업 중이라 봇 연결을 삭제할 수 없습니다.`);
  }
  if (session.worktree) {
    await removeManagedWorktree(session.worktree);
  }
  delete chat.sessions[label];
  if (chat.activeSessionKey === label) {
    chat.activeSessionKey = firstOpenSessionKey(chat);
  }
  await saveState();
  return [
    `세션 "${label}" 의 봇 연결을 삭제했습니다.`,
    "- 원본 Codex 세션 기록은 삭제하지 않습니다.",
    ...(session.worktree ? ["- 관리형 worktree는 제거했습니다."] : []),
  ].join("\n");
}

async function cancelSession(chatId, chat, label) {
  if (!label || !chat.sessions[label]) {
    throw new Error("취소할 세션을 찾지 못했습니다.");
  }
  const session = chat.sessions[label];
  if (session.runState !== "running") {
    return `세션 "${label}" 은 현재 실행 중이 아닙니다.`;
  }

  const runtime = runningSessionProcesses.get(sessionRuntimeKey(chatId, label));
  if (!runtime?.child) {
    return `세션 "${label}" 실행 상태를 찾지 못했습니다. 잠시 후 다시 확인해주세요.`;
  }

  runtime.cancelRequested = true;
  runtime.child.kill("SIGINT");
  setTimeout(() => {
    const latest = runningSessionProcesses.get(sessionRuntimeKey(chatId, label));
    if (latest?.child === runtime.child) {
      latest.child.kill("SIGTERM");
    }
  }, 2000).unref();

  return `세션 "${label}" 실행 취소를 요청했습니다.`;
}

function splitTelegramText(text) {
  const max = 3500;
  const normalized = text.replaceAll("\r\n", "\n");
  if (normalized.length <= max) {
    return [normalized];
  }

  const chunks = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    chunks.push(normalized.slice(cursor, cursor + max));
    cursor += max;
  }
  return chunks;
}

function helpText() {
  return [
    "Codex Telegram Bot",
    "",
    "/menu : 버튼 메뉴 열기",
    "/new 세션명 [cwd] : 새 세션 생성, Git repo면 전용 worktree 자동 생성",
    "/attach 세션명 session_id|recent번호 [cwd] : 기존 Codex 세션 붙이기",
    "/use 세션명 : 활성 세션 전환",
    "/sessions : 세션 목록 보기",
    "/recent [개수] : 최근 Codex 세션과 cwd 보기",
    "/status : 활성 세션 요약 보기",
    "/cancel [세션명] : 실행 중인 작업 취소",
    "/whoami : 현재 chat_id 와 사용자 정보 보기",
    "/close [세션명] : 봇 연결 닫기",
    "/drop [세션명] : 봇 연결 삭제, 관리형 worktree도 함께 제거",
    "/reopen 세션명 : 닫힌 세션 다시 열기",
    "/setcwd /absolute/path : 기본 cwd 저장",
    "/where : 활성 세션의 cwd와 thread_id 확인",
    "",
    "일반 메시지는 현재 활성 세션으로 codex exec 또는 codex exec resume 됩니다.",
    "",
    "참고: codex fork 는 현재 CLI에서 JSON 자동화 표면이 없어 1차 버전에서는 넣지 않았습니다.",
  ].join("\n");
}

function menuHomeText() {
  return [
    "Codex Telegram Bot 메뉴",
    "",
    "- 최근 세션 불러오기",
    "- 붙인 세션 관리",
    "- 현재 활성 세션 확인",
    "- 도움말 보기",
    "",
    "버튼을 눌러 진행하세요.",
  ].join("\n");
}

function buildTelegramCommands() {
  return [
    { command: "menu", description: "버튼 메뉴 열기" },
    { command: "whoami", description: "현재 chat_id 확인" },
    { command: "recent", description: "최근 Codex 세션 보기" },
    { command: "sessions", description: "세션 목록 보기" },
    { command: "status", description: "현재 세션 상태 보기" },
    { command: "new", description: "새 세션 만들기" },
  ];
}

function formatSessions(chat) {
  const labels = Object.keys(chat.sessions);
  if (labels.length === 0) {
    return "세션 없음\n\n/new 작업명 으로 시작하세요.";
  }

  const lines = ["세션 목록", ""];
  for (const label of labels.sort()) {
    const session = chat.sessions[label];
    const marker = chat.activeSessionKey === label ? ">" : "-";
    const state = formatSessionState(session);
    const location = compactCwdLabel(session.cwd);
    const worktreeMark = session.worktree ? "wt" : "dir";
    lines.push(`${marker} ${label}`);
    lines.push(`  ${state} | ${worktreeMark} | ${location}`);
  }
  return lines.join("\n");
}

function formatStatus(chat) {
  const session = getActiveSession(chat);
  if (!session) {
    return "활성 세션 없음";
  }

  return [
    "현재 세션",
    "",
    `이름: ${chat.activeSessionKey}`,
    `상태: ${formatSessionState(session)}`,
    `위치: ${compactCwdLabel(session.cwd)}`,
    `thread: ${shortThreadId(session.threadId)}`,
    `작업공간: ${session.worktree ? "worktree" : "directory"}`,
    ...(session.worktree
      ? [
          `브랜치: ${session.worktree.branch}`,
          `repo: ${session.worktree.repoRoot}`,
        ]
      : []),
    "",
    `최근 사용자: ${inlineText(session.lastUserMessage)}`,
    `최근 응답: ${inlineText(session.lastAssistantMessage)}`,
    "",
    `cwd: ${session.cwd}`,
    ...(session.worktree ? [`worktree: ${session.worktree.path}`] : []),
  ].join("\n");
}

function formatSessionMenuText(chat, labels, page) {
  if (labels.length === 0) {
    return "붙어 있는 세션이 없습니다.";
  }

  const lines = [`붙어 있는 세션 · ${page + 1} 페이지`, ""];
  for (const label of labels) {
    const session = chat.sessions[label];
    const marker = chat.activeSessionKey === label ? "현재" : "세션";
    lines.push(`${marker} · ${label} · ${compactCwdLabel(session.cwd)}`);
  }
  lines.push("");
  lines.push("세션 버튼을 누르면 상세 화면으로 이동합니다.");
  return lines.join("\n");
}

function buildSessionDetailText(chat, label) {
  const session = chat.sessions[label];
  if (!session) {
    throw new Error("세션을 찾지 못했습니다.");
  }

  return [
    "세션 상세",
    "",
    `이름: ${label}`,
    `상태: ${formatSessionState(session)}`,
    `위치: ${compactCwdLabel(session.cwd)}`,
    `thread: ${shortThreadId(session.threadId)}`,
    `작업공간: ${session.worktree ? "worktree" : "directory"}`,
    ...(session.runState === "running" ? ["실행: 진행 중"] : []),
    ...(session.worktree ? [`브랜치: ${session.worktree.branch}`] : []),
    "",
    `cwd: ${session.cwd}`,
  ].join("\n");
}

function formatWhoAmI(message) {
  const from = message?.from ?? {};
  const chat = message?.chat ?? {};

  return [
    "현재 대화 정보",
    `- chat_id: ${chat.id ?? "알 수 없음"}`,
    `- chat_type: ${chat.type ?? "알 수 없음"}`,
    `- username: ${chat.username ?? from.username ?? "없음"}`,
    `- user_id: ${from.id ?? "알 수 없음"}`,
    `- first_name: ${from.first_name ?? "없음"}`,
    `- last_name: ${from.last_name ?? "없음"}`,
  ].join("\n");
}

function formatRecentSessions(entries, limit) {
  if (entries.length === 0) {
    return `최근 Codex 세션을 찾지 못했습니다. sessions root=${CODEX_SESSIONS_ROOT}`;
  }

  const lines = [`최근 Codex 세션 ${entries.length}/${limit}`];
  for (const [index, entry] of entries.entries()) {
    lines.push(
      [
        `- [${index + 1}] ${entry.id}`,
        `  cwd=${entry.cwd ?? "알 수 없음"}`,
        `  at=${entry.timestamp ?? "알 수 없음"}`,
        `  source=${entry.source ?? "알 수 없음"}`,
      ].join("\n"),
    );
  }
  lines.push("");
  lines.push("예시: /attach bugfix 3");
  return lines.join("\n");
}

function formatRecentMenuText(entries, page) {
  if (entries.length === 0) {
    return "최근 Codex 세션이 없습니다.";
  }

  const lines = [`최근 세션 · ${page + 1} 페이지`, ""];
  for (const [index, entry] of entries.entries()) {
    lines.push(
      `${index + 1}. ${compactCwdLabel(entry.cwd)} · ${entry.id.slice(0, 8)}`,
    );
  }
  lines.push("");
  lines.push("세션 버튼을 누르면 상세 화면으로 이동합니다.");
  return lines.join("\n");
}

function renderReply(label, text, threadId) {
  return [`[${label}]`, "", text, "", `thread_id: ${threadId}`].join("\n");
}

function inlineText(value) {
  if (!value) {
    return "없음";
  }
  return value.replace(/\s+/g, " ").slice(0, 100);
}

function compactCwdLabel(cwd) {
  if (!cwd) {
    return "unknown";
  }
  const resolved = path.resolve(cwd);
  const parts = resolved.split(path.sep).filter(Boolean);
  return parts.slice(-3).join("/") || resolved;
}

function formatRecentButtonLabel(entry, chat) {
  const attached = findAttachedSessionByThreadId(chat, entry.id);
  const prefix = attached ? `열림 ${attached[0]}` : "불러오기";
  return `${prefix} · ${compactCwdLabel(entry.cwd)}`;
}

function buildMainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "최근 세션", callback_data: "menu:recent:0" },
        { text: "붙인 세션", callback_data: "menu:sessions:0" },
      ],
      [
        { text: "현재 세션", callback_data: "menu:status" },
        { text: "도움말", callback_data: "menu:help" },
      ],
    ],
  };
}

function buildBackToMenuKeyboard() {
  return {
    inline_keyboard: [[{ text: "메인 메뉴", callback_data: "menu:home" }]],
  };
}

function buildRecentMenuKeyboard(entries, page, chat) {
  const rows = entries.map((entry) => [
    {
      text: formatRecentButtonLabel(entry, chat),
      callback_data: `recent:open:${page}:${entry.id}`,
    },
  ]);

  const navRow = [];
  if (page > 0) {
    navRow.push({ text: "이전", callback_data: `recent:page:${page - 1}` });
  }
  if (entries.length === RECENT_MENU_PAGE_SIZE) {
    navRow.push({ text: "다음", callback_data: `recent:page:${page + 1}` });
  }
  if (navRow.length > 0) {
    rows.push(navRow);
  }

  rows.push([{ text: "메인 메뉴", callback_data: "menu:home" }]);
  return { inline_keyboard: rows };
}

function buildRecentSessionDetailKeyboard(sessionId, page, chat) {
  const attached = findAttachedSessionByThreadId(chat, sessionId);
  return {
    inline_keyboard: [
      [
        {
          text: attached ? `불러오기 (${attached[0]})` : "이 세션 불러오기",
          callback_data: `recent:attach:${page}:${sessionId}`,
        },
      ],
      [
        { text: "최근 목록으로", callback_data: `recent:page:${page}` },
        { text: "메인 메뉴", callback_data: "menu:home" },
      ],
    ],
  };
}

function buildRecentSessionAfterAttachKeyboard(page) {
  return {
    inline_keyboard: [
      [
        { text: "최근 목록으로", callback_data: `recent:page:${page}` },
        { text: "메인 메뉴", callback_data: "menu:home" },
      ],
    ],
  };
}

function buildSessionMenuKeyboard(chat, labels, page, hasNextPage) {
  const rows = labels.map((label) => [
    {
      text: formatSessionMenuButtonLabel(chat, label),
      callback_data: `session:detail:${page}:${label}`,
    },
  ]);

  const navRow = [];
  if (page > 0) {
    navRow.push({ text: "이전", callback_data: `session:page:${page - 1}` });
  }
  if (hasNextPage) {
    navRow.push({ text: "다음", callback_data: `session:page:${page + 1}` });
  }
  if (navRow.length > 0) {
    rows.push(navRow);
  }

  rows.push([{ text: "메인 메뉴", callback_data: "menu:home" }]);
  return { inline_keyboard: rows };
}

function buildSessionDetailKeyboard(label, page, chat) {
  const isActive = chat.activeSessionKey === label;
  const session = chat.sessions[label];
  return {
    inline_keyboard: [
      [
        {
          text: isActive ? `현재 활성 세션 (${label})` : "이 세션으로 이동",
          callback_data: `session:use:${page}:${label}`,
        },
      ],
      ...(session?.runState === "running"
        ? [[{ text: "실행 취소", callback_data: `session:cancel:${page}:${label}` }]]
        : []),
      [
        { text: "연결 닫기", callback_data: `session:close:${page}:${label}` },
        { text: "연결 삭제", callback_data: `session:drop:${page}:${label}` },
      ],
      [
        { text: "세션 목록으로", callback_data: `session:page:${page}` },
        { text: "메인 메뉴", callback_data: "menu:home" },
      ],
    ],
  };
}

function buildSessionAfterActionKeyboard(page) {
  return {
    inline_keyboard: [
      [
        { text: "세션 목록으로", callback_data: `session:page:${page}` },
        { text: "메인 메뉴", callback_data: "menu:home" },
      ],
    ],
  };
}

function formatSessionMenuButtonLabel(chat, label) {
  const session = chat.sessions[label];
  const prefix = chat.activeSessionKey === label ? "현재" : "세션";
  return `${prefix} · ${label} · ${compactCwdLabel(session.cwd)}`;
}

function ensureChat(chatId) {
  if (!state.chats[chatId]) {
    state.chats[chatId] = {
      defaultCwd: DEFAULT_CWD,
      activeSessionKey: null,
      recentSessionChoices: [],
      sessions: {},
    };
  }
  return state.chats[chatId];
}

function isChatAllowed(chatId) {
  return ALLOWED_CHAT_IDS.size === 0 || ALLOWED_CHAT_IDS.has(String(chatId));
}

function findAttachedSessionByThreadId(chat, threadId) {
  return (
    Object.entries(chat.sessions).find(([, session]) => session.threadId === threadId) ?? null
  );
}

function sessionRuntimeKey(chatId, label) {
  return `${chatId}::${label}`;
}

function formatSessionState(session) {
  const life =
    session.lifecycle === "open"
      ? "open"
      : session.lifecycle === "closed"
        ? "closed"
        : session.lifecycle;
  const run = session.runState === "running" ? "running" : "idle";
  return `${life}/${run}`;
}

function shortThreadId(threadId) {
  if (!threadId) {
    return "없음";
  }
  return threadId.slice(0, 8);
}

class SessionCanceledError extends Error {
  constructor() {
    super("session canceled");
    this.name = "SessionCanceledError";
  }
}

function getActiveSession(chat) {
  if (!chat.activeSessionKey) {
    return null;
  }
  return chat.sessions[chat.activeSessionKey] ?? null;
}

function firstOpenSessionKey(chat) {
  return (
    Object.entries(chat.sessions).find(([, session]) => session.lifecycle === "open")?.[0] ??
    null
  );
}

function splitLabel(rest) {
  if (!rest) {
    return { label: "", remainder: "" };
  }
  const trimmed = rest.trim();
  const match = trimmed.match(/^(\S+)(?:\s+([\s\S]+))?$/);
  if (!match) {
    return { label: "", remainder: "" };
  }
  return {
    label: match[1],
    remainder: match[2]?.trim() ?? "",
  };
}

function generateSessionLabel(chat, meta) {
  const cwdBase = sanitizeSegment(path.basename(meta.cwd || "session"));
  const shortId = String(meta.id ?? "session").slice(0, 6).toLowerCase();
  const base = `${cwdBase}-${shortId}`;
  let candidate = base;
  let counter = 2;
  while (chat.sessions[candidate]) {
    candidate = `${base}-${counter}`;
    counter += 1;
  }
  return candidate;
}

async function provisionSessionWorkspace(chatId, label, requestedCwd) {
  const gitContext = await detectGitContext(requestedCwd);
  if (!gitContext) {
    return { cwd: requestedCwd, worktree: null };
  }

  await fs.mkdir(WORKTREE_ROOT, { recursive: true });

  const repoName = sanitizeSegment(path.basename(gitContext.repoRoot));
  const chatSegment = sanitizeSegment(chatId);
  const labelSegment = sanitizeSegment(label);
  const uniqueSuffix = compactTimestamp();
  const worktreePath = path.join(
    WORKTREE_ROOT,
    repoName,
    chatSegment,
    `${labelSegment}-${uniqueSuffix}`,
  );
  const branch = `bot/${chatSegment}/${labelSegment}-${uniqueSuffix}`;

  await runCommand("git", [
    "-C",
    gitContext.repoRoot,
    "worktree",
    "add",
    "-b",
    branch,
    worktreePath,
    "HEAD",
  ]);

  const sessionCwd = gitContext.relativeSubdir
    ? path.join(worktreePath, gitContext.relativeSubdir)
    : worktreePath;

  return {
    cwd: sessionCwd,
    worktree: {
      repoRoot: gitContext.repoRoot,
      path: worktreePath,
      branch,
      relativeSubdir: gitContext.relativeSubdir,
    },
  };
}

async function removeManagedWorktree(worktree) {
  await runCommand("git", [
    "-C",
    worktree.repoRoot,
    "worktree",
    "remove",
    "--force",
    worktree.path,
  ]);
}

async function detectGitContext(targetCwd) {
  try {
    const repoRoot = (
      await runCommand("git", ["-C", targetCwd, "rev-parse", "--show-toplevel"])
    ).trim();
    const relativeSubdir = normalizeRelativeSubdir(path.relative(repoRoot, targetCwd));
    return { repoRoot, relativeSubdir };
  } catch {
    return null;
  }
}

function normalizeRelativeSubdir(value) {
  if (!value || value === ".") {
    return "";
  }
  return value;
}

function sanitizeSegment(value) {
  const normalized = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "session";
}

function compactTimestamp() {
  return new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
}

async function runCommand(command, args) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });

  if (exitCode !== 0) {
    throw new Error((stderr || stdout || `${command} exited with ${exitCode}`).trim());
  }

  return stdout;
}

function resolveRecentChoice(chat, rawTarget) {
  const target = String(rawTarget ?? "").trim();
  if (!/^\d+$/.test(target)) {
    return null;
  }
  const index = Number.parseInt(target, 10);
  return chat.recentSessionChoices?.find((entry) => entry.index === index) ?? null;
}

function clampRecentLimit(raw) {
  const parsed = Number.parseInt(raw ?? "10", 10);
  if (!Number.isFinite(parsed)) {
    return 10;
  }
  return Math.min(Math.max(parsed, 1), 30);
}

async function listRecentCodexSessions(limit = 10, offset = 0) {
  const files = await collectSessionFiles(CODEX_SESSIONS_ROOT);
  files.sort((left, right) => right.localeCompare(left));

  const results = [];
  for (const filePath of files) {
    const meta = await readSessionMeta(filePath);
    if (!meta?.id) {
      continue;
    }
    results.push(meta);
    if (results.length >= offset + limit) {
      break;
    }
  }

  return results.slice(offset, offset + limit);
}

async function findCodexSessionMeta(sessionId) {
  const files = await collectSessionFiles(CODEX_SESSIONS_ROOT);
  files.sort((left, right) => right.localeCompare(left));

  for (const filePath of files) {
    if (!filePath.includes(sessionId)) {
      continue;
    }
    const meta = await readSessionMeta(filePath);
    if (meta?.id === sessionId) {
      return meta;
    }
  }

  for (const filePath of files) {
    const meta = await readSessionMeta(filePath);
    if (meta?.id === sessionId) {
      return meta;
    }
  }

  return null;
}

async function collectSessionFiles(rootDir) {
  const files = [];

  async function walk(currentDir) {
    let entries;
    try {
      entries = await fs.readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }
      if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        files.push(fullPath);
      }
    }
  }

  await walk(rootDir);
  return files;
}

async function readSessionMeta(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }

  const firstLine = raw.split("\n", 1)[0]?.trim();
  if (!firstLine) {
    return null;
  }

  try {
    const parsed = JSON.parse(firstLine);
    if (parsed.type !== "session_meta") {
      return null;
    }
    return {
      id: parsed.payload?.id ?? null,
      cwd: parsed.payload?.cwd ?? null,
      timestamp: parsed.payload?.timestamp ?? parsed.timestamp ?? null,
      source:
        typeof parsed.payload?.source === "string"
          ? parsed.payload.source
          : parsed.payload?.source?.subagent ?? "unknown",
      filePath,
    };
  } catch {
    return null;
  }
}

async function loadState() {
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    parsed.lastUpdateId ??= 0;
    parsed.chats ??= {};
    for (const chat of Object.values(parsed.chats)) {
      chat.defaultCwd ??= DEFAULT_CWD;
      chat.activeSessionKey ??= null;
      chat.recentSessionChoices ??= [];
      chat.sessions ??= {};
      for (const session of Object.values(chat.sessions)) {
        session.lifecycle ??= "open";
        session.runState = "idle";
        session.threadId ??= null;
        session.cwd ??= chat.defaultCwd;
        session.worktree ??= null;
        if (session.worktree) {
          session.worktree.relativeSubdir ??= "";
        }
        session.lastAssistantMessage ??= "";
        session.lastUserMessage ??= "";
      }
    }
    return parsed;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    const fresh = { version: 1, lastUpdateId: 0, chats: {} };
    await writeJsonAtomic(STATE_PATH, fresh);
    return fresh;
  }
}

async function saveState() {
  const writeOp = saveChain.then(() => writeJsonAtomic(STATE_PATH, state));
  saveChain = writeOp.catch(() => {});
  return writeOp;
}

async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}

function loadDotEnv(filePath) {
  try {
    const raw = readFileSync(filePath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) {
        continue;
      }
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      if (!(key in process.env)) {
        process.env[key] = stripQuotes(value);
      }
    }
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} environment variable is required.`);
  }
  return value;
}

function stripQuotes(value) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseIdSet(value) {
  return new Set(
    value
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  );
}

function isTruthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function now() {
  return new Date().toISOString();
}
