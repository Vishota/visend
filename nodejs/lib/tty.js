'use strict';

const fs = require('fs');
const readline = require('readline');
const { VisendError } = require('./errors');

// Interactive input must NOT come from stdin: stdin carries piped data.
// If stdin is the terminal itself we can use it; otherwise we open the
// controlling terminal directly (/dev/tty on POSIX, CONIN$ on Windows).

let cachedFd; // false = no tty, number = raw fd

function openTty() {
  if (cachedFd !== undefined) return cachedFd;
  cachedFd = false;
  if (process.stdin.isTTY) return (cachedFd = 'stdin');
  const dev = process.platform === 'win32' ? 'CONIN$' : '/dev/tty';
  try {
    cachedFd = fs.openSync(dev, 'r');
  } catch (err) {
    cachedFd = false;
  }
  return cachedFd;
}

function noTty() {
  throw new VisendError(
    'This prompt needs an interactive terminal. ' +
    'Re-run from a console, or pass -y / --yes to auto-confirm.'
  );
}

function readLineFromFd(fd) {
  const one = Buffer.alloc(1);
  let line = '';
  for (;;) {
    let n;
    try {
      n = fs.readSync(fd, one, 0, 1, null);
    } catch (err) {
      if (line.length) return line;
      throw new VisendError('Failed to read input: ' + err.message);
    }
    if (n <= 0) {
      if (line.length) return line;
      throw new VisendError('Input stream closed (EOF).');
    }
    const ch = one[0];
    if (ch === 10) return line; // \n
    if (ch !== 13) line += one.toString('latin1'); // drop \r; answers are ASCII
  }
}

function prompt(question) {
  return new Promise(function (resolve) {
    const fd = openTty();
    if (fd === false) return resolve(noTty());
    process.stdout.write(question);
    if (fd === 'stdin') {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question('', function (answer) {
        rl.close();
        resolve(answer);
      });
    } else {
      try {
        resolve(readLineFromFd(fd));
      } catch (err) {
        resolve(Promise.reject(err));
      }
    }
  });
}

async function confirm(question, yes) {
  if (yes) return true;
  const answer = await module.exports.prompt(question + ' [y/N] ');
  return /^[ \t]*y(es)?[ \t]*$/i.test(answer);
}

async function askRequired(question) {
  for (;;) {
    const answer = await module.exports.prompt(question);
    if (answer.trim()) return answer.trim();
    process.stdout.write('Value is required.\n');
  }
}

async function askUserId(question) {
  for (;;) {
    const answer = await module.exports.prompt(question);
    const trimmed = answer.trim();
    if (/^\d{1,16}$/.test(trimmed)) return Number(trimmed);
    process.stdout.write('User id must be a number (yours from @userinfobot).\n');
  }
}

module.exports = {
  prompt: prompt,
  confirm: confirm,
  askRequired: askRequired,
  askUserId: askUserId,
};
