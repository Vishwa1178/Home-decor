"use strict";

// Tiny structured logger. Swap for pino/winston if needed.
function format(level, args) {
  const time = new Date().toISOString();
  return [`[${time}]`, `[${level}]`, ...args];
}

module.exports = {
  info: (...args) => console.log(...format("INFO", args)),
  warn: (...args) => console.warn(...format("WARN", args)),
  error: (...args) => console.error(...format("ERROR", args)),
};
