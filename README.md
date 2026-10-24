# visend

Send files and text **to yourself** via Telegram, straight from any terminal.

```sh
ls | visend
visend text "remember this"
visend file report.pdf
cat dump.sql | visend file --name dump.sql
```

Fast to install, zero runtime dependencies, works on Windows / Linux / macOS:
three interchangeable implementations ship in this repo — nodejs (no deps,
node >= 10), bash+curl, and PowerShell — all sharing one config.

> **Security note.** visend is built for dev work and pet projects. Treat the
> shared server mode as untrusted transit: your text and files pass through a
> third-party server. Do not use it for sensitive data — use your own bot
> (direct Telegram API) or host your own server instead.

## Contents

- [Install](#install)
- [Setup](#setup)
- [Usage](#usage)
- [How it works](#how-it-works)
- [Self-hosting the server](#self-hosting-the-server)
- [Development](#development)

## Install

### npm (any OS with node >= 10)

```sh
npx visend            # try it without installing
npm i -g visend       # install
```

### Debian / Ubuntu (apt repository)

```sh
curl -fsSL https://repo.visend.vishota.com/apt-repo-public.asc | sudo tee /etc/apt/trusted.gpg.d/visend.asc
echo "deb [signed-by=/etc/apt/trusted.gpg.d/visend.asc] https://repo.visend.vishota.com/apt stable main" | sudo tee /etc/apt/sources.list.d/visend.list
sudo apt update && sudo apt install visend
```

The package is architecture-independent (`all`) and depends on
`nodejs (>= 16) | curl` — the `/usr/bin/visend` dispatcher picks the nodejs
implementation when node is available and falls back to bash+curl otherwise.

### Alpine (apk repository)

```sh
sudo curl -fsSL -o /etc/apk/keys/visend-repo.rsa.pub https://repo.visend.vishota.com/apk/visend-repo.rsa.pub
echo "https://repo.visend.vishota.com/apk" | sudo tee -a /etc/apk/repositories
sudo apk update && sudo apk add visend
```

(The package is `noarch` — the same apk is served for x86_64 and aarch64.)

### Arch Linux (AUR)

```sh
yay -S visend        # or any AUR helper
```

### Windows

- **scoop** (uses the portable exe zip; no node required):

  ```powershell
  scoop bucket add vishota https://github.com/vishota/scoop-bucket
  scoop install visend
  ```

- **winget** — in progress (phase 2; PR to `microsoft/winget-pkgs`).
- Manual: grab `visend-<version>-win-x64.zip` from the
  [releases](https://github.com/vishota/visend/releases) page, unpack, add to
  `PATH`.
- With PowerShell and no exe: `powershell/visend.ps1` from this repo works as-is.

## Setup

```sh
visend setup
```

Two modes are offered:

1. **Shared server** (fastest, no bot needed): open the bot link the setup
   shows, send `/start`, receive your user id and a one-time code, paste both
   back into the setup. Done. The server hands out a pairing token; your
   Telegram bot token never touches your machine.
2. **Your own bot** (most private): paste a token from
   [@BotFather](https://t.me/BotFather), then send `/start` to your bot —
   visend detects your user id automatically (manual input with
   [@userinfobot](https://t.me/userinfobot) is always available as fallback).

Setup ends with a test message to your chat.

## Usage

```
visend                                 with piped stdin = `visend text`, else help
visend text [text...] [--force-as-text]
visend file [path] [--name <name>]
visend setup
visend settings
visend forget [-y|--yes]
visend server
visend server set <url> [-y|--yes]
visend server reset [-y|--yes]
visend help
```

- `ls | visend` — pipe anything as text; binary content is detected and you
  are asked to confirm (or pointed to `visend` file mode).
- Text longer than 4096 characters is sent as `visend.txt` automatically; use
  `--force-as-text` to send it as a message anyway (Telegram will cut it).
- `visend file` with piped stdin buffers it into a file named `visend.txt`
  (override with `--name`). With a path argument it sends that file.
- Files over 50 MB are rejected locally (Telegram bot API limit). A
  self-hosted server may impose a stricter limit — visend reports it as a
  server-side limit.
- Flags go **after** positional arguments: `visend text hello --force-as-text`.
- `-y / --yes` answers all confirmation prompts (required in non-interactive
  environments — prompts are read from the terminal, not stdin).

Settings live in `~/.config/visend/config.json` (`%USERPROFILE%` on Windows),
restricted to your user (chmod 600 / Windows ACL). `visend settings` shows
them (tokens are masked); `visend forget` wipes everything except the server
URL.

## How it works

```
+--------+   mode: bot       +----------------+        +-----------+
| visend | ----------------> | api.telegram.org| -----> | your chat |
+--------+                   +----------------+        +-----------+
     |   mode: server
     |  +-------------+   POST /text /file    +----------------+
     +->| visend server| --------------------> | api.telegram.org|
        +-------------+   (Bearer JWT token)   +----------------+
```

- **Own bot mode** talks to the Telegram Bot API directly; the token is stored
  only on your machine.
- **Server mode** pairs once with a one-time code (issued by the bot on
  `/start`, valid 1 h, 5 wrong attempts burn it) and receives a JWT signed
  with the server's secret. The server stores no tokens: rotate `SERVER_SECRET`
  to revoke everything.

## Self-hosting the server

The server is a single docker container (Express + jose on node 24), no
database, no volumes. Get your own bot token from [@BotFather](https://t.me/BotFather), then:

```sh
mkdir -p secrets
echo "123456:YOUR-BOT-TOKEN" > secrets/telegram_bot_token.txt
head -c 32 /dev/urandom | base64 > secrets/server_secret.txt   # keep it stable!
docker run -d --name visend-server -p 8080:8080 \
  --secret source=telegram_bot_token,target=telegram_bot_token,src=secrets/telegram_bot_token.txt \
  --secret source=server_secret,target=server_secret,src=secrets/server_secret.txt \
  ghcr.io/vishota/visend-server:latest
```

or with the bundled [compose.example.yml](server/compose.example.yml):

```sh
docker compose -f server/compose.example.yml up -d
```

Then point your clients at it:

```sh
visend server set https://visend.example.com
visend setup
```

Configuration:

| Setting | How | Notes |
|---|---|---|
| Bot token | docker secret `telegram_bot_token` / env `TELEGRAM_BOT_TOKEN` | required |
| Token signing secret | docker secret `server_secret` / env `SERVER_SECRET` | required; same secret = tokens survive restarts; rotate to revoke all |
| User allow list | env `ALLOWED_USER_IDS=123,456` | optional; restricts who may pair |
| Max file size | env `MAX_FILE_SIZE` (bytes, default 50 MB) | optional |
| Port | env `PORT` (default 8080) | |

Endpoints: `GET /status`, `GET /config`, `POST /connect {user_id, code}`,
`POST /text` and `POST /file?name=...` (Authorization: Bearer JWT, raw body).

Note: the server consumes bot updates via getUpdates polling, so **exactly one
instance** may run per bot token (a second poller gets HTTP 409 from Telegram).

## Development

```
nodejs/       node CLI (zero dependencies, node >= 10)
bash/         bash CLI (curl + coreutils)
powershell/   PowerShell CLI (PS 5.1+)
server/       TS server (Express + jose), docker image
packaging/    deb/apk/AUR/winget/scoop templates + dispatcher + keys
tests/        e2e suites with a mock Telegram API and a mock visend server
```

Run the test suites:

```sh
node tests/run.js         # node CLI e2e (45 checks)
node tests/run-bash.js    # bash CLI e2e (27 checks; linux/MSYS)
node tests/run-server.js  # server integration (23 checks; build server first)
node tests/run-ps.js      # powershell e2e (21 checks; windows)
```

Releases are tag-driven (`git tag v1.2.3 && git push --tags`): CI lints all
three platforms, runs the suites on node 10/12/16/24, builds the release
directory (tarball, .deb, .apk, checksums), publishes the GitHub Release, npm
package, apt+apk repositories on gh-pages, AUR package and the docker image.

MIT License — see [LICENSE](LICENSE). [README.RU.md](README.RU.md) — документация на русском.
