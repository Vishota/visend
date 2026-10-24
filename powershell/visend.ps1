# visend - send files and text to yourself via Telegram.
# visend is a fast cross-platform tool way to send anything to telegram.
#
# Author:  vishota
# Repo:    https://github.com/vishota/visend
# Docs:    https://github.com/vishota/visend#readme
#
# Pure Windows PowerShell 5.1+ implementation (no dependencies).
# Shares the config file with the nodejs/bash implementations:
#   ~\.config\visend\config.json
#
# Usage: visend.ps1 [command] [args] [-y] [--name <name>] [--force-as-text]

#require -Version 5.1

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Windows PowerShell 5.1 defaults do not include TLS 1.2 on older systems.
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch { }

$script:DefaultServerUrl = 'https://visend.vishota.com'
$script:TgApiBase = if ($env:VISEND_TELEGRAM_API_BASE) { $env:VISEND_TELEGRAM_API_BASE } else { 'https://api.telegram.org' }
$script:TelegramTextLimit = 4096
$script:TelegramFileLimit = 50MB
$script:AssumeYes = $false
$script:ForceAsText = $false
$script:OptName = $null

Add-Type -AssemblyName System.Net.Http | Out-Null

function Write-Out2([string]$Text) { Write-Host $Text }
function Write-Warn2([string]$Text) { Write-Host "Warning: $Text" }
function Die([string]$Message) {
    Write-Host "Error: $Message" -ForegroundColor Red
    exit 1
}

# ---------------------------------------------------------------- config ---

function Get-ConfigPath {
    Join-Path $env:USERPROFILE '.config\visend\config.json'
}

function Load-Config {
    $path = Get-ConfigPath
    $cfg = @{}
    if (Test-Path $path) {
        try {
            $raw = Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json
            foreach ($p in $raw.PSObject.Properties) {
                if ($null -ne $p.Value -and "$($p.Value)" -ne '') { $cfg[$p.Name] = $p.Value }
            }
        } catch {
            Die "Settings file is corrupted ($path). Fix it manually or remove it, then run 'visend setup' again."
        }
    }
    return ,$cfg
}

function Save-Config([hashtable]$Cfg) {
    $path = Get-ConfigPath
    $dir = Split-Path $path -Parent
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    # Restrict ACL to the current user.
    try {
        & icacls.exe $dir /inheritance:r /grant:r "${env:USERDOMAIN}\${env:USERNAME}:(OI)(CI)F" | Out-Null
    } catch { }

    $clean = @{}
    foreach ($k in @('mode', 'bot_token', 'user_id', 'server_url', 'server_token')) {
        if ($Cfg.ContainsKey($k) -and $null -ne $Cfg[$k] -and "$($Cfg[$k])" -ne '') { $clean[$k] = $Cfg[$k] }
    }
    if ($clean.Count -eq 0) {
        if (Test-Path $path) { Remove-Item -LiteralPath $path -Force }
        return
    }
    $tmp = Join-Path $dir ('.config-' + [Guid]::NewGuid().ToString('N').Substring(0, 8) + '.tmp')
    $json = $clean | ConvertTo-Json -Depth 3
    [IO.File]::WriteAllText($tmp, $json + "`n", (New-Object Text.UTF8Encoding($false)))
    try {
        & icacls.exe $tmp /inheritance:r /grant:r "${env:USERDOMAIN}\${env:USERNAME}:F" | Out-Null
    } catch { }
    Move-Item -LiteralPath $tmp -Destination $path -Force
}

function Get-EffectiveServerUrl([hashtable]$Cfg) {
    if ($Cfg.ContainsKey('server_url') -and $Cfg['server_url']) { "$($Cfg['server_url'])" } else { $script:DefaultServerUrl }
}

function Require-Setup([hashtable]$Cfg) {
    if ($Cfg['mode'] -eq 'bot' -and $Cfg['bot_token'] -and $Cfg['user_id']) { return }
    if ($Cfg['mode'] -eq 'server' -and $Cfg['user_id']) {
        if (-not $Cfg['server_token']) {
            Die "The server token is missing (the server URL was changed after setup). Run 'visend setup' again to get a new one-time code."
        }
        return
    }
    Die 'visend is not configured yet. Run "visend setup" first.'
}

# ------------------------------------------------------------------ tty ---

# Read-Host reads from the console even when pipeline input is redirected.
function Confirm-Action([string]$Question) {
    if ($script:AssumeYes) { return $true }
    $reply = Read-Host "$Question [y/N]"
    return $reply -match '^\s*y(es)?\s*$'
}

