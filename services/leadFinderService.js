/**
 * services/leadFinderService.js
 *
 * Multi-Niche Search — bounded multi-round pipeline.
 *
 * Each run goes through up to MAX_ROUNDS rounds.
 * Each round:
 *   Phase 1 – collect a bounded pool of NEW candidates from TomTom
 *   Phase 2 – scrape emails (20 parallel workers, retry ladder)
 *   Save    – persist new valid leads to ONE shared batch, update leadCount
 *
 * Stop conditions (first hit wins):
 *   ✓ target reached
 *   ✓ MAX_ROUNDS done
 *   ✓ TIME_LIMIT elapsed
 *   ✓ round produced 0 new valid leads
 *   ✓ no new candidates remain for any niche
 *   ✓ TomTom returned 403/rate-limit OR ≥60 TomTom calls made
 *   ✓ user pressed Stop
 *
 * Also exports low-level helpers (searchTomTom, parseTomTomResult,
 * runInBatches, normaliseUrl, sleep, constants) used by smartSearchService.
 */

'use strict';

const https          = require('https');
const axios          = require('axios');
const cheerio        = require('cheerio');
const Batch          = require('../models/Batch');
const Lead           = require('../models/Lead');
const { resolveNicheTerms } = require('./nicheResolver');

// ── Config ────────────────────────────────────────────────────────────────────

const TOMTOM_BASE_URL      = 'https://api.tomtom.com/search/2/search';
const TOMTOM_POI_URL       = 'https://api.tomtom.com/search/2/poiSearch';
const TOMTOM_GEO_URL       = 'https://api.tomtom.com/search/2/geocode';
const TOMTOM_PAGE_SIZE     = 100;
const TOMTOM_CALL_DELAY_MS = 250;
const getTomTomMaxCalls    = () => parseInt(process.env.TOMTOM_MAX_CALLS_PER_RUN, 10) || 40;
const MAX_PAGES_SINGLE_CITY = 6;
const MAX_ROUNDS           = 3;
const TIME_LIMIT_MS        = 6 * 60 * 1000;   // 6 minutes
const SCRAPE_CONCURRENCY   = 20;
const FETCH_TIMEOUT_MS     = 8_000;
const SITE_BUDGET_MS       = 25_000;
const MAX_RESPONSE_BYTES   = 2 * 1024 * 1024;
const CONTACT_PATHS_ORDERED = [
  '/impressum', '/kontakt', '/contact', '/imprint',
  '/impressum.html', '/kontakt.html', '/rechtliches', '/about',
];

// HARD_CAP_PER_NICHE kept for export (used by smart search legacy path)
const HARD_CAP_PER_NICHE = 400;
const OVERFETCH_RATIO    = 3;

// Directory/listing domains to skip
const DIRECTORY_DOMAINS = new Set([
  'gelbeseiten.de', 'dasoertliche.de', '11880.com', 'meinestadt.de',
  'stadtbranchenbuch.com', 'branchen-info.net', 'yelp.de', 'yelp.com',
  'cylex.de', 'goyellow.de', 'gelbe-seiten.de', 'klicktel.de',
  'dastelefonbuch.de', 'herold.at', 'local.ch', 'swisscom.ch',
]);

// German cities for "All cities" mode (lat, lon pairs)
const GERMANY_CITIES = [
  { name: 'Berlin',          lat: 52.5200, lon: 13.4050 },
  { name: 'Hamburg',         lat: 53.5511, lon:  9.9937 },
  { name: 'Munich',          lat: 48.1351, lon: 11.5820 },
  { name: 'Cologne',         lat: 50.9375, lon:  6.9603 },
  { name: 'Frankfurt',       lat: 50.1109, lon:  8.6821 },
  { name: 'Stuttgart',       lat: 48.7758, lon:  9.1829 },
  { name: 'Dusseldorf',      lat: 51.2277, lon:  6.7735 },
  { name: 'Dortmund',        lat: 51.5136, lon:  7.4653 },
  { name: 'Essen',           lat: 51.4556, lon:  7.0116 },
  { name: 'Leipzig',         lat: 51.3397, lon: 12.3731 },
  { name: 'Bremen',          lat: 53.0793, lon:  8.8017 },
  { name: 'Dresden',         lat: 51.0504, lon: 13.7373 },
  { name: 'Hanover',         lat: 52.3759, lon:  9.7320 },
  { name: 'Nuremberg',       lat: 49.4521, lon: 11.0767 },
  { name: 'Duisburg',        lat: 51.4344, lon:  6.7623 },
  { name: 'Bochum',          lat: 51.4818, lon:  7.2162 },
  { name: 'Wuppertal',       lat: 51.2562, lon:  7.1508 },
  { name: 'Bielefeld',       lat: 52.0302, lon:  8.5325 },
  { name: 'Bonn',            lat: 50.7374, lon:  7.0982 },
  { name: 'Munster',         lat: 51.9607, lon:  7.6261 },
  { name: 'Karlsruhe',       lat: 49.0069, lon:  8.4037 },
  { name: 'Mannheim',        lat: 49.4875, lon:  8.4660 },
  { name: 'Augsburg',        lat: 48.3705, lon: 10.8978 },
  { name: 'Wiesbaden',       lat: 50.0782, lon:  8.2398 },
  { name: 'Gelsenkirchen',   lat: 51.5177, lon:  7.0857 },
  { name: 'Monchengladbach', lat: 51.1805, lon:  6.4428 },
  { name: 'Braunschweig',    lat: 52.2689, lon: 10.5268 },
  { name: 'Chemnitz',        lat: 50.8278, lon: 12.9214 },
  { name: 'Kiel',            lat: 54.3233, lon: 10.1228 },
  { name: 'Aachen',          lat: 50.7753, lon:  6.0839 },
];

// ── Tiny helpers ──────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

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

async function runInBatches(fns, concurrency) {
  const results = [];
  for (let i = 0; i < fns.length; i += concurrency) {
    const settled = await Promise.allSettled(fns.slice(i, i + concurrency).map(f => f()));
    for (const r of settled) results.push(r.status === 'fulfilled' ? r.value : null);
  }
  return results;
}

// ── Email helpers ─────────────────────────────────────────────────────────────

const EMAIL_REGEX  = /\b[a-zA-Z0-9._%+\-]{1,64}@[a-zA-Z0-9.\-]{1,253}\.[a-zA-Z]{2,}\b/g;
const OBFUSC_REGEX = /\b([a-zA-Z0-9._%+\-]{1,64})\s*(?:\[at\]|\(at\)|{\s*at\s*}|\s+AT\s+)\s*([a-zA-Z0-9.\-]{1,253}\.[a-zA-Z]{2,})\b/g;

