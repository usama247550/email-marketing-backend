/**
 * services/scheduler.js
 *
 * Every minute, checks for active Automations whose scheduledTime (HH:mm)
 * matches the CURRENT TIME in the configured timezone, and that haven't
 * already run today (in that same timezone), then fires them.
 *
 * Timezone config
 * ───────────────
 * Set SCHEDULER_TIMEZONE to any IANA timezone string.
 * Defaults to "Asia/Karachi" (Pakistan Standard Time, UTC+5).
 *
 *   SCHEDULER_TIMEZONE=Asia/Karachi     (PKT, UTC+5 — default)
 *   SCHEDULER_TIMEZONE=UTC              (no conversion)
 */

const cron                             = require('node-cron');
const { formatInTimeZone, toZonedTime } = require('date-fns-tz');
const Automation                       = require('../models/Automation');
const { runAutomation }                = require('./automationEngine');

// Prevent overlapping runs of the same automation if a send takes > 1 min
const runningAutomations = new Set();

const startScheduler = () => {
  const TZ = process.env.SCHEDULER_TIMEZONE || 'Asia/Karachi';

  // ── Startup diagnostic log ──────────────────────────────────────────────
  const startupNow = new Date();
  console.log('[Scheduler] ──────────────────────────────────────────────');
  console.log('[Scheduler] Automation scheduler starting.');
  console.log(`[Scheduler] Configured timezone : ${TZ}`);
  console.log(`[Scheduler] Server UTC time     : ${startupNow.toISOString()}`);
  console.log(`[Scheduler] Server local time   : ${startupNow.toString()}`);
  console.log(`[Scheduler] Time in ${TZ} : ${formatInTimeZone(startupNow, TZ, 'yyyy-MM-dd HH:mm:ss zzz')}`);
  console.log('[Scheduler] Per-minute tick will log every 60 s regardless of matches.');
  console.log('[Scheduler] ──────────────────────────────────────────────');

  // ── Every-minute cron tick ──────────────────────────────────────────────
  cron.schedule('* * * * *', async () => {
    const nowUTC = new Date();

    // ── UNCONDITIONAL first log — fires every single minute no matter what ──
    // If you see the startup banner above but never see this TICK line,
    // node-cron is not firing at all (event-loop issue, version problem, etc.)
    console.log(`[Scheduler] TICK ${nowUTC.toISOString()} | local: ${nowUTC.toString()}`);

    // Current HH:mm in the configured timezone
    const nowTime = formatInTimeZone(nowUTC, TZ, 'HH:mm');

    // "Start of today" in the configured timezone for the "not yet run today" guard
    const zonedNow       = toZonedTime(nowUTC, TZ);
    const startOfTodayTZ = new Date(zonedNow);
    startOfTodayTZ.setHours(0, 0, 0, 0);
    const startOfTodayUTC = new Date(
      startOfTodayTZ.getTime() - (zonedNow.getTimezoneOffset() * 60 * 1000)
    );

    // ── Query all active automations ────────────────────────────────────────
    let activeAutomations;
    try {
      activeAutomations = await Automation.find(
        { status: 'active' },
        'name scheduledTime lastRunAt'
      );
    } catch (err) {
      console.error('[Scheduler] DB error querying automations:', err.message);
      return;
    }

    if (activeAutomations.length === 0) {
      console.log(`[Scheduler] ${nowTime} ${TZ} | no active automations.`);
      return;
    }

    // ── Per-tick summary — shows every active automation and whether it matches
    const summary = activeAutomations
      .map(a => `"${a.name}" @ ${a.scheduledTime}${a.scheduledTime === nowTime ? ' ← MATCH' : ''}`)
      .join(' | ');
    console.log(`[Scheduler] ${nowTime} ${TZ} | UTC: ${nowUTC.toISOString()} | ${summary}`);

    // ── Find automations that match now and haven't run today ───────────────
    const candidates = activeAutomations.filter(a => {
      if (a.scheduledTime !== nowTime) return false;
      if (!a.lastRunAt) return true;                        // never run
      return new Date(a.lastRunAt) < startOfTodayUTC;      // ran before today (TZ-aware)
    });

    if (candidates.length === 0) return;

    console.log(
      `[Scheduler] → Firing ${candidates.length} automation(s): ` +
      candidates.map(a => `"${a.name}"`).join(', ')
    );

    for (const automation of candidates) {
      const id = automation._id.toString();

      if (runningAutomations.has(id)) {
        console.warn(`[Scheduler] "${automation.name}" already running — skipping overlap.`);
        continue;
      }

      runningAutomations.add(id);

      runAutomation(id)
        .catch(err => {
          console.error(`[Scheduler] Error in "${automation.name}":`, err.message);
        })
        .finally(() => {
          runningAutomations.delete(id);
        });
    }
  });
};

module.exports = { startScheduler };
