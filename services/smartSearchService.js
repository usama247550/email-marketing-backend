/**
 * services/smartSearchService.js
 *
 * Smart Search pipeline — Steps 2, 3, 4 and 5.
 *
 *  Step 2: parseSmartSearchInstruction  — AI parses free-text into structured params
 *  Step 3: extractWebsiteSignals        — pure HTML signal extraction (no AI)
 *  Step 4: evaluateLeadsAgainstCriteria — AI batch-scores candidates against criteria
 *  Step 5: runSmartSearch               — full background pipeline orchestrator
 *
 * TomTom search + email scraping is imported from leadFinderService (no duplication).
 */

'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');

const { askAI }   = require('./aiService');
const Batch       = require('../models/Batch');
const Lead        = require('../models/Lead');

// Shared helpers imported from leadFinderService — no code duplication
const {
  searchTomTom,
  parseTomTomResult,
  scrapeWebsiteForEmail,
  runInBatches,
  normaliseUrl,
  sleep,
  HARD_CAP_PER_NICHE,
  TOMTOM_CALL_DELAY_MS,
  TOMTOM_PAGE_SIZE,
  OVERFETCH_RATIO,
} = require('./leadFinderService');

// ── Config ────────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS      = 10_000;
const MAX_RESPONSE_BYTES    = 3 * 1024 * 1024;
const EVAL_CHUNK_SIZE       = 8;      // candidates per AI evaluation call
const EVAL_CHUNK_DELAY_MS   = 1500;   // pause between AI evaluation calls (free-tier)
const EVAL_RETRY_DELAY_MS   = 3000;   // pause before retrying after 429
const SIGNAL_CONCURRENCY    = 8;      // parallel extractWebsiteSignals calls
const SCRAPE_CONCURRENCY    = 10;     // parallel scrapeWebsiteForEmail calls

// Patterns that suggest a modern JS/CSS framework
const MODERN_FRAMEWORK_PATTERNS = [
  /__next/i, /react(?:\.min)?\.js/i, /_next\/static/i, /data-reactroot/i,
  /vue(?:\.min)?\.js/i, /__nuxt/i, /ng-version/i, /angular(?:\.min)?\.js/i,
  /tailwind(?:css)?(?:\.min)?\.css/i,
  /class="[^"]*(?:flex|grid|px-|py-|text-|bg-)[^"]*"/,
  /bootstrap(?:\.min)?\.(?:css|js)/i,
  /class="[^"]*(?:container-fluid|navbar-expand|btn-primary)/,
];

// ── Internal fetch helper (Step 3) ────────────────────────────────────────────

async function fetchForSignals(rawUrl) {
  let url = (rawUrl || '').trim();
  if (!url) return null;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  const t0 = Date.now();
  try {
    const resp = await axios.get(url, {
      timeout: FETCH_TIMEOUT_MS,
      maxRedirects: 5,
      maxContentLength: MAX_RESPONSE_BYTES,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      validateStatus: () => true,
    });

    const loadTimeMs = Date.now() - t0;
    const finalUrl   = resp.request?.res?.responseUrl || url;
    const hasSSL     = finalUrl.startsWith('https://');
    const ct         = (resp.headers['content-type'] || '').toLowerCase();

    if (!ct.includes('html') && !ct.includes('text/plain')) return null;
    if (resp.status >= 400) return null;

    return { html: String(resp.data), finalUrl, loadTimeMs, hasSSL, statusCode: resp.status };
  } catch {
    return null;
  }
}

// ── Step 2 ────────────────────────────────────────────────────────────────────

/**
 * parseSmartSearchInstruction
 * AI-powered free-text → structured params.
 *
 * @param {string} instructionText
 * @returns {Promise<{ country, city, niche, criteria, leadsCount }>}
 */
