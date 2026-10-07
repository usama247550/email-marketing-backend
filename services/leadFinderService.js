/**
 * services/leadFinderService.js
 *
 * Core logic for the Multi-Niche Lead Finder.
 *
 * Designed to be called from TWO places:
 *   1. controllers/leadFinderController.js  — manual trigger via HTTP POST
 *   2. services/scheduler.js (future)       — automated daily runs
 *
 * The function `runMultiNicheSearch` is a pure async service function with
 * no knowledge of Express (no req/res). It receives a plain options object
 * and returns a plain result object, making it trivially reusable.
 *
 * Flow per call:
 *   1. Divide totalLeads evenly across niches
 *   2. For each niche → TomTom Fuzzy Search (GET) → extract businesses
 *   3. For each business with a website → scrape homepage + contact/impressum
 *      page for emails (cheerio + regex + mailto: links)
 *   4. Scraping runs in parallel batches of SCRAPE_CONCURRENCY
 *   5. Create one Batch document + Lead documents for all results
 *   6. Return summary { batchId, totalFound, validCount, invalidCount, perNicheBreakdown }
 */

'use strict';

const axios   = require('axios');
const cheerio = require('cheerio');
const Batch   = require('../models/Batch');
const Lead    = require('../models/Lead');

// ── Config ────────────────────────────────────────────────────────────────────

const TOMTOM_BASE_URL    = 'https://api.tomtom.com/search/2/search';
const SCRAPE_CONCURRENCY = 10;   // max parallel website scrapes
const SCRAPE_TIMEOUT_MS  = 9000; // per-site HTTP timeout
const MAX_RESULTS_LIMIT  = 100;  // TomTom hard cap per request (their API max)

// Regex that matches most common email patterns found in page HTML
const EMAIL_REGEX = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;

// Domains/patterns we don't want to treat as real emails
const EMAIL_BLACKLIST = [
  /\.(png|jpg|jpeg|gif|svg|webp|css|js|woff|ttf)$/i,
  /^example\./i,
  /sentry\./i,
  /wixpress\.com$/i,
  /githubusercontent\.com$/i,
  /cloudflare\.com$/i,
];

// Contact page path keywords (checked in order)
const CONTACT_SLUGS = [
  '/contact', '/kontakt', '/impressum', '/imprint',
  '/about', '/about-us', '/ueber-uns', '/reach-us',
  '/get-in-touch',
];

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Divides `total` as evenly as possible across `count` buckets.
 * The remainder is distributed one-by-one to the first buckets.
 * e.g. distribute(100, 3) → [34, 33, 33]
 */
function distribute(total, count) {
  if (count <= 0) return [];
  const base      = Math.floor(total / count);
  const remainder = total % count;
  return Array.from({ length: count }, (_, i) => base + (i < remainder ? 1 : 0));
}

/**
 * Normalise a raw URL string into an absolute https:// URL.
 * Returns null if the string is not a usable URL.
 */
function normaliseUrl(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let url = raw.trim();
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    url = 'https://' + url;
  }
  try {
    const parsed = new URL(url);
    // Accept only http / https
    if (!['http:', 'https:'].includes(parsed.protocol)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Filter extracted email candidates:
 *   - basic format check
 *   - not in blacklist
 *   - not an image/asset path masquerading as an email
 */
function isUsableEmail(email) {
  if (!email || typeof email !== 'string') return false;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return false;
  for (const pattern of EMAIL_BLACKLIST) {
    if (pattern.test(email)) return false;
  }
  return true;
}

/**
 * Extract all unique candidate emails from an HTML string.
 * Checks both the raw text (regex) and href="mailto:..." attributes.
 */
function extractEmailsFromHtml(html) {
  if (!html) return [];
  const $ = cheerio.load(html);
  const found = new Set();

  // 1. mailto: link hrefs
  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr('href') || '';
    const mail = href.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
    if (isUsableEmail(mail)) found.add(mail);
  });

  // 2. Regex over the full text content (catches obfuscated text too)
  const text = $.text();
  const matches = text.match(EMAIL_REGEX) || [];
  for (const m of matches) {
    const mail = m.toLowerCase().trim();
    if (isUsableEmail(mail)) found.add(mail);
  }

  // 3. Regex over raw HTML (catches data attributes, JSON-LD, etc.)
  const rawMatches = html.match(EMAIL_REGEX) || [];
  for (const m of rawMatches) {
    const mail = m.toLowerCase().trim();
    if (isUsableEmail(mail)) found.add(mail);
  }

  return [...found];
}

