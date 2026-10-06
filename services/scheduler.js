/**
 * services/scheduler.js
 *
 * Every minute, checks for active Automations whose scheduledTime (HH:mm)
 * matches the CURRENT TIME in the configured timezone, and that haven't
 * already run today (in that same timezone), then fires them.
 *
 * Timezone config
 * ───────────────
 * Set the SCHEDULER_TIMEZONE Railway environment variable to any IANA timezone
 * string.  Defaults to "Asia/Karachi" (Pakistan Standard Time, UTC+5).
 *
 * Examples:
 *   SCHEDULER_TIMEZONE=Asia/Karachi        (PKT, UTC+5  — default)
 *   SCHEDULER_TIMEZONE=America/New_York    (ET)
 *   SCHEDULER_TIMEZONE=Europe/London       (GMT/BST)
 *   SCHEDULER_TIMEZONE=UTC                 (no conversion)
 */

const cron       = require('node-cron');
const { formatInTimeZone, toZonedTime } = require('date-fns-tz');
const Automation = require('../models/Automation');
const { runAutomation } = require('./automationEngine');

// Guard against overlapping runs of the same automation if a send takes > 1 min
const runningAutomations = new Set();

const startScheduler = () => {
  const TZ = process.env.SCHEDULER_TIMEZONE || 'Asia/Karachi';

  // ── Startup diagnostic log ──────────────────────────────────────────────────
  const startupNow = new Date();
  console.log('[Scheduler] ─────────────────────────────────────────────────');
  console.log('[Scheduler] Automation scheduler starting.');
  console.log(`[Scheduler] Configured timezone : ${TZ}`);
  console.log(`[Scheduler] Server UTC time     : ${startupNow.toISOString()}`);
  console.log(`[Scheduler] Server local time   : ${startupNow.toString()}`);
  console.log(`[Scheduler] Time in ${TZ.padEnd(20)} : ${formatInTimeZone(startupNow, TZ, 'yyyy-MM-dd HH:mm:ss zzz')}`);
  console.log('[Scheduler] Checks run every minute. Matching against scheduledTime in', TZ);
  console.log('[Scheduler] ─────────────────────────────────────────────────');

  // ── Every-minute cron tick ──────────────────────────────────────────────────
  cron.schedule('* * * * *', async () => {
    const nowUTC    = new Date();

    // Current HH:mm in the configured timezone
    const nowTime   = formatInTimeZone(nowUTC, TZ, 'HH:mm');

    // "Start of today" in the configured timezone — used for the "not yet run
    // today" guard.  We build a zoned Date at midnight in TZ, then convert to
    // the UTC instant that represents that midnight.
    const zonedNow       = toZonedTime(nowUTC, TZ);
    const startOfTodayTZ = new Date(zonedNow);
    startOfTodayTZ.setHours(0, 0, 0, 0);
    // Convert back to UTC for the MongoDB query
    const startOfTodayUTC = new Date(
      startOfTodayTZ.getTime() - (zonedNow.getTimezoneOffset() * 60 * 1000)
    );

    // ── Per-tick diagnostic log (always printed so you can watch in Railway) ──
    let activeAutomations;
    try {
      activeAutomations = await Automation.find({ status: 'active' }, 'name scheduledTime lastRunAt');
    } catch (err) {
      console.error('[Scheduler] Error querying automations:', err.message);
      return;
    }

    if (activeAutomations.length === 0) {
      console.log(`[Scheduler] ${nowTime} ${TZ} | server UTC: ${nowUTC.toISOString()} | no active automations.`);
      return;
    }

    // Log current time + every active automation's scheduled time for visibility
    const summary = activeAutomations
      .map(a => `"${a.name}" @ ${a.scheduledTime}${a.scheduledTime === nowTime ? ' ← MATCH' : ''}`)
      .join(' | ');
    console.log(`[Scheduler] ${nowTime} ${TZ} | UTC: ${nowUTC.toISOString()} | active: ${summary}`);

    // ── Find automations whose scheduledTime matches now and haven't run today ─
    const candidates = activeAutomations.filter(a => {
      if (a.scheduledTime !== nowTime) return false;
      if (!a.lastRunAt) return true;                                  // never run
      return new Date(a.lastRunAt) < startOfTodayUTC;                // ran before today (in TZ)
    });

    if (candidates.length === 0) return;

    console.log(`[Scheduler] → ${candidates.length} automation(s) to fire: ${candidates.map(a => `"${a.name}"`).join(', ')}`);

    for (const automation of candidates) {
      const id = automation._id.toString();

      if (runningAutomations.has(id)) {
        console.warn(`[Scheduler] "${automation.name}" is already running — skipping overlap.`);
        continue;
      }

      runningAutomations.add(id);

      runAutomation(id)
        .catch((err) => {
          console.error(`[Scheduler] Unhandled error in automation "${automation.name}":`, err.message);
        })
        .finally(() => {
          runningAutomations.delete(id);
        });
    }
  });
};

module.exports = { startScheduler };