const EMAIL_DOMAIN_BL = new Set([
  'example.com','example.org','example.net','sentry.io','wixpress.com',
  'githubusercontent.com','cloudflare.com','googletagmanager.com',
  'google-analytics.com','gravatar.com','facebook.com','twitter.com',
  'instagram.com','linkedin.com','jquery.com','w3.org','schema.org',
]);
const FAKE_TLDS = new Set([
  'png','jpg','jpeg','gif','svg','webp','css','js',
  'woff','woff2','ttf','eot','ico','pdf','mp4','mp3','zip','xml','json',
]);
const LOCAL_BL = [
  /\.(png|jpe?g|gif|svg|webp|css|js|woff2?|ttf|eot|ico|pdf)$/i,
  /^(noreply|no-reply|donotreply|do-not-reply|mailer-daemon|postmaster|abuse|spam|example|test)$/i,
  /\d{6,}/,
];

function isUsableEmail(e) {
  if (!e || typeof e !== 'string') return false;
  const l = e.toLowerCase().trim();
  if (!/^[^\s@]{1,64}@[^\s@]{1,253}\.[a-z]{2,}$/.test(l)) return false;
  const [local, domain] = l.split('@');
  if (EMAIL_DOMAIN_BL.has(domain)) return false;
  if (FAKE_TLDS.has(domain.split('.').pop())) return false;
  for (const p of LOCAL_BL) if (p.test(local)) return false;
  return true;
}

function extractEmailsFromHtml(html) {
  if (!html) return [];
  const $ = cheerio.load(html);
  const found = new Set();

  $('a[href^="mailto:"],a[href^="MAILTO:"]').each((_, el) => {
    const m = ($(el).attr('href') || '').replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
    if (isUsableEmail(m)) found.add(m);
  });

  const text = $.text();
  for (const m of (text.match(EMAIL_REGEX) || []))  { const l = m.toLowerCase(); if (isUsableEmail(l)) found.add(l); }
  for (const m of (html.match(EMAIL_REGEX) || []))  { const l = m.toLowerCase(); if (isUsableEmail(l)) found.add(l); }

  // Obfuscated emails
  const combined = text + ' ' + html;
  let om; OBFUSC_REGEX.lastIndex = 0;
  while ((om = OBFUSC_REGEX.exec(combined)) !== null) {
    const c = `${om[1]}@${om[2]}`.toLowerCase();
    if (isUsableEmail(c)) found.add(c);
  }

  return [...found];
}

// ── Fetch error classification ────────────────────────────────────────────────

function classifyFetchError(err, httpStatus) {
  if (httpStatus) {
    if (httpStatus === 403 || httpStatus === 429) return { code: 'BLOCKED',            message: `HTTP ${httpStatus}` };
    if (httpStatus >= 400 && httpStatus < 500)   return { code: 'HTTP_4XX',           message: `HTTP ${httpStatus}` };
    if (httpStatus >= 500)                        return { code: 'HTTP_5XX',           message: `HTTP ${httpStatus}` };
  }
  if (!err) return { code: 'OTHER', message: 'unknown' };
  const msg   = (err.message || '').toLowerCase();
  const eCode = (err.code    || '').toUpperCase();
  if (eCode === 'CERT_HAS_EXPIRED' || eCode === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
      eCode === 'ERR_TLS_CERT_ALTNAME_INVALID' || eCode === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
      eCode === 'SELF_SIGNED_CERT_IN_CHAIN' || eCode === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' ||
      eCode.startsWith('ERR_SSL') || eCode.startsWith('ERR_CERT') ||
      msg.includes('certificate') || msg.includes('ssl') || msg.includes('tls'))
    return { code: 'CERT_ERROR', message: err.message };
  if (eCode === 'ENOTFOUND' || eCode === 'EAI_AGAIN' || msg.includes('getaddrinfo'))
    return { code: 'DNS_ERROR', message: err.message };
  if (eCode === 'ECONNABORTED' || eCode === 'ETIMEDOUT' || msg.includes('timeout'))
    return { code: 'TIMEOUT',   message: err.message };
  if (eCode === 'ECONNREFUSED' || eCode === 'ECONNRESET' || eCode === 'EPIPE')
    return { code: 'CONNECTION_REFUSED', message: err.message };
  return { code: 'OTHER', message: err.message };
}

const BROWSER_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
};