async function parseSmartSearchInstruction(instructionText) {
  const systemPrompt = `You are a search-parameter extractor for a B2B lead-generation tool.

The user will describe (in any language) the kind of business leads they want to find.
Your job is to extract exactly these fields and return them as a JSON object:

  country     (string)        — The target country. Default to "Germany" if not clearly stated.
  city        (string|null)   — The specific city, or null if no city is mentioned or the user
                                  wants to search the whole country.
  niche       (string)        — The business type/category as a concise English search term that
                                  works well as a TomTom POI query (e.g. "restaurant", "cafe",
                                  "dentist", "hair salon", "car repair").  One term, no commas.
  criteria    (string|null)   — A clear, concise restatement of the qualitative filter that makes
                                  a lead "good" or a match for what the user wants (e.g.
                                  "outdated website design", "no mobile-friendly site",
                                  "missing SSL certificate").  Use null if no quality criteria
                                  are mentioned — in that case all found businesses are treated
                                  as matching.
  leadsCount  (number)        — How many leads the user wants.  Default to 20 if not specified.
                                  Must be an integer between 1 and 200.

Rules:
- Respond ONLY with a JSON object containing exactly those 5 keys.
- Do not add extra keys, explanations, or markdown.
- If the instruction mentions multiple niches, pick the single most prominent one.
- Keep niche as a simple, lowercase English noun or noun phrase.`;

  const result = await askAI(systemPrompt, `Instruction: "${instructionText}"`, { jsonMode: true });

  return {
    country:    typeof result.country    === 'string' ? result.country.trim()          : 'Germany',
    city:       typeof result.city       === 'string' ? result.city.trim() || null      : null,
    niche:      typeof result.niche      === 'string' ? result.niche.trim().toLowerCase() : 'business',
    criteria:   typeof result.criteria   === 'string' ? result.criteria.trim() || null  : null,
    leadsCount: Number.isInteger(result.leadsCount) && result.leadsCount > 0
                  ? Math.min(result.leadsCount, 200)
                  : 20,
  };
}

// ── Step 3 ────────────────────────────────────────────────────────────────────

/**
 * extractWebsiteSignals
 * Pure HTML parsing — no AI.
 *
 * @param {string} websiteUrl
 * @returns {Promise<signals object>}
 */
