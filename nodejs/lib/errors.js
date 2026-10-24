'use strict';

/**
 * User-facing error. `main()` catches it, prints the message to stderr
 * and exits with code 1.
 */
class VisendError extends Error {
  constructor(message) {
    super(message);
    this.name = 'VisendError';
  }
}

module.exports = { VisendError };
