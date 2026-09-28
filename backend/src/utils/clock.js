"use strict";

// The only source of "now" for booking rules, so tests can control time.
module.exports = { now: () => new Date() };