/**
 * Try to discover a contact/impressum page URL from the homepage HTML.
 * Returns an absolute URL string or null.
 */
function findContactPageUrl(html, baseUrl) {
  const $ = cheerio.load(html);
  const base = new URL(baseUrl);

  for (const slug of CONTACT_SLUGS) {
    // Look for <a> tags whose href matches this slug pattern
    let found = null;
    $('a[href]').each((_, el) => {
      const href = $(el).attr('href') || '';
      const lower = href.toLowerCase();
      // Match exact slug or slug as a path segment
      if (
        lower === slug ||
        lower.startsWith(slug + '/') ||
        lower.startsWith(slug + '?') ||
        lower.endsWith(slug)
      ) {
        found = href;
        return false; // break
      }
    });

    if (found) {
      try {
        return new URL(found, base.href).href;
      } catch {
        // bad href, keep looking
      }
    }
  }
  return null;
}

/**
 * Fetch a URL with a timeout and return { html, finalUrl }.
 * Returns null on any error (timeout, DNS, 4xx, 5xx, etc.).
 */
async function fetchPage(url) {
  try {
    const resp = await axios.get(url, {
      timeout: SCRAPE_TIMEOUT_MS,
      maxRedirects: 5,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; LeadFinderBot/1.0; +https://kiro.dev)',
        'Accept': 'text/html,application/xhtml+xml,*/*;q=0.8',
        'Accept-Language': 'de,en;q=0.8',
      },
      // Don't throw on 4xx/5xx — we handle them below
      validateStatus: (s) => s < 500,
    });
    if (resp.status >= 400) return null;
    const ct = (resp.headers['content-type'] || '').toLowerCase();
    if (!ct.includes('text/html') && !ct.includes('text/plain') && !ct.includes('application/xhtml')) {
      return null;
    }
    return { html: resp.data, finalUrl: resp.config.url || url };
  } catch {
    return null;
  }
}

/**
 * Scrape a business website:
 *   1. Fetch homepage, extract emails
 *   2. If none found yet, look for a contact/impressum link and scrape that too
 * Returns the first usable email found, or null.
 */
async function scrapeWebsiteForEmail(rawUrl) {
  const url = normaliseUrl(rawUrl);
  if (!url) return null;

  // ── Step 1: homepage ──
  const home = await fetchPage(url);
  if (!home) return null;

  const homeEmails = extractEmailsFromHtml(home.html);
  if (homeEmails.length > 0) return homeEmails[0];

  // ── Step 2: contact / impressum page ──
  const contactUrl = findContactPageUrl(home.html, home.finalUrl || url);
  if (!contactUrl) return null;
  // Don't re-fetch the same URL
  try {
    if (new URL(contactUrl).pathname === new URL(home.finalUrl || url).pathname) return null;
  } catch { /* ignore */ }

  const contact = await fetchPage(contactUrl);
  if (!contact) return null;

  const contactEmails = extractEmailsFromHtml(contact.html);
  return contactEmails.length > 0 ? contactEmails[0] : null;
}

/**
 * Search TomTom Fuzzy Search for a given niche + location.
 * Returns an array of raw TomTom result objects (up to `limit`).
 *
 * TomTom Fuzzy Search GET:
 *   GET /search/2/search/{query}.json?key=...&limit=...&countrySet=...&typeahead=false
 *
 * We add `countrySet` to bias results to the right country, and pass
 * city+country as part of the query string for best locality.
 */
