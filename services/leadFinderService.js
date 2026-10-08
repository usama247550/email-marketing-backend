/**
 * services/leadFinderService.js
 *
 * Core logic for the Multi-Niche Lead Finder.
 *
 * Called from:
 *   1. controllers/leadFinderController.js  — HTTP trigger, passes onProgress callback
 *   2. services/scheduler.js (future)        — automated daily runs (onProgress optional)
 *
 * ── TomTom quota controls (this version) ─────────────────────────────────────
 *
 *  HARD_CAP_PER_NICHE   – absolute ceiling on businesses checked per niche per run.
 *                         Replaces the old unbounded SAFETY_CAP_RATIO (8×) that sent
 *                         4000+ offset requests in one run.  Set conservatively so
 *                         a full multi-niche search stays well within the free tier.
 *
 *  OVERFETCH_RATIO      – how many results to request per TomTom call, expressed as
 *                         a multiple of the remaining valid-lead target for that niche.
 *                         Kept at 3× so we don't under-fetch on the first call, but
 *                         the hard cap above bounds total calls regardless.
 *
 *  TOMTOM_CALL_DELAY_MS – minimum pause between consecutive TomTom calls within a
 *                         single search run.  Prevents request-burst rate-limiting
 *                         (separate from daily quota exhaustion).
 *
 *  On a 403 response from TomTom: stop immediately, save whatever valid leads were
 *  already found, and include stopReason = 'rate_limit' in the summary so the UI
 *  can explain the shortfall to the user.
 */

'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');
const Batch   = require('../models/Batch');
const Lead    = require('../models/Lead');

// ── Config ────────────────────────────────────────────────────────────────────

const TOMTOM_BASE_URL      = 'https://api.tomtom.com/search/2/search';
const SCRAPE_CONCURRENCY   = 10;    // parallel website scrapes per batch
const SCRAPE_TIMEOUT_MS    = 8000;  // per-site hard timeout (ms)
const TOMTOM_PAGE_SIZE     = 100;   // TomTom max results per single request
const OVERFETCH_RATIO      = 3;     // fetch 3× remaining-valid-target per TomTom call
const HARD_CAP_PER_NICHE   = 50;    // ABSOLUTE max businesses checked per niche per run
                                    // (replaces unbounded SAFETY_CAP_RATIO = 8×)
const TOMTOM_CALL_DELAY_MS = 250;   // pause between consecutive TomTom requests

// ── Email helpers ─────────────────────────────────────────────────────────────

const EMAIL_REGEX = /\b[a-zA-Z0-9._%+\-]{1,64}@[a-zA-Z0-9.\-]{1,253}\.[a-zA-Z]{2,}\b/g;

const LOCAL_PART_BLACKLIST = [
  /\.(png|jpe?g|gif|svg|webp|css|js|woff2?|ttf|eot|ico|pdf)$/i,
  /^(example|test|noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster|abuse|spam)$/i,
  /\d{6,}/,
];

// TLDs that are actually image/media file extensions misidentified as emails
const FAKE_TLDS = new Set(['png','jpg','jpeg','gif','svg','webp','css','js','woff','woff2','ttf','eot','ico','pdf','mp4','mp3','zip','xml','json']);

const DOMAIN_BLACKLIST = [
  'example.com', 'example.org', 'example.net',
  'sentry.io', 'wixpress.com', 'githubusercontent.com',
  'cloudflare.com', 'googletagmanager.com', 'google-analytics.com',
  'gravatar.com', 'jquery.com', 'w3.org', 'schema.org',
  'facebook.com', 'twitter.com', 'instagram.com', 'linkedin.com',
];

const CONTACT_PATHS = [
  '/kontakt', '/impressum', '/contact', '/imprint',
  '/ueber-uns', '/about-us', '/about', '/reach-us', '/get-in-touch',
  '/kontakt.html', '/impressum.html', '/contact.html',
];

// ── Tiny helpers ──────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function normaliseUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let url = raw.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
  try {
    const p = new URL(url);
    return ['http:', 'https:'].includes(p.protocol) ? p.href : null;
  } catch { return null; }
}

function distribute(total, count) {
  if (count <= 0) return [];
  const base = Math.floor(total / count), rem = total % count;
  return Array.from({ length: count }, (_, i) => base + (i < rem ? 1 : 0));
}

// ── Email filtering ───────────────────────────────────────────────────────────

