/**
 * controllers/leadFinderController.js
 *
 * Async job pattern — shared by Multi-Niche Search and Smart Search.
 *
 * All searches share ONE in-memory job store (Map).  Each job has a `type`
 * field so the status endpoint can return the right fields for each job type.
 *
 * Job lifecycle:
 *   POST trigger  → creates job, fires background function, responds 202 immediately
 *   GET  status   → returns current job state including live progress
 *   POST save     → (Smart Search only) saves matched leads to a new Batch in MongoDB
 *
 * The background function never touches Express req/res — it only mutates the
 * in-memory job object via the updateJob / onProgress callbacks.
 */

'use strict';

const { randomUUID }           = require('crypto');
const { runMultiNicheSearch }  = require('../services/leadFinderService');
const { runSmartSearch }       = require('../services/smartSearchService');
const Batch                    = require('../models/Batch');
const Lead                     = require('../models/Lead');

// ── In-memory job store ───────────────────────────────────────────────────────
// Map<jobId, JobRecord>
//
// JobRecord (shared fields)
//   type:        'multi_niche' | 'smart'
//   status:      'running' | 'done' | 'error'
//   startedAt:   ISO string
//   finishedAt:  ISO string | null
//   params:      original request params (varies by type)
//   progress:    live counters object (varies by type)
//   result:      final summary (multi_niche only)
//   error:       string | null
//   saved:       boolean (smart only — prevents double-save)
//   _runKey:     internal dedup key
//   _jobId:      echo of Map key
//
// Smart-specific extra fields:
//   stage:       'analyzing' | 'searching' | 'checking' | 'filtering' | 'completed'
//   parsedParams: { country, city, niche, criteria, leadsCount }
//   results:     Array<{ company, city, website, email, niche, reason }>
//   summary:     { candidatesFound, checked, withEmail, matched, stoppedEarlyReason }

const jobs = new Map();
const JOB_TTL_MS = 30 * 60 * 1000;  // keep finished jobs 30 minutes

function scheduleCleanup(jobId) {
  setTimeout(() => jobs.delete(jobId), JOB_TTL_MS);
}

// ── Build public response ─────────────────────────────────────────────────────

function buildResponse(job) {
  const base = {
    type:       job.type,
    status:     job.status,
    startedAt:  job.startedAt,
    finishedAt: job.finishedAt,
    params:     job.params,
    progress:   job.progress,
  };

  if (job.type === 'smart') {
    base.stage       = job.stage;
    base.parsedParams = job.parsedParams;
    if (job.status === 'done')   { base.results = job.results;  base.summary = job.summary; }
    if (job.status === 'error')    base.error   = job.error;
    if (job.saved)                 base.saved   = true;
  } else {
    // multi_niche
    if (job.status === 'done')   base.result  = job.result;
    if (job.status === 'error')  base.error   = job.error;
  }

  return base;
}

// ── GET /api/lead-finder/status/:jobId ────────────────────────────────────────

const getJobStatus = (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({
      error: 'Job not found. It may have expired (jobs are kept 30 minutes) or the ID is wrong.',
    });
  }
  return res.json(buildResponse(job));
};

// ── POST /api/lead-finder/multi-niche-search ──────────────────────────────────

