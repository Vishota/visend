'use strict';

const binary = require('../binary');
const send = require('../send');
const stdin = require('../stdin');
const tty = require('../tty');
const { VisendError } = require('../errors');

const TELEGRAM_TEXT_LIMIT = 4096;

async function run(args, flags) {
  const textArg = args.join(' ');
  const hasStdin = stdin.isPiped();
  let buf = null;

  if (textArg && hasStdin) {
    process.stdout.write('Warning: stdin ignored - the text argument takes priority.\n');
  }
  if (textArg) {
    buf = Buffer.from(textArg, 'utf8');
  } else if (hasStdin) {
    buf = await stdin.readAll();
    if (!buf.length) {
      throw new VisendError(
        'Nothing to send - stdin is empty. Pipe something in (`cat notes.txt | visend text`)' +
        ' or pass the text as an argument (`visend text hello world`).'
      );
    }
  } else {
    throw new VisendError(
      'Nothing to send. Pipe something in (`cat notes.txt | visend text`)' +
      ' or pass the text as an argument (`visend text hello world`).'
    );
  }

  // Binary check runs before the length check.
  const detected = binary.inspect(buf);
  if (detected.binary) {
    process.stdout.write(
      'Warning: the input looks like binary data (' + detected.reason + ').\n' +
      'First bytes: ' + binary.preview(buf) + '\n'
    );
    let ok;
    try {
      ok = await tty.confirm('Send it as text anyway?', flags.yes);
    } catch (err) {
      throw err;
    }
    if (!ok) {
      throw new VisendError('Aborted. Use `visend file` to send binary data as a file.');
    }
  }

  const charCount = buf.toString('utf8').length;

  if (flags.forceAsText) {
    if (charCount > TELEGRAM_TEXT_LIMIT) {
      process.stdout.write(
        'Warning: the input is ' + charCount + ' characters; Telegram cuts messages at ' +
        TELEGRAM_TEXT_LIMIT + ' characters. Sending the first ' + TELEGRAM_TEXT_LIMIT + ' (--force-as-text).\n'
      );
      const cut = Buffer.from(buf.toString('utf8').slice(0, TELEGRAM_TEXT_LIMIT), 'utf8');
      process.stdout.write(await send.deliverText(send.requireConfig(), cut) + '\n');
      return;
    }
    process.stdout.write(await send.deliverText(send.requireConfig(), buf) + '\n');
    return;
  }

  if (charCount > TELEGRAM_TEXT_LIMIT) {
    process.stdout.write(
      'Warning: the input is ' + charCount + ' characters, but Telegram messages are capped at ' +
      TELEGRAM_TEXT_LIMIT + ' characters. Sending it as a file "visend.txt" instead.' +
      ' Use --force-as-text to send it as text anyway (it will be cut).\n'
    );
    process.stdout.write(await send.deliverFile(send.requireConfig(), buf, 'visend.txt') + '\n');
    return;
  }

  process.stdout.write(await send.deliverText(send.requireConfig(), buf) + '\n');
}

module.exports = { run: run };