async function extractWebsiteSignals(websiteUrl) {
  const unreachable = {
    siteUnreachable: true,
    hasSSL: null, hasMobileViewport: null, copyrightYear: null,
    pageTitle: null, hasSocialLinks: null, estimatedLoadTimeMs: null,
    hasModernFramework: null, detectedLanguage: null, wordCount: null,
  };

  const fetched = await fetchForSignals(websiteUrl);
  if (!fetched) return unreachable;

  const { html, loadTimeMs, hasSSL } = fetched;

  try {
    const $ = cheerio.load(html);

    const hasMobileViewport = $('meta[name="viewport"]').length > 0;
    const pageTitle         = $('title').first().text().trim() || null;
    const htmlLang          = $('html').attr('lang');
    const detectedLanguage  = htmlLang ? htmlLang.trim().toLowerCase() : null;

    const footerText = $('footer, #footer, .footer, [class*="footer"]').text() || '';
    const searchText = (footerText || $.text()).replace(/\s+/g, ' ');
    const copyrightRe  = /(?:©|copyright|\(c\))[\s\S]{0,60}?((?:19|20)\d{2})/i;
    const copyrightRe2 = /((?:19|20)\d{2})[\s\S]{0,20}?(?:©|copyright)/i;
    let copyrightYear  = null;
    const m1 = searchText.match(copyrightRe);
    const m2 = searchText.match(copyrightRe2);
    if (m1) copyrightYear = parseInt(m1[1], 10);
    else if (m2) copyrightYear = parseInt(m2[1], 10);
    if (copyrightYear && (copyrightYear < 1990 || copyrightYear > new Date().getFullYear() + 1))
      copyrightYear = null;

    const socialDomains = ['facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'linkedin.com'];
    let hasSocialLinks = false;
    $('a[href]').each((_, el) => {
      if (hasSocialLinks) return false;
      const href = ($(el).attr('href') || '').toLowerCase();
      if (socialDomains.some(d => href.includes(d))) hasSocialLinks = true;
    });

    let hasModernFramework = false;
    for (const p of MODERN_FRAMEWORK_PATTERNS) { if (p.test(html)) { hasModernFramework = true; break; } }

    $('script, style, noscript').remove();
    const cleanText = $.text().replace(/\s+/g, ' ').trim();
    const wordCount  = cleanText.split(' ').filter(w => w.length > 1).length;

    return { siteUnreachable: false, hasSSL, hasMobileViewport, copyrightYear, pageTitle,
             hasSocialLinks, estimatedLoadTimeMs: loadTimeMs, hasModernFramework,
             detectedLanguage, wordCount };
  } catch (err) {
    console.error('[SmartSearch] extractWebsiteSignals parse error:', err.message);
    return { siteUnreachable: false, hasSSL, hasMobileViewport: null, copyrightYear: null,
             pageTitle: null, hasSocialLinks: null, estimatedLoadTimeMs: loadTimeMs,
             hasModernFramework: null, detectedLanguage: null, wordCount: null };
  }
}

// ── Step 4 ────────────────────────────────────────────────────────────────────

/**
 * evaluateLeadsAgainstCriteria
 *
 * Batch-scores candidates against the user's qualitative criteria using AI.
 * Candidates are chunked into groups of EVAL_CHUNK_SIZE, each chunk = one AI call.
 *
 * If criteria is null/empty every candidate is a match (no AI called).
 *
 * @param {string|null} criteria   e.g. "outdated website design"
 * @param {Array<{ company: string, website: string, signals: object }>} candidates
 *
 * @returns {Promise<Array<{ company: string, website: string, match: boolean, reason: string }>>}
 */
async function evaluateLeadsAgainstCriteria(criteria, candidates) {
  // ── No criteria → all match, skip AI entirely ─────────────────────────
  if (!criteria || !criteria.trim()) {
    return candidates.map(c => ({
      company: c.company,
      website: c.website,
      match:   true,
      reason:  'No specific criteria requested — all leads accepted.',
    }));
  }

  const systemPrompt = `You are evaluating whether each business matches a specific lead-qualification criterion.

You will receive a JSON array of candidates, each with these signals extracted from their website:
  hasSSL, hasMobileViewport, copyrightYear, pageTitle, hasSocialLinks,
  estimatedLoadTimeMs, hasModernFramework, detectedLanguage, wordCount, siteUnreachable.

Rules:
- Evaluate ONLY using the provided signals. Do NOT invent facts.
- If signals are insufficient or siteUnreachable is true, decide conservatively (match: false) and note it in the reason.
- Return a JSON array with one object per candidate in the same order, each with:
    { "index": <number>, "match": <boolean>, "reason": "<one short sentence>" }
- "reason" must directly reference the signals that led to your decision.
- Respond with ONLY the JSON array. No markdown, no explanation outside the array.`;

  const results = [];

  for (let chunkStart = 0; chunkStart < candidates.length; chunkStart += EVAL_CHUNK_SIZE) {
    const chunk     = candidates.slice(chunkStart, chunkStart + EVAL_CHUNK_SIZE);
    const chunkList = chunk.map((c, i) => ({
      index:   i,
      company: c.company,
      website: c.website,
      signals: c.signals,
    }));

    const userPrompt =
      `Criterion: "${criteria}"\n\nCandidates:\n${JSON.stringify(chunkList, null, 2)}`;

    let evaluated = null;

    // Try once, then retry on failure or 429
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const raw = await askAI(systemPrompt, userPrompt, { jsonMode: true });

        // Validate: must be an array with the right indexes
        if (!Array.isArray(raw)) throw new Error('AI returned non-array');
        if (raw.length !== chunk.length) throw new Error(`Expected ${chunk.length} items, got ${raw.length}`);
        for (const item of raw) {
          if (typeof item.index !== 'number' || typeof item.match !== 'boolean')
            throw new Error('AI returned malformed item');
        }
        evaluated = raw;
        break;
      } catch (err) {
        const is429 = err.message?.includes('429');
        if (attempt === 1) {
          const delay = is429 ? EVAL_RETRY_DELAY_MS : 500;
          console.warn(`[SmartSearch] Eval chunk attempt ${attempt} failed: ${err.message}. Retrying in ${delay}ms…`);
          await sleep(delay);
        } else {
          // Second failure: mark all in this chunk as failed (not matched)
          console.error(`[SmartSearch] Eval chunk at index ${chunkStart} failed after 2 attempts:`, err.message);
          evaluated = chunk.map((_, i) => ({
            index:  i,
            match:  false,
            reason: 'Evaluation failed — could not reach AI for this candidate.',
          }));
        }
      }
    }

    // Map back to candidates
    for (const item of evaluated) {
      const candidate = chunk[item.index];
      if (!candidate) continue; // malformed index guard
      results.push({
        company: candidate.company,
        website: candidate.website,
        match:   item.match,
        reason:  item.reason || '',
      });
    }

    // Delay between chunks to respect free-tier rate limit
    if (chunkStart + EVAL_CHUNK_SIZE < candidates.length) {
      await sleep(EVAL_CHUNK_DELAY_MS);
    }
  }

  return results;
}

// ── Step 5 ────────────────────────────────────────────────────────────────────

