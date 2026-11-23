'use strict';

const assert = require('assert');
const {
  parseSendSchedule,
  splitIntoParts,
  estimateSendDurationMs,
} = require('./sendSchedule');

const schedule = parseSendSchedule({
  emailGapSeconds: 60,
  partCount: 5,
  partGapMinutes: 20,
});

assert.strictEqual(schedule.emailGapSeconds, 60);
assert.strictEqual(schedule.partCount, 5);

const parts = splitIntoParts(
  Array.from({ length: 10 }, (_, i) => ({ id: i })),
  5
);
assert.strictEqual(parts.length, 5);
assert.strictEqual(parts.reduce((n, p) => n + p.length, 0), 10);

// 100 leads, 5 parts (20 each), 1 min between emails, 20 min between 4 gaps
const ms = estimateSendDurationMs(100, schedule);
const expected =
  5 * (19 * 60 * 1000) + // 19 gaps per part × 20 leads
  4 * (20 * 60 * 1000);  // 4 part gaps
assert.strictEqual(ms, expected);

console.log('sendSchedule.test.js: OK');