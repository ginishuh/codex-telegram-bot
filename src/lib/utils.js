import path from "node:path";

export function splitTelegramText(text) {
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

export function compactCwdLabel(cwd) {
  if (!cwd) {
    return "unknown";
  }
  const resolved = path.resolve(cwd);
  const parts = resolved.split(path.sep).filter(Boolean);
  return parts.slice(-3).join("/") || resolved;
}

export function formatSessionState(session) {
  const life =
    session.lifecycle === "open"
      ? "open"
      : session.lifecycle === "closed"
        ? "closed"
        : session.lifecycle;
  const run = session.runState === "running" ? "running" : "idle";
  return `${life}/${run}`;
}

export function shortThreadId(threadId) {
  if (!threadId) {
    return "없음";
  }
  return threadId.slice(0, 8);
}

export function splitLabel(rest) {
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

export function sanitizeSegment(value) {
  const normalized = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "session";
}

export function compactTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
}
