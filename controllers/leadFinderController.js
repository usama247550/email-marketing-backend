/**
 * controllers/leadFinderController.js
 *
 * HTTP layer for the Lead Finder feature.
 *
 * ── Sync vs Async decision ────────────────────────────────────────────────────
 * We use an ASYNC / job-polling pattern for all searches, regardless of size.
 *
 * Reason: website scraping is I/O-bound and unpredictable. Even a "small" search
 * of 10 leads can take 30-90 seconds if several sites are slow or timing out.
 * Express has no built-in request timeout, but Vercel/Railway proxies do (usually
 * 30-60 s). More importantly, the frontend already shows a "Search queued!" state,
 * so an immediate "started" response + polling is the correct UX contract.
 *
 * The job store is an in-memory Map. This is fine because:
 *   - Jobs are short-lived (minutes at most)
 *   - This is a single-process Node app
 *   - The scheduler will call runMultiNicheSearch() directly, not via HTTP
 *
 * For a future multi-process deployment, swap the Map for a Redis/MongoDB job queue.
 *
 * Endpoints:
 *   POST /api/lead-finder/multi-niche-search  → start job, return { jobId }
 *   GET  /api/lead-finder/status/:jobId       → poll job status + result
 */

'use strict';

const { randomUUID }          = require('crypto');
const { runMultiNicheSearch } = require('../services/leadFinderService');

// ── In-memory job store ───────────────────────────────────────────────────────
// Structure: Map<jobId, { status, startedAt, finishedAt, result, error }>
// status: 'running' | 'done' | 'error'

const jobs = new Map();

// Auto-clean finished jobs after 30 minutes so the Map doesn't grow forever
const JOB_TTL_MS = 30 * 60 * 1000;

function scheduleCleanup(jobId) {
  setTimeout(() => jobs.delete(jobId), JOB_TTL_MS);
}

// ── Controller functions ──────────────────────────────────────────────────────

/**
 * POST /api/lead-finder/multi-niche-search
 *
 * Body: { projectId, country, city, niches: string[], totalLeads: number }
 *
 * Validates input, kicks off the search asynchronously, returns immediately
 * with the jobId the client can poll.
 */
const triggerMultiNicheSearch = async (req, res) => {
  const { projectId, country, city, niches, totalLeads } = req.body;

  // ── Validation ────────────────────────────────────────────────────────────
  const errors = [];

  if (!projectId || typeof projectId !== 'string' || projectId.trim() === '') {
    errors.push('projectId is required.');
  }
  if (!country || typeof country !== 'string' || country.trim() === '') {
    errors.push('country is required.');
  }
  if (!city || typeof city !== 'string' || city.trim() === '') {
    errors.push('city is required.');
  }
  if (!Array.isArray(niches) || niches.length === 0) {
    errors.push('niches must be a non-empty array of strings.');
  } else {
    const invalid = niches.filter((n) => typeof n !== 'string' || n.trim() === '');
    if (invalid.length > 0) errors.push('All niche entries must be non-empty strings.');
    if (niches.length > 10) errors.push('Maximum 10 niches per search.');
  }
  if (
    totalLeads == null ||
    typeof totalLeads !== 'number' ||
    !Number.isInteger(totalLeads) ||
    totalLeads < 1 ||
    totalLeads > 5000
  ) {
    errors.push('totalLeads must be an integer between 1 and 5000.');
  }

  if (errors.length > 0) {
    return res.status(400).json({ error: 'Validation failed', details: errors });
  }

  // ── Create job ────────────────────────────────────────────────────────────
  const jobId = randomUUID();
  const job = {
    status:     'running',
    startedAt:  new Date().toISOString(),
    finishedAt: null,
    result:     null,
    error:      null,
    // Echo back the search params so the client can show them while polling
    params: { projectId, country, city, niches, totalLeads },
  };
  jobs.set(jobId, job);

  // ── Fire search asynchronously ────────────────────────────────────────────
  // We deliberately do NOT await here — response goes out immediately.
  runMultiNicheSearch({ projectId, country, city, niches, totalLeads })
    .then((result) => {
      job.status     = 'done';
      job.finishedAt = new Date().toISOString();
      job.result     = result;
      scheduleCleanup(jobId);
    })
    .catch((err) => {
      console.error(`[LeadFinder] Job ${jobId} failed:`, err.message);
      job.status     = 'error';
      job.finishedAt = new Date().toISOString();
      job.error      = err.message || 'Unknown error';
      scheduleCleanup(jobId);
    });

  // ── Respond immediately ───────────────────────────────────────────────────
  return res.status(202).json({
    message: 'Search started. Poll /api/lead-finder/status/:jobId for results.',
    jobId,
    params: job.params,
  });
};

/**
 * GET /api/lead-finder/status/:jobId
 *
 * Returns current status of a search job.
 *
 * Response shapes:
 *   running: { status: 'running', startedAt, params }
 *   done:    { status: 'done',    startedAt, finishedAt, result: { batchId, totalFound, ... } }
 *   error:   { status: 'error',   startedAt, finishedAt, error: '...' }
 */
const getJobStatus = (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({
      error: 'Job not found. It may have expired (jobs are kept for 30 minutes) or the ID is invalid.',
    });
  }

  const response = {
    status:     job.status,
    startedAt:  job.startedAt,
    finishedAt: job.finishedAt,
    params:     job.params,
  };

  if (job.status === 'done')  response.result = job.result;
  if (job.status === 'error') response.error  = job.error;

  return res.json(response);
};

module.exports = { triggerMultiNicheSearch, getJobStatus };
