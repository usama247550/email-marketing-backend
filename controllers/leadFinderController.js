/**
 * controllers/leadFinderController.js
 *
 * Async job pattern:
 *   POST /api/lead-finder/multi-niche-search  → validate, create job, fire background work,
 *                                               respond immediately with { jobId }
 *   GET  /api/lead-finder/status/:jobId        → return job status + live progress + result
 *
 * The job object held in the in-memory Map is the single source of truth.
 * The background search mutates job.progress in-place via an onProgress callback;
 * every poll response includes the current progress snapshot so the UI can show
 * live "Checked N businesses, found M valid leads so far" counts.
 *
 * No external queue library needed — this is a single-process Node app and the
 * background async function is independent of the original HTTP request lifetime.
 */

'use strict';

const { randomUUID }          = require('crypto');
const { runMultiNicheSearch } = require('../services/leadFinderService');

// ── In-memory job store ───────────────────────────────────────────────────────
// Map<jobId, JobRecord>
//
// JobRecord {
//   status:     'running' | 'done' | 'error'
//   startedAt:  ISO string
//   finishedAt: ISO string | null
//   params:     { projectId, country, city, niches, totalLeads }
//   progress:   { checked, validFound, target, currentNiche }
//   result:     SearchSummary | null
//   error:      string | null
//   _runKey:    string   (internal dedup key)
//   _jobId:     string   (echo of the Map key, convenient for 409 responses)
// }

const jobs = new Map();

// Jobs are kept for 30 minutes after completion, then GC'd
const JOB_TTL_MS = 30 * 60 * 1000;

function scheduleCleanup(jobId) {
  setTimeout(() => jobs.delete(jobId), JOB_TTL_MS);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Build the public-facing job response object.
 * Always includes progress so the poller sees live counts during 'running'.
 */
function buildResponse(job) {
  const resp = {
    status:     job.status,
    startedAt:  job.startedAt,
    finishedAt: job.finishedAt,
    params:     job.params,
    progress:   job.progress,   // always present — { checked, validFound, target, currentNiche }
  };
  if (job.status === 'done')  resp.result = job.result;
  if (job.status === 'error') resp.error  = job.error;
  return resp;
}

// ── POST /api/lead-finder/multi-niche-search ──────────────────────────────────

const triggerMultiNicheSearch = async (req, res) => {
  const { projectId, country, niches, totalLeads } = req.body;
  // city is optional — '' / null / missing all mean "search entire country"
  const city = typeof req.body.city === 'string' ? req.body.city.trim() : '';

  // ── Validation ──────────────────────────────────────────────────────────
  const errors = [];

  if (!projectId || typeof projectId !== 'string' || !projectId.trim())
    errors.push('projectId is required.');
  if (!country || typeof country !== 'string' || !country.trim())
    errors.push('country is required.');
  if (!Array.isArray(niches) || niches.length === 0) {
    errors.push('niches must be a non-empty array of strings.');
  } else {
    if (niches.some(n => typeof n !== 'string' || !n.trim()))
      errors.push('All niche entries must be non-empty strings.');
    if (niches.length > 10)
      errors.push('Maximum 10 niches per search.');
  }
  if (
    totalLeads == null || typeof totalLeads !== 'number' ||
    !Number.isInteger(totalLeads) || totalLeads < 1 || totalLeads > 5000
  ) errors.push('totalLeads must be an integer between 1 and 5000.');

  if (errors.length > 0)
    return res.status(400).json({ error: 'Validation failed', details: errors });

  // ── Duplicate-run guard ─────────────────────────────────────────────────
  // If an identical search (same projectId + niches + city) is already running,
  // return the existing jobId instead of spawning a duplicate.
  const runKey = `${projectId}|${[...niches].sort().join(',')}|${city}`;
  for (const [, existing] of jobs) {
    if (existing.status === 'running' && existing._runKey === runKey) {
      return res.status(409).json({
        error: 'A search with the same parameters is already running.',
        jobId: existing._jobId,
      });
    }
  }

  // ── Create job record ───────────────────────────────────────────────────
  const jobId = randomUUID();
  const job = {
    status:     'running',
    startedAt:  new Date().toISOString(),
    finishedAt: null,
    result:     null,
    error:      null,
    _runKey:    runKey,
    _jobId:     jobId,
    params:     { projectId, country, city, niches, totalLeads },
    // Live progress — mutated in-place by the onProgress callback below
    progress: {
      checked:      0,
      validFound:   0,
      target:       totalLeads,
      currentNiche: niches[0] ?? '',
    },
  };
  jobs.set(jobId, job);

  // ── onProgress callback ─────────────────────────────────────────────────
  // Passed into the service so it can report mid-run counts back to us.
  // Mutates job.progress directly — no async overhead, no DB write.
  const onProgress = ({ checked, validFound, currentNiche }) => {
    job.progress.checked      = checked;
    job.progress.validFound   = validFound;
    job.progress.currentNiche = currentNiche;
  };

  // ── Fire background search (deliberately NOT awaited) ───────────────────
  // The HTTP response below goes out immediately; the search runs independently.
  runMultiNicheSearch({ projectId, country, city, niches, totalLeads, onProgress })
    .then((result) => {
      job.status     = 'done';
      job.finishedAt = new Date().toISOString();
      job.result     = result;
      // Ensure final progress reflects the real totals from the result
      job.progress.checked    = result.checkedCount;
      job.progress.validFound = result.validCount;
      scheduleCleanup(jobId);
    })
    .catch((err) => {
      console.error(`[LeadFinder] Job ${jobId} failed:`, err.message);
      job.status     = 'error';
      job.finishedAt = new Date().toISOString();
      job.error      = err.message || 'Unknown error';
      scheduleCleanup(jobId);
    });

  // ── Immediate 202 response ──────────────────────────────────────────────
  return res.status(202).json({
    message: 'Search started. Poll /api/lead-finder/status/:jobId for live progress.',
    jobId,
    params: job.params,
  });
};

// ── GET /api/lead-finder/status/:jobId ────────────────────────────────────────

const getJobStatus = (req, res) => {
  const { jobId } = req.params;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({
      error: 'Job not found. It may have expired (jobs are kept 30 minutes) or the ID is wrong.',
    });
  }

  return res.json(buildResponse(job));
};

module.exports = { triggerMultiNicheSearch, getJobStatus };
