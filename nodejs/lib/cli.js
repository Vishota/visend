'use strict';

const { VisendError } = require('./errors');
const stdin = require('./stdin');

const commands = {
  setup: require('./commands/setup'),
  text: require('./commands/text'),
  file: require('./commands/file'),
  forget: require('./commands/forget'),
  server: require('./commands/server'),
  settings: require('./commands/settings'),
  help: require('./commands/help'),
};

const VALID_COMMANDS = ['setup', 'text', 'file', 'forget', 'server', 'settings', 'help'];

function usageError(argv) {
  throw new VisendError(
    'Unknown command "' + argv[0] + '". Run `visend help` to see the available commands.'
  );
}

function parseArgs(argv) {
  const positionals = [];
  const flags = { yes: false, forceAsText: false, name: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      for (let j = i + 1; j < argv.length; j++) positionals.push(argv[j]);
      break;
    }
    if (a === '-y' || a === '--yes') {
      flags.yes = true;
    } else if (a === '--force-as-text') {
      flags.forceAsText = true;
    } else if (a === '-h' || a === '--help') {
      flags.help = true;
    } else if (a === '--name') {
      if (i + 1 >= argv.length) throw new VisendError('--name requires a value: --name <name>');
      flags.name = argv[++i];
    } else if (a.indexOf('--') === 0 && a.indexOf('=') !== -1) {
      const eq = a.indexOf('=');
      const key = a.slice(2, eq);
      const value = a.slice(eq + 1);
      if (key === 'name') flags.name = value;
      else if (key === 'yes' && value === 'true') flags.yes = true;
      else if (key === 'force-as-text' && value === 'true') flags.forceAsText = true;
      else throw new VisendError('Unknown flag "--' + key + '". Run `visend help`.');
    } else if (a.indexOf('-') === 0 && a.length > 1 && !(a === '-')) {
      throw new VisendError('Unknown flag "' + a + '". Run `visend help`.');
    } else {
      positionals.push(a);
    }
  }
  return { positionals: positionals, flags: flags };
}

async function main() {
  const argv = process.argv.slice(2);
  const parsed = parseArgs(argv);
  const positionals = parsed.positionals;
  const flags = parsed.flags;

  let cmd = positionals.shift();
  if (cmd === undefined) {
    // Bare `visend`: piped data means `text`, otherwise `help`.
    cmd = stdin.isPiped() ? 'text' : 'help';
  }
  if (cmd === 'help' || flags.help) {
    cmd = 'help';
  } else if (VALID_COMMANDS.indexOf(cmd) === -1) {
    usageError([cmd]);
  }

  await commands[cmd].run(positionals, flags);
}

function entry() {
  main().then(
    function () { process.exit(0); },
    function (err) {
      const msg = err && err.name === 'VisendError'
        ? err.message
        : (err && err.stack ? err.stack : String(err));
      process.stderr.write('Error: ' + msg + '\n');
      process.exit(1);
    }
  );
}

module.exports = { main: entry };
