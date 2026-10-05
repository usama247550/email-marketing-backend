/**
 * services/scheduler.js
 *
 * Every minute, checks for active Automations whose scheduledTime matches
 * the current HH:mm and that haven't already run today, then fires them.
 *
 * Import and call startScheduler() once from server.js after DB connects.
 *
 * Timezone note: comparison uses the server's local time (process.env.TZ or
 * the OS default). Railway sets UTC by default — set TZ in your Railway
 * environment variables if you want a different timezone (e.g. TZ=America/New_York).
 */

const cron      = require('node-cron');
const Automation = require('../models/Automation');
const { runAutomation } = require('./automationEngine');

// Guard against overlapping runs of the same automation if a send takes > 1 min
const runningAutomations = new Set();

const startScheduler = () => {
  // Fires every minute: "* * * * *"
  cron.schedule('* * * * *', async () => {
    const now     = new Date();
    const HH      = String(now.getHours()).padStart(2, '0');
    const mm      = String(now.getMinutes()).padStart(2, '0');
    const nowTime = `${HH}:${mm}`; // "09:00", "14:32", etc.

    // Start-of-today (midnight) for "not yet run today" check
    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    let candidates;
    try {
      candidates = await Automation.find({
        status:        'active',
        scheduledTime: nowTime,
        $or: [
          { lastRunAt: { $lt: startOfToday } }, // ran before today
          { lastRunAt: { $exists: false }     }, // never run
          { lastRunAt: null                   }, // explicitly null
        ],
      });
    } catch (err) {
      console.error('[Scheduler] Error querying automations:', err.message);
      return;
    }

    if (candidates.length === 0) return;

    console.log(`[Scheduler] ${nowTime} — found ${candidates.length} automation(s) to run.`);

    for (const automation of candidates) {
      const id = automation._id.toString();

      if (runningAutomations.has(id)) {
        console.warn(`[Scheduler] "${automation.name}" is already running — skipping overlap.`);
        continue;
      }

      runningAutomations.add(id);

      // Fire-and-forget: don't await so the cron tick returns quickly.
      // Errors are caught inside runAutomation already, but we add a safety net.
      runAutomation(id)
        .catch((err) => {
          console.error(`[Scheduler] Unhandled error in automation "${automation.name}":`, err.message);
        })
        .finally(() => {
          runningAutomations.delete(id);
        });
    }
  });

  console.log('[Scheduler] Automation scheduler started (checks every minute).');
};

module.exports = { startScheduler };