/**
 * runSmartSearch
 *
 * Full pipeline background orchestrator.
 *
 * Stages: analyzing → searching → checking → filtering → completed
 *
 * Does NOT save a Batch to the database.  Instead it stores the matched leads
 * in job.results.  The caller (triggerSmartSearch controller) creates the job
 * record and passes updateJob / setStage so this function can report live progress.
 *
 * @param {object} opts
 * @param {string}   opts.projectId
 * @param {string}   opts.instructionText
 * @param {Function} opts.updateJob   ({ stage?, progress?, parsedParams?, results?, summary? }) => void
 *                                    Mutates the in-memory job object — no DB write.
 */
async function runSmartSearch({ projectId, instructionText, updateJob }) {
  const noop = () => {};
  const update = typeof updateJob === 'function' ? updateJob : noop;

  console.log(`[SmartSearch] ── Starting pipeline ──────────────────────────────────`);
  console.log(`[SmartSearch] project: ${projectId} | instruction: "${instructionText}"`);

  // ── Pre-load existing project emails for deduplication ────────────────
  const existingBatches  = await Batch.find({ projectId }, '_id');
  const existingBatchIds = existingBatches.map(b => b._id);
  let   projectEmails    = new Set();

  if (existingBatchIds.length > 0) {
    const existing = await Lead.find(
      { batchId: { $in: existingBatchIds }, email: { $exists: true, $ne: '' } },
      'email'
    ).lean();
    projectEmails = new Set(existing.map(l => l.email.toLowerCase().trim()));
    console.log(`[SmartSearch] Pre-loaded ${projectEmails.size} existing email(s) for dedup`);
  }

  // ══════════════════════════════════════════════════════════════════════
  // Stage 1: ANALYZING — parse instruction text with AI
  // ══════════════════════════════════════════════════════════════════════
  update({ stage: 'analyzing', progress: { stage: 'analyzing', detail: 'Parsing your instruction…' } });

  const parsed = await parseSmartSearchInstruction(instructionText);
  console.log(`[SmartSearch] Parsed:`, JSON.stringify(parsed));

  if (!parsed.country) {
    throw new Error('Could not determine a target country from the instruction. Please mention a country (e.g. "in Germany").');
  }

  update({ parsedParams: parsed, progress: { stage: 'analyzing', detail: 'Instruction parsed.' } });

  const { country, city, niche, criteria, leadsCount } = parsed;
  // We fetch roughly 3× leadsCount candidates (capped to HARD_CAP_PER_NICHE)
  const candidateTarget = Math.min(leadsCount * 3, HARD_CAP_PER_NICHE);

  // ══════════════════════════════════════════════════════════════════════
  // Stage 2: SEARCHING — TomTom + collect businesses with websites
  // ══════════════════════════════════════════════════════════════════════
  update({ stage: 'searching', progress: { stage: 'searching', detail: `Searching TomTom for "${niche}" in ${city || country}…` } });

  const tomtomCallCounter = { count: 0 };
  const seenPOIs          = new Set();
  const candidatesRaw     = [];   // [{name, address, city, website}]
  let   tomtomOffset      = 0;
  let   searchStopReason  = null;

  while (candidatesRaw.length < candidateTarget) {
    const budget   = candidateTarget - candidatesRaw.length;
    const fetch    = Math.min(budget * OVERFETCH_RATIO, TOMTOM_PAGE_SIZE);

    if (tomtomOffset > 0) await sleep(TOMTOM_CALL_DELAY_MS);

    const { results: raw, rateLimited, exhausted } = await searchTomTom({
      niche, country, city: city || '', limit: fetch, offset: tomtomOffset, tomtomCallCounter,
    });

    if (rateLimited) { searchStopReason = 'rate_limit'; break; }
    if (exhausted || raw.length === 0) break;

    const deduped = raw.filter(r => {
      const id = r.id || (r.poi?.name ?? '') + (r.address?.freeformAddress ?? '');
      if (seenPOIs.has(id)) return false;
      seenPOIs.add(id);
      return true;
    });
    tomtomOffset += raw.length;

    for (const r of deduped.map(parseTomTomResult)) {
      if (r.website) candidatesRaw.push(r);
      if (candidatesRaw.length >= candidateTarget) break;
    }

    update({ progress: {
      stage: 'searching',
      detail: `Found ${candidatesRaw.length} candidates with websites so far…`,
      candidatesFound: candidatesRaw.length,
    }});

    console.log(`[SmartSearch] TomTom offset=${tomtomOffset} → ${candidatesRaw.length} candidates with websites`);
  }

  console.log(`[SmartSearch] Searching done: ${candidatesRaw.length} candidates (${tomtomCallCounter.count} TomTom calls)${searchStopReason ? ` [${searchStopReason}]` : ''}`);

  if (candidatesRaw.length === 0) {
    // Nothing found — still complete the job gracefully
    update({ results: [], summary: {
      candidatesFound: 0, checked: 0, withEmail: 0, matched: 0,
      stoppedEarlyReason: searchStopReason,
    }});
    return;
  }

  // ══════════════════════════════════════════════════════════════════════
  // Stage 3: CHECKING — parallel signals + email scraping, dedup
  // ══════════════════════════════════════════════════════════════════════
  update({ stage: 'checking', progress: {
    stage: 'checking',
    detail: `Checking ${candidatesRaw.length} websites for emails and signals…`,
    total: candidatesRaw.length, checked: 0,
  }});

  let checkedCount = 0;

  // Run signals + email scraping in parallel batches
  const signalJobs = candidatesRaw.map(biz => async () => {
    const [signals, email] = await Promise.all([
      extractWebsiteSignals(biz.website),
      scrapeWebsiteForEmail(biz.website),
    ]);
    checkedCount++;
    update({ progress: {
      stage: 'checking',
      detail: `Checked ${checkedCount} of ${candidatesRaw.length} websites…`,
      total: candidatesRaw.length, checked: checkedCount,
    }});
    return { biz, signals, email };
  });

  const checkResults = await runInBatches(signalJobs, Math.max(SIGNAL_CONCURRENCY, SCRAPE_CONCURRENCY));

  // Filter: must have a usable non-duplicate email
  const withEmail = [];
  const seenEmails = new Set();

  for (const r of checkResults) {
    if (!r) continue;
    const { biz, signals, email } = r;
    if (!email) continue;
    const norm = email.toLowerCase().trim();
    if (projectEmails.has(norm) || seenEmails.has(norm)) continue;
    seenEmails.add(norm);
    withEmail.push({ biz, signals, email: norm });
  }

  console.log(`[SmartSearch] Checking done: ${withEmail.length} with usable email out of ${candidatesRaw.length} checked`);

  // ══════════════════════════════════════════════════════════════════════
  // Stage 4: FILTERING — AI evaluates each candidate against criteria
  // ══════════════════════════════════════════════════════════════════════
  update({ stage: 'filtering', progress: {
    stage: 'filtering',
    detail: `Evaluating ${withEmail.length} candidates against criteria…`,
    total: withEmail.length,
  }});

  const evalCandidates = withEmail.map(({ biz, signals }) => ({
    company: biz.name,
    website: biz.website,
    signals,
  }));

  const evalResults = await evaluateLeadsAgainstCriteria(criteria, evalCandidates);

  // Merge evaluation results back with email + biz data, keep only matches
  const matchedLeads = [];
  for (let i = 0; i < evalResults.length; i++) {
    const ev = evalResults[i];
    if (!ev.match) continue;
    const { biz, email } = withEmail[i];
    matchedLeads.push({
      company: biz.name,
      city:    biz.city || city || country,
      website: biz.website,
      email,
      niche,
      reason:  ev.reason,
    });
    if (matchedLeads.length >= leadsCount) break;
  }

  console.log(`[SmartSearch] Filtering done: ${matchedLeads.length} matches out of ${withEmail.length} evaluated`);

  // ══════════════════════════════════════════════════════════════════════
  // Done — store results in job (batch NOT saved here; save endpoint does that)
  // ══════════════════════════════════════════════════════════════════════
  const summary = {
    candidatesFound:    candidatesRaw.length,
    checked:            candidatesRaw.length,
    withEmail:          withEmail.length,
    matched:            matchedLeads.length,
    tomtomCallCount:    tomtomCallCounter.count,
    stoppedEarlyReason: searchStopReason,
  };

  update({ results: matchedLeads, summary });

  console.log('[SmartSearch] ── Pipeline complete ─────────────────────────────────────');
  console.log('[SmartSearch]', JSON.stringify(summary, null, 2));
}

module.exports = {
  parseSmartSearchInstruction,
  extractWebsiteSignals,
  evaluateLeadsAgainstCriteria,
  runSmartSearch,
};
