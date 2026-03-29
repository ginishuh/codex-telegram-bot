import fs from "node:fs/promises";
import path from "node:path";

export async function loadStateFile(filePath, defaultCwd) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return normalizeState(JSON.parse(raw), defaultCwd);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
    const fresh = { version: 1, lastUpdateId: 0, chats: {} };
    await writeJsonAtomic(filePath, fresh);
    return fresh;
  }
}

export function normalizeState(value, defaultCwd) {
  const parsed = value ?? {};
  parsed.version ??= 1;
  parsed.lastUpdateId ??= 0;
  parsed.chats ??= {};
  for (const chat of Object.values(parsed.chats)) {
    chat.defaultCwd ??= defaultCwd;
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
}

export async function writeJsonAtomic(filePath, value) {
  const tempPath = `${filePath}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, filePath);
}
