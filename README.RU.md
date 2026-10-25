# visend

Отправляйте файлы и текст **себе** в Telegram прямо из любого терминала.

```sh
ls | visend
visend text "запомнить это"
visend file report.pdf
cat dump.sql | visend file --name dump.sql
```

Быстро ставится, ноль рантайм-зависимостей, работает на Windows / Linux / macOS:
в репозитории три взаимозаменяемые реализации — nodejs (без зависимостей,
node >= 10), bash+curl и PowerShell — с общим конфигом.

> **Про безопасность.** visend сделан для dev-задач и пет-проектов. Режим
> общего сервера — это передача текста и файлов через сторонний сервер: не
> используйте его для чувствительных данных. Для этого — свой бот (прямой
> доступ к Telegram API) или собственный сервер.

## Содержание

- [Установка](#установка)
- [Настройка](#настройка)
- [Использование](#использование)
- [Как это работает](#как-это-работает)
- [Свой сервер](#свой-сервер)
- [Разработка](#разработка)

## Установка

### npm (любая ОС с node >= 10)

```sh
npx visend            # попробовать без установки
npm i -g visend       # установить
```

### Debian / Ubuntu (apt-репозиторий)

```sh
curl -fsSL https://repo.visend.vishota.com/apt-repo-public.asc | sudo tee /etc/apt/trusted.gpg.d/visend.asc
echo "deb [signed-by=/etc/apt/trusted.gpg.d/visend.asc] https://repo.visend.vishota.com/apt stable main" | sudo tee /etc/apt/sources.list.d/visend.list
sudo apt update && sudo apt install visend
```

Пакет архитектурно-независимый (`all`), зависит от `nodejs (>= 16) | curl`:
диспетчер `/usr/bin/visend` выбирает node-реализацию, если node доступен,
иначе откатывается на bash+curl.

### Alpine (apk-репозиторий)

```sh
sudo curl -fsSL -o /etc/apk/keys/visend-repo.rsa.pub https://repo.visend.vishota.com/apk/visend-repo.rsa.pub
echo "https://repo.visend.vishota.com/apk" | sudo tee -a /etc/apk/repositories
sudo apk update && sudo apk add visend
```

(Пакет `noarch` — один и тот же apk раздаётся для x86_64 и aarch64.)

### Arch Linux (AUR)

```sh
yay -S visend        # или любой AUR-хелпер
```

### Windows

Сейчас работают три способа:

- **npm** (при установленном node): `npm i -g visend` или `npx visend`.
- **PowerShell-скрипт** (node не нужен): скачайте
  [powershell/visend.ps1](powershell/visend.ps1), запускайте
  `visend.ps1 text "привет"`; нативные пайпы (`type file.log | visend.ps1 file`)
  бинарно-безопасны. Нюанс: пайп изнутри PowerShell-сессии
  (`"x" | visend.ps1`) не поддерживается — передавайте текст аргументом или
  пайпьте из программ.
- **Git Bash / WSL**: bash-версия или npm.

Запланировано (фаза 2, пока недоступно): портабельный exe-zip, scoop и winget.
Шаблоны манифестов лежат в `packaging/`; пока нет билд-джобы, файла
`visend-<version>-win-x64.zip` не существует.

## Настройка

```sh
visend setup
```

Предлагается два режима:

1. **Общий сервер** (быстрее всего, бот не нужен): откройте ссылку на бота,
   пошлите `/start`, получите свой user id и одноразовый код, введите их в
   setup. Сервер выдаст pairing-токен; токен телеграм-бота на вашу машину
   не попадает.
2. **Свой бот** (максимальная приватность): вставьте токен от
   [@BotFather](https://t.me/BotFather), пошлите боту `/start` — visend сам
   определит ваш user id (ручной ввод через [@userinfobot](https://t.me/userinfobot)
   всегда доступен как запасной вариант).

Setup завершается тестовым сообщением в ваш чат.

## Использование

```
visend                                 stdin в пайпе = `visend text`, иначе help
visend text [текст...] [--force-as-text]
visend file [путь] [--name <имя>]
visend setup
visend settings
visend forget [-y|--yes]
visend server
visend server set <url> [-y|--yes]
visend server reset [-y|--yes]
visend help
```

- `ls | visend` — любой пайп уходит текстом; бинарный ввод детектится, и вас
  переспросят (или отправят к `visend file`).
- Текст длиннее 4096 символов автоматически уходит файлом `visend.txt`;
  флаг `--force-as-text` шлёт сообщением, невзирая на обрезку Telegram.
- `visend file` с пайпом буферизует stdin в файл `visend.txt` (имя меняется
  через `--name`). С аргументом-путём отправляется указанный файл.
- Файлы больше 50 МБ отклоняются локально (лимит Bot API). Свой сервер может
  иметь более строгий лимит — visend честно сообщает, что лимит серверный.
- Флаги идут **после** позиционных аргументов: `visend text hello --force-as-text`.
- `-y / --yes` отвечает «да» на все вопросы (нужен в неинтерактивных средах —
  подтверждения читаются из терминала, а не из stdin).

Настройки лежат в `~/.config/visend/config.json` (на Windows — в профиле
пользователя), доступ ограничен владельцем (chmod 600 / ACL Windows).
`visend settings` показывает их (токены маскируются); `visend forget` стирает
всё, кроме URL сервера.

## Как это работает

```
+--------+   режим: бот       +----------------+        +-----------+
| visend | ----------------> | api.telegram.org| -----> | ваш чат   |
+--------+                   +----------------+        +-----------+
     |   режим: сервер
     |  +-------------+   POST /text /file    +----------------+
     +->| visend server| --------------------> | api.telegram.org|
        +-------------+   (Bearer JWT-токен)   +----------------+
```

- **Свой бот**: CLI ходит в Telegram Bot API напрямую, токен хранится только
  у вас.
- **Сервер**: одноразовое сопряжение по коду (бот выдаёт на `/start`, код
  живёт 1 час, 5 неверных попыток сжигают его), затем **пара токенов**:
  access на 24 часа и ротируемый refresh на 180 дней (JWT, HS256, внутри только
  user_id и тип). Когда access истекает, CLI сам обновляет пару, сохраняет её и
  повторяет запрос — для вас это незаметно. Сервер токены не хранит: сменили
  `SERVER_SECRET` — все токены отозваны.

## Свой сервер

Сервер — один docker-контейнер (Express + jose на node 24), без базы данных и
volume'ов. Токен бота — у [@BotFather](https://t.me/BotFather), дальше:

```sh
mkdir -p secrets
echo "123456:ВАШ-ТОКЕН-БОТА" > secrets/telegram_bot_token.txt
head -c 32 /dev/urandom | base64 > secrets/server_secret.txt   # держите его неизменным!
docker run -d --name visend-server -p 8080:8080 \
  --secret source=telegram_bot_token,target=telegram_bot_token,src=secrets/telegram_bot_token.txt \
  --secret source=server_secret,target=server_secret,src=secrets/server_secret.txt \
  ghcr.io/vishota/visend-server:latest
```

или через [compose.example.yml](server/compose.example.yml):

```sh
docker compose -f server/compose.example.yml up -d
```

Затем направьте клиентов на него:

```sh
visend server set https://visend.example.com
visend setup
```

Настройки:

| Параметр | Как задать | Примечание |
|---|---|---|
| Токен бота | docker secret `telegram_bot_token` / env `TELEGRAM_BOT_TOKEN` | обязателен |
| Секрет подписи токенов | docker secret `server_secret` / env `SERVER_SECRET` | обязателен; одинаковый секрет = токены живут через рестарты; смена = отзыв всех |
| Белый список user id | env `ALLOWED_USER_IDS=123,456` | опционально; мусорное значение = отказ старта (fail-closed) |
| Макс. размер файла | env `MAX_FILE_SIZE` (байты, по умолчанию 50 МБ) | также ранний гейт по Content-Length |
| Макс. одновременных загрузок | env `MAX_CONCURRENT_UPLOADS` (по умолчанию 8) | память: auth и заявленный размер проверяются ДО чтения тела |
| TTL access-токена | env `ACCESS_TOKEN_TTL` (по умолчанию `24h`) | истёк -> 401 `token_expired`, клиент сам обновляет |
| TTL refresh-токена | env `REFRESH_TOKEN_TTL` (по умолчанию `180d`) | ротируется при каждом обновлении |
| Доверять реверс-прокси | env `TRUST_PROXY=1` | только тогда X-Forwarded-For участвует в rate limit |
| Порт | env `PORT` (по умолчанию 8080) | |

Эндпоинты: `GET /status`, `GET /config`, `POST /connect {user_id, code}`,
`POST /refresh` (Bearer refresh-токен), `POST /text` и `POST /file?name=...`
(Bearer access-токен, тело — raw). Auth и заявленный Content-Length
проверяются **до** чтения тела запроса, одновременные загрузки ограничены —
анонимные и сверхлимитные запросы отвергаются без буферизации.

Важно: сервер получает апдейты бота через getUpdates-поллинг, поэтому на один
токен бота — **ровно один инстанс** (второй поллер получит HTTP 409).

## Разработка

```
nodejs/       node CLI (ноль зависимостей, node >= 10.12)
bash/         bash CLI (curl + coreutils)
powershell/   PowerShell CLI (PS 5.1+)
server/       TS-сервер (Express + jose), docker-образ
packaging/    шаблоны deb/apk/AUR/winget/scoop + диспетчер + ключи
tests/        e2e-наборы с моком Telegram API и моком visend-сервера
```

Запуск тестов:

```sh
node tests/run.js         # e2e node CLI (50 проверок)
node tests/run-bash.js    # e2e bash CLI (31 проверка; linux/MSYS)
node tests/run-server.js  # интеграция сервера (35 проверок; сначала собрать)
node tests/run-ps.js      # e2e powershell (24 проверки; windows)
```

Релизы управляются тегами (`git tag v1.2.3 && git push --tags`): CI линтит все
три платформы, гоняет тесты на node 10.12/12/16/24 плюс отдельный job на
Windows PowerShell 5.1, собирает релизную папку (tarball, .deb, .apk,
checksums), публикует GitHub Release, npm-пакет, apt+apk-репозитории на
gh-pages (pool хранит старые версии для отката), пакет в AUR и docker-образ.

Лицензия MIT — см. [LICENSE](LICENSE). English docs: [README.md](README.md).
