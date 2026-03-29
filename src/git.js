import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

import { compactTimestamp, sanitizeSegment } from "./lib/utils.js";
import { buildGitChildEnv } from "./child-env.js";

export function createRecentSessionStore(rootDir, ttlMs) {
  const cache = {
    expiresAt: 0,
    entries: [],
  };

  async function getRecentSessionEntries(forceRefresh = false) {
    const nowMs = Date.now();
    if (!forceRefresh && cache.entries.length > 0 && cache.expiresAt > nowMs) {
      return cache.entries;
    }

    const files = await collectSessionFiles(rootDir);
    files.sort((left, right) => right.localeCompare(left));

    const entries = [];
    for (const filePath of files) {
      const meta = await readSessionMeta(filePath);
      if (!meta?.id) {
        continue;
      }
      entries.push(meta);
    }

    cache.entries = entries;
    cache.expiresAt = nowMs + ttlMs;
    return entries;
  }

  return {
    async listRecentSessions(limit = 10, offset = 0) {
      const entries = await getRecentSessionEntries();
      return entries.slice(offset, offset + limit);
    },
    async findSessionMeta(sessionId) {
      const entries = await getRecentSessionEntries();
      return entries.find((entry) => entry.id === sessionId) ?? null;
    },
    getRecentSessionEntries,
  };
}

export async function cleanupOrphanedWorktrees(worktreeRoot, registeredPaths) {
  await fs.mkdir(worktreeRoot, { recursive: true });

  const actualPaths = await collectManagedWorktreePaths(worktreeRoot);
  let removedCount = 0;

  for (const worktreePath of actualPaths) {
    if (registeredPaths.has(worktreePath)) {
      continue;
    }

    const metadata = await inspectWorktree(worktreePath);
    if (!metadata?.repoRoot) {
      console.warn(`[boot] orphan worktree candidate skipped: ${worktreePath}`);
      continue;
    }

    try {
      await runCommand("git", [
        "-C",
        metadata.repoRoot,
        "worktree",
        "remove",
        "--force",
        worktreePath,
      ]);
      removedCount += 1;
      console.log(`[boot] removed orphan worktree: ${worktreePath}`);
    } catch (error) {
      console.error(`[boot] orphan worktree cleanup failed for ${worktreePath}: ${error.message || error}`);
    }
  }

  if (removedCount > 0) {
    console.log(`[boot] orphan worktree cleanup complete: removed=${removedCount}`);
  }
}

export async function provisionSessionWorkspace(chatId, label, requestedCwd, worktreeRoot) {
  const gitContext = await detectGitContext(requestedCwd);
  if (!gitContext) {
    return { cwd: requestedCwd, worktree: null };
  }

  await fs.mkdir(worktreeRoot, { recursive: true });

  const repoName = sanitizeSegment(path.basename(gitContext.repoRoot));
  const chatSegment = sanitizeSegment(chatId);
  const labelSegment = sanitizeSegment(label);
  const uniqueSuffix = compactTimestamp();
  const worktreePath = path.join(
    worktreeRoot,
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

export async function removeManagedWorktree(worktree) {
  await runCommand("git", [
    "-C",
    worktree.repoRoot,
    "worktree",
    "remove",
    "--force",
    worktree.path,
  ]);
}

export async function resolveRepoRoot(targetCwd) {
  const gitContext = await detectGitContext(targetCwd);
  return gitContext?.repoRoot ?? path.resolve(targetCwd);
}

export async function collectManagedWorktreePaths(rootDir) {
  const directories = [];

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

    const hasGitMetadata = entries.some((entry) => entry.name === ".git");
    if (hasGitMetadata) {
      directories.push(currentDir);
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      await walk(path.join(currentDir, entry.name));
    }
  }

  await walk(rootDir);
  directories.sort();
  return directories;
}

export async function inspectWorktree(worktreePath) {
  try {
    const commonDir = (
      await runCommand("git", ["-C", worktreePath, "rev-parse", "--path-format=absolute", "--git-common-dir"])
    ).trim();
    if (!commonDir) {
      return null;
    }
    return {
      repoRoot: path.dirname(commonDir),
    };
  } catch {
    return null;
  }
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

async function runCommand(command, args) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: buildGitChildEnv(),
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

async function collectSessionFiles(rootPath) {
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

  await walk(rootPath);
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
