import {
  compactCwdLabel,
  formatSessionState,
  shortThreadId,
} from "./lib/utils.js";

function escapeTelegramMarkdown(text) {
  return String(text).replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, "\\$1");
}

function code(value) {
  return `\`${escapeTelegramMarkdown(value)}\``;
}

function inlineText(value) {
  if (!value) {
    return "없음";
  }
  return value.replace(/\s+/g, " ").slice(0, 100);
}

export function findAttachedSessionByThreadId(chat, threadId) {
  return (
    Object.entries(chat.sessions).find(([, session]) => session.threadId === threadId) ?? null
  );
}

function formatRecentButtonLabel(entry, chat) {
  const attached = findAttachedSessionByThreadId(chat, entry.id);
  const prefix = attached ? `열림 ${attached[0]}` : "불러오기";
  return `${prefix} · ${compactCwdLabel(entry.cwd)}`;
}

function formatSessionMenuButtonLabel(chat, label) {
  const session = chat.sessions[label];
  const prefix = chat.activeSessionKey === label ? "현재" : "세션";
  return `${prefix} · ${label} · ${compactCwdLabel(session.cwd)}`;
}

export function helpText() {
  return [
    "Codex Telegram Bot",
    "",
    "Codex Core",
    "/new 세션명 [cwd] : 새 thread 시작, Git repo면 전용 worktree 자동 생성",
    "/thread : 현재 thread 상태 보기",
    "/threads : 열린 세션 목록 보기",
    "/status : 현재 활성 세션 요약 보기",
    "/cancel [세션명] : 현재 turn 취소",
    "/cwd : 현재 cwd, thread_id, branch 확인",
    "/use 세션명 : 활성 세션 전환",
    "/resume 세션명 : 닫힌 세션 다시 열기",
    "",
    "Telegram Extras",
    "/menu : 버튼 메뉴 열기",
    "/attach 세션명 session_id|recent번호 [cwd] : 기존 Codex 세션 붙이기",
    "/recent [개수] : 최근 Codex 세션과 cwd 보기",
    "/whoami : 현재 chat_id 와 사용자 정보 보기",
    "/close [세션명] : 봇 연결 닫기",
    "/drop [세션명] : 봇 연결 삭제, 관리형 worktree도 함께 제거",
    "/setcwd /absolute/path : 기본 cwd 저장",
    "/where : /cwd 와 동일한 상세 정보",
    "/sessions : /threads 와 동일한 세션 목록",
    "/reopen 세션명 : /resume 과 동일",
    "",
    "일반 메시지는 현재 활성 thread로 이어서 작업합니다.",
    "",
    "참고: codex fork 는 현재 CLI에서 JSON 자동화 표면이 없어 아직 넣지 않았습니다.",
  ].join("\n");
}

export function menuHomeText() {
  return [
    "Codex Telegram Bot 메뉴",
    "",
    "- 새 세션 만들기",
    "- 최근 세션 불러오기",
    "- 붙인 세션 관리",
    "- 현재 활성 세션 확인",
    "- 도움말 보기",
    "",
    "버튼을 눌러 진행하세요.",
  ].join("\n");
}

export function buildTelegramCommands() {
  return [
    { command: "menu", description: "버튼 메뉴 열기" },
    { command: "thread", description: "현재 thread 상태 보기" },
    { command: "threads", description: "열린 세션 목록 보기" },
    { command: "cwd", description: "현재 cwd와 thread 확인" },
    { command: "new", description: "새 thread 시작" },
    { command: "whoami", description: "현재 chat_id 확인" },
  ];
}