function Read-Required([string]$Question) {
    while ($true) {
        $v = (Read-Host $Question)
        if ($v -and $v.Trim()) { return $v.Trim() }
        Write-Host 'Value is required.'
    }
}

function Read-UserId([string]$Question) {
    while ($true) {
        $v = (Read-Host $Question).Trim()
        if ($v -match '^\d{1,16}$') { return [long]$v }
        Write-Host 'User id must be a number (yours from @userinfobot).'
    }
}

# ------------------------------------------------------------------ net ---

function Get-HttpErrorDescription($ErrorRecord) {
    $result = @{ message = "$($ErrorRecord)"; error = $null; maxFileSize = $null }
    try {
        if ($ErrorRecord.Exception.Response) {
            $code = [int]$ErrorRecord.Exception.Response.StatusCode
            $result.message = "HTTP $code"
            # Invoke-RestMethod usually consumes the stream itself in PS 5.1;
            # ErrorDetails.Message holds the body then.
            $raw = $null
            if ($ErrorRecord.ErrorDetails -and $ErrorRecord.ErrorDetails.Message) {
                $raw = $ErrorRecord.ErrorDetails.Message
            } elseif ($ErrorRecord.Exception.Response.GetResponseStream()) {
                $reader = New-Object IO.StreamReader($ErrorRecord.Exception.Response.GetResponseStream())
                $raw = $reader.ReadToEnd()
            }
            if ($raw) {
                try {
                    $parsed = $raw | ConvertFrom-Json
                    $result.error = $parsed.error
                    $result.maxFileSize = $parsed.max_file_size
                    if ($parsed.description) { $result.message = "HTTP $code $($parsed.description)" }
                    elseif ($parsed.error) { $result.message = "HTTP $code $($parsed.error)" }
                } catch {
                    $result.message = "HTTP $code $raw"
                }
            }
        }
    } catch { }
    return $result
}

function Invoke-Tg([string]$Method, [object]$Payload) {
    $url = "$script:TgApiBase/bot$($script:BotToken)/$Method"
    $irm = @{
        Uri         = $url
        Method      = 'Post'
        TimeoutSec  = 60
        ErrorAction = 'Stop'
    }
    if ($Payload) {
        $irm.Body = ($Payload | ConvertTo-Json -Compress -Depth 5)
        $irm.ContentType = 'application/json'
    }
    try {
        return Invoke-RestMethod @irm
    } catch {
        $info = Get-HttpErrorDescription $_
        throw [Exception]"Telegram API error: $($info.message)"
    }
}

function Send-TelegramText([string]$Token, [long]$ChatId, [string]$Text) {
    $url = "$script:TgApiBase/bot$Token/sendMessage"
    try {
        return Invoke-RestMethod -Uri $url -Method Post -TimeoutSec 60 -ErrorAction Stop -Body (@{ chat_id = $ChatId; text = $Text; disable_web_page_preview = $true } | ConvertTo-Json -Compress) -ContentType 'application/json'
    } catch {
        Die "Telegram API error: $_"
    }
}

function Send-TelegramFile([string]$Token, [long]$ChatId, [byte[]]$Bytes, [string]$FileName) {
    $url = "$script:TgApiBase/bot$Token/sendDocument"
    $client = New-Object Net.Http.HttpClient
    $client.Timeout = [TimeSpan]::FromMinutes(5)
    try {
        $form = New-Object Net.Http.MultipartFormDataContent
        $form.Add([Net.Http.StringContent]::new("$ChatId"), 'chat_id') | Out-Null
        $fileContent = New-Object Net.Http.ByteArrayContent(, $Bytes)
        $fileContent.Headers.ContentType = [Net.Http.Headers.MediaTypeHeaderValue]::Parse('application/octet-stream')
        $form.Add($fileContent, 'document', $FileName) | Out-Null
        $resp = $client.PostAsync($url, $form).GetAwaiter().GetResult()
        $body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        $json = $body | ConvertFrom-Json
        if (-not $json.ok) { Die "Telegram API error: $($json.description)" }
        return $json
    } finally {
        $client.Dispose()
    }
}