function isUsableEmail(email) {
  if (!email || typeof email !== 'string') return false;
  const lower = email.toLowerCase().trim();
  if (!/^[^\s@]{1,64}@[^\s@]{1,253}\.[a-z]{2,}$/.test(lower)) return false;
  const [local, domain] = lower.split('@');
  if (DOMAIN_BLACKLIST.includes(domain)) return false;
  for (const p of LOCAL_PART_BLACKLIST) if (p.test(local)) return false;
  // Reject if the TLD is actually a media/asset file extension (e.g. flags@2x.webp)
  const tld = domain.split('.').pop();
  if (FAKE_TLDS.has(tld)) return false;
  return true;
}

function extractEmailsFromHtml(html) {
  if (!html) return [];
  const $ = cheerio.load(html);
  const found = new Set();
  $('a[href^="mailto:"], a[href^="MAILTO:"]').each((_, el) => {
    const mail = ($(el).attr('href') || '').replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
    if (isUsableEmail(mail)) found.add(mail);
  });
  for (const m of ($.text().match(EMAIL_REGEX) || []))
    { const mail = m.toLowerCase(); if (isUsableEmail(mail)) found.add(mail); }
  for (const m of (html.match(EMAIL_REGEX) || []))
    { const mail = m.toLowerCase(); if (isUsableEmail(mail)) found.add(mail); }
  return [...found];
}

// ── Page fetching ─────────────────────────────────────────────────────────────

async function fetchPage(url) {
  try {
    const resp = await axios.get(url, {
      timeout: SCRAPE_TIMEOUT_MS,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      validateStatus: s => s < 500,
      maxContentLength: 2 * 1024 * 1024,
    });
    if (resp.status >= 400) return null;
    const ct = (resp.headers['content-type'] || '').toLowerCase();
    if (!ct.includes('text/html') && !ct.includes('text/plain') && !ct.includes('application/xhtml'))
      return null;
    const finalUrl = resp.request?.res?.responseUrl || url;
    return { html: String(resp.data), finalUrl };
  } catch { return null; }
}

async function scrapeWebsiteForEmail(rawUrl) {
  const url = normaliseUrl(rawUrl);
  if (!url) return null;
  let origin;
  try { origin = new URL(url).origin; } catch { return null; }

  const home = await fetchPage(url);
  if (!home) return null;
  const homeEmails = extractEmailsFromHtml(home.html);
  if (homeEmails.length > 0) return homeEmails[0];

  let homePath;
  try { homePath = new URL(home.finalUrl).pathname; } catch { homePath = '/'; }
  const visited = new Set([homePath]);

  const $ = cheerio.load(home.html);
  const linkedUrls = [];
  $('a[href]').each((_, el) => {
    const href = ($(el).attr('href') || '').trim();
    if (!href) return;
    const lower = href.toLowerCase();
    if (!CONTACT_PATHS.some(p => lower === p || lower.startsWith(p + '/') ||
        lower.startsWith(p + '?') || lower.endsWith(p))) return;
    try {
      const abs = new URL(href, home.finalUrl).href;
      const path = new URL(abs).pathname;
      if (!visited.has(path)) { visited.add(path); linkedUrls.push(abs); }
    } catch { /* bad href */ }
  });

  for (const cu of linkedUrls) {
    const page = await fetchPage(cu);
    if (!page) continue;
    const emails = extractEmailsFromHtml(page.html);
    if (emails.length > 0) return emails[0];
  }

  for (const path of CONTACT_PATHS) {
    if (visited.has(path)) continue;
    visited.add(path);
    const page = await fetchPage(`${origin}${path}`);
    if (!page) continue;
    const emails = extractEmailsFromHtml(page.html);
    if (emails.length > 0) return emails[0];
  }

  return null;
}

// ── Concurrency helper ────────────────────────────────────────────────────────

async function runInBatches(fns, concurrency) {
  const results = [];
  for (let i = 0; i < fns.length; i += concurrency) {
    const settled = await Promise.allSettled(fns.slice(i, i + concurrency).map(f => f()));
    for (const r of settled) results.push(r.status === 'fulfilled' ? r.value : null);
  }
  return results;
}

// ── TomTom search ─────────────────────────────────────────────────────────────

/**
 * Make one TomTom Fuzzy Search request and return a rich result object.
 *
 * @returns {{ results: object[], rateLimited: boolean, exhausted: boolean }}
 *   rateLimited  true if TomTom returned 403 (daily/burst quota hit)
 *   exhausted    true if TomTom returned an empty result set (no more POIs)
 *   results      array of raw TomTom result objects
 */
