'use strict';

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/**
 * @param {object} raw
 * @returns {{ emailGapSeconds: number, partCount: number, partGapMinutes: number, emailGapMs: number, partGapMs: number }}
 */
function parseSendSchedule(raw = {}) {
  const emailGapSeconds = clamp(Number(raw.emailGapSeconds) || 30, 1, 600);
  const partCount = clamp(Number(raw.partCount) || 1, 1, 50);
  const partGapMinutes = clamp(Number(raw.partGapMinutes) || 0, 0, 180);
  return {
    emailGapSeconds,
    partCount,
    partGapMinutes,
    emailGapMs: emailGapSeconds * 1000,
    partGapMs: partGapMinutes * 60 * 1000,
  };
}

function splitIntoParts(leads, partCount) {
  if (!leads.length) return [];
  const n = Math.min(partCount, leads.length);
  const parts = Array.from({ length: n }, () => []);
  leads.forEach((lead, i) => {
    parts[i % n].push(lead);
  });
  return parts.filter((p) => p.length > 0);
}

function estimateSendDurationMs(leadCount, schedule) {
  if (leadCount <= 0) return 0;
  const parts = splitIntoParts(
    Array.from({ length: leadCount }, (_, i) => i),
    schedule.partCount
  );
  let ms = 0;
  for (let p = 0; p < parts.length; p++) {
    const count = parts[p].length;
    if (count > 1) ms += (count - 1) * schedule.emailGapMs;
    if (p < parts.length - 1) ms += schedule.partGapMs;
  }
  return ms;
}

module.exports = {
  parseSendSchedule,
  splitIntoParts,
  estimateSendDurationMs,
};