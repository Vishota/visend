*still in work currently, has not been published anywhere yet*

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

Today, three ways work:

- **npm** (with node installed): `npm i -g visend` or `npx visend`.
- **PowerShell script** (no node needed): download
  [powershell/visend.ps1](powershell/visend.ps1), run
  `visend.ps1 text "hello"`; native pipes (`type file.log | visend.ps1 file`)
  are binary-safe. Note: piping from *inside* a PowerShell session
  (`"x" | visend.ps1`) is not supported - pass text as arguments or pipe from
  programs.
- **Git Bash / WSL**: use the bash version or npm.

Planned (phase 2, not yet available): a portable exe zip, scoop and winget
channels. The manifest templates live in `packaging/`; until the bundling
job exists there is no `visend-<version>-win-x64.zip` to download.

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
  `/start`, valid 1 h, 5 wrong attempts burn it) and receives a **token pair**:
  a 24 h access token and a rotating 180-day refresh token (JWT, HS256, only
  user_id + type inside). When the access token expires, the CLI refreshes the
  pair automatically, persists it and retries - you never notice. The server
  stores no tokens: rotate `SERVER_SECRET` to revoke everything.

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
| User allow list | env `ALLOWED_USER_IDS=123,456` | optional; restricts who may pair; garbage in the value refuses to start (fail-closed) |
| Max file size | env `MAX_FILE_SIZE` (bytes, default 50 MB) | optional; also the early Content-Length gate |
| Max concurrent uploads | env `MAX_CONCURRENT_UPLOADS` (default 8) | memory bound: auth + declared size are checked before the body is read |
| Access token TTL | env `ACCESS_TOKEN_TTL` (default `24h`) | expired access -> 401 `token_expired`; clients auto-refresh |
| Refresh token TTL | env `REFRESH_TOKEN_TTL` (default `180d`) | refresh rotates on every use |
| Trust reverse proxy | env `TRUST_PROXY=1` | only then X-Forwarded-For is used for rate limiting |
| Port | env `PORT` (default 8080) | |

Endpoints: `GET /status`, `GET /config`, `POST /connect {user_id, code}`,
`POST /refresh` (Bearer refresh token), `POST /text` and `POST /file?name=...`
(Bearer access token, raw body). Auth and the declared Content-Length are
verified **before** the request body is read, and concurrent uploads are
capped - anonymous or oversized requests are rejected without buffering.

Note: the server consumes bot updates via getUpdates polling, so **exactly one
instance** may run per bot token (a second poller gets HTTP 409 from Telegram).

## Development

```
nodejs/       node CLI (zero dependencies, node >= 10.12)
bash/         bash CLI (curl + coreutils)
powershell/   PowerShell CLI (PS 5.1+)
server/       TS server (Express + jose), docker image
packaging/    deb/apk/AUR/winget/scoop templates + dispatcher + keys
tests/        e2e suites with a mock Telegram API and a mock visend server
```

Run the test suites:

```sh
node tests/run.js         # node CLI e2e (50 checks)
node tests/run-bash.js    # bash CLI e2e (31 checks; linux/MSYS)
node tests/run-server.js  # server integration (35 checks; build server first)
node tests/run-ps.js      # powershell e2e (24 checks; windows)
```

Releases are tag-driven (`git tag v1.2.3 && git push --tags`): CI lints all
three platforms, runs the suites on node 10.12/12/16/24 plus a Windows
PowerShell 5.1 job, builds the release directory (tarball, .deb, .apk,
checksums), publishes the GitHub Release, npm package, apt+apk repositories on
gh-pages (pool keeps old versions for rollback), AUR package and the docker
image.

MIT License — see [LICENSE](LICENSE). [README.RU.md](README.RU.md) — документация на русском.