async function searchTomTom({ niche, country, city, limit, offset, tomtomCallCounter }) {
  const apiKey = process.env.TOMTOM_API_KEY;
  if (!apiKey) throw new Error('TOMTOM_API_KEY is not set in environment variables.');

  const query      = city ? `${niche} ${city} ${country}` : `${niche} ${country}`;
  const safeLimit  = Math.min(limit, TOMTOM_PAGE_SIZE);

  tomtomCallCounter.count += 1;  // increment shared call counter before the request

  try {
    const resp = await axios.get(`${TOMTOM_BASE_URL}/${encodeURIComponent(query)}.json`, {
      timeout: 15000,
      params: { key: apiKey, limit: safeLimit, offset, typeahead: false, idxSet: 'POI' },
    });

    const results = resp.data?.results || [];
    return { results, rateLimited: false, exhausted: results.length === 0 };

  } catch (err) {
    const status = err.response?.status;
    if (status === 403 || status === 429) {
      console.warn(
        `[LeadFinder] ⚠ TomTom quota/rate limit (HTTP ${status}) ` +
        `for "${query}" at offset ${offset}. Stopping search early.`
      );
      return { results: [], rateLimited: true, exhausted: false };
    }
    // Other network error (timeout, DNS, etc.) — treat as empty, not rate limited
    console.error(`[LeadFinder] TomTom error for "${query}" (offset ${offset}):`, err.message);
    return { results: [], rateLimited: false, exhausted: true };
  }
}

function parseTomTomResult(r) {
  const poi = r.poi || {}, addr = r.address || {};
  return {
    name:    poi.name || addr.freeformAddress || 'Unknown',
    address: addr.freeformAddress || '',
    city:    addr.municipality || addr.localName || '',
    website: normaliseUrl(poi.url || null),
  };
}

// ── Per-niche search loop ─────────────────────────────────────────────────────

/**
 * Search + scrape one niche until `targetValid` valid leads are found,
 * the hard cap is hit, TomTom is exhausted, or a rate-limit is encountered.
 *
 * @param {object}   opts
 * @param {string}   opts.niche
 * @param {string}   opts.country
 * @param {string}   opts.city              '' = whole country
 * @param {number}   opts.targetValid       desired valid leads from this niche
 * @param {Set}      opts.seenEmails        cross-niche dedup (mutated in place)
 * @param {Set}      opts.projectEmails     pre-loaded project emails (read-only)
 * @param {number}   opts.globalChecked     cumulative checked before this niche
 * @param {number}   opts.globalValid       cumulative valid before this niche
 * @param {object}   opts.tomtomCallCounter { count: number } — shared mutable counter
 * @param {Function} opts.onProgress        ({ checked, validFound, currentNiche }) => void
 *
 * @returns {Promise<{
 *   validLeads:   Array<object>,
 *   totalChecked: number,
 *   rateLimited:  boolean,   // true if we stopped because of a 403/429
 *   capHit:       boolean,   // true if we stopped because of HARD_CAP_PER_NICHE
 * }>}
 */
