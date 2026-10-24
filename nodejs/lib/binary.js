'use strict';

const SAMPLE_SIZE = 8192;

/**
 * Heuristic binary-content detection for piped data the user is about to
 * send as text: NUL bytes, invalid UTF-8 or a high ratio of control chars.
 */
function inspect(buf) {
  const sample = buf.length > SAMPLE_SIZE ? buf.slice(0, SAMPLE_SIZE) : buf;
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0) return { binary: true, reason: 'contains NUL bytes' };
  }
  const text = sample.toString('utf8');
  if (text.indexOf('\uFFFD') !== -1) return { binary: true, reason: 'is not valid UTF-8' };
  let control = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) control++;
  }
  if (text.length && control / text.length > 0.05) {
    return { binary: true, reason: 'contains many control characters' };
  }
  return { binary: false, reason: '' };
}

// One-line escaped preview of the first `limit` bytes.
function preview(buf, limit) {
  const n = Math.min(buf.length, limit === undefined ? 64 : limit);
  let text = buf.slice(0, n).toString('utf8');
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = text.charCodeAt(i);
    if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (code < 32 || code === 127) out += '\\x' + code.toString(16).padStart(2, '0');
    else out += ch;
  }
  if (buf.length > n) out += '...';
  return out;
}

module.exports = { inspect: inspect, preview: preview };
