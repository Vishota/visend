'use strict';

const HELP = [
  'visend - send files and text to yourself via Telegram',
  '',
  'Usage:',
  '  visend                                 same as `visend text` when stdin is piped,',
  '                                         otherwise shows this help',
  '  visend text [text...] [--force-as-text]',
  '                                         send text; multiple arguments are joined with',
  '                                         spaces; piped stdin is sent as the text',
  '  visend file [path] [--name <name>]     send a file; with piped stdin sends it as a',
  '                                         file named visend.txt (or --name)',
  '  visend setup                           pair visend with your Telegram (own bot or',
  '                                         shared server)',
  '  visend settings                        show current settings',
  '  visend forget [-y|--yes]               delete all settings except the server URL',
  '  visend server                          show server URL, status and bot link',
  '  visend server set <url> [-y|--yes]     switch to another visend server',
  '  visend server reset [-y|--yes]         switch back to the default server',
  '  visend help                            show this help',
  '',
  'Options:',
  '  -y, --yes           answer "yes" to all confirmation prompts',
  '  --name <name>       file name to use for `visend file`',
  '  --force-as-text     send text longer than 4096 chars as text anyway (it will be cut',
  '                      to the Telegram limit)',
  '  -h, --help          show this help',
  '',
  'Flags go after positional arguments: `visend text hello --force-as-text`.',
  '',
  'Examples:',
  '  ls | visend',
  '  cat log.txt | visend text',
  '  visend text hello world',
  '  visend file report.pdf',
  '  cat data.csv | visend file --name data.csv',
  '',
  'Docs: https://github.com/Vishota/visend',
].join('\n');

async function run() {
  process.stdout.write(HELP + '\n');
}

module.exports = { run: run };