async function searchNiche({
  niche, country, city, targetValid,
  seenEmails, projectEmails,
  globalChecked, globalValid,
  tomtomCallCounter,
  onProgress,
}) {
  const validLeads  = [];
  let nicheChecked  = 0;
  let tomtomOffset  = 0;
  let rateLimited   = false;
  let capHit        = false;
  const seenPOIs    = new Set();

  console.log(
    `[LeadFinder]   Niche "${niche}": target=${targetValid} valid, ` +
    `hard cap=${HARD_CAP_PER_NICHE} businesses`
  );

  // Announce the niche switch to the progress tracker
  onProgress({ checked: globalChecked, validFound: globalValid, currentNiche: niche });

  while (validLeads.length < targetValid) {

    // ── Hard cap check ─────────────────────────────────────────────────────
    if (nicheChecked >= HARD_CAP_PER_NICHE) {
      capHit = true;
      console.log(
        `[LeadFinder]   Niche "${niche}": hard cap of ${HARD_CAP_PER_NICHE} businesses ` +
        `reached (found ${validLeads.length}/${targetValid} valid). Stopping niche.`
      );
      break;
    }

    // ── Calculate how many to fetch this page ─────────────────────────────
    // Don't exceed the remaining hard-cap budget
    const remaining     = targetValid - validLeads.length;
    const capBudget     = HARD_CAP_PER_NICHE - nicheChecked;
    const fetchCount    = Math.min(remaining * OVERFETCH_RATIO, TOMTOM_PAGE_SIZE, capBudget);

    // ── Delay between TomTom calls to avoid burst rate-limiting ───────────
    if (tomtomOffset > 0) {
      await sleep(TOMTOM_CALL_DELAY_MS);
    }

    // ── TomTom call ────────────────────────────────────────────────────────
    const { results: rawResults, rateLimited: rl, exhausted } = await searchTomTom({
      niche, country, city,
      limit:             fetchCount,
      offset:            tomtomOffset,
      tomtomCallCounter,
    });

    if (rl) {
      rateLimited = true;
      break;   // stop this niche AND signal outer loop to abort remaining niches
    }

    if (exhausted || rawResults.length === 0) {
      console.log(`[LeadFinder]   Niche "${niche}": TomTom exhausted at offset ${tomtomOffset}`);
      break;
    }

    // ── Deduplicate POIs across pages ─────────────────────────────────────
    const newResults = rawResults.filter(r => {
      const id = r.id || (r.poi?.name ?? '') + (r.address?.freeformAddress ?? '');
      if (seenPOIs.has(id)) return false;
      seenPOIs.add(id);
      return true;
    });
    tomtomOffset  += rawResults.length;

    const businesses  = newResults.map(parseTomTomResult);
    const withWebsite = businesses.filter(b => !!b.website);
    nicheChecked     += businesses.length;

    // ── Scrape the batch ───────────────────────────────────────────────────
    if (withWebsite.length > 0) {
      const emails = await runInBatches(
        withWebsite.map(biz => () => scrapeWebsiteForEmail(biz.website)),
        SCRAPE_CONCURRENCY,
      );

      for (let i = 0; i < withWebsite.length; i++) {
        const email = emails[i];
        if (!email) continue;
        const norm = email.toLowerCase().trim();
        if (projectEmails.has(norm) || seenEmails.has(norm)) {
          console.log(`[LeadFinder]   Skipping duplicate: ${norm}`);
          continue;
        }
        seenEmails.add(norm);
        validLeads.push({ ...withWebsite[i], email: norm, niche });
        if (validLeads.length >= targetValid) break;
      }
    }

    // ── Progress update after each TomTom page ────────────────────────────
    onProgress({
      checked:      globalChecked + nicheChecked,
      validFound:   globalValid   + validLeads.length,
      currentNiche: niche,
    });

    console.log(
      `[LeadFinder]   Niche "${niche}": ${validLeads.length}/${targetValid} valid` +
      ` (checked=${nicheChecked}/${HARD_CAP_PER_NICHE}, offset=${tomtomOffset}, ` +
      `TomTom calls so far=${tomtomCallCounter.count})`
    );
  }

  return { validLeads, totalChecked: nicheChecked, rateLimited, capHit };
}

// ── Main exported function ────────────────────────────────────────────────────

/**
 * runMultiNicheSearch
 *
 * @param {object}    opts
 * @param {string}    opts.projectId
 * @param {string}    opts.country
 * @param {string}    opts.city           '' = all cities
 * @param {string[]}  opts.niches
 * @param {number}    opts.totalLeads     target VALID leads
 * @param {Function}  [opts.onProgress]   optional live-progress hook
 *
 * @returns {Promise<{
 *   batchId, totalFound, validCount, checkedCount,
 *   tomtomCallCount, stopReason, perNicheBreakdown
 * }>}
 *
 * stopReason values:
 *   null              – completed normally (target reached or TomTom exhausted)
 *   'rate_limit'      – TomTom returned 403/429; search stopped early
 *   'cap_hit'         – one or more niches hit HARD_CAP_PER_NICHE
 */