const triggerMultiNicheSearch = async (req, res) => {
  const { projectId, country, niches, totalLeads } = req.body;
  const city = typeof req.body.city === 'string' ? req.body.city.trim() : '';

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
  if (totalLeads == null || typeof totalLeads !== 'number' ||
      !Number.isInteger(totalLeads) || totalLeads < 1 || totalLeads > 5000)
    errors.push('totalLeads must be an integer between 1 and 5000.');

  if (errors.length > 0) return res.status(400).json({ error: 'Validation failed', details: errors });

  // Duplicate-run guard
  const runKey = `multi|${projectId}|${[...niches].sort().join(',')}|${city}`;
  for (const [, existing] of jobs) {
    if (existing.status === 'running' && existing._runKey === runKey)
      return res.status(409).json({ error: 'A search with the same parameters is already running.', jobId: existing._jobId });
  }

  const jobId = randomUUID();
  const job = {
    type:       'multi_niche',
    status:     'running',
    startedAt:  new Date().toISOString(),
    finishedAt: null,
    result:     null,
    error:      null,
    _runKey:    runKey,
    _jobId:     jobId,
    params:     { projectId, country, city, niches, totalLeads },
    progress:   { checked: 0, validFound: 0, target: totalLeads, currentNiche: niches[0] ?? '' },
  };
  jobs.set(jobId, job);

  const onProgress = ({ checked, validFound, currentNiche }) => {
    job.progress.checked      = checked;
    job.progress.validFound   = validFound;
    job.progress.currentNiche = currentNiche;
  };

  runMultiNicheSearch({ projectId, country, city, niches, totalLeads, onProgress })
    .then((result) => {
      job.status     = 'done';
      job.finishedAt = new Date().toISOString();
      job.result     = result;
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

  return res.status(202).json({
    message: 'Search started. Poll /api/lead-finder/status/:jobId for live progress.',
    jobId,
    params: job.params,
  });
};

// ── POST /api/lead-finder/smart-search ───────────────────────────────────────

const triggerSmartSearch = async (req, res) => {
  const { projectId, instructionText } = req.body;

  const errors = [];
  if (!projectId || typeof projectId !== 'string' || !projectId.trim())
    errors.push('projectId is required.');
  if (!instructionText || typeof instructionText !== 'string' || !instructionText.trim())
    errors.push('instructionText is required.');

  if (errors.length > 0) return res.status(400).json({ error: 'Validation failed', details: errors });

  // Duplicate-run guard (per projectId + instruction)
  const runKey = `smart|${projectId}|${instructionText.trim().toLowerCase().slice(0, 100)}`;
  for (const [, existing] of jobs) {
    if (existing.status === 'running' && existing._runKey === runKey)
      return res.status(409).json({ error: 'A smart search with the same instruction is already running.', jobId: existing._jobId });
  }

  const jobId = randomUUID();
  const job = {
    type:         'smart',
    status:       'running',
    startedAt:    new Date().toISOString(),
    finishedAt:   null,
    error:        null,
    saved:        false,
    _runKey:      runKey,
    _jobId:       jobId,
    params:       { projectId, instructionText: instructionText.trim() },
    stage:        'analyzing',
    parsedParams: null,
    results:      null,
    summary:      null,
    progress:     { stage: 'analyzing', detail: 'Starting…' },
  };
  jobs.set(jobId, job);

  // updateJob callback: smartSearchService calls this to report live state
  const updateJob = ({ stage, progress, parsedParams, results, summary } = {}) => {
    if (stage        !== undefined) job.stage        = stage;
    if (progress     !== undefined) job.progress     = progress;
    if (parsedParams !== undefined) job.parsedParams = parsedParams;
    if (results      !== undefined) job.results      = results;
    if (summary      !== undefined) job.summary      = summary;
  };

  runSmartSearch({ projectId, instructionText: instructionText.trim(), updateJob })
    .then(() => {
      job.status     = 'done';
      job.stage      = 'completed';
      job.finishedAt = new Date().toISOString();
      job.progress   = { stage: 'completed', detail: 'Pipeline finished.' };
      scheduleCleanup(jobId);
    })
    .catch((err) => {
      console.error(`[SmartSearch] Job ${jobId} failed:`, err.message);
      job.status     = 'error';
      job.finishedAt = new Date().toISOString();
      job.error      = err.message || 'Unknown error';
      scheduleCleanup(jobId);
    });

  return res.status(202).json({
    message: 'Smart search started. Poll /api/lead-finder/status/:jobId for progress.',
    jobId,
    params: job.params,
  });
};

// ── POST /api/lead-finder/smart-search/:jobId/save ────────────────────────────

const saveSmartSearchResults = async (req, res) => {
  const { jobId }         = req.params;
  const { selectedEmails } = req.body;  // optional array; if omitted, save ALL matched leads

  const job = jobs.get(jobId);
  if (!job)
    return res.status(404).json({ error: 'Job not found or expired.' });
  if (job.type !== 'smart')
    return res.status(400).json({ error: 'This endpoint is only for Smart Search jobs.' });
  if (job.status !== 'done')
    return res.status(400).json({ error: `Job is not completed yet (current status: ${job.status}).` });
  if (job.saved)
    return res.status(409).json({ error: 'This job has already been saved to a batch.' });
  if (!job.results || job.results.length === 0)
    return res.status(400).json({ error: 'No results to save.' });

  // Determine which leads to save
  let leadsToSave = job.results;
  if (Array.isArray(selectedEmails) && selectedEmails.length > 0) {
    const emailSet = new Set(selectedEmails.map(e => e.toLowerCase().trim()));
    leadsToSave = job.results.filter(l => emailSet.has(l.email.toLowerCase().trim()));
  }

  if (leadsToSave.length === 0)
    return res.status(400).json({ error: 'None of the selected emails matched the job results.' });

  // Build batch name: "Smart: {niche} - {country/city} - {date}"
  const pp     = job.parsedParams || {};
  const loc    = pp.city ? `${pp.city}, ${pp.country}` : pp.country || 'Unknown';
  const dateStr = new Date().toISOString().slice(0, 10);
  const batchName = `Smart: ${pp.niche || 'search'} - ${loc} - ${dateStr}`;

  try {
    const batch = new Batch({
      name:      batchName,
      projectId: job.params.projectId,
      source:    'Lead Finder Agent',
      leadCount: leadsToSave.length,
    });
    await batch.save();

    await Lead.insertMany(leadsToSave.map(l => ({
      batchId:     batch._id,
      company:     l.company,
      city:        l.city || pp.city || pp.country || '',
      website:     l.website || '',
      email:       l.email,
      niche:       l.niche || pp.niche || '',
      matchReason: l.reason || '',
      status:      'Valid',
    })));

    job.saved = true;

    console.log(`[SmartSearch] Saved ${leadsToSave.length} leads to batch "${batchName}" (${batch._id})`);

    return res.json({
      success:    true,
      batchId:    batch._id,
      batchName,
      savedCount: leadsToSave.length,
    });
  } catch (err) {
    console.error('[SmartSearch] Save error:', err.message);
    return res.status(500).json({ error: `Failed to save leads: ${err.message}` });
  }
};

module.exports = { triggerMultiNicheSearch, triggerSmartSearch, saveSmartSearchResults, getJobStatus };
