"use strict";

function invalidDate(message = "Date filter is invalid") {
  return Object.assign(new Error(message), { status: 400 });
}

function parseIsoDateFilter(value, options = {}) {
  if (value === undefined || value === null || String(value).trim() === "") return null;
  const text = String(value).trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) throw invalidDate(options.message);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const time = options.endOfDay ? "23:59:59.999" : "00:00:00.000";
  const date = new Date(`${text}T${time}Z`);
  if (
    !Number.isFinite(date.getTime())
    || date.getUTCFullYear() !== year
    || date.getUTCMonth() + 1 !== month
    || date.getUTCDate() !== day
  ) {
    throw invalidDate(options.message);
  }
  return date;
}

function assertDateRange(start, end, message = "Date range is invalid") {
  if (start && end && start > end) throw invalidDate(message);
}

module.exports = { assertDateRange, parseIsoDateFilter };