const runMultiNicheSearch = async ({
  projectId, country, city, niches, totalLeads,
  onProgress: rawOnProgress,
}) => {
  const onProgress = typeof rawOnProgress === 'function' ? rawOnProgress : () => {};

  const locationLabel = city || country;

  // Shared mutable counter for all TomTom calls this run
  const tomtomCallCounter = { count: 0 };

  console.log(`[LeadFinder] ── Starting search ─────────────────────────────────────`);
  console.log(
    `[LeadFinder] project:${projectId} | location:${locationLabel} | ` +
    `niches:${niches.join(', ')} | target:${totalLeads} valid | ` +
    `hard cap: ${HARD_CAP_PER_NICHE} businesses/niche | delay: ${TOMTOM_CALL_DELAY_MS}ms/call`
  );

  // ── 1. Pre-load existing project emails for deduplication ──────────────
  const existingBatches  = await Batch.find({ projectId }, '_id');
  const existingBatchIds = existingBatches.map(b => b._id);
  let   projectEmails    = new Set();

  if (existingBatchIds.length > 0) {
    const existing = await Lead.find(
      { batchId: { $in: existingBatchIds }, email: { $exists: true, $ne: '' } },
      'email',
    ).lean();
    projectEmails = new Set(existing.map(l => l.email.toLowerCase().trim()));
    console.log(`[LeadFinder] Pre-loaded ${projectEmails.size} existing email(s) for dedup`);
  }

  // ── 2. Distribute valid-lead targets across niches ─────────────────────
  const quotas = distribute(totalLeads, niches.length);

  // ── 3. Search + scrape each niche sequentially ─────────────────────────
  const seenEmails        = new Set();
  const perNicheBreakdown = [];
  const allValidLeads     = [];
  let   totalChecked      = 0;
  let   searchStopReason  = null;   // null | 'rate_limit' | 'cap_hit'

  for (let i = 0; i < niches.length; i++) {
    const niche       = niches[i];
    const targetValid = quotas[i];

    // If the previous niche hit a rate limit, skip remaining niches
    if (searchStopReason === 'rate_limit') {
      console.log(`[LeadFinder]   Skipping niche "${niche}" — rate limit already hit.`);
      perNicheBreakdown.push({ niche, validFound: 0, totalChecked: 0, skipped: true });
      continue;
    }

    const {
      validLeads,
      totalChecked: nicheChecked,
      rateLimited,
      capHit,
    } = await searchNiche({
      niche,
      country,
      city:          city || '',
      targetValid,
      seenEmails,
      projectEmails,
      globalChecked: totalChecked,
      globalValid:   allValidLeads.length,
      tomtomCallCounter,
      onProgress,
    });

    allValidLeads.push(...validLeads);
    totalChecked += nicheChecked;

    perNicheBreakdown.push({
      niche,
      validFound:   validLeads.length,
      totalChecked: nicheChecked,
      ...(capHit      && { stoppedEarly: 'cap_hit'     }),
      ...(rateLimited && { stoppedEarly: 'rate_limit'  }),
    });

    if (rateLimited && !searchStopReason) searchStopReason = 'rate_limit';
    if (capHit      && !searchStopReason) searchStopReason = 'cap_hit';

    console.log(
      `[LeadFinder] Niche "${niche}" done: ${validLeads.length} valid from ` +
      `${nicheChecked} checked${rateLimited ? ' [RATE LIMIT]' : capHit ? ' [CAP HIT]' : ''}`
    );
  }

  // ── 4. Log TomTom API usage summary ────────────────────────────────────
  console.log(
    `[LeadFinder] ── TomTom API usage ──────────────────────────────────────────`
  );
  console.log(
    `[LeadFinder]   Total TomTom calls this run : ${tomtomCallCounter.count}`
  );
  console.log(
    `[LeadFinder]   Businesses checked          : ${totalChecked}`
  );
  console.log(
    `[LeadFinder]   Valid leads found           : ${allValidLeads.length} / ${totalLeads} target`
  );
  if (searchStopReason) {
    console.log(`[LeadFinder]   Stop reason                : ${searchStopReason}`);
  }

  // ── 5. Create Batch document — ONCE, at the end ─────────────────────────
  const nicheLabel = niches.join(', ');
  const batchName  = city
    ? `${city} - Multi-Niche (${nicheLabel})`
    : `${country} - Multi-Niche (${nicheLabel})`;

  const batch = new Batch({
    name: batchName, projectId, source: 'Lead Finder Agent', leadCount: allValidLeads.length,
  });
  await batch.save();
  console.log(`[LeadFinder] Created batch "${batchName}" (${batch._id})`);

  // ── 6. Insert only valid leads ──────────────────────────────────────────
  if (allValidLeads.length > 0) {
    await Lead.insertMany(allValidLeads.map(biz => ({
      batchId: batch._id,
      company: biz.name,
      city:    biz.city || locationLabel,
      website: biz.website || '',
      email:   biz.email,
      niche:   biz.niche,
      status:  'Valid',
    })));
    console.log(`[LeadFinder] Saved ${allValidLeads.length} valid lead(s).`);
  }

  const summary = {
    batchId:           batch._id,
    totalFound:        allValidLeads.length,
    validCount:        allValidLeads.length,
    checkedCount:      totalChecked,
    tomtomCallCount:   tomtomCallCounter.count,
    stopReason:        searchStopReason,   // null = normal completion
    perNicheBreakdown,
  };

  console.log('[LeadFinder] ── Complete ─────────────────────────────────────────────');
  console.log('[LeadFinder]', JSON.stringify(summary, null, 2));
  return summary;
};

module.exports = {
  runMultiNicheSearch,
  // ── Shared helpers used by smartSearchService ───────────────────────────
  // Exported so the Smart Search pipeline can reuse TomTom + scraping logic
  // without duplicating code.
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
};
