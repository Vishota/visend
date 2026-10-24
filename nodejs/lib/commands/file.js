'use strict';

const fs = require('fs');
const path = require('path');
const send = require('../send');
const stdin = require('../stdin');
const { VisendError } = require('../errors');

const TELEGRAM_FILE_LIMIT = 50 * 1024 * 1024;

async function run(args, flags) {
  const pathArg = args[0];
  const hasStdin = stdin.isPiped();
  let buf;
  let name;

  if (pathArg && hasStdin) {
    process.stdout.write('Warning: stdin ignored - the file path takes priority.\n');
  }

  if (pathArg) {
    let st;
    try {
      st = fs.statSync(pathArg);
    } catch (err) {
      throw new VisendError('Cannot read "' + pathArg + '": ' + err.message);
    }
    if (st.isDirectory()) {
      throw new VisendError('"' + pathArg + '" is a directory. Pass a file path.');
    }
    try {
      buf = fs.readFileSync(pathArg);
    } catch (err) {
      throw new VisendError('Cannot read "' + pathArg + '": ' + err.message);
    }
    name = flags.name || path.basename(pathArg);
  } else if (hasStdin) {
    buf = await stdin.readAll();
    if (!buf.length) {
      throw new VisendError(
        'Nothing to send - stdin is empty. Pipe something in (`cat report.pdf | visend file`)' +
        ' or pass a file path (`visend file report.pdf`).'
      );
    }
    name = flags.name || 'visend.txt';
  } else {
    throw new VisendError(
      'Nothing to send. Pipe something in (`cat report.pdf | visend file`)' +
      ' or pass a file path (`visend file report.pdf`).'
    );
  }

  const cfg = send.requireConfig();

  if (buf.length > TELEGRAM_FILE_LIMIT) {
    const mb = Math.round(buf.length / (1024 * 1024) * 10) / 10;
    throw new VisendError(
      'The file is ' + mb + ' MB, but Telegram bots can only send files up to 50 MB.'
    );
  }

  process.stdout.write(
    await send.deliverFile(cfg, buf, name) + '\n'
  );
}

module.exports = { run: run };