async function searchTomTom({ niche, country, city, limit }) {
  const apiKey = process.env.TOMTOM_API_KEY;
  if (!apiKey) {
    throw new Error('TOMTOM_API_KEY is not set in environment variables.');
  }

  // Clamp to TomTom's max of 100 per request
  const safeLimit = Math.min(limit, MAX_RESULTS_LIMIT);

  // Build a query like "Restaurant Frankfurt Germany" for best locality matching
  const query = `${niche} ${city} ${country}`;

  const url = `${TOMTOM_BASE_URL}/${encodeURIComponent(query)}.json`;

  try {
    const resp = await axios.get(url, {
      timeout: 15000,
      params: {
        key:        apiKey,
        limit:      safeLimit,
        typeahead:  false,
        // countrySet uses ISO 3166-1 alpha-2 — we pass country name and let
        // the query string provide the geographic context since we don't have
        // the code readily available; countrySet is optional for Fuzzy Search
      },
    });

    return resp.data?.results || [];
  } catch (err) {
    console.error(`[LeadFinder] TomTom API error for "${query}":`, err.message);
    return [];
  }
}

/**
 * Extract structured business info from a single TomTom result object.
 * Returns { name, address, city, website } — website may be undefined.
 */
function parseTomTomResult(result) {
  const poi     = result.poi     || {};
  const address = result.address || {};

  // TomTom returns website in poi.url
  const website = poi.url || null;

  // Build readable address
  const addressParts = [
    address.streetName && address.streetNumber
      ? `${address.streetName} ${address.streetNumber}`
      : address.streetName || address.freeformAddress || '',
  ].filter(Boolean);

  return {
    name:    poi.name || address.freeformAddress || 'Unknown',
    address: addressParts[0] || address.freeformAddress || '',
    city:    address.municipality || address.localName || '',
    website: normaliseUrl(website),
  };
}

/**
 * Run scraping jobs in parallel batches to avoid hammering too many sites at once.
 * `jobs` is an array of async functions returning a value.
 * Returns an array of results in the same order (null for failed jobs).
 */
async function runInBatches(jobs, concurrency) {
  const results = new Array(jobs.length).fill(null);
  for (let i = 0; i < jobs.length; i += concurrency) {
    const batch = jobs.slice(i, i + concurrency);
    const batchResults = await Promise.allSettled(batch.map((fn) => fn()));
    batchResults.forEach((r, j) => {
      results[i + j] = r.status === 'fulfilled' ? r.value : null;
    });
  }
  return results;
}

// ── Main exported function ────────────────────────────────────────────────────

/**
 * runMultiNicheSearch
 *
 * @param {object} options
 * @param {string}   options.projectId   - MongoDB ObjectId of the project
 * @param {string}   options.country     - Country name (e.g. "Germany")
 * @param {string}   options.city        - City name (e.g. "Frankfurt")
 * @param {string[]} options.niches      - Array of niche strings (e.g. ["Restaurant", "Cafe"])
 * @param {number}   options.totalLeads  - Total leads to find across all niches
 *
 * @returns {Promise<{
 *   batchId:           string,
 *   totalFound:        number,
 *   validCount:        number,
 *   invalidCount:      number,
 *   perNicheBreakdown: Array<{ niche: string, found: number, valid: number, invalid: number }>
 * }>}
 */
