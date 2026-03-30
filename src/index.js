import { readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import {
  sanitizeSegment,
  compactCwdLabel,
  splitLabel,
} from "./lib/utils.js";
import { loadStateFile, writeJsonAtomic } from "./lib/state.js";
import { UserVisibleError, logError, toUserMessage } from "./errors.js";
import {
  buildBackToMenuKeyboard,
  buildMainMenuKeyboard,
  buildNewSessionKeyboard,
  buildNewSessionPendingKeyboard,
  buildRecentMenuKeyboard,
  buildRecentSessionAfterAttachKeyboard,
  buildRecentSessionDetailKeyboard,
  buildSessionAfterActionKeyboard,
  buildSessionDetailKeyboard,
  buildSessionDetailText,
  buildSessionMenuKeyboard,
  buildTelegramCommands,
  findAttachedSessionByThreadId,
  formatNewSessionMenuText,
  formatNewSessionPendingText,
  formatRecentMenuText,
  formatRecentSessions,
  formatSessionMenuText,
  formatSessions,
  formatStatus,
  formatWhoAmI,
  helpText,
  menuHomeText,
  renderError,
  renderProgress,
  renderReply,
} from "./menu.js";
import { createTelegramClient } from "./telegram.js";
import {
  cleanupOrphanedWorktrees as cleanupOrphanedManagedWorktrees,
  createRecentSessionStore,
  provisionSessionWorkspace,
  removeManagedWorktree,
  resolveRepoRoot,
} from "./git.js";
import { runCodexSdkTurn } from "./codex-sdk.js";

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
const RECENT_CACHE_TTL_MS = Number.parseInt(process.env.RECENT_CACHE_TTL_MS ?? "30000", 10);
let stateMutationChain = Promise.resolve();
const runningSessionProcesses = new Map();
const telegramClient = createTelegramClient(TELEGRAM_API);
const { telegram, ensureCommandMenu, sendText, editText, answerCallback } = telegramClient;
const recentSessionStore = createRecentSessionStore(CODEX_SESSIONS_ROOT, RECENT_CACHE_TTL_MS);

const state = await loadStateFile(STATE_PATH, DEFAULT_CWD);
const backgroundJobs = new Set();

class SessionCanceledError extends Error {
  constructor() {
    super("session canceled");
    this.name = "SessionCanceledError";
  }
}

console.log(`[boot] state=${STATE_PATH}`);
console.log(`[boot] default cwd=${DEFAULT_CWD}`);
if (BOT_DRY_RUN) {
  console.log("[boot] dry run complete");
  process.exit(0);
}

console.log("[boot] polling telegram updates");

await ensureCommandMenu(buildTelegramCommands());
await cleanupOrphanedManagedWorktrees(WORKTREE_ROOT, collectRegisteredWorktreePaths());
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
        await mutateState(() => {
          state.lastUpdateId = update.update_id;
        });
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

  if (chat.pendingInput?.type === "new_session") {
    await handlePendingNewSessionInput(chatId, chat, text);
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

  const activeLabel = chat.activeSessionKey;
  await mutateState(() => {
    const latestChat = ensureChat(chatId);
    const latestSession = latestChat.sessions[activeLabel];
    if (!latestSession) {
      throw new UserVisibleError("활성 세션을 찾지 못했습니다.");
    }
    latestSession.runState = "running";
    latestSession.updatedAt = now();
    latestSession.lastUserMessage = text;
  });
  const progressMessage = await sendText(
    chatId,
    renderProgress(activeLabel, {
      threadId: session.threadId,
      statusText: "시작됨",
      steps: ["요청 전달 완료", "Codex 준비 중"],
    }),
    { parse_mode: "MarkdownV2" },
  );

  const job = processSessionPrompt(chatId, activeLabel, text, progressMessage?.message_id ?? null).finally(
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
    case "/threads":
    case "/sessions":
      await sendText(chatId, formatSessions(chat));
      return;
    case "/recent": {
      const limit = clampRecentLimit(parts[0]);
      const recentSessions = await recentSessionStore.listRecentSessions(limit);
      await mutateState(() => {
        chat.recentSessionChoices = recentSessions.map((entry, index) => ({
          index: index + 1,
          id: entry.id,
          cwd: entry.cwd,
          timestamp: entry.timestamp,
          source: entry.source,
        }));
      });
      await sendText(chatId, formatRecentSessions(recentSessions, limit, CODEX_SESSIONS_ROOT));
      return;
    }
    case "/thread":
    case "/status":
      await sendText(chatId, formatStatus(chat, chat.activeSessionKey));
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
        const meta = await recentSessionStore.findSessionMeta(sessionId);
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
        workspace = await provisionSessionWorkspace(
          chatId,
          label,
          path.resolve(cwd),
          WORKTREE_ROOT,
        );
      } catch (error) {
        logError(`attach:${label}`, error);
        await sendText(chatId, toUserMessage(error, `기존 세션 \`${label}\` 연결에 실패했습니다.`));
        return;
      }

      await mutateState(() => {
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
      });
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
      const resolvedCwd = path.resolve(rest);
      await mutateState(() => {
        chat.defaultCwd = resolvedCwd;
      });
      await sendText(chatId, `기본 cwd를 \`${resolvedCwd}\` 로 저장했습니다.`);
      return;
    }
    case "/new": {
      const { label, remainder } = splitLabel(rest);
      if (!label) {
        await sendText(chatId, "사용법: `/new 세션명 [cwd]`");
        return;
      }
      const requestedCwd = path.resolve(remainder || chat.defaultCwd || DEFAULT_CWD);
      try {
        const created = await createSession(chatId, chat, label, requestedCwd);
        await sendText(chatId, created);
      } catch (error) {
        await sendText(chatId, toUserMessage(error, `세션 \`${label}\` 생성에 실패했습니다.`));
      }
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
    case "/resume":
    case "/reopen": {
      const label = parts[0];
      if (!label || !chat.sessions[label]) {
        await sendText(chatId, "사용법: `/resume 세션명` 또는 `/reopen 세션명`");
        return;
      }
      await mutateState(() => {
        const session = chat.sessions[label];
        session.lifecycle = "open";
        session.updatedAt = now();
        chat.activeSessionKey = label;
      });
      await sendText(chatId, `세션 \`${label}\` 을 다시 열고 활성 세션으로 지정했습니다.`);
      return;
    }
    case "/cwd":
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
    if (data === "menu:new") {
      const options = await listNewSessionOptions(chat);
      await mutateState(() => {
        chat.newSessionChoices = options.map((option) => ({
          index: option.index,
          source: option.source,
          cwd: option.cwd,
        }));
      });
      await updateMenuMessage(
        query,
        formatNewSessionMenuText(chat, options),
        buildNewSessionKeyboard(options),
      );
      await answerCallback(query.id);
      return;
    }
    if (data === "menu:status") {
      await updateMenuMessage(
        query,
        formatStatus(chat, chat.activeSessionKey),
        buildBackToMenuKeyboard(),
      );
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
    if (data.startsWith("new:prepare:")) {
      const [, , sourceType, ...restParts] = data.split(":");
      const prepared = await prepareNewSessionInput(chatId, chat, sourceType ?? "", restParts.join(":"));
      await updateMenuMessage(
        query,
        formatNewSessionPendingText(prepared.mode, prepared.cwd, prepared.label),
        buildNewSessionPendingKeyboard(),
      );
      await answerCallback(query.id, "세션 이름 입력을 기다립니다.");
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
    logError("callback", error);
    await answerCallback(query.id, toUserMessage(error, "요청 처리 중 오류가 발생했습니다."), true);
  }
}

async function createSession(chatId, chat, label, requestedCwd) {
  if (chat.sessions[label]) {
    throw new UserVisibleError(`세션 \`${label}\` 이 이미 있습니다.`);
  }

  let workspace;
  try {
    workspace = await provisionSessionWorkspace(
      chatId,
      label,
      requestedCwd,
      WORKTREE_ROOT,
    );
  } catch (error) {
    logError(`new:${label}`, error);
    throw new UserVisibleError(`세션 \`${label}\` 생성에 실패했습니다.\n\n서비스 로그를 확인해주세요.`);
  }

  await mutateState(() => {
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
    chat.pendingInput = null;
  });

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
  return lines.join("\n");
}

async function listNewSessionOptions(chat) {
  const options = [
    {
      source: "기본 리포",
      cwd: path.resolve(chat.defaultCwd || DEFAULT_CWD),
    },
  ];

  const seen = new Set([path.resolve(chat.defaultCwd || DEFAULT_CWD)]);
  const labels = Object.keys(chat.sessions).sort((left, right) => {
    if (left === chat.activeSessionKey) {
      return -1;
    }
    if (right === chat.activeSessionKey) {
      return 1;
    }
    return left.localeCompare(right);
  });

  for (const label of labels) {
    const session = chat.sessions[label];
    const repoPath = path.resolve(session.worktree?.repoRoot ?? session.cwd);
    if (seen.has(repoPath)) {
      continue;
    }
    seen.add(repoPath);
    options.push({
      source: label === chat.activeSessionKey ? "현재 세션 리포" : `세션 ${label} 리포`,
      cwd: repoPath,
    });
  }

  const recentEntries = await recentSessionStore.listRecentSessions(12);
  for (const entry of recentEntries) {
    if (!entry.cwd) {
      continue;
    }
    const repoPath = await resolveRepoRoot(path.resolve(entry.cwd));
    if (seen.has(repoPath)) {
      continue;
    }
    seen.add(repoPath);
    options.push({
      source: "최근 Codex 리포",
      cwd: repoPath,
    });
    if (options.length >= 8) {
      break;
    }
  }

  return options.map((option, index) => ({
    ...option,
    index: index + 1,
  }));
}

async function prepareNewSessionInput(chatId, chat, mode, value = "") {
  let nextPendingInput;

  if (mode === "repo") {
    const index = Number.parseInt(value, 10);
    const choice = chat.newSessionChoices?.find((entry) => entry.index === index);
    if (!choice) {
      throw new UserVisibleError("선택한 리포를 찾지 못했습니다.");
    }
    nextPendingInput = {
      type: "new_session",
      mode,
      label: choice.source,
      cwd: choice.cwd,
    };
  } else if (mode === "custom") {
    nextPendingInput = {
      type: "new_session",
      mode,
      label: "직접 입력",
      cwd: null,
    };
  } else {
    throw new UserVisibleError("알 수 없는 새 세션 시작 방식입니다.");
  }

  await mutateState(() => {
    const latestChat = ensureChat(chatId);
    latestChat.pendingInput = nextPendingInput;
  });

  return nextPendingInput;
}

async function handlePendingNewSessionInput(chatId, chat, text) {
  const pendingInput = chat.pendingInput;
  if (!pendingInput || pendingInput.type !== "new_session") {
    return false;
  }

  const { label, remainder } = splitLabel(text);
  if (!label) {
    await sendText(chatId, "세션 이름이 필요합니다. 예: `bugfix-auth`");
    return true;
  }

  let requestedCwd;
  if (pendingInput.mode === "custom") {
    if (!remainder) {
      await sendText(chatId, "`세션명 /absolute/path` 형식으로 다시 보내주세요.");
      return true;
    }
    requestedCwd = path.resolve(remainder);
  } else {
    requestedCwd = path.resolve(pendingInput.cwd || chat.defaultCwd || DEFAULT_CWD);
  }

  try {
    const created = await createSession(chatId, chat, label, requestedCwd);
    await sendText(chatId, created);
  } catch (error) {
    await sendText(chatId, toUserMessage(error, `세션 \`${label}\` 생성에 실패했습니다.`));
  }

  return true;
}

async function processSessionPrompt(chatId, label, prompt, progressMessageId = null) {
  const chat = ensureChat(chatId);
  const session = chat.sessions[label];
  if (!session) {
    return;
  }

  const progressState = {
    threadId: session.threadId ?? "",
    statusText: "실행 중",
    steps: ["Codex 응답 대기 중"],
  };
  let lastProgressText = "";
  let progressChain = Promise.resolve();

  function queueProgress(step, overrides = {}) {
    if (overrides.threadId) {
      progressState.threadId = overrides.threadId;
    }
    if (overrides.statusText) {
      progressState.statusText = overrides.statusText;
    }
    if (step && progressState.steps.at(-1) !== step) {
      progressState.steps.push(step);
    }
    if (!progressMessageId) {
      return;
    }
    const nextText = renderProgress(label, progressState);
    if (nextText === lastProgressText) {
      return;
    }
    lastProgressText = nextText;
    progressChain = progressChain
      .then(() => editText(chatId, progressMessageId, nextText, { parse_mode: "MarkdownV2" }))
      .catch(() => {});
  }

  try {
    queueProgress("요청 분석 중");
    const result = await runCodexSession(chatId, label, session, prompt, queueProgress);
    const threadId = await mutateState(() => {
      const latestChat = ensureChat(chatId);
      const latestSession = latestChat.sessions[label];
      if (!latestSession) {
        return result.threadId;
      }
      latestSession.threadId = result.threadId ?? latestSession.threadId;
      latestSession.runState = "idle";
      latestSession.updatedAt = now();
      latestSession.lastAssistantMessage = result.text;
      return latestSession.threadId;
    });
    queueProgress("응답 전달 완료", {
      threadId,
      statusText: "완료",
    });
    await progressChain;
    await sendText(
      chatId,
      renderReply(label, result.text, threadId, {
        branch: session.worktree?.branch ?? "",
        usage: result.usage ?? null,
      }),
      { parse_mode: "MarkdownV2" },
    );
  } catch (error) {
    await mutateState(() => {
      const latestChat = ensureChat(chatId);
      const latestSession = latestChat.sessions[label];
      if (!latestSession) {
        return;
      }
      latestSession.runState = "idle";
      latestSession.updatedAt = now();
    });
    if (error instanceof SessionCanceledError) {
      queueProgress("사용자 취소 요청 반영", { statusText: "취소됨" });
      await progressChain;
      await sendText(chatId, renderError(label, '실행을 취소했습니다.'), {
        parse_mode: "MarkdownV2",
      });
      return;
    }
    queueProgress("실행 중 오류 발생", { statusText: "실패" });
    await progressChain;
    logError(`session-run:${label}`, error);
    await sendText(
      chatId,
      renderError(label, toUserMessage(error, `세션 \`${label}\` 실행 중 오류가 발생했습니다.`)),
      { parse_mode: "MarkdownV2" },
    );
  }
}

async function attachRecentSession(chatId, chat, sessionId) {
  const existingEntry = Object.entries(chat.sessions).find(
    ([, session]) => session.threadId === sessionId,
  );
  if (existingEntry) {
    const [label, session] = existingEntry;
    await mutateState(() => {
      session.lifecycle = "open";
      session.updatedAt = now();
      chat.activeSessionKey = label;
    });
    return [
      "이미 붙어 있는 세션입니다.",
      `- key: ${label}`,
      `- thread_id: ${sessionId}`,
      `- cwd: ${session.cwd}`,
    ].join("\n");
  }

  const meta = await recentSessionStore.findSessionMeta(sessionId);
  if (!meta?.cwd) {
    throw new UserVisibleError("세션 메타에서 cwd를 찾지 못했습니다.");
  }

  const autoLabel = generateSessionLabel(chat, meta);
  const workspace = await provisionSessionWorkspace(
    chatId,
    autoLabel,
    path.resolve(meta.cwd),
    WORKTREE_ROOT,
  );
  await mutateState(() => {
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
  });

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
  const meta = await recentSessionStore.findSessionMeta(sessionId);
  if (!meta) {
    throw new UserVisibleError("세션 메타를 찾지 못했습니다.");
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

async function runCodexSession(chatId, label, session, prompt, onProgress = () => {}) {
  const runtimeKey = sessionRuntimeKey(chatId, label);
  const abortController = new AbortController();
  runningSessionProcesses.set(runtimeKey, {
    cancelRequested: false,
    abortController,
  });

  try {
    const result = await runCodexSdkTurn(session, prompt, {
      signal: abortController.signal,
      model: CODEX_MODEL,
      fullAuto: CODEX_FULL_AUTO,
      skipGitRepoCheck: CODEX_SKIP_GIT_REPO_CHECK,
      onEvent(event) {
        if (event.type === "thread.started" && event.thread_id) {
          onProgress("세션 연결 완료", { threadId: event.thread_id });
          return;
        }
        if (event.type === "turn.started") {
          onProgress("요청 분석 중");
          return;
        }
        if (event.type === "item.started" && event.item?.type === "command_execution") {
          onProgress(`명령 실행 중: ${summarizeCommandForProgress(event.item.command)}`);
          return;
        }
        if (event.type === "item.completed" && event.item?.type === "command_execution") {
          const commandText = summarizeCommandForProgress(event.item.command);
          const exitText = typeof event.item.exit_code === "number" ? ` (exit ${event.item.exit_code})` : "";
          onProgress(`명령 완료: ${commandText}${exitText}`);
          return;
        }
        if (event.type === "item.completed" && event.item?.type === "reasoning") {
          onProgress("해결 방향 정리 중");
          return;
        }
        if (
          event.type === "item.completed" &&
          event.item?.type === "agent_message" &&
          typeof event.item.text === "string"
        ) {
          onProgress("응답 정리 중");
          return;
        }
        if (event.type === "item.completed" && event.item?.type === "file_change") {
          const changed = event.item.changes?.map((change) => change.path).filter(Boolean) ?? [];
          const summary = changed.length > 0 ? changed.slice(0, 2).join(", ") : "파일 변경";
          onProgress(`파일 반영: ${summary}`);
          return;
        }
        if (event.type === "item.completed" && event.item?.type === "mcp_tool_call") {
          onProgress(`도구 완료: ${event.item.server}/${event.item.tool}`);
          return;
        }
        if (event.type === "item.completed" && event.item?.type === "web_search") {
          onProgress(`검색 완료: ${event.item.query}`);
          return;
        }
        if (event.type === "item.completed" && event.item?.type === "todo_list") {
          onProgress("계획 업데이트");
          return;
        }
        if (event.type === "turn.completed") {
          onProgress("응답 마무리 중");
        }
      },
    });

    if (!result.threadId) {
      throw new UserVisibleError("Codex thread_id를 추출하지 못했습니다.");
    }

    return {
      threadId: result.threadId,
      text: result.text || "(빈 응답)",
      usage: result.usage ?? null,
    };
  } catch (error) {
    const runtime = runningSessionProcesses.get(runtimeKey);
    if (runtime?.cancelRequested || error?.name === "AbortError") {
      throw new SessionCanceledError();
    }
    throw error;
  } finally {
    runningSessionProcesses.delete(runtimeKey);
  }
}

function summarizeCommandForProgress(command) {
  if (!command) {
    return "명령";
  }

  let summary = String(command).replace(/\s+/g, " ").trim();
  if (summary.startsWith("/bin/bash -lc ")) {
    summary = summary.slice("/bin/bash -lc ".length);
  }
  if (
    (summary.startsWith("\"") && summary.endsWith("\"")) ||
    (summary.startsWith("'") && summary.endsWith("'"))
  ) {
    summary = summary.slice(1, -1);
  }

  return summary.length > 100 ? `${summary.slice(0, 97)}...` : summary;
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
  const entries = await recentSessionStore.listRecentSessions(RECENT_MENU_PAGE_SIZE, offset);
  await mutateState(() => {
    chat.recentSessionChoices = entries.map((entry, index) => ({
      index: offset + index + 1,
      id: entry.id,
      cwd: entry.cwd,
      timestamp: entry.timestamp,
      source: entry.source,
    }));
  });

  const text = formatRecentMenuText(entries, safePage);
  const keyboard = buildRecentMenuKeyboard(entries, safePage, chat, RECENT_MENU_PAGE_SIZE);
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
    throw new UserVisibleError("세션을 찾지 못했습니다.");
  }
  await mutateState(() => {
    chat.activeSessionKey = label;
    chat.sessions[label].updatedAt = now();
  });
  return `활성 세션을 "${label}" 로 전환했습니다.`;
}

async function closeSession(chat, label) {
  if (!label || !chat.sessions[label]) {
    throw new UserVisibleError("닫을 세션을 찾지 못했습니다.");
  }
  const session = chat.sessions[label];
  if (session.runState === "running") {
    throw new UserVisibleError(`세션 "${label}" 은 현재 작업 중이라 봇 연결을 닫을 수 없습니다.`);
  }
  await mutateState(() => {
    session.lifecycle = "closed";
    session.updatedAt = now();
    if (chat.activeSessionKey === label) {
      chat.activeSessionKey = firstOpenSessionKey(chat);
    }
  });
  const suffix = session.worktree
    ? "\n- 원본 Codex 세션은 유지됩니다.\n- worktree는 유지됩니다. 완전히 정리하려면 /drop 세션명"
    : "";
  return `세션 "${label}" 의 봇 연결을 닫았습니다.${suffix}`;
}

async function dropSession(chat, label) {
  if (!label || !chat.sessions[label]) {
    throw new UserVisibleError("삭제할 봇 연결을 찾지 못했습니다.");
  }
  const session = chat.sessions[label];
  if (session.runState === "running") {
    throw new UserVisibleError(`세션 "${label}" 은 현재 작업 중이라 봇 연결을 삭제할 수 없습니다.`);
  }
  if (session.worktree) {
    await removeManagedWorktree(session.worktree);
  }
  await mutateState(() => {
    delete chat.sessions[label];
    if (chat.activeSessionKey === label) {
      chat.activeSessionKey = firstOpenSessionKey(chat);
    }
  });
  return [
    `세션 "${label}" 의 봇 연결을 삭제했습니다.`,
    "- 원본 Codex 세션 기록은 삭제하지 않습니다.",
    ...(session.worktree ? ["- 관리형 worktree는 제거했습니다."] : []),
  ].join("\n");
}

async function cancelSession(chatId, chat, label) {
  if (!label || !chat.sessions[label]) {
    throw new UserVisibleError("취소할 세션을 찾지 못했습니다.");
  }
  const session = chat.sessions[label];
  if (session.runState !== "running") {
    return `세션 "${label}" 은 현재 실행 중이 아닙니다.`;
  }

  const runtime = runningSessionProcesses.get(sessionRuntimeKey(chatId, label));
  if (!runtime?.abortController) {
    return `세션 "${label}" 실행 상태를 찾지 못했습니다. 잠시 후 다시 확인해주세요.`;
  }

  runtime.cancelRequested = true;
  runtime.abortController.abort();

  return `세션 "${label}" 실행 취소를 요청했습니다.`;
}

function ensureChat(chatId) {
  if (!state.chats[chatId]) {
    state.chats[chatId] = {
      defaultCwd: DEFAULT_CWD,
      activeSessionKey: null,
      pendingInput: null,
      newSessionChoices: [],
      recentSessionChoices: [],
      sessions: {},
    };
  }
  return state.chats[chatId];
}

function isChatAllowed(chatId) {
  return ALLOWED_CHAT_IDS.size === 0 || ALLOWED_CHAT_IDS.has(String(chatId));
}

function collectRegisteredWorktreePaths() {
  const paths = new Set();

  for (const chat of Object.values(state.chats)) {
    for (const session of Object.values(chat.sessions ?? {})) {
      if (session.worktree?.path) {
        paths.add(path.resolve(session.worktree.path));
      }
    }
  }

  return paths;
}

function sessionRuntimeKey(chatId, label) {
  return `${chatId}::${label}`;
}

async function mutateState(mutator) {
  const writeOp = stateMutationChain.then(async () => {
    const result = await mutator(state);
    await writeJsonAtomic(STATE_PATH, structuredClone(state));
    return result;
  });
  stateMutationChain = writeOp.catch(() => {});
  return writeOp;
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