async function rawFetch(url, { noVerify = false, altUA = false, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const t0 = Date.now();
  const headers = altUA ? {
    'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Accept':          'text/html,application/xhtml+xml,*/*;q=0.9',
    'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
  } : BROWSER_HEADERS;
  const httpsAgent = noVerify ? new https.Agent({ rejectUnauthorized: false }) : undefined;
  const resp = await axios.get(url, {
    timeout: timeoutMs, maxRedirects: 5, maxContentLength: MAX_RESPONSE_BYTES,
    headers, httpsAgent, validateStatus: () => true,
  });
  const ct = (resp.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('html') && !ct.includes('text/plain')) return null;
  if (resp.status === 403 || resp.status === 429) {
    const e = new Error(`HTTP ${resp.status}`); e.httpStatus = resp.status; throw e;
  }
  if (resp.status >= 400) {
    const e = new Error(`HTTP ${resp.status}`); e.httpStatus = resp.status; throw e;
  }
  const finalUrl = resp.request?.res?.responseUrl || url;
  return { html: String(resp.data), finalUrl, hasSSL: finalUrl.startsWith('https://'), loadTimeMs: Date.now() - t0 };
}

/**
 * Fetch with retry ladder (shared with smartSearchService logic).
 * Returns { html, finalUrl, hasSSL, loadTimeMs, sslError? } or { fetchError }
 */
async function fetchPageWithRetry(rawUrl) {
  let url = (rawUrl || '').trim();
  if (!url) return { fetchError: { code: 'OTHER', message: 'empty url' } };
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  const deadline  = Date.now() + SITE_BUDGET_MS;
  const remaining = () => Math.max(500, deadline - Date.now());

  let lastCode = 'OTHER', lastError = null;
  try {
    const r = await rawFetch(url, { timeoutMs: Math.min(FETCH_TIMEOUT_MS, remaining()) });
    if (r) return r;
    return { fetchError: { code: 'OTHER', message: 'non-HTML content type' } };
  } catch (err) {
    const c = classifyFetchError(err, err.httpStatus);
    lastCode = c.code; lastError = c;
  }

  if (lastCode === 'CERT_ERROR') {
    if (remaining() > 1000) {
      try {
        const r = await rawFetch(url, { noVerify: true, timeoutMs: Math.min(FETCH_TIMEOUT_MS, remaining()) });
        if (r) return { ...r, hasSSL: false, sslError: true };
      } catch (err2) { const c2 = classifyFetchError(err2, err2.httpStatus); lastCode = c2.code; lastError = c2; }
    }
  } else if (lastCode === 'DNS_ERROR' || lastCode === 'CONNECTION_REFUSED') {
    let altUrl = null;
    try {
      const p = new URL(url);
      p.hostname = p.hostname.startsWith('www.') ? p.hostname.slice(4) : 'www.' + p.hostname;
      altUrl = p.href;
    } catch {}
    if (altUrl && remaining() > 1000) {
      try {
        const r = await rawFetch(altUrl, { timeoutMs: Math.min(FETCH_TIMEOUT_MS, remaining()) });
        if (r) return r;
      } catch (err2) { const c2 = classifyFetchError(err2, err2.httpStatus); lastCode = c2.code; lastError = c2; }
    }
    if (url.startsWith('https://') && remaining() > 1000) {
      try {
        const r = await rawFetch('http://' + url.slice(8), { timeoutMs: Math.min(FETCH_TIMEOUT_MS, remaining()) });
        if (r) return r;
      } catch (err3) { const c3 = classifyFetchError(err3, err3.httpStatus); lastCode = c3.code; lastError = c3; }
    }
  } else if (lastCode === 'BLOCKED') {
    if (remaining() > 1000) {
      try {
        const r = await rawFetch(url, { altUA: true, timeoutMs: Math.min(FETCH_TIMEOUT_MS, remaining()) });
        if (r) return r;
      } catch (err2) { const c2 = classifyFetchError(err2, err2.httpStatus); lastCode = c2.code; lastError = c2; }
    }
  }

  return { fetchError: lastError || { code: lastCode, message: 'all retries failed' } };
}

// ── Email scraper (homepage + contact pages) ──────────────────────────────────

async function scrapeEmailForSite(rawUrl, fetchErrorCounts) {
  const homeFetch = await fetchPageWithRetry(rawUrl);
  if (!homeFetch || homeFetch.fetchError) {
    if (fetchErrorCounts && homeFetch?.fetchError?.code) {
      const code = homeFetch.fetchError.code;
      fetchErrorCounts[code] = (fetchErrorCounts[code] || 0) + 1;
    }
    return null;
  }

  const homeEmails = extractEmailsFromHtml(homeFetch.html);
  if (homeEmails.length > 0) return homeEmails[0];

  // Prefer real links found in homepage, then guessed paths
  let origin, finalUrl;
  try { origin = new URL(homeFetch.finalUrl).origin; finalUrl = homeFetch.finalUrl; } catch { return null; }

  const homePath = (() => { try { return new URL(finalUrl).pathname; } catch { return '/'; } })();
  const visited  = new Set([homePath]);
  const toProbe  = [];

  const $ = cheerio.load(homeFetch.html);
  $('a[href]').each((_, el) => {
    if (toProbe.length >= 2) return false;
    const href  = ($(el).attr('href') || '').trim();
    const lower = href.toLowerCase();
    if (!CONTACT_PATHS_ORDERED.some(p => lower === p || lower.startsWith(p + '/') ||
        lower.startsWith(p + '?') || lower.endsWith(p))) return;
    try {
      const abs  = new URL(href, finalUrl).href;
      const path = new URL(abs).pathname;
      if (!visited.has(path)) { visited.add(path); toProbe.push(abs); }
    } catch {}
  });

  // Fill from guessed paths
  for (const path of CONTACT_PATHS_ORDERED) {
    if (toProbe.length >= 2) break;
    if (visited.has(path)) continue;
    visited.add(path);
    toProbe.push(`${origin}${path}`);
  }

  for (const probe of toProbe) {
    const page = await fetchPageWithRetry(probe);
    if (!page || page.fetchError) {
      if (fetchErrorCounts && page?.fetchError?.code) {
        const code = page.fetchError.code;
        fetchErrorCounts[code] = (fetchErrorCounts[code] || 0) + 1;
      }
      continue;
    }
    const emails = extractEmailsFromHtml(page.html);
    if (emails.length > 0) return emails[0];
  }

  return null;
}

// ── TomTom helpers ────────────────────────────────────────────────────────────

async function searchTomTom({ niche, country, city, limit, offset, tomtomCallCounter }) {
  const apiKey = process.env.TOMTOM_API_KEY;
  if (!apiKey) throw new Error('TOMTOM_API_KEY is not set in environment variables.');
  const query     = city ? `${niche} ${city} ${country}` : `${niche} ${country}`;
  const safeLimit = Math.min(limit, TOMTOM_PAGE_SIZE);
  tomtomCallCounter.count += 1;
  try {
    const resp = await axios.get(`${TOMTOM_BASE_URL}/${encodeURIComponent(query)}.json`, {
      timeout: 15000,
      params:  { key: apiKey, limit: safeLimit, offset, typeahead: false, idxSet: 'POI' },
    });
    const results = resp.data?.results || [];
    return { results, rateLimited: false, exhausted: results.length === 0 };
  } catch (err) {
    const status = err.response?.status;
    if (status === 403 || status === 429) {
      console.warn(`[LeadFinder] TomTom quota/rate limit (HTTP ${status}) for "${query}" offset ${offset}`);
      return { results: [], rateLimited: true, exhausted: false };
    }
    console.error(`[LeadFinder] TomTom error for "${query}" (offset ${offset}):`, err.message);
    return { results: [], rateLimited: false, exhausted: true };
  }
}

/**
 * Geocode a city name once using TomTom Geocoding API.
 * Returns { lat, lon } or null on failure.
 */
async function geocodeCity(cityName, country, tomtomCallCounter) {
  const apiKey = process.env.TOMTOM_API_KEY;
  if (!apiKey) return null;
  tomtomCallCounter.count += 1;
  try {
    const resp = await axios.get(`${TOMTOM_GEO_URL}/${encodeURIComponent(`${cityName} ${country}`)}.json`, {
      timeout: 10000,
      params: { key: apiKey, limit: 1 },
    });
    const pos = resp.data?.results?.[0]?.position;
    if (!pos) return null;
    return { lat: pos.lat, lon: pos.lon };
  } catch (err) {
    console.warn(`[LeadFinder] Geocode failed for "${cityName}": ${err.message}`);
    return null;
  }
}

/**
 * POI search by lat/lon/radius — more accurate for a specific city.
 */
async function searchTomTomByCoord({ niche, lat, lon, country, limit, offset, tomtomCallCounter }) {
  const apiKey = process.env.TOMTOM_API_KEY;
  if (!apiKey) throw new Error('TOMTOM_API_KEY is not set in environment variables.');
  const safeLimit = Math.min(limit, TOMTOM_PAGE_SIZE);
  tomtomCallCounter.count += 1;
  try {
    const resp = await axios.get(`${TOMTOM_POI_URL}/${encodeURIComponent(niche)}.json`, {
      timeout: 15000,
      params: {
        key: apiKey, limit: safeLimit, offset,
        lat, lon, radius: 15000,
        countrySet: country === 'Germany' ? 'DE' : undefined,
      },
    });
    const results = resp.data?.results || [];
    return { results, rateLimited: false, exhausted: results.length === 0 };
  } catch (err) {
    const status = err.response?.status;
    if (status === 403 || status === 429) {
      console.warn(`[LeadFinder] TomTom POI quota/rate limit (HTTP ${status}) for "${niche}" near ${lat},${lon}`);
      return { results: [], rateLimited: true, exhausted: false };
    }
    // Fall back to regular search
    return searchTomTom({ niche, country, city: '', limit, offset, tomtomCallCounter });
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

function getDomain(website) {
  try { return new URL(website).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}

function isDirectoryDomain(domain) {
  if (!domain) return false;
  return DIRECTORY_DOMAINS.has(domain) || [...DIRECTORY_DOMAINS].some(d => domain.endsWith('.' + d));
}

// ── Phase 1: collect candidates from TomTom for one niche ────────────────────

/**
 * Collect up to `poolTarget` new candidates for a single niche.
 * Uses per-term round-robin: iterates over the niche's resolved search terms,
 * cycling through them so no term starves the others. A term with 0 results
 * on 3 consecutive cities/pages is marked dead for the rest of the run.
 *
 * For a specific city: a term that returns 0 on page 1 is dead immediately.
 * For all-cities Germany: a term needs 3 consecutive 0-result cities.
 *
 * @returns { candidates: Biz[], rateLimited: bool, exhausted: bool }
 */
async function collectForNiche({
  niche,
  city,
  country,
  poolTarget,
  seenDomains,
  nicheState,
  tomtomCallCounter,
  isAllCitiesGermany,
  cancelFlag,
  runStart,
  citiesCoveredMap,
  searchTomTomFn = searchTomTom,
  searchTomTomByCoordFn = searchTomTomByCoord,
  maxCalls = getTomTomMaxCalls(),
}) {
  const candidates   = [];
  let rateLimited    = false;
  let capReached     = false;
  let exhausted      = false;
  let firstCall      = true;
  let pagesThisRound = 0;
  const maxPages     = isAllCitiesGermany ? Infinity : MAX_PAGES_SINGLE_CITY;

  // ── Per-term state initialisation ─────────────────────────────────────────
  // nicheState.terms: the resolved search terms (string[])
  // nicheState.termIdx: next term to use (round-robin index)
  // nicheState.termConsecZeros: Map<term, consecutiveZeroCount>
  // nicheState.deadTerms: Set<term> — terms skipped for the rest of the run
  const terms = (nicheState.terms && nicheState.terms.length > 0)
    ? nicheState.terms
    : [niche];  // fallback: use the niche name itself

  if (!nicheState.termConsecZeros)  nicheState.termConsecZeros = new Map();
  if (!nicheState.deadTerms)        nicheState.deadTerms       = new Set();
  if (typeof nicheState.termIdx !== 'number') nicheState.termIdx = 0;

  // Per-term offsets for single-city/country text search (separate from the
  // niche-level offset which is kept for backward-compat cursors without terms)
  if (!nicheState.termOffsets)      nicheState.termOffsets     = {};
  if (!nicheState.termCityOffsets)  nicheState.termCityOffsets = {};
  if (!nicheState.termCityIdx)      nicheState.termCityIdx     = {};
  if (!nicheState.termExhaustedCities) nicheState.termExhaustedCities = {};

  // ── Main collection loop ───────────────────────────────────────────────────
  while (
    candidates.length < poolTarget &&
    !rateLimited &&
    !exhausted &&
    pagesThisRound < maxPages
  ) {
    if (cancelFlag?.cancelled === true) break;
    if (runStart && (Date.now() - runStart) >= TIME_LIMIT_MS) break;

    // Check TomTom call budget
    if (tomtomCallCounter.count >= maxCalls) {
      console.log(`[LeadFinder] TomTom call cap (${maxCalls}) reached`);
      capReached = true;
      break;
    }

    // Pick the next live term (round-robin, skip dead ones)
    const liveTerms = terms.filter(t => !nicheState.deadTerms.has(t));
    if (liveTerms.length === 0) {
      // All terms are dead — this niche is exhausted
      exhausted = true;
      break;
    }

    const termIdx   = nicheState.termIdx % liveTerms.length;
    const activeTerm = liveTerms[termIdx];
    nicheState.termIdx = (termIdx + 1) % liveTerms.length;

    if (!firstCall) await sleep(TOMTOM_CALL_DELAY_MS);
    firstCall = false;
    pagesThisRound++;

    let results, rl, exh;
    let cityName    = '';
    let cityPageNum = 1;

    if (isAllCitiesGermany) {
      // Round-robin through German cities, per term
      if (!nicheState.termCityIdx[activeTerm])      nicheState.termCityIdx[activeTerm]      = 0;
      if (!nicheState.termCityOffsets[activeTerm])  nicheState.termCityOffsets[activeTerm]  = {};
      if (!nicheState.termExhaustedCities[activeTerm]) nicheState.termExhaustedCities[activeTerm] = [];

      const termExhSet = new Set(nicheState.termExhaustedCities[activeTerm]);
      const numCities  = GERMANY_CITIES.length;
      let foundCity    = null;

      for (let attempt = 0; attempt < numCities; attempt++) {
        const candidateIdx = (nicheState.termCityIdx[activeTerm] + attempt) % numCities;
        const cityEntry    = GERMANY_CITIES[candidateIdx];
        if (!termExhSet.has(cityEntry.name)) {
          foundCity = cityEntry;
          nicheState.termCityIdx[activeTerm] = (candidateIdx + 1) % numCities;
          break;
        }
      }

      if (!foundCity) {
        // Mark term dead
        nicheState.deadTerms.add(activeTerm);
        console.log(`[LeadFinder] Term "${activeTerm}" for "${niche}" is dead (all cities exhausted)`);
        continue;
      }

      cityName = foundCity.name;
      const cityOffset = (nicheState.termCityOffsets[activeTerm][cityName] || 0);
      cityPageNum = Math.floor(cityOffset / TOMTOM_PAGE_SIZE) + 1;

      ({ results, rateLimited: rl, exhausted: exh } = await searchTomTomByCoordFn({
        niche: activeTerm,
        lat:   foundCity.lat,
        lon:   foundCity.lon,
        country: 'Germany',
        limit:   TOMTOM_PAGE_SIZE,
        offset:  cityOffset,
        tomtomCallCounter,
      }));

      if (rl) { rateLimited = true; break; }

      const gotResults = results && results.length > 0;
      if (exh || !results || results.length < TOMTOM_PAGE_SIZE) {
        termExhSet.add(cityName);
        nicheState.termExhaustedCities[activeTerm] = Array.from(termExhSet);
        if (termExhSet.size >= numCities) {
          nicheState.deadTerms.add(activeTerm);
          console.log(`[LeadFinder] Term "${activeTerm}" for "${niche}" exhausted all cities`);
        }
      } else {
        nicheState.termCityOffsets[activeTerm][cityName] = cityOffset + results.length;
      }

      // Dead-term rule: 3 consecutive 0-result cities → mark dead
      if (!gotResults) {
        const prev = nicheState.termConsecZeros.get(activeTerm) || 0;
        const next = prev + 1;
        nicheState.termConsecZeros.set(activeTerm, next);
        if (next >= 3 && !nicheState.deadTerms.has(activeTerm)) {
          nicheState.deadTerms.add(activeTerm);
          console.log(`[LeadFinder] Term "${activeTerm}" for "${niche}" marked dead after ${next} consecutive empty cities`);
        }
      } else {
        nicheState.termConsecZeros.set(activeTerm, 0);
      }

      // Also maintain the global exhaustedCities set (for backward compat)
      if (termExhSet.size > 0) {
        for (const c of termExhSet) nicheState.exhaustedCities.add(c);
      }
      if (nicheState.exhaustedCities.size >= numCities && liveTerms.length <= 1) {
        exhausted = true;
      }

    } else if (nicheState.coords) {
      // Specific city with geocoded coordinates
      cityName = city || 'Target City';
      if (typeof nicheState.termOffsets[activeTerm] !== 'number')
        nicheState.termOffsets[activeTerm] = 0;
      cityPageNum = Math.floor(nicheState.termOffsets[activeTerm] / TOMTOM_PAGE_SIZE) + 1;

      ({ results, rateLimited: rl, exhausted: exh } = await searchTomTomByCoordFn({
        niche:  activeTerm,
        lat:    nicheState.coords.lat,
        lon:    nicheState.coords.lon,
        country,
        limit:  TOMTOM_PAGE_SIZE,
        offset: nicheState.termOffsets[activeTerm],
        tomtomCallCounter,
      }));

      if (rl) { rateLimited = true; break; }

      const gotResults = results && results.length > 0;

      // Dead-term rule: single city → 0 on page 1 = dead immediately
      if (!gotResults && nicheState.termOffsets[activeTerm] === 0) {
        nicheState.deadTerms.add(activeTerm);
        console.log(`[LeadFinder] Term "${activeTerm}" for "${niche}" marked dead (0 results on page 1, single city)`);
      } else {
        if (exh || !results || results.length < TOMTOM_PAGE_SIZE) {
          nicheState.deadTerms.add(activeTerm);
        }
        nicheState.termOffsets[activeTerm] += (results?.length || 0);
      }

      // Also keep legacy offset in sync for first term (cursor compat)
      if (activeTerm === terms[0]) {
        nicheState.offset = nicheState.termOffsets[activeTerm];
      }

    } else {
      // Country-wide text search
      cityName = city || country || 'All';
      if (typeof nicheState.termOffsets[activeTerm] !== 'number')
        nicheState.termOffsets[activeTerm] = 0;
      cityPageNum = Math.floor(nicheState.termOffsets[activeTerm] / TOMTOM_PAGE_SIZE) + 1;

      ({ results, rateLimited: rl, exhausted: exh } = await searchTomTomFn({
        niche:  activeTerm,
        country,
        city,
        limit:  TOMTOM_PAGE_SIZE,
        offset: nicheState.termOffsets[activeTerm],
        tomtomCallCounter,
      }));

      if (rl) { rateLimited = true; break; }

      const gotResults = results && results.length > 0;

      if (exh || !results || results.length < TOMTOM_PAGE_SIZE) {
        nicheState.deadTerms.add(activeTerm);
      } else {
        nicheState.termOffsets[activeTerm] += results.length;
      }

      // Keep legacy offset in sync for first term
      if (activeTerm === terms[0]) {
        nicheState.offset = nicheState.termOffsets[activeTerm];
      }
    }

    // ── Filter and dedupe ──────────────────────────────────────────────────
    let withWebsite = 0, skippedNoWebsite = 0, skippedDir = 0, skippedDup = 0, kept = 0;
    for (const r of (results || []).map(parseTomTomResult)) {
      if (!r.website) { skippedNoWebsite++; continue; }
      withWebsite++;
      const domain = getDomain(r.website);
      if (!domain || isDirectoryDomain(domain)) { skippedDir++; continue; }
      if (seenDomains.has(domain))               { skippedDup++; continue; }
      seenDomains.add(domain);
      if (isAllCitiesGermany && !r.city && cityName) r.city = cityName;
      candidates.push(r);
      kept++;

      if (citiesCoveredMap) {
        const cName = r.city || cityName || city || country;
        citiesCoveredMap.set(cName, (citiesCoveredMap.get(cName) || 0) + 1);
      }

      if (candidates.length >= poolTarget) break;
    }

    console.log(
      `[LeadFinder] [${cityName}] [${niche}→${activeTerm}] page ${cityPageNum}` +
      ` | results=${results?.length || 0} | withWebsite=${withWebsite}` +
      ` | noWebsite=${skippedNoWebsite} | dirSkip=${skippedDir} | dupSkip=${skippedDup}` +
      ` | kept=${kept} (nichePool=${candidates.length}/${poolTarget})`,
    );

    // If all live terms are now dead, exit
    if (terms.every(t => nicheState.deadTerms.has(t))) {
      exhausted = true;
      break;
    }
  }

  return { candidates, rateLimited, capReached, exhausted };
}

// ── Quota redistribution helper ──────────────────────────────────────────────

function redistributeExhaustedQuotas(nicheStates) {
  let deficit = 0;
  for (const ns of nicheStates) {
    if (ns.exhausted && ns.target > ns.saved) {
      deficit += (ns.target - ns.saved);
      ns.target = ns.saved;
    }
  }
  if (deficit > 0) {
    const active = nicheStates.filter(ns => !ns.exhausted);
    if (active.length > 0) {
      const extra = distribute(deficit, active.length);
      active.forEach((ns, i) => {
        ns.target += extra[i];
      });
      console.log(`[LeadFinder] Redistributed ${deficit} lead target from exhausted niche(s) to ${active.length} active niche(s)`);
    }
  }
}

// ── In-memory search lock ───────────────────────────────────────────────────
let isFinderActive = false;

function isLeadFinderActive() {
  return isFinderActive;
}

function acquireLeadFinderLock() {
  if (isFinderActive) return false;
  isFinderActive = true;
  return true;
}

function releaseLeadFinderLock() {
  isFinderActive = false;
}

// ── Main: runMultiNicheSearch ─────────────────────────────────────────────────

/**
 * Multi-round pipeline.
 *
 * @param {object} opts
 * @param {string}   opts.projectId
 * @param {string}   opts.country
 * @param {string}   opts.city           '' = all cities
 * @param {string[]} opts.niches
 * @param {number}   opts.totalLeads
 * @param {Function} opts.onProgress     (progress) => void
 * @param {object}   opts.cancelFlag     { cancelled: boolean }
 * @param {Function} opts.onBatchCreated (batchId) => void   — called the first time the batch is created
 * @param {Function} opts.onRoundDone    (roundStats) => void
 * @param {object}   opts.cursor         optional saved cursor from previous run
 * @param {string}   opts.batchNamePrefix optional prefix for batch name (e.g. "Auto")
 */
const runMultiNicheSearch = async ({
  projectId, country, city, niches, totalLeads,
  onProgress: rawProgress,
  cancelFlag,
  onBatchCreated,
  onRoundDone,
  cursor,
  batchNamePrefix,
  dependencies = {},
}) => {
  if (!acquireLeadFinderLock()) {
    const err = new Error('Another lead finder run was in progress');
    err.code = 'FINDER_BUSY';
    throw err;
  }

  try {
    const BatchModel = dependencies.Batch || Batch;
    const LeadModel = dependencies.Lead || Lead;
    const resolveNiche = dependencies.resolveNicheTerms || resolveNicheTerms;
    const geocode = dependencies.geocodeCity || geocodeCity;
    const searchText = dependencies.searchTomTom || searchTomTom;
    const searchCoord = dependencies.searchTomTomByCoord || searchTomTomByCoord;
    const scrapeSite = dependencies.scrapeEmailForSite || scrapeEmailForSite;
    const maxTomTomCalls = dependencies.getTomTomMaxCalls || getTomTomMaxCalls;
    const onProgress   = typeof rawProgress    === 'function' ? rawProgress    : () => {};
    const isCancelled  = () => cancelFlag?.cancelled === true;
    const notifyBatch  = typeof onBatchCreated === 'function' ? onBatchCreated : () => {};
    const notifyRound  = typeof onRoundDone    === 'function' ? onRoundDone    : () => {};

    const runStart = Date.now();
    const elapsed      = () => Math.round((Date.now() - runStart) / 1000);
    const timeLimitHit = () => (Date.now() - runStart) >= TIME_LIMIT_MS;

    const isAllCitiesGermany = !city && country.toLowerCase().includes('germany');
    const locationLabel      = city || (isAllCitiesGermany ? 'All cities' : country);
    const nicheLabel         = niches.join(', ');

    console.log(`[LeadFinder] \u2500\u2500 Starting multi-round pipeline \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500`);
    console.log(`[LeadFinder] project:${projectId} | location:${locationLabel} | niches:[${nicheLabel}] | target:${totalLeads}`);

    // \u2500\u2500 Pre-load project domains and emails \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    const existingBatches  = await BatchModel.find({ projectId }, '_id');
    const existingBatchIds = existingBatches.map(b => b._id);
    const seenDomains      = new Set();
    const seenEmails       = new Set();

    if (existingBatchIds.length > 0) {
      const existing = await LeadModel.find(
        { batchId: { $in: existingBatchIds }, email: { $exists: true, $ne: '' } },
        'email website',
      ).lean();
      for (const l of existing) {
        if (l.email)   seenEmails.add(l.email.toLowerCase().trim());
        if (l.website) { const d = getDomain(l.website); if (d) seenDomains.add(d); }
      }
      console.log(`[LeadFinder] Pre-loaded ${seenDomains.size} domains, ${seenEmails.size} emails for dedup`);
    }

    // \u2500\u2500 Geocode city (once, before rounds) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    const tomtomCallCounter = { count: 0 };
    let cityCoords = null;
    if (city && city.trim()) {
      cityCoords = await geocode(city, country, tomtomCallCounter);
      if (cityCoords) {
        console.log(`[LeadFinder] Geocoded "${city}": lat=${cityCoords.lat} lon=${cityCoords.lon}`);
      } else {
        console.warn(`[LeadFinder] Geocode failed for "${city}" \u2014 falling back to text search`);
      }
    }

    // \u2500\u2500 Niche resolution (Phase 0): translate niches to local-language terms \u2500\u2500\u2500\u2500
    // resolveNicheTerms never throws; worst case returns [original text]
    console.log(`[LeadFinder] Resolving ${niches.length} niche(s) for country "${country}"...`);
    const resolvedNiches = await Promise.all(
      niches.map(n => resolveNiche(n, country)),
    );
    const nicheResolutionMap = new Map(resolvedNiches.map(r => [r.original, r]));

    // \u2500\u2500 Per-niche state (persists across rounds, resumed from cursor if present)
    const quotas     = distribute(totalLeads, niches.length);  // initial per-niche targets
    const nicheStates = niches.map((niche, i) => {
      const savedCursor = (cursor && cursor[niche]) ? cursor[niche] : null;
      const resolution  = nicheResolutionMap.get(niche) || { terms: [niche], source: 'fallback' };

      const initialExhaustedCities = savedCursor && Array.isArray(savedCursor.exhaustedCities)
        ? new Set(savedCursor.exhaustedCities) : new Set();
      const initialCityOffsets = (savedCursor && savedCursor.cityOffsets && typeof savedCursor.cityOffsets === 'object')
        ? { ...savedCursor.cityOffsets } : {};
      const initialOffset = (savedCursor && typeof savedCursor.offset === 'number')
        ? savedCursor.offset : 0;
      const initialCityIdx = (savedCursor && typeof savedCursor.cityIdx === 'number')
        ? savedCursor.cityIdx : 0;

      // Backward-compatible: old cursors may not have term state; start fresh if missing
      const initialTermIdx  = (savedCursor && typeof savedCursor.termIdx === 'number')
        ? savedCursor.termIdx : 0;
      const initialTermOffsets = (savedCursor && savedCursor.termOffsets && typeof savedCursor.termOffsets === 'object')
        ? { ...savedCursor.termOffsets } : {};
      const initialTermCityIdx = (savedCursor && savedCursor.termCityIdx && typeof savedCursor.termCityIdx === 'object')
        ? { ...savedCursor.termCityIdx } : {};
      const initialTermCityOffsets = (savedCursor && savedCursor.termCityOffsets && typeof savedCursor.termCityOffsets === 'object')
        ? JSON.parse(JSON.stringify(savedCursor.termCityOffsets)) : {};
      const initialTermExhCities = (savedCursor && savedCursor.termExhaustedCities && typeof savedCursor.termExhaustedCities === 'object')
        ? JSON.parse(JSON.stringify(savedCursor.termExhaustedCities)) : {};
      const initialDeadTerms = (savedCursor && Array.isArray(savedCursor.deadTerms))
        ? new Set(savedCursor.deadTerms) : new Set();
      // Use saved terms from cursor (avoids re-calling AI on automation resume)
      const initialTerms = (savedCursor && Array.isArray(savedCursor.terms) && savedCursor.terms.length > 0)
        ? savedCursor.terms : resolution.terms;

      return {
        niche,
        target:              quotas[i],
        saved:               0,
        offset:              initialOffset,
        cityIdx:             initialCityIdx,
        cityOffsets:         initialCityOffsets,
        exhaustedCities:     initialExhaustedCities,
        round:               1,
        coords:              cityCoords,
        exhausted:           Boolean(savedCursor?.exhausted),
        prevYield:           null,
        // Per-term state
        terms:               initialTerms,
        termsSource:         resolution.source,
        termIdx:             initialTermIdx,
        termOffsets:         initialTermOffsets,
        termCityIdx:         initialTermCityIdx,
        termCityOffsets:     initialTermCityOffsets,
        termExhaustedCities: initialTermExhCities,
        deadTerms:           initialDeadTerms,
        termConsecZeros:     new Map(),
      };
    });

  const citiesCoveredMap = new Map();
  let batchId    = null;
  let batchName  = null;
  let totalSaved = 0;
  let stopReason = null;
  const allRoundStats = [];
  const fetchErrorCounts = {};

  // ── Round loop ─────────────────────────────────────────────────────────────
  for (let roundNum = 1; roundNum <= MAX_ROUNDS; roundNum++) {
    if (isCancelled())  { stopReason = 'cancelled';   break; }
    if (timeLimitHit()) { stopReason = 'time_limit';  break; }
    if (tomtomCallCounter.count >= maxTomTomCalls()) { stopReason = 'call_cap'; break; }

    const activeNiches = nicheStates.filter(ns => !ns.exhausted && ns.target > ns.saved);
    if (activeNiches.length === 0) { stopReason = 'all_niches_exhausted'; break; }

    console.log(`[LeadFinder] ── Round ${roundNum} ──────────────────────────────────────`);
    const roundStart = Date.now();

    // ── Compute pool sizes for this round ──────────────────────────────────
    // Round 1: pool = min(400, max(60, 6 * totalLeads)) split across active niches
    // Later rounds: use measured yield from previous round
    const totalRemaining = nicheStates.reduce((s, ns) => s + Math.max(0, ns.target - ns.saved), 0);

    const poolPerNiche = activeNiches.map(ns => {
      const remaining = ns.target - ns.saved;
      if (roundNum === 1) {
        const totalPool = Math.min(400, Math.max(60, 6 * totalLeads));
        return Math.ceil(totalPool / activeNiches.length);
      }
      // yield-based sizing
      const y = ns.prevYield
        ? Math.max(0.05, ns.prevYield.valid / Math.max(1, ns.prevYield.scraped))
        : 0.10;
      return Math.min(400, Math.ceil((remaining / y) * 1.3));
    });

    // ── Phase 1: collect candidates ───────────────────────────────────────
    let roundCandidates = [];
    let rateLimited     = false;
    let capReached      = false;

    for (let ni = 0; ni < activeNiches.length; ni++) {
      const ns    = activeNiches[ni];
      const pSize = poolPerNiche[ni];
      if (isCancelled() || timeLimitHit() || tomtomCallCounter.count >= maxTomTomCalls()) {
        capReached = tomtomCallCounter.count >= maxTomTomCalls();
        break;
      }


      ns.round = roundNum;
      const { candidates, rateLimited: rl, capReached: cap, exhausted } = await collectForNiche({
        niche:               ns.niche,
        city,
        country,
        poolTarget:          pSize,
        seenDomains,
        nicheState:          ns,
        tomtomCallCounter,
        isAllCitiesGermany,
        cancelFlag,
        runStart,
        citiesCoveredMap,
        searchTomTomFn: searchText,
        searchTomTomByCoordFn: searchCoord,
        maxCalls: maxTomTomCalls(),
      });

      if (exhausted) {
        ns.exhausted = true;
        redistributeExhaustedQuotas(nicheStates);
      }
      if (rl) { rateLimited = true; }
      if (cap) { capReached = true; }
      if (tomtomCallCounter.count >= maxTomTomCalls()) { capReached = true; }

      // Tag candidates with their niche
      for (const c of candidates) { c._niche = ns.niche; c._nicheIdx = ni; }
      roundCandidates.push(...candidates);

      console.log(`[LeadFinder]   Collected ${candidates.length} candidates for "${ns.niche}"`);
      onProgress({ round: roundNum, collecting: true, niche: ns.niche, totalSaved, target: totalLeads });
    }

    if ((rateLimited || capReached) && roundCandidates.length === 0) {
      stopReason = rateLimited ? 'rate_limit' : 'call_cap'; break;
    }

    console.log(`[LeadFinder] Round ${roundNum} Phase 1 done: ${roundCandidates.length} candidates | ${elapsed()}s`);

    if (roundCandidates.length === 0) {
      if (activeNiches.every(ns => ns.exhausted)) {
        // Check if all terms across all niches were dead
        const allTermsDead = nicheStates.every(
          ns => ns.deadTerms && ns.terms && ns.terms.every(t => ns.deadTerms.has(t)),
        );
        stopReason = allTermsDead ? 'all_terms_empty' : 'no_candidates';
      } else if (rateLimited) {
        stopReason = 'rate_limit';
      } else if (capReached || tomtomCallCounter.count >= maxTomTomCalls()) {
        stopReason = 'call_cap';
      }
      break;
    }

    // ── Phase 2: scrape emails ────────────────────────────────────────────
    // Stop scraping as soon as this round's needed leads or totalLeads are found
    let roundValid    = 0;
    let roundScraped  = 0;
    const roundLeads  = [];   // { biz, email, niche }

    onProgress({ round: roundNum, scraping: true, totalSaved, target: totalLeads, roundCandidates: roundCandidates.length });

    for (let bStart = 0; bStart < roundCandidates.length; bStart += SCRAPE_CONCURRENCY) {
      if (isCancelled() || timeLimitHit()) break;
      if (totalSaved + roundLeads.length >= totalLeads) break;  // target reached

      const bSlice = roundCandidates.slice(bStart, bStart + SCRAPE_CONCURRENCY);
      const jobs   = bSlice.map(biz => async () => {
        const email = await scrapeSite(biz.website, fetchErrorCounts);
        return { biz, email };
      });
      const results = await runInBatches(jobs, SCRAPE_CONCURRENCY);
      roundScraped += bSlice.length;

      for (const r of results) {
        if (!r || !r.email) continue;
        const norm = r.email.toLowerCase().trim();
        if (seenEmails.has(norm)) continue;

        // Stop immediately if target is reached — ignore further results in flight
        if (totalSaved + roundLeads.length >= totalLeads) break;

        seenEmails.add(norm);
        roundLeads.push({ biz: r.biz, email: norm, niche: r.biz._niche || niches[0] });
        roundValid++;
      }

      onProgress({
        round: roundNum, scraping: true,
        roundScraped, roundCandidates: roundCandidates.length,
        roundValid: roundLeads.length, totalSaved, target: totalLeads,
      });

      if (totalSaved + roundLeads.length >= totalLeads) break;
    }

    // Track yield per niche for next round sizing
    for (const ns of activeNiches) {
      const nicheLeads   = roundLeads.filter(l => l.niche === ns.niche).length;
      const nicheCandidates = roundCandidates.filter(c => c._niche === ns.niche).length;
      ns.prevYield = { valid: nicheLeads, scraped: nicheCandidates };
    }

    console.log(`[LeadFinder] Round ${roundNum} Phase 2 done: scraped=${roundScraped} valid=${roundLeads.length} | ${elapsed()}s`);

    // ── Save this round's leads ──────────────────────────────────────────
    // Trim roundLeads so that totalSaved + leadsToSave never exceeds totalLeads
    const maxToSave   = Math.max(0, totalLeads - totalSaved);
    const leadsToSave = roundLeads.slice(0, maxToSave);

    if (leadsToSave.length > 0) {
      // Create batch on first save
      if (!batchId) {
        if (batchNamePrefix) {
          const dateStr = new Date().toISOString().slice(0, 10);
          batchName = `${batchNamePrefix} - ${locationLabel} - Multi-Niche (${nicheLabel}) - ${dateStr}`;
        } else {
          batchName = `${locationLabel} - Multi-Niche (${nicheLabel})`;
        }
        const batch = new BatchModel({
          name: batchName, projectId, source: 'Lead Finder Agent', leadCount: 0,
        });
        await batch.save();
        batchId = batch._id.toString();
        notifyBatch(batchId, batchName);
        console.log(`[LeadFinder] Created batch "${batchName}" (${batchId})`);
      }

      await LeadModel.insertMany(leadsToSave.map(l => ({
        batchId,
        company: l.biz.name,
        city:    l.biz.city || city || country,
        website: l.biz.website || '',
        email:   l.email,
        niche:   l.niche,
        status:  'Valid',
      })));

      // Update niche saved counts
      for (const l of leadsToSave) {
        const ns = nicheStates.find(n => n.niche === l.niche);
        if (ns) ns.saved++;
      }

      totalSaved += leadsToSave.length;

      // Update batch leadCount
      await BatchModel.updateOne({ _id: batchId }, { leadCount: totalSaved });
      console.log(`[LeadFinder] Round ${roundNum}: saved ${leadsToSave.length} leads (total=${totalSaved})`);
    }

    const roundElapsed = Math.round((Date.now() - roundStart) / 1000);
    const roundStats = {
      round:      roundNum,
      candidates: roundCandidates.length,
      scraped:    roundScraped,
      validFound: leadsToSave.length,
      saved:      totalSaved,
      remaining:  Math.max(0, totalLeads - totalSaved),
      elapsedSec: roundElapsed,
    };
    allRoundStats.push(roundStats);
    notifyRound(roundStats);

    console.log(`[LeadFinder] Round ${roundNum} done: ${JSON.stringify(roundStats)}`);

    // ── Check stop conditions after round ───────────────────────────────
    if (totalSaved >= totalLeads) { stopReason = 'target_reached'; break; }
    if (rateLimited)              { stopReason = 'rate_limit';     break; }
    if (capReached || tomtomCallCounter.count >= maxTomTomCalls()) { stopReason = 'call_cap'; break; }
    if (leadsToSave.length === 0) { stopReason = 'no_new_leads';   break; }
    if (isCancelled())            { stopReason = 'cancelled';      break; }
    if (timeLimitHit())           { stopReason = 'time_limit';     break; }

    const anyRemaining = nicheStates.some(ns => !ns.exhausted && ns.target > ns.saved);
    if (!anyRemaining) { stopReason = 'all_niches_exhausted'; break; }
  }

  if (!stopReason) stopReason = MAX_ROUNDS + '_rounds_done';

  const citiesCovered = Array.from(citiesCoveredMap.entries()).map(([cityName, count]) => ({
    city: cityName,
    count,
  }));

  const endCursor = {};
  for (const ns of nicheStates) {
    endCursor[ns.niche] = {
      offset:               ns.offset || 0,
      cityIdx:              ns.cityIdx || 0,
      cityOffsets:          { ...(ns.cityOffsets || {}) },
      exhaustedCities:      Array.from(ns.exhaustedCities || []),
      exhausted:            Boolean(ns.exhausted),
      // Per-term state (new; absent in old cursors → handled on load)
      termIdx:              ns.termIdx || 0,
      termOffsets:          { ...(ns.termOffsets || {}) },
      termCityIdx:          { ...(ns.termCityIdx || {}) },
      termCityOffsets:      ns.termCityOffsets ? JSON.parse(JSON.stringify(ns.termCityOffsets)) : {},
      termExhaustedCities:  ns.termExhaustedCities ? JSON.parse(JSON.stringify(ns.termExhaustedCities)) : {},
      deadTerms:            Array.from(ns.deadTerms || []),
      terms:                ns.terms || [],
    };
  }
  const allNichesExhausted = nicheStates.every(ns => ns.exhausted);

  const totalElapsed = elapsed();
  const summary = {
    batchId,
    batchName,
    totalFound:      totalSaved,
    validCount:      totalSaved,
    checkedCount:    allRoundStats.reduce((s, r) => s + r.scraped, 0),
    tomtomCallCount: tomtomCallCounter.count,
    citiesCovered,
    rounds:          allRoundStats,
    stopReason,
    totalElapsedSec: totalElapsed,
    fetchErrorCounts,
    endCursor,
    allNichesExhausted,
    perNicheBreakdown: nicheStates.map(ns => ({
      niche:        ns.niche,
      validFound:   ns.saved,
      totalChecked: allRoundStats.reduce((s, r) => s + (r.candidates || 0), 0),
      exhausted:    ns.exhausted,
    })),
    // New: shows what terms were used for each niche
    searchTerms: nicheStates.map(ns => ({
      niche:  ns.niche,
      terms:  ns.terms  || [ns.niche],
      source: ns.termsSource || 'fallback',
    })),
  };

  console.log(`[LeadFinder] ── Pipeline complete in ${totalElapsed}s ─────────────────`);
  console.log(`[LeadFinder] stopReason=${stopReason} | saved=${totalSaved}/${totalLeads} | rounds=${allRoundStats.length} | TomTom=${tomtomCallCounter.count}`);

  return summary;
  } finally {
    releaseLeadFinderLock();
  }
};

module.exports = {
  runMultiNicheSearch,
  isLeadFinderActive,
  acquireLeadFinderLock,
  releaseLeadFinderLock,
  collectForNiche,
  GERMANY_CITIES,
  getTomTomMaxCalls,
  // ── Shared helpers used by smartSearchService ───────────────────────────
  searchTomTom,
  parseTomTomResult,
  fetchPageWithRetry,
  extractEmailsFromHtml,
  isUsableEmail,
  runInBatches,
  normaliseUrl,
  sleep,
  HARD_CAP_PER_NICHE,
  TOMTOM_CALL_DELAY_MS,
  TOMTOM_PAGE_SIZE,
  OVERFETCH_RATIO,
};