function Invoke-ServerRequest([string]$Url, [string]$Method, [hashtable]$Headers, [byte[]]$BodyBytes, [string]$ContentType) {
    $irm = @{ Uri = $Url; Method = $Method; TimeoutSec = 300; ErrorAction = 'Stop' }
    if ($Headers) { $irm.Headers = $Headers }
    if ($BodyBytes) { $irm.Body = $BodyBytes }
    if ($ContentType) { $irm.ContentType = $ContentType }
    try {
        return Invoke-RestMethod @irm
    } catch {
        $info = Get-HttpErrorDescription $_
        if ($info.error -eq 'file_too_large' -and $info.maxFileSize) {
            $mb = [math]::Round($info.maxFileSize / 1MB, 1)
            Die "The server rejected the file: its own size limit is $mb MB (this is a server-side limit, not the Telegram one)."
        }
        Die "Request to server failed: $($info.message)"
    }
}

# --------------------------------------------------------------- content ---

function Test-Binary([byte[]]$Bytes, [ref]$Reason) {
    $sampleLen = [Math]::Min($Bytes.Length, 8192)
    for ($i = 0; $i -lt $sampleLen; $i++) {
        if ($Bytes[$i] -eq 0) { $Reason.Value = 'contains NUL bytes'; return $true }
    }
    try {
        $strict = New-Object Text.UTF8Encoding($false, $true)
        $null = $strict.GetString($Bytes, 0, $sampleLen)
    } catch {
        $Reason.Value = 'is not valid UTF-8'
        return $true
    }
    return $false
}

function Get-Preview([byte[]]$Bytes) {
    $n = [Math]::Min($Bytes.Length, 64)
    $sb = New-Object Text.StringBuilder
    $text = [Text.Encoding]::UTF8.GetString($Bytes, 0, $n)
    foreach ($ch in $text.ToCharArray()) {
        $code = [int]$ch
        if ($ch -eq "`n") { $null = $sb.Append('\n') }
        elseif ($ch -eq "`r") { $null = $sb.Append('\r') }
        elseif ($ch -eq "`t") { $null = $sb.Append('\t') }
        elseif ($code -lt 32 -or $code -eq 127) { $null = $sb.Append('\x' + $code.ToString('x2')) }
        else { $null = $sb.Append($ch) }
    }
    if ($Bytes.Length -gt $n) { $null = $sb.Append('...') }
    return $sb.ToString()
}

function Get-StdinText {
    # Pipeline input is captured at script level into $script:StdinText before
    # Main runs ($input is not visible inside functions).
    return $script:StdinText
}

# ---------------------------------------------------------------- send ----

function Send-Text([hashtable]$Cfg, [string]$Text) {
    Require-Setup $Cfg
    if (-not $Text.Trim()) { Die 'Refusing to send an empty message.' }
    if ($Cfg['mode'] -eq 'bot') {
        $r = Send-TelegramText "$($Cfg['bot_token'])" ([long]$Cfg['user_id']) $Text
        Write-Out2 "Text sent to Telegram (message_id $($r.result.message_id))."
        return
    }
    $url = (Get-EffectiveServerUrl $Cfg) + '/text'
    $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
    $headers = @{ Authorization = "Bearer $($Cfg['server_token'])" }
    $r = Invoke-ServerRequest $url 'Post' $headers $bytes 'text/plain; charset=utf-8'
    Write-Out2 "Text sent to Telegram via $(Get-EffectiveServerUrl $Cfg) (message_id $($r.message_id))."
}

