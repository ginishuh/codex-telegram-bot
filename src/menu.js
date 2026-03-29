import {
  compactCwdLabel,
  formatSessionState,
  shortThreadId,
} from "./lib/utils.js";

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
    { command: "whoami", description: "현재 chat_id 확인" },
    { command: "recent", description: "최근 Codex 세션 보기" },
    { command: "sessions", description: "세션 목록 보기" },
    { command: "status", description: "현재 세션 상태 보기" },
    { command: "new", description: "새 세션 만들기" },
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

export function renderReply(label, text, threadId) {
  return [`[${label}]`, "", text, "", `thread_id: ${threadId}`].join("\n");
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
