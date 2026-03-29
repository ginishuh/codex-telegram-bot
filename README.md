# Codex Telegram Bot

한 대의 PC에서 여러 `Codex CLI` 세션을 관리할 수 있게 만든 텔레그램 봇 뼈대입니다.

이 프로젝트는 다음 흐름을 전제로 합니다.

- 봇 하나는 PC 하나에만 붙습니다.
- 그 봇 안에서 여러 세션을 만들고 전환합니다.
- 새 세션은 Git repo 안에서 만들면 세션 전용 `git worktree`가 먼저 생성됩니다.
- 새 세션의 첫 메시지는 `codex exec --json` 으로 시작합니다.
- 기존 세션의 다음 메시지는 `codex exec resume --json` 으로 이어갑니다.
- 중요한 점: `exec resume` 는 세션의 원래 `cwd`를 자동 복원하지 않으므로, 봇은 세션마다 저장한 `cwd`에서 Codex 프로세스를 실행합니다.

## 왜 이렇게 만들었나

- 텔레그램 봇은 비대화형 서버 프로세스이므로 `codex exec` 계열이 가장 다루기 쉽습니다.
- `thread.started` 이벤트에서 `thread_id` 를 추출해 `chat_id -> session label -> thread_id` 로 저장합니다.
- 같은 리포에서 여러 세션이 동시에 수정할 수 있으므로, `/new` 와 `/attach` 는 Git repo 경로일 때 관리형 `git worktree`를 자동으로 만듭니다.
- `codex fork` 는 현재 CLI에서 JSON 자동화 표면이 없어 1차 버전에서는 제외했습니다.

## 기능

- long polling 기반 텔레그램 수신
- 채팅별 세션 목록 저장
- `active/open/closed/running` 상태 관리
- 세션별 `cwd` 저장
- 재시작 후에도 세션 상태 복구
- 허용된 `chat_id` 제한 옵션

## 명령어

- `/menu`
- `/new 세션명 [cwd]`
- `/attach 세션명 session_id|recent번호 [cwd]`
- `/use 세션명`
- `/sessions`
- `/recent [개수]`
- `/status`
- `/cancel [세션명]`
- `/whoami`
- `/close [세션명]`
- `/drop [세션명]`
- `/reopen 세션명`
- `/setcwd /absolute/path`
- `/where`

일반 메시지는 현재 활성 세션으로 전달됩니다.

`/menu` 를 보내면 버튼 메뉴가 열립니다. 최근 세션은 `목록 -> 상세 -> 불러오기`, 붙인 세션은 `목록 -> 상세 -> 이동/실행 취소/연결 닫기/연결 삭제` 흐름으로 들어가며, 봇 시작 시 텔레그램 명령 메뉴도 자동 등록합니다.

## 빠른 시작

1. `.env.example` 을 `.env` 로 복사합니다.
2. `TELEGRAM_BOT_TOKEN` 을 넣습니다.
3. 필요하면 `DEFAULT_CWD`, `ALLOWED_CHAT_IDS` 를 수정합니다.
4. 아래 명령으로 실행합니다.

```bash
cd /home/ginis/codex-telegram-bot
node src/index.js
```

또는

```bash
cd /home/ginis/codex-telegram-bot
npm start
```

## systemd 등록

상시 운영할 때는 user-level systemd 서비스로 두는 편이 가장 단순합니다.

1. 서비스 파일 복사

```bash
mkdir -p ~/.config/systemd/user
cp /home/ginis/codex-telegram-bot/systemd/codex-telegram-bot.service ~/.config/systemd/user/
```

2. `.env` 준비

```bash
cd /home/ginis/codex-telegram-bot
cp .env.example .env
```

3. 서비스 등록 및 시작

```bash
systemctl --user daemon-reload
systemctl --user enable --now codex-telegram-bot
```

4. 상태 및 로그 확인

```bash
systemctl --user status codex-telegram-bot
journalctl --user -u codex-telegram-bot -f
```

5. 재시작과 중지

```bash
systemctl --user restart codex-telegram-bot
systemctl --user stop codex-telegram-bot
```

로그아웃 후에도 user service를 유지하려면 필요 시 아래를 한 번 실행합니다.

```bash
loginctl enable-linger "$USER"
```

## 환경 변수

- `TELEGRAM_BOT_TOKEN`: 필수
- `ALLOWED_CHAT_IDS`: 쉼표 구분 허용 chat id 목록
- `DEFAULT_CWD`: 새 세션 기본 작업 디렉터리
- `STATE_PATH`: 상태 JSON 저장 위치
- `CODEX_SESSIONS_ROOT`: 기존 Codex 세션 검색 루트
- `WORKTREE_ROOT`: 관리형 `git worktree` 생성 루트
- `POLL_TIMEOUT_SECONDS`: Telegram long polling 타임아웃
- `CODEX_MODEL`: 지정하면 `codex -m ...` 로 실행
- `CODEX_FULL_AUTO`: `1` 이면 `--full-auto` 사용
- `CODEX_SKIP_GIT_REPO_CHECK`: 기본 `1`
- `BOT_DRY_RUN`: `1` 이면 Telegram polling 없이 설정과 상태 파일만 확인하고 종료

## 상태 파일 예시

`data/state.json`

```json
{
  "version": 1,
  "lastUpdateId": 0,
  "chats": {
    "123456789": {
      "defaultCwd": "/home/ginis",
      "activeSessionKey": "bugfix",
      "sessions": {
        "bugfix": {
          "threadId": "019d38fb-ddf5-7962-8563-f31dc593d50f",
          "cwd": "/home/ginis/wastelite-suite/wastelite",
          "lifecycle": "open",
          "runState": "idle"
        }
      }
    }
  }
}
```

## 운영 메모

- 같은 세션에 동시에 여러 메시지를 넣지 않도록 `running` 상태를 둡니다.
- 여러 세션이 같은 리포를 수정한다면 세션별 `git worktree` 분리가 사실상 필수라서, `/new` 는 Git repo 경로일 때 기본으로 관리형 worktree를 생성합니다.
- 회사용 봇과 집용 봇은 토큰과 상태 파일을 완전히 분리하는 편이 안전합니다.
- 회사용/집용을 나눌 때는 서비스 파일을 복사해 이름만 `codex-telegram-bot-work.service`, `codex-telegram-bot-home.service`처럼 분리하고 `.env` 경로도 각각 별도로 두는 편이 안전합니다.
- `/recent` 는 `~/.codex/sessions` 아래 JSONL의 `session_meta.payload.cwd` 를 읽어와서 번호와 함께 `session_id + cwd`를 보여줍니다.
- `/attach` 는 `session_id` 직접 입력도 가능하고, 방금 본 `/recent` 번호로도 붙일 수 있습니다.
- `/attach` 에서 `cwd`를 생략하면 최근 목록 또는 세션 메타에서 자동으로 찾아 붙입니다.
- `/attach` 도 Git repo 경로면 전용 worktree를 새로 만들어 그 경로에서 기존 세션을 이어갑니다.
- `/close` 는 봇 연결만 닫고 원본 Codex 세션과 worktree는 남겨둡니다.
- `/drop` 은 봇 연결을 지우고 관리형 worktree도 함께 제거하지만, 원본 Codex 세션 기록은 삭제하지 않습니다.
- `/drop` 은 `git worktree remove --force` 를 사용하므로, 아직 커밋하지 않은 변경도 삭제될 수 있습니다.
