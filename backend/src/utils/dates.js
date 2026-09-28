"use strict";

// "Today" as YYYY-MM-DD in the given IANA timezone (en-CA formats as ISO date).
function todayInTimezone(timeZone, now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

// True for real calendar dates ("2026-02-31" is not one).
function isRealDate(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function addDays(isoDate, days) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// 0 = Sunday ... 6 = Saturday, for a calendar date (timezone independent).
function weekdayOf(isoDate) {
  const [y, m, d] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

// "HH:MM" -> minutes since midnight.
function minutesOfDay(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// Minutes since local midnight in the given IANA timezone.
function minutesNowInTimezone(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return get("hour") * 60 + get("minute");
}

module.exports = { todayInTimezone, isRealDate, addDays, weekdayOf, minutesOfDay, minutesNowInTimezone };
