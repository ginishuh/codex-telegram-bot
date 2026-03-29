const BASE_ENV_KEYS = [
  "HOME",
  "PATH",
  "SHELL",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM",
  "TMPDIR",
  "TMP",
  "TEMP",
  "PWD",
  "WSL_DISTRO_NAME",
  "WSLENV",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
];

const BASE_ENV_PREFIXES = [
  "XDG_",
  "SSH_",
  "GIT_",
  "SSL_",
];

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
];

function buildChildEnv({ includeCodex = false } = {}) {
  const nextEnv = {};
  const allowPrefixes = [...BASE_ENV_PREFIXES];

  if (includeCodex) {
    allowPrefixes.push("OPENAI_", "CODEX_");
  }

  for (const key of BASE_ENV_KEYS) {
    if (process.env[key] !== undefined) {
      nextEnv[key] = process.env[key];
    }
  }

  for (const key of PROXY_ENV_KEYS) {
    if (process.env[key] !== undefined) {
      nextEnv[key] = process.env[key];
    }
  }

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) {
      continue;
    }
    if (key in nextEnv) {
      continue;
    }
    if (allowPrefixes.some((prefix) => key.startsWith(prefix))) {
      nextEnv[key] = value;
    }
  }

  return nextEnv;
}

export function buildGitChildEnv() {
  return buildChildEnv({ includeCodex: false });
}

export function buildCodexChildEnv() {
  return buildChildEnv({ includeCodex: true });
}