function Send-File([hashtable]$Cfg, [byte[]]$Bytes, [string]$Name) {
    Require-Setup $Cfg
    if ($Bytes.Length -gt $script:TelegramFileLimit) {
        $mb = [math]::Round($Bytes.Length / 1MB, 1)
        Die "The file is $mb MB, but Telegram bots can only send files up to 50 MB."
    }
    if ($Cfg['mode'] -eq 'bot') {
        $null = Send-TelegramFile "$($Cfg['bot_token'])" ([long]$Cfg['user_id']) $Bytes $Name
        $mb = [math]::Round($Bytes.Length / 1MB, 1)
        Write-Out2 "File `"$Name`" ($mb MB) sent to Telegram."
        return
    }
    $url = (Get-EffectiveServerUrl $Cfg) + '/file?name=' + [Uri]::EscapeDataString($Name)
    $headers = @{ Authorization = "Bearer $($Cfg['server_token'])" }
    $null = Invoke-ServerRequest $url 'Post' $headers $Bytes 'application/octet-stream'
    $mb = [math]::Round($Bytes.Length / 1MB, 1)
    Write-Out2 "File `"$Name`" ($mb MB) sent to Telegram via $(Get-EffectiveServerUrl $Cfg)."
}

# -------------------------------------------------------------- commands ---

$script:HelpText = @'
visend - send files and text to yourself via Telegram

Usage:
  visend                                 same as `visend text` when stdin is piped,
                                         otherwise shows this help
  visend text [text...] [--force-as-text]
                                         send text; multiple arguments are joined with
                                         spaces; piped stdin is sent as the text
  visend file [path] [--name <name>]     send a file; with piped stdin sends it as a
                                         file named visend.txt (or --name)
  visend setup                           pair visend with your Telegram (own bot or
                                         shared server)
  visend settings                        show current settings
  visend forget [-y|--yes]               delete all settings except the server URL
  visend server                          show server URL, status and bot link
  visend server set <url> [-y|--yes]     switch to another visend server
  visend server reset [-y|--yes]         switch back to the default server
  visend help                            show this help

Options:
  -y, --yes           answer "yes" to all confirmation prompts
  --name <name>       file name to use for `visend file`
  --force-as-text     send text longer than 4096 chars as text anyway (it will be cut
                      to the Telegram limit)
  -h, --help          show this help

Flags go after positional arguments: `visend text hello --force-as-text`.

Examples:
  ls | visend
  cat log.txt | visend text
  visend text hello world
  visend file report.pdf
  cat data.csv | visend file --name data.csv

Docs: https://github.com/Vishota/visend
'@

function Cmd-Help { Write-Host $script:HelpText }

function Cmd-Text([string[]]$Positional) {
    $textArg = ($Positional -join ' ')
    $cfg = Load-Config
    $stdinText = Get-StdinText
    $hasStdin = $null -ne $stdinText

    if ($textArg -and $hasStdin) {
        Write-Warn2 'stdin ignored - the text argument takes priority.'
    }
    if ($textArg) {
        $text = $textArg
    } elseif ($hasStdin) {
        if ($stdinText.Length -eq 0) {
            Die 'Nothing to send - stdin is empty. Pipe something in (e.g. Get-Content notes.txt | visend text) or pass the text as an argument (visend text hello world).'
        }
        $text = $stdinText
    } else {
        Die 'Nothing to send. Pipe something in (e.g. Get-Content notes.txt | visend text) or pass the text as an argument (visend text hello world).'
    }

    $bytes = [Text.Encoding]::UTF8.GetBytes($text)
    $reason = ''
    $isBinary = Test-Binary $bytes ([ref]$reason)
    if ($isBinary) {
        Write-Warn2 "the input looks like binary data ($reason)."
        Write-Out2 ("First bytes: " + (Get-Preview $bytes))
        if (-not (Confirm-Action 'Send it as text anyway?')) {
            Die 'Aborted. Use "visend file" to send binary data as a file.'
        }
    }

    if ($script:ForceAsText) {
        if ($text.Length -gt $script:TelegramTextLimit) {
            Write-Warn2 "the input is $($text.Length) characters; Telegram cuts messages at $($script:TelegramTextLimit) characters. Sending the first $($script:TelegramTextLimit) (--force-as-text)."
            $text = $text.Substring(0, $script:TelegramTextLimit)
        }
        Send-Text $cfg $text
        return
    }

    if ($text.Length -gt $script:TelegramTextLimit) {
        Write-Warn2 "the input is $($text.Length) characters, but Telegram messages are capped at $($script:TelegramTextLimit) characters. Sending it as a file `"visend.txt`" instead. Use --force-as-text to send it as text anyway (it will be cut)."
        Send-File $cfg $bytes 'visend.txt'
        return
    }
    Send-Text $cfg $text
}

function Cmd-File([string[]]$Positional) {
    $cfg = Load-Config
    $pathArg = $Positional | Where-Object { $_ } | Select-Object -First 1
    $stdinText = Get-StdinText
    $hasStdin = $null -ne $stdinText

    if ($pathArg -and $hasStdin) {
        Write-Warn2 'stdin ignored - the file path takes priority.'
    }
    $bytes = $null
    $name = $script:OptName
    if ($pathArg) {
        if (-not (Test-Path -LiteralPath $pathArg -PathType Leaf)) {
            if (Test-Path -LiteralPath $pathArg -PathType Container) { Die "`"$pathArg`" is a directory. Pass a file path." }
            Die "Cannot read `"$pathArg`": no such file."
        }
        $bytes = [IO.File]::ReadAllBytes($pathArg)
        if (-not $name) { $name = Split-Path $pathArg -Leaf }
    } elseif ($hasStdin) {
        if ($stdinText.Length -eq 0) {
            Die 'Nothing to send - stdin is empty. Pipe something in (e.g. Get-Content report.pdf | visend file) or pass a file path (visend file report.pdf).'
        }
        $bytes = [Text.Encoding]::UTF8.GetBytes($stdinText)
        if (-not $name) { $name = 'visend.txt' }
    } else {
        Die 'Nothing to send. Pipe something in (e.g. Get-Content report.pdf | visend file) or pass a file path (visend file report.pdf).'
    }

    Send-File $cfg $bytes $name
}

function Cmd-Settings {
    $cfg = Load-Config
    Write-Out2 "Settings file: $(Get-ConfigPath)"
    if ($cfg['mode'] -eq 'bot') { Write-Out2 'Mode:          own bot (direct Telegram API)' }
    elseif ($cfg['mode'] -eq 'server') { Write-Out2 'Mode:          shared server' }
    else { Write-Out2 'Mode:          not configured (run "visend setup")' }
    Write-Out2 "User id:       $(if ($cfg['user_id']) { $cfg['user_id'] } else { 'not set' })"
    $srv = Get-EffectiveServerUrl $cfg
    $isDefault = -not $cfg['server_url']
    Write-Out2 "Server URL:    $srv$(if ($isDefault) { ' (default)' })"
    Write-Out2 "Bot token:     $(if ($cfg['bot_token']) { "$($cfg['bot_token'].ToString().Substring(0,4))...$($cfg['bot_token'].ToString().Substring($cfg['bot_token'].ToString().Length-4))" } else { 'not set' })"
    Write-Out2 "Server token:  $(if ($cfg['server_token']) { "$($cfg['server_token'].ToString().Substring(0,4))...$($cfg['server_token'].ToString().Substring($cfg['server_token'].ToString().Length-4))" } else { 'not set' })"
}

function Cmd-Forget {
    $cfg = Load-Config
    if (-not ($cfg['mode'] -or $cfg['bot_token'] -or $cfg['server_token'] -or $cfg['user_id'])) {
        Write-Out2 'Nothing to forget - visend is not configured.'
        return
    }
    if (-not (Confirm-Action 'Delete all visend settings (bot token, server token, user id)? The server URL is kept.')) {
        Die 'Aborted.'
    }
    $keep = @{}
    if ($cfg['server_url']) { $keep['server_url'] = $cfg['server_url'] }
    Save-Config $keep
    Write-Out2 "Settings removed ($(Get-ConfigPath)). Run 'visend setup' to start over."
}

function Get-ServerStatus([string]$Url) {
    try {
        return Invoke-RestMethod -Uri ($Url.TrimEnd('/') + '/status') -Method Get -TimeoutSec 10 -ErrorAction Stop
    } catch {
        return $null
    }
}

function Get-ServerConfig([string]$Url) {
    try {
        return Invoke-RestMethod -Uri ($Url.TrimEnd('/') + '/config') -Method Get -TimeoutSec 10 -ErrorAction Stop
    } catch {
        return $null
    }
}

function Format-Uptime([long]$Seconds) {
    $h = [math]::Floor($Seconds / 3600)
    $m = [math]::Floor(($Seconds % 3600) / 60)
    if ($h -gt 0) { return "${h}h ${m}m" }
    if ($m -gt 0) { return "${m}m $($Seconds % 60)s" }
    return "${Seconds}s"
}

function Cmd-ServerShow {
    $cfg = Load-Config
    $url = Get-EffectiveServerUrl $cfg
    Write-Out2 "Server: $url"
    $status = Get-ServerStatus $url
    if (-not $status -or -not $status.ok) {
        Write-Out2 'Status: unreachable - the server did not respond.'
        Write-Out2 ''
        Write-Out2 'You can host your own visend server from the official docker image and point'
        Write-Out2 'visend at it with "visend server set <url>" - see the README (Self-hosting).'
        return
    }
    Write-Out2 "Status: online (uptime $(Format-Uptime ([long]$status.uptime_seconds)))"
    $srvCfg = Get-ServerConfig $url
    if ($srvCfg -and $srvCfg.bot) {
        Write-Out2 "Bot: $($srvCfg.bot) (send /start to it to get your user id and a code)"
    } else {
        Write-Out2 'Bot: unknown (could not fetch server config).'
    }
}

function Apply-ServerUrl([hashtable]$Cfg, [string]$NewUrl) {
    $current = Get-EffectiveServerUrl $Cfg
    if ($NewUrl -eq $current) {
        Write-Out2 "Server URL is already $NewUrl - nothing to change."
        return
    }
    if ($NewUrl -eq $script:DefaultServerUrl) {
        $Cfg.Remove('server_url')
    } else {
        $Cfg['server_url'] = $NewUrl
    }
    if ($Cfg['mode'] -eq 'server' -and $Cfg['server_token']) {
        $Cfg.Remove('server_token')
        Save-Config $Cfg
        Write-Out2 'Server URL saved.'
        Write-Out2 ''
        Write-Out2 'Note: for security the old server token has been removed - the new server will'
        Write-Out2 'not accept it. Run "visend setup" again and enter a new one-time code.'
        return
    }
    Save-Config $Cfg
    Write-Out2 'Server URL saved.'
}

function Cmd-ServerSet([string]$RawUrl) {
    $url = "$RawUrl".Trim().TrimEnd('/')
    if ($url -notmatch '^https?://') {
        Die "Invalid URL `"$RawUrl`": it must start with http:// or https://"
    }
    if ($url -match '^http://') {
        Write-Warn2 'this URL uses plain http:// - your pairing code, token and data will'
        Write-Warn2 'travel over the network unencrypted.'
        if (-not (Confirm-Action 'Continue anyway?')) { Die 'Aborted.' }
    }
    Write-Out2 "Checking $url ..."
    $status = Get-ServerStatus $url
    if ($status -and $status.ok) {
        Write-Out2 'Server is up.'
    } else {
        Write-Warn2 'the server did not respond.'
        if (-not (Confirm-Action 'Save this URL anyway?')) { Die 'Aborted.' }
    }
    $cfg = Load-Config
    Apply-ServerUrl $cfg $url
}

function Cmd-ServerReset {
    Write-Out2 "Reset the server URL to $script:DefaultServerUrl?"
    if (-not (Confirm-Action 'Continue?')) { Die 'Aborted.' }
    Write-Out2 "Checking $script:DefaultServerUrl ..."
    $status = Get-ServerStatus $script:DefaultServerUrl
    if (-not ($status -and $status.ok)) {
        Write-Warn2 'the default server did not respond.'
        if (-not (Confirm-Action 'Reset anyway?')) { Die 'Aborted.' }
    }
    $cfg = Load-Config
    if (-not $cfg['server_url']) {
        Write-Out2 'The server URL is already the default.'
        return
    }
    Apply-ServerUrl $cfg $script:DefaultServerUrl
}

# ---------------------------------------------------------------- setup ---

function Cmd-Setup {
    $cfg = Load-Config
    $serverUrl = Get-EffectiveServerUrl $cfg
    Write-Out2 'visend setup'
    Write-Out2 ''
    $status = Get-ServerStatus $serverUrl
    $serverOnline = ($status -and $status.ok)
    $srvCfg = $null
    if ($serverOnline) { $srvCfg = Get-ServerConfig $serverUrl }

    while ($true) {
        Write-Out2 'How do you want to receive your messages?'
        Write-Out2 ''
        $suffix = ''
        if (-not $serverOnline) { $suffix = '  [currently unavailable]' }
        Write-Out2 "  1) Through the shared visend server ($serverUrl)$suffix"
        Write-Out2 '  2) Through my own Telegram bot (needs a token from @BotFather)'
        Write-Out2 '  3) Cancel'
        $choice = (Read-Host 'Choice [1-3]').Trim()
        if ($choice -eq '3') { Die 'Setup cancelled.' }
        if ($choice -eq '1') {
            if (-not $serverOnline) {
                Write-Out2 ''
                Write-Out2 'The configured server did not respond, so this option is unavailable right now.'
                Write-Out2 'Check "visend server" for details, or host your own server (see README).'
                Write-Out2 ''
                continue
            }
            Setup-Server $serverUrl $srvCfg
            return
        }
        if ($choice -eq '2') { Setup-Bot; return }
        Write-Out2 'Please enter 1, 2 or 3.'
        Write-Out2 ''
    }
}

function Setup-Server([string]$ServerUrl, $SrvCfg) {
    Write-Out2 ''
    Write-Out2 'Warning: with the shared server your text, files and pairing codes pass through'
    Write-Out2 'a third-party server before reaching Telegram. Treat it as a dev tool - do not use'
    Write-Out2 'it for sensitive data. For full control you can host your own server from the'
    Write-Out2 'official docker image - see "visend server" and the README.'
    Write-Out2 ''
    $botLink = $null
    if ($SrvCfg -and $SrvCfg.bot) { $botLink = "$($SrvCfg.bot)" }
    if ($botLink) {
        Write-Out2 "1. Open $botLink and send /start to the bot."
    } else {
        Write-Out2 '1. Send /start to the visend bot of this server (see "visend server" for the link).'
    }
    Write-Out2 '2. The bot will reply with your user id and a one-time code (valid for 1 hour).'
    Write-Out2 ''
    $userId = Read-UserId 'Your user id: '
    $code = (Read-Required 'One-time code: ').ToUpperInvariant()
    Write-Out2 "Connecting to $ServerUrl ..."
    $resp = Invoke-ServerRequest ($ServerUrl.TrimEnd('/') + '/connect') 'Post' $null ([Text.Encoding]::UTF8.GetBytes((@{ user_id = $userId; code = $code } | ConvertTo-Json -Compress))) 'application/json'
    $cfg = Load-Config
    $cfg['mode'] = 'server'
    $cfg['user_id'] = $userId
    $cfg['server_token'] = "$($resp.token)"
    $cfg.Remove('bot_token')
    Save-Config $cfg
    Write-Out2 'Paired with the server.'
    try {
        $null = Invoke-ServerRequest ($ServerUrl.TrimEnd('/') + '/text') 'Post' @{ Authorization = "Bearer $($resp.token)" } ([Text.Encoding]::UTF8.GetBytes('visend is set up! Everything you pipe will arrive here.')) 'text/plain; charset=utf-8'
        Write-Out2 'Test message sent to your Telegram. Setup complete.'
    } catch {
        Write-Warn2 'pairing succeeded, but the test message failed.'
    }
}

function Handle-WebhookConflict {
    Write-Out2 'Another getUpdates poller or a webhook is active on this bot (HTTP 409).'
    Write-Out2 'This usually means the bot is used by another integration.'
    if (-not (Confirm-Action 'Delete the webhook? WARNING: this will break the existing integration.')) {
        return $false
    }
    $null = Invoke-Tg 'deleteWebhook' @{ drop_pending_updates = $false }
    Write-Out2 'Webhook deleted.'
    return $true
}

function Setup-Bot {
    $token = (Read-Required 'Bot token (from @BotFather): ')
    if ($token -notmatch '^\d{5,}:[A-Za-z0-9_-]{30,}$') {
        Die 'That does not look like a bot token. Expected format: 123456789:AA...'
    }
    $script:BotToken = $token
    $me = Invoke-Tg 'getMe' $null
    $botName = $me.result.username
    if (-not $botName) { $botName = $me.result.first_name }
    Write-Out2 "Token is valid. Bot: @$botName"
    Write-Out2 ''
    Write-Out2 "Now open Telegram and send /start to @$botName."

    # First call only establishes the baseline update_id; queued (stale)
    # updates are never shown to the user.
    $lastId = 0
    $declined = $false
    while ($true) {
        $first = $null
        try {
            $first = Invoke-Tg 'getUpdates' $null
        } catch {
            if ("$_" -match 'HTTP 409') {
                if (-not (Handle-WebhookConflict)) { $declined = $true; break }
                continue
            }
            Die "$_"
        }
        if ($first -and $first.result) {
            foreach ($u in $first.result) { if ($u.update_id -gt $lastId) { $lastId = $u.update_id } }
        }
        break
    }

    $deadline = (Get-Date).AddSeconds(120)
    $found = $null
    if (-not $declined) {
        Write-Out2 'Waiting for your /start...'
        while ($true) {
            try {
                $resp = Invoke-Tg 'getUpdates' @{ offset = ($lastId + 1); timeout = 25; limit = 1 }
            } catch {
                if ("$_" -match 'HTTP 409') {
                    if (-not (Handle-WebhookConflict)) { $declined = $true; break }
                    continue
                }
                Die "$_"
            }
            if ($resp.result) {
                foreach ($u in $resp.result) {
                    if ($u.update_id -gt $lastId) { $lastId = $u.update_id }
                    $m = $u.message
                    if ($m -and $m.chat -and $m.chat.type -eq 'private' -and $m.text -and ($m.text -split '\s+')[0] -eq '/start') {
                        $found = $m
                        break
                    }
                }
            }
            if ($found) { break }
            if ((Get-Date) -ge $deadline) { break }
        }
    }

    $userId = 0
    if ($found) {
        $uname = $null
        if ($found.from -and $found.from.username) { $uname = $found.from.username }
        if ($uname) {
            Write-Out2 "Got it: user_id $($found.from.id) (@$uname)"
        } else {
            Write-Out2 "Got it: user_id $($found.from.id) (no @username)"
        }
        $answer = Read-Host 'Press Enter to save this user id, or type another one (yours from @userinfobot)'
        if ($answer -match '^\d{1,16}$') {
            $userId = [long]$answer
        } else {
            $userId = [long]$found.from.id
        }
    } else {
        if ($declined) {
            Write-Out2 'Falling back to manual user id input.'
        } else {
            Write-Out2 'Timed out after 120 seconds waiting for /start.'
        }
        $userId = Read-UserId 'Enter your user id manually (yours from @userinfobot): '
    }

    $cfg = Load-Config
    $cfg['mode'] = 'bot'
    $cfg['bot_token'] = $token
    $cfg['user_id'] = $userId
    $cfg.Remove('server_token')
    Save-Config $cfg
    Write-Out2 'Saved.'
    try {
        $null = Send-TelegramText $token $userId 'visend is set up! Everything you pipe will arrive here.'
        Write-Out2 'Test message sent to your Telegram. Setup complete.'
    } catch {
        Write-Warn2 'settings saved, but the test message failed.'
    }
}

# ----------------------------------------------------------------- main ---

# Capture piped input before entering functions. $input only exists at the
# script level; redirected native stdin is read from the console stream.
$script:StdinText = $null
try {
    if ($MyInvocation.ExpectingInput) {
        $lines = @()
        foreach ($item in @($input)) { $lines += "$item" }
        if ($lines.Count -gt 0) { $script:StdinText = ($lines -join "`n") }
        elseif ([Console]::IsInputRedirected) { $script:StdinText = '' }
    } elseif ([Console]::IsInputRedirected) {
        $reader = New-Object IO.StreamReader([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)
        $lines = @()
        while ($null -ne ($line = $reader.ReadLine())) { $lines += $line }
        $script:StdinText = ($lines -join "`n")
    }
} catch { }

function Main {
    $argv = @($args)
    $positionals = @()
    for ($i = 0; $i -lt $argv.Count; $i++) {
        $a = "$($argv[$i])"
        if ($a -eq '-y' -or $a -eq '--yes') { $script:AssumeYes = $true }
        elseif ($a -eq '--force-as-text') { $script:ForceAsText = $true }
        elseif ($a -eq '-h' -or $a -eq '--help') { Cmd-Help; exit 0 }
        elseif ($a -eq '--name') {
            if ($i + 1 -ge $argv.Count) { Die '--name requires a value: --name <name>' }
            $i++
            $script:OptName = "$($argv[$i])"
        }
        elseif ($a -like '--name=*') { $script:OptName = $a.Substring(7) }
        elseif ($a -eq '--') { for ($j = $i + 1; $j -lt $argv.Count; $j++) { $positionals += "$($argv[$j])" }; break }
        elseif ($a.StartsWith('-') -and $a.Length -gt 1) { Die "Unknown flag `"$a`". Run 'visend help'." }
        else { $positionals += $a }
    }

    $cmd = $null
    if ($positionals.Count -gt 0) { $cmd = $positionals[0] }
    $rest = @()
    if ($positionals.Count -gt 1) { $rest = $positionals[1..($positionals.Count - 1)] }

    if (-not $cmd) {
        $stdinText = Get-StdinText
        if ($null -ne $stdinText) { $cmd = 'text' } else { Cmd-Help; exit 0 }
    }

    switch ($cmd) {
        'help' { Cmd-Help }
        'text' { Cmd-Text $rest }
        'file' { Cmd-File $rest }
        'setup' { Cmd-Setup }
        'settings' { Cmd-Settings }
        'forget' { Cmd-Forget }
        'server' {
            $sub = $null
            if ($rest.Count -gt 0) { $sub = $rest[0] }
            if ($sub -eq 'set') {
                if ($rest.Count -lt 2) { Die 'Usage: visend server set <url>   e.g. visend server set http://example.com:6767/test/misc/visend' }
                Cmd-ServerSet $rest[1]
            }
            elseif ($sub -eq 'reset') { Cmd-ServerReset }
            elseif (-not $sub) { Cmd-ServerShow }
            else { Die "Unknown subcommand `"$sub`". Use 'visend server', 'visend server set <url>' or 'visend server reset'." }
        }
        default { Die "Unknown command `"$cmd`". Run 'visend help' to see the available commands." }
    }
}

Main @args