const runMultiNicheSearch = async ({ projectId, country, city, niches, totalLeads }) => {
  console.log(
    `[LeadFinder] Starting multi-niche search | project: ${projectId} | ` +
    `${city}, ${country} | niches: ${niches.join(', ')} | target: ${totalLeads} leads`
  );

  // ── 1. Distribute leads across niches ────────────────────────────────────
  const quotas = distribute(totalLeads, niches.length);
  // quotas[i] = how many leads to request for niches[i]

  // ── 2. Search TomTom for each niche ──────────────────────────────────────
  // Run TomTom searches sequentially (API quota-friendly); each is fast (<1s)
  const nicheResults = []; // [{ niche, businesses: [{name,address,city,website}] }]

  for (let i = 0; i < niches.length; i++) {
    const niche = niches[i];
    const limit = quotas[i];

    console.log(`[LeadFinder] TomTom search: "${niche}" in ${city}, ${country} (limit: ${limit})`);

    const raw = await searchTomTom({ niche, country, city, limit });
    const businesses = raw.map(parseTomTomResult);

    console.log(`[LeadFinder]   → ${businesses.length} result(s) from TomTom for "${niche}"`);
    nicheResults.push({ niche, businesses });
  }

  // ── 3. Build flat list of scraping jobs ───────────────────────────────────
  // Each job = { nicheLabel, business } with a website to scrape
  // We tag every business with its niche up front.
  const allBusinesses = []; // { niche, name, address, city, website }

  for (const { niche, businesses } of nicheResults) {
    for (const biz of businesses) {
      allBusinesses.push({ ...biz, niche });
    }
  }

  // ── 4. Scrape websites in parallel batches ────────────────────────────────
  const withWebsite    = allBusinesses.filter((b) => !!b.website);
  const withoutWebsite = allBusinesses.filter((b) => !b.website);

  console.log(
    `[LeadFinder] Scraping ${withWebsite.length} websites ` +
    `(${SCRAPE_CONCURRENCY} concurrent, ${SCRAPE_TIMEOUT_MS / 1000}s timeout each)…`
  );

  const scrapeJobs = withWebsite.map((biz) => () => scrapeWebsiteForEmail(biz.website));
  const emails     = await runInBatches(scrapeJobs, SCRAPE_CONCURRENCY);

  // Attach scraped emails back to businesses
  const scrapedBusinesses = withWebsite.map((biz, idx) => ({
    ...biz,
    email:  emails[idx] || null,
    status: emails[idx] ? 'Valid' : 'Invalid',
  }));

  const noWebsiteBusinesses = withoutWebsite.map((biz) => ({
    ...biz,
    email:  null,
    status: 'Invalid',
  }));

  const allProcessed = [...scrapedBusinesses, ...noWebsiteBusinesses];

  // ── 5. Build per-niche breakdown ──────────────────────────────────────────
  const breakdownMap = {};
  for (const niche of niches) {
    breakdownMap[niche] = { niche, found: 0, valid: 0, invalid: 0 };
  }
  for (const biz of allProcessed) {
    const entry = breakdownMap[biz.niche];
    if (!entry) continue;
    entry.found++;
    if (biz.status === 'Valid') entry.valid++;
    else entry.invalid++;
  }
  const perNicheBreakdown = Object.values(breakdownMap);

  const validCount   = allProcessed.filter((b) => b.status === 'Valid').length;
  const invalidCount = allProcessed.length - validCount;

  console.log(
    `[LeadFinder] Scraping done. ` +
    `${validCount} valid email(s) found out of ${allProcessed.length} total businesses.`
  );

  // ── 6. Create Batch document ──────────────────────────────────────────────
  const nicheLabel = niches.join(', ');
  const batchName  = `${city} - Multi-Niche (${nicheLabel})`;

  const batch = new Batch({
    name:      batchName,
    projectId: projectId,
    source:    'Lead Finder Agent',
    leadCount: allProcessed.length,
  });
  await batch.save();

  console.log(`[LeadFinder] Created batch "${batchName}" (${batch._id})`);

  // ── 7. Create Lead documents ──────────────────────────────────────────────
  if (allProcessed.length > 0) {
    const leadDocs = allProcessed.map((biz) => ({
      batchId: batch._id,
      company: biz.name,
      city:    biz.city || city,
      website: biz.website || '',
      email:   biz.email  || '',
      niche:   biz.niche,
      status:  biz.status,
    }));

    await Lead.insertMany(leadDocs);
    console.log(`[LeadFinder] Inserted ${leadDocs.length} lead document(s).`);
  }

  const summary = {
    batchId:           batch._id,
    totalFound:        allProcessed.length,
    validCount,
    invalidCount,
    perNicheBreakdown,
  };

  console.log('[LeadFinder] Search complete:', JSON.stringify(summary, null, 2));
  return summary;
};

module.exports = { runMultiNicheSearch };
