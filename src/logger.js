'use strict';

function ts() {
  return new Date().toISOString();
}

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

class Logger {
  constructor(opts = {}) {
    this.level = (opts.level || process.env.LOG_LEVEL || 'info').toLowerCase();
    if (!(this.level in LEVELS)) this.level = 'info';
    this.prefix = opts.prefix || process.env.LOG_PREFIX || 'komari-node-agent';
  }

  _ok(lvl) {
    return LEVELS[lvl] <= LEVELS[this.level];
  }

  _fmt(lvl, msg) {
    return `[${ts()}] [${this.prefix}] [${lvl.toUpperCase()}] ${msg}`;
  }

  error(msg, meta) {
    if (!this._ok('error')) return;
    console.error(this._fmt('error', msg));
    if (meta) console.error(meta);
  }

  warn(msg, meta) {
    if (!this._ok('warn')) return;
    console.warn(this._fmt('warn', msg));
    if (meta) console.warn(meta);
  }

  info(msg, meta) {
    if (!this._ok('info')) return;
    console.log(this._fmt('info', msg));
    if (meta) console.log(meta);
  }

  debug(msg, meta) {
    if (!this._ok('debug')) return;
    console.log(this._fmt('debug', msg));
    if (meta) console.log(meta);
  }

  trace(msg, meta) {
    if (!this._ok('trace')) return;
    console.log(this._fmt('trace', msg));
    if (meta) console.log(meta);
  }
}

module.exports = { Logger };