export function formatSessions(chat) {
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

export function formatStatus(chat, activeSessionKey) {
  const session = activeSessionKey ? chat.sessions[activeSessionKey] ?? null : null;
  if (!session) {
    return "활성 세션 없음";
  }

  return [
    "현재 세션",
    "",
    `이름: ${activeSessionKey}`,
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

export function formatSessionMenuText(chat, labels, page) {
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

export function buildSessionDetailText(chat, label) {
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

export function formatWhoAmI(message) {
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

export function formatRecentSessions(entries, limit, sessionsRoot) {
  if (entries.length === 0) {
    return `최근 Codex 세션을 찾지 못했습니다. sessions root=${sessionsRoot}`;
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

export function formatRecentMenuText(entries, page) {
  if (entries.length === 0) {
    return "최근 Codex 세션이 없습니다.";
  }

  const lines = [`최근 세션 · ${page + 1} 페이지`, ""];
  for (const [index, entry] of entries.entries()) {
    lines.push(`${index + 1}. ${compactCwdLabel(entry.cwd)} · ${entry.id.slice(0, 8)}`);
  }
  lines.push("");
  lines.push("세션 버튼을 누르면 상세 화면으로 이동합니다.");
  return lines.join("\n");
}

function formatUsage(usage) {
  if (!usage) {
    return null;
  }

  const formatTokenCount = (value) => {
    if (value < 1000) {
      return String(value);
    }

    const compact = (value / 1000).toFixed(value >= 10000 ? 0 : 1);
    return `${compact.replace(/\.0$/, "")}k`;
  };

  const parts = [`in ${formatTokenCount(usage.input_tokens)}`];
  if (usage.cached_input_tokens) {
    parts.push(`cached ${formatTokenCount(usage.cached_input_tokens)}`);
  }
  parts.push(`out ${formatTokenCount(usage.output_tokens)}`);
  return parts.join(" | ");
}

export function renderReply(label, text, threadId, { branch = "", usage = null } = {}) {
  const body = escapeTelegramMarkdown(text);
  const footer = [`*thread* ${code(threadId)}`];

  if (branch) {
    footer.push(`*branch* ${code(branch)}`);
  }

  const usageText = formatUsage(usage);
  if (usageText) {
    footer.push(`*usage* ${escapeTelegramMarkdown(usageText)}`);
  }

  return [
    `*\\[${escapeTelegramMarkdown(label)}\\] 결과*`,
    "",
    body,
    "",
    footer.join("\n"),
  ].join("\n");
}

export function renderProgress(label, { threadId = "", statusText = "실행 중", steps = [] } = {}) {
  const recentSteps = steps.slice(-4);
  const lines = [`*\\[${escapeTelegramMarkdown(label)}\\] 진행 상황*`, ""];

  lines.push(`*상태* ${escapeTelegramMarkdown(statusText)}`);

  if (threadId) {
    lines.push(`*thread* ${code(threadId)}`);
  }

  if (recentSteps.length > 0) {
    lines.push("");
    for (const [index, step] of recentSteps.entries()) {
      lines.push(`${index + 1}\\. ${escapeTelegramMarkdown(step)}`);
    }
  }

  return lines.join("\n");
}

export function renderError(label, message) {
  return [
    `*\\[${escapeTelegramMarkdown(label)}\\] 오류*`,
    "",
    escapeTelegramMarkdown(message),
  ].join("\n");
}

export function buildMainMenuKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: "새 세션", callback_data: "menu:new" },
        { text: "최근 세션", callback_data: "menu:recent:0" },
      ],
      [
        { text: "붙인 세션", callback_data: "menu:sessions:0" },
        { text: "현재 세션", callback_data: "menu:status" },
      ],
      [
        { text: "도움말", callback_data: "menu:help" },
      ],
    ],
  };
}

export function buildBackToMenuKeyboard() {
  return {
    inline_keyboard: [[{ text: "메인 메뉴", callback_data: "menu:home" }]],
  };
}

export function buildRecentMenuKeyboard(entries, page, chat, pageSize = 6) {
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
  if (entries.length === pageSize) {
    navRow.push({ text: "다음", callback_data: `recent:page:${page + 1}` });
  }
  if (navRow.length > 0) {
    rows.push(navRow);
  }

  rows.push([{ text: "메인 메뉴", callback_data: "menu:home" }]);
  return { inline_keyboard: rows };
}

export function buildRecentSessionDetailKeyboard(sessionId, page, chat) {
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

export function buildRecentSessionAfterAttachKeyboard(page) {
  return {
    inline_keyboard: [
      [
        { text: "최근 목록으로", callback_data: `recent:page:${page}` },
        { text: "메인 메뉴", callback_data: "menu:home" },
      ],
    ],
  };
}

export function buildSessionMenuKeyboard(chat, labels, page, hasNextPage) {
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

export function buildSessionDetailKeyboard(label, page, chat) {
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

export function buildSessionAfterActionKeyboard(page) {
  return {
    inline_keyboard: [
      [
        { text: "세션 목록으로", callback_data: `session:page:${page}` },
        { text: "메인 메뉴", callback_data: "menu:home" },
      ],
    ],
  };
}

export function formatNewSessionMenuText(chat, options) {
  return [
    "리포 선택",
    "",
    `기본 리포: ${chat.defaultCwd}`,
    "",
    ...options.map((option, index) => `${index + 1}. ${option.source} · ${compactCwdLabel(option.cwd)}`),
    "",
    "기본 리포, 붙은 세션 리포, 최근 Codex 리포를 버튼으로 보여줍니다.",
    "버튼으로 시작 리포를 고른 뒤 세션 이름을 보내세요.",
    "직접 입력을 고르면 `세션명 /absolute/path` 형식으로 보내면 됩니다.",
  ].join("\n");
}

export function buildNewSessionKeyboard(options) {
  const rows = options.map((option) => [
    {
      text: `${option.source} · ${compactCwdLabel(option.cwd)}`,
      callback_data: `new:prepare:repo:${option.index}`,
    },
  ]);

  rows.push([{ text: "직접 리포 경로 입력", callback_data: "new:prepare:custom" }]);
  rows.push([{ text: "메인 메뉴", callback_data: "menu:home" }]);
  return { inline_keyboard: rows };
}

export function buildNewSessionPendingKeyboard() {
  return {
    inline_keyboard: [
      [{ text: "새 세션 메뉴로", callback_data: "menu:new" }],
      [{ text: "메인 메뉴", callback_data: "menu:home" }],
    ],
  };
}

export function formatNewSessionPendingText(mode, cwd, label = "직접 입력") {
  if (mode === "custom") {
    return [
      "새 세션 입력 대기",
      "",
      "`세션명 /absolute/path` 형식으로 메시지를 보내세요.",
      "예: `bugfix /home/ginis/sogecon-app`",
    ].join("\n");
  }

  return [
    "새 세션 입력 대기",
    "",
    `선택: ${label}`,
    `시작 리포: ${cwd}`,
    "이제 세션 이름만 보내세요.",
    "예: `bugfix-auth`",
  ].join("\n");
}
