/**
 * services/smartSearchService.js
 *
 * Smart Search pipeline — high-yield version with retry ladder.
 *
 *  fetchPageWithRetry           — retry ladder: CERT_ERROR → no-verify, DNS/CONN → www toggle + http,
 *                                 BLOCKED → alternate UA; records fetchError code on total failure
 *  parseSmartSearchInstruction  — AI infers country from city, returns nicheTerms + cities
 *  collectCandidates            — (nicheTerm × city) TomTom with pagination, domain dedup, pool cap
 *  extractSignalsFromHtml       — signal extraction from pre-fetched HTML; sslError propagated
 *  passesOutdatedPrefilter      — fast rule-based pre-filter; sslError = strong outdated indicator
 *  extractEmailsFromHtml        — standard + obfuscated email detection
 *  scrapeContactEmails          — reuses homepage HTML, probes ≤2 contact pages when needed
 *  evaluateLeadsAgainstCriteria — batched AI scoring 0-100; sslError in prompt
 *  runSmartSearch               — orchestrator: 8-min budget, cancel flag, fetchErrorCounts in summary
 */

'use strict';

const https   = require('https');
const axios   = require('axios');
const cheerio = require('cheerio');

const { askAI } = require('./aiService');
const Batch     = require('../models/Batch');
const Lead      = require('../models/Lead');

const {
  searchTomTom,
  parseTomTomResult,
  runInBatches,
  normaliseUrl,
  sleep,
  TOMTOM_CALL_DELAY_MS,
  TOMTOM_PAGE_SIZE,
} = require('./leadFinderService');

// ── Config ────────────────────────────────────────────────────────────────────

const SMART_SEARCH_MAX_MS  = 8 * 60 * 1000;
const FETCH_TIMEOUT_MS     = 7_000;   // per attempt
const SITE_BUDGET_MS       = 15_000;  // total per site
const MAX_CONTACT_PAGES    = 2;
const MAX_RESPONSE_BYTES   = 2 * 1024 * 1024;
const EVAL_CHUNK_SIZE      = 8;
const EVAL_CHUNK_DELAY_MS  = 1500;
const EVAL_RETRY_DELAY_MS  = 3000;
const HOMEPAGE_CONCURRENCY = 20;
const EMAIL_CONCURRENCY    = 10;
const TOMTOM_MAX_PAGES     = 4;

const STRICTNESS_THRESHOLDS = { strict: 70, normal: 50, loose: 25 };

const FALLBACK_CITIES = {
  germany:          ['Berlin', 'Hamburg', 'Munich', 'Cologne', 'Frankfurt', 'Stuttgart', 'Dusseldorf', 'Leipzig'],
  deutschland:      ['Berlin', 'Hamburg', 'Munich', 'Cologne', 'Frankfurt', 'Stuttgart', 'Dusseldorf', 'Leipzig'],
  france:           ['Paris', 'Lyon', 'Marseille', 'Toulouse', 'Nice', 'Nantes', 'Strasbourg', 'Bordeaux'],
  'united kingdom': ['London', 'Birmingham', 'Manchester', 'Glasgow', 'Leeds', 'Liverpool', 'Bristol', 'Edinburgh'],
  spain:            ['Madrid', 'Barcelona', 'Valencia', 'Seville', 'Zaragoza', 'Malaga', 'Murcia', 'Palma'],
  italy:            ['Rome', 'Milan', 'Naples', 'Turin', 'Palermo', 'Genoa', 'Bologna', 'Florence'],
  netherlands:      ['Amsterdam', 'Rotterdam', 'The Hague', 'Utrecht', 'Eindhoven', 'Groningen', 'Tilburg', 'Almere'],
  poland:           ['Warsaw', 'Krakow', 'Lodz', 'Wroclaw', 'Poznan', 'Gdansk', 'Szczecin', 'Bydgoszcz'],
  pakistan:         ['Karachi', 'Lahore', 'Islamabad', 'Faisalabad', 'Rawalpindi', 'Multan', 'Peshawar', 'Quetta'],
};

const CONTACT_PATHS = [
  '/kontakt', '/impressum', '/contact', '/imprint',
  '/ueber-uns', '/about-us', '/about',
  '/kontakt.html', '/impressum.html', '/contact.html',
];

const MODERN_FRAMEWORK_PATTERNS = [
  /__next/i, /react(?:\.min)?\.js/i, /_next\/static/i, /data-reactroot/i,
  /vue(?:\.min)?\.js/i, /__nuxt/i, /ng-version/i, /angular(?:\.min)?\.js/i,
  /tailwind(?:css)?(?:\.min)?\.css/i, /bootstrap(?:\.min)?\.(?:css|js)/i,
];

// ── Error classification ──────────────────────────────────────────────────────

/**
 * Classify an axios/node error into one of the known fetch-error codes.
 * Returns { code, message } where code is one of:
 *   CERT_ERROR | DNS_ERROR | TIMEOUT | CONNECTION_REFUSED | HTTP_4XX | HTTP_5XX | BLOCKED | OTHER
 */
function classifyFetchError(err, httpStatus) {
  if (httpStatus) {
    if (httpStatus === 403 || httpStatus === 429) return { code: 'BLOCKED',   message: `HTTP ${httpStatus}` };
    if (httpStatus >= 400 && httpStatus < 500)   return { code: 'HTTP_4XX',  message: `HTTP ${httpStatus}` };
    if (httpStatus >= 500)                        return { code: 'HTTP_5XX',  message: `HTTP ${httpStatus}` };
  }
  if (!err) return { code: 'OTHER', message: 'unknown' };

  const msg   = (err.message || '').toLowerCase();
  const eCode = (err.code    || '').toUpperCase();

  // Certificate / TLS errors
  if (
    eCode === 'CERT_HAS_EXPIRED'         ||
    eCode === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    eCode === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
    eCode === 'DEPTH_ZERO_SELF_SIGNED_CERT' ||
    eCode === 'SELF_SIGNED_CERT_IN_CHAIN' ||
    eCode === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' ||
    eCode.startsWith('ERR_SSL') ||
    eCode.startsWith('ERR_CERT') ||
    msg.includes('certificate') ||
    msg.includes('ssl') ||
    msg.includes('tls') ||
    msg.includes('self-signed') ||
    msg.includes('self signed')
  ) return { code: 'CERT_ERROR', message: err.message };

  // DNS
  if (eCode === 'ENOTFOUND' || eCode === 'EAI_AGAIN' || msg.includes('getaddrinfo'))
    return { code: 'DNS_ERROR', message: err.message };

  // Timeout
  if (eCode === 'ECONNABORTED' || eCode === 'ETIMEDOUT' || msg.includes('timeout'))
    return { code: 'TIMEOUT', message: err.message };

  // Connection refused
  if (eCode === 'ECONNREFUSED' || eCode === 'ECONNRESET' || eCode === 'EPIPE')
    return { code: 'CONNECTION_REFUSED', message: err.message };

  return { code: 'OTHER', message: err.message };
}

// ── Single raw fetch attempt ──────────────────────────────────────────────────

const BROWSER_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
};

/**
 * Make one HTTP GET attempt.
 *
 * @param {string} url
 * @param {object} opts
 * @param {boolean} [opts.noVerify]    — disable TLS cert verification
 * @param {boolean} [opts.altUA]       — use the alternate desktop UA
 * @param {number}  [opts.timeoutMs]   — override per-attempt timeout
 *
 * @returns {{ html, finalUrl, hasSSL, loadTimeMs }|null}  on success (2xx HTML)
 * @throws  the axios error on any failure so caller can classify it
 */
async function rawFetch(url, { noVerify = false, altUA = false, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const t0 = Date.now();

  const headers = altUA ? {
    'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    'Accept':          'text/html,application/xhtml+xml,*/*;q=0.9',
    'Accept-Language': 'de-DE,de;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
  } : BROWSER_HEADERS;

  const httpsAgent = noVerify
    ? new https.Agent({ rejectUnauthorized: false })
    : undefined;

  const resp = await axios.get(url, {
    timeout:          timeoutMs,
    maxRedirects:     5,
    maxContentLength: MAX_RESPONSE_BYTES,
    headers,
    httpsAgent,
    validateStatus:   () => true,   // we inspect status ourselves
  });

  // Treat non-HTML content types as failure (not a page we can parse)
  const ct = (resp.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('html') && !ct.includes('text/plain')) return null;

  // Map HTTP errors to classified throws so the retry ladder can act on them
  if (resp.status === 403 || resp.status === 429) {
    const e = new Error(`HTTP ${resp.status}`);
    e.code = 'BLOCKED_HTTP'; e.httpStatus = resp.status;
    throw e;
  }
  if (resp.status >= 400) {
    const e = new Error(`HTTP ${resp.status}`);
    e.httpStatus = resp.status;
    throw e;
  }

  const finalUrl   = resp.request?.res?.responseUrl || url;
  const hasSSL     = finalUrl.startsWith('https://');
  const loadTimeMs = Date.now() - t0;
  return { html: String(resp.data), finalUrl, hasSSL, loadTimeMs };
}

// ── Retry ladder ──────────────────────────────────────────────────────────────

/**
 * Fetch a homepage, trying multiple strategies before giving up.
 *
 * Returns one of:
 *   { html, finalUrl, hasSSL, loadTimeMs, sslError? }   — success
 *   { fetchError: { code, message } }                   — total failure
 *
 * Retry ladder:
 *  Attempt 1: normal https, standard UA
 *  If CERT_ERROR  → Attempt 2: https, same URL, rejectUnauthorized=false; if ok: sslError=true, hasSSL=false
 *  If DNS_ERROR or CONNECTION_REFUSED:
 *                 → Attempt 2: toggle www. prefix
 *                 → Attempt 3: try http:// instead of https://
 *  If BLOCKED     → Attempt 2: alternate desktop UA
 *  All other errors (TIMEOUT, HTTP_4XX, HTTP_5XX, OTHER) → no retry
 *
 * Total time capped at SITE_BUDGET_MS.
 */
async function fetchPageWithRetry(rawUrl) {
  let url = (rawUrl || '').trim();
  if (!url) return { fetchError: { code: 'OTHER', message: 'empty url' } };
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

  const deadline = Date.now() + SITE_BUDGET_MS;
  const remaining = () => Math.max(500, deadline - Date.now());

  // ── Attempt 1: normal ────────────────────────────────────────────────────
  let lastError = null;
  let lastCode  = 'OTHER';

  try {
    const r = await rawFetch(url, { timeoutMs: Math.min(FETCH_TIMEOUT_MS, remaining()) });
    if (r) return r;
    // null = wrong content type
    return { fetchError: { code: 'OTHER', message: 'non-HTML content type' } };
  } catch (err) {
    const classified = classifyFetchError(err, err.httpStatus);
    lastCode  = classified.code;
    lastError = classified;
    console.log(`[SmartSearch] Fetch fail #1  ${url}  [${classified.code}] ${classified.message}`);
  }

  // ── Attempt 2 onwards — depends on error type ────────────────────────────

  if (lastCode === 'CERT_ERROR') {
    // Retry with cert verification disabled — marks sslError=true
    if (remaining() > 1000) {
      try {
        const r = await rawFetch(url, { noVerify: true, timeoutMs: Math.min(FETCH_TIMEOUT_MS, remaining()) });
        if (r) {
          console.log(`[SmartSearch] Fetch ok (no-verify SSL)  ${url}`);
          return { ...r, hasSSL: false, sslError: true };
        }
      } catch (err2) {
        const c2 = classifyFetchError(err2, err2.httpStatus);
        lastCode  = c2.code;
        lastError = c2;
        console.log(`[SmartSearch] Fetch fail #2 (no-verify)  ${url}  [${c2.code}] ${c2.message}`);
      }
    }

  } else if (lastCode === 'DNS_ERROR' || lastCode === 'CONNECTION_REFUSED') {
    // Attempt 2a: toggle www. prefix
    let altUrl;
    try {
      const parsed = new URL(url);
      if (parsed.hostname.startsWith('www.')) {
        parsed.hostname = parsed.hostname.slice(4);
      } else {
        parsed.hostname = 'www.' + parsed.hostname;
      }
      altUrl = parsed.href;
    } catch { altUrl = null; }

    if (altUrl && remaining() > 1000) {
      try {
        const r = await rawFetch(altUrl, { timeoutMs: Math.min(FETCH_TIMEOUT_MS, remaining()) });
        if (r) { console.log(`[SmartSearch] Fetch ok (www-toggle)  ${altUrl}`); return r; }
      } catch (err2) {
        const c2 = classifyFetchError(err2, err2.httpStatus);
        lastCode  = c2.code;
        lastError = c2;
        console.log(`[SmartSearch] Fetch fail #2 (www-toggle)  ${altUrl}  [${c2.code}] ${c2.message}`);
      }
    }

    // Attempt 2b: try http:// if original was https://
    if (url.startsWith('https://') && remaining() > 1000) {
      const httpUrl = 'http://' + url.slice(8);
      try {
        const r = await rawFetch(httpUrl, { timeoutMs: Math.min(FETCH_TIMEOUT_MS, remaining()) });
        if (r) { console.log(`[SmartSearch] Fetch ok (http fallback)  ${httpUrl}`); return r; }
      } catch (err3) {
        const c3 = classifyFetchError(err3, err3.httpStatus);
        lastCode  = c3.code;
        lastError = c3;
        console.log(`[SmartSearch] Fetch fail #3 (http fallback)  ${httpUrl}  [${c3.code}] ${c3.message}`);
      }
    }

  } else if (lastCode === 'BLOCKED') {
    // Retry with alternate desktop UA
    if (remaining() > 1000) {
      try {
        const r = await rawFetch(url, { altUA: true, timeoutMs: Math.min(FETCH_TIMEOUT_MS, remaining()) });
        if (r) { console.log(`[SmartSearch] Fetch ok (alt-UA)  ${url}`); return r; }
      } catch (err2) {
        const c2 = classifyFetchError(err2, err2.httpStatus);
        lastCode  = c2.code;
        lastError = c2;
        console.log(`[SmartSearch] Fetch fail #2 (alt-UA)  ${url}  [${c2.code}] ${c2.message}`);
      }
    }
  }

  // Total failure
  console.log(`[SmartSearch] Fetch GAVE UP  ${url}  [${lastError.code}]`);
  return { fetchError: lastError };
}

// ── Email helpers ─────────────────────────────────────────────────────────────

const EMAIL_REGEX  = /\b[a-zA-Z0-9._%+\-]{1,64}@[a-zA-Z0-9.\-]{1,253}\.[a-zA-Z]{2,}\b/g;
const OBFUSC_REGEX = /\b([a-zA-Z0-9._%+\-]{1,64})\s*(?:\[at\]|\(at\)|{\s*at\s*}|\s+AT\s+)\s*([a-zA-Z0-9.\-]{1,253}\.[a-zA-Z]{2,})\b/g;

const DOMAIN_BL = new Set([
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

function isGoodEmail(e) {
  if (!e || typeof e !== 'string') return false;
  const l = e.toLowerCase().trim();
  if (!/^[^\s@]{1,64}@[^\s@]{1,253}\.[a-z]{2,}$/.test(l)) return false;
  const [local, domain] = l.split('@');
  if (DOMAIN_BL.has(domain)) return false;
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
    if (isGoodEmail(m)) found.add(m);
  });

  const text = $.text();
  for (const m of (text.match(EMAIL_REGEX) || []))  { const l = m.toLowerCase(); if (isGoodEmail(l)) found.add(l); }
  for (const m of (html.match(EMAIL_REGEX) || []))  { const l = m.toLowerCase(); if (isGoodEmail(l)) found.add(l); }

  const combined = text + ' ' + html;
  let om;
  OBFUSC_REGEX.lastIndex = 0;
  while ((om = OBFUSC_REGEX.exec(combined)) !== null) {
    const candidate = `${om[1]}@${om[2]}`.toLowerCase();
    if (isGoodEmail(candidate)) found.add(candidate);
  }

  return [...found];
}

// ── Signal extraction (from pre-fetched result) ───────────────────────────────

/**
 * Extract quality signals from the result of fetchPageWithRetry.
 *
 * Accepts either:
 *   { html, finalUrl, hasSSL, loadTimeMs, sslError? }   — success
 *   { fetchError: { code, message } }                   — total failure
 *   null
 *
 * Returns a signals object. When sslError=true it is included as a strong outdated indicator.
 */
function extractSignalsFromHtml(fetched) {
  const baseUnreachable = {
    siteUnreachable: true, sslError: false,
    hasSSL: null, hasMobileViewport: null, copyrightYear: null,
    pageTitle: null, hasSocialLinks: null, estimatedLoadTimeMs: null,
    hasModernFramework: null, detectedLanguage: null, wordCount: null,
    isHtml5: null, usesTableLayout: null, hasDeprecatedTags: null,
    jqueryVersion: null, hasMediaQueries: null, usesFlash: null, generatorTag: null,
  };

  if (!fetched || fetched.fetchError) return baseUnreachable;

  const { html, hasSSL, loadTimeMs, sslError = false } = fetched;

  try {
    const $ = cheerio.load(html);

    const hasMobileViewport = $('meta[name="viewport"]').length > 0;
    const pageTitle         = $('title').first().text().trim() || null;
    const detectedLanguage  = ($('html').attr('lang') || '').trim().toLowerCase() || null;

    const searchText = ($('footer,#footer,.footer,[class*="footer"]').text() || $.text()).replace(/\s+/g, ' ');
    let copyrightYear = null;
    const m1 = searchText.match(/(?:©|copyright|\(c\))[\s\S]{0,60}?((?:19|20)\d{2})/i);
    const m2 = searchText.match(/((?:19|20)\d{2})[\s\S]{0,20}?(?:©|copyright)/i);
    if (m1) copyrightYear = parseInt(m1[1], 10);
    else if (m2) copyrightYear = parseInt(m2[1], 10);
    const yr = new Date().getFullYear();
    if (copyrightYear && (copyrightYear < 1990 || copyrightYear > yr + 1)) copyrightYear = null;

    let hasSocialLinks = false;
    const socialDomains = ['facebook.com','instagram.com','twitter.com','x.com','linkedin.com'];
    $('a[href]').each((_, el) => {
      if (hasSocialLinks) return false;
      if (socialDomains.some(d => ($(el).attr('href') || '').toLowerCase().includes(d))) hasSocialLinks = true;
    });

    let hasModernFramework = false;
    for (const p of MODERN_FRAMEWORK_PATTERNS) if (p.test(html)) { hasModernFramework = true; break; }

    $('script,style,noscript').remove();
    const cleanText = $.text().replace(/\s+/g, ' ').trim();
    const wordCount  = cleanText.split(' ').filter(w => w.length > 1).length;

    const isHtml5         = /<!doctype\s+html\s*>/i.test(html);
    const usesTableLayout = $('table').length >= 3;

    const deprecatedTags  = ['font','center','marquee','blink','strike','frameset'];
    let hasDeprecatedTags = false;
    for (const tag of deprecatedTags) { if ($(tag).length > 0) { hasDeprecatedTags = true; break; } }

    let jqueryVersion = null;
    $('script[src]').each((_, el) => {
      if (jqueryVersion) return false;
      const jqm = ($(el).attr('src') || '').toLowerCase().match(/jquery[.-](\d+\.\d+(?:\.\d+)?)/);
      if (jqm) jqueryVersion = jqm[1];
    });
    if (!jqueryVersion) {
      const jqm = html.match(/jquery[.-](\d+\.\d+(?:\.\d+)?)/i);
      if (jqm) jqueryVersion = jqm[1];
    }

    const styleContent    = $('style').map((_, el) => $(el).html()).get().join(' ');
    const hasMediaQueries = /@media\s*\(/i.test(styleContent) || html.includes('@media (');
    const usesFlash       = /\.swf["']/i.test(html) || /<object[^>]+shockwave-flash/i.test(html);
    const generatorTag    = $('meta[name="generator"]').attr('content') || null;

    return {
      siteUnreachable: false, sslError,
      hasSSL: sslError ? false : hasSSL,
      hasMobileViewport, copyrightYear, pageTitle,
      hasSocialLinks, estimatedLoadTimeMs: loadTimeMs, hasModernFramework,
      detectedLanguage, wordCount, isHtml5, usesTableLayout, hasDeprecatedTags,
      jqueryVersion, hasMediaQueries, usesFlash, generatorTag,
    };
  } catch (err) {
    console.error('[SmartSearch] extractSignalsFromHtml parse error:', err.message);
    return { ...baseUnreachable, siteUnreachable: false, sslError, hasSSL: sslError ? false : hasSSL };
  }
}

// ── Outdated pre-filter ───────────────────────────────────────────────────────

function passesOutdatedPrefilter(signals) {
  if (signals.siteUnreachable) return true;   // total failure — let AI decide
  if (signals.hasModernFramework) return false; // React/Vue/Next/Bootstrap → modern

  let score = 0;
  if (signals.sslError)                                                   score += 2;  // expired/invalid cert
  if (!signals.hasMobileViewport)                                         score += 2;
  if (!signals.isHtml5)                                                   score += 2;
  if (signals.usesTableLayout)                                            score += 2;
  if (signals.hasDeprecatedTags)                                          score += 2;
  if (signals.usesFlash)                                                  score += 3;
  if (signals.jqueryVersion && signals.jqueryVersion.startsWith('1.'))   score += 2;
  if (!signals.hasMediaQueries && !signals.hasMobileViewport)             score += 1;
  const yr = new Date().getFullYear();
  if (signals.copyrightYear && signals.copyrightYear <= yr - 3)          score += 1;
  if (!signals.hasSSL && !signals.sslError)                              score += 1;  // plain http (not cert-error)

  return score >= 2;
}

function isOutdatedCriteria(criteria) {
  if (!criteria) return false;
  const kw = ['outdat', 'old', 'veraltet', 'alt ', 'no ssl', 'kein ssl',
               'no mobile', 'not mobile', 'not responsive', 'nicht mobil'];
  return kw.some(k => criteria.toLowerCase().includes(k));
}

// ── Contact email scraper (reuses homepage HTML) ──────────────────────────────

async function scrapeContactEmails(rawUrl, homepageFetch) {
  // homepageFetch is the result from fetchPageWithRetry — may be a success object or { fetchError }
  const successFetch = homepageFetch && !homepageFetch.fetchError ? homepageFetch : null;

  const emails = successFetch ? extractEmailsFromHtml(successFetch.html) : [];
  if (emails.length > 0) return emails[0];

  const url = normaliseUrl(rawUrl);
  if (!url) return null;

  let origin;
  try { origin = new URL(url).origin; } catch { return null; }

  const finalUrl = successFetch?.finalUrl || url;
  let homePath;
  try { homePath = new URL(finalUrl).pathname; } catch { homePath = '/'; }
  const visited  = new Set([homePath]);
  const toProbe  = [];

  if (successFetch) {
    const $ = cheerio.load(successFetch.html);
    $('a[href]').each((_, el) => {
      if (toProbe.length >= MAX_CONTACT_PAGES) return false;
      const href  = ($(el).attr('href') || '').trim();
      const lower = href.toLowerCase();
      if (!CONTACT_PATHS.some(p => lower === p || lower.startsWith(p + '/') ||
          lower.startsWith(p + '?') || lower.endsWith(p))) return;
      try {
        const abs  = new URL(href, finalUrl).href;
        const path = new URL(abs).pathname;
        if (!visited.has(path)) { visited.add(path); toProbe.push(abs); }
      } catch { /* bad href */ }
    });
  }

  for (const path of CONTACT_PATHS) {
    if (toProbe.length >= MAX_CONTACT_PAGES) break;
    if (visited.has(path)) continue;
    visited.add(path);
    toProbe.push(`${origin}${path}`);
  }

  for (const probeUrl of toProbe) {
    const page = await fetchPageWithRetry(probeUrl);
    if (!page || page.fetchError) continue;
    const found = extractEmailsFromHtml(page.html);
    if (found.length > 0) return found[0];
  }

  return null;
}

// ── Step 1: parseSmartSearchInstruction ──────────────────────────────────────

async function parseSmartSearchInstruction(instructionText) {
  const systemPrompt = `You are a search-parameter extractor for a B2B lead-generation tool.

The user describes (in any language) the business leads they want to find.
Return ONLY a JSON object with exactly these keys:

  country    (string|null)  — Target country in English. If not stated, INFER it from a well-known city
                               (e.g. Frankfurt → "Germany", Lahore → "Pakistan", Lyon → "France").
                               Return null ONLY when neither a country nor a recognizable city is present.
  city       (string|null)  — Specific city mentioned, or null for a whole-country search.
  niche      (string)       — Business type as a short lowercase English noun/phrase for TomTom POI search.
  criteria   (string|null)  — Qualitative filter (e.g. "outdated website", "no SSL"). null if none.
  nicheTerms (string[])     — 3 to 4 synonyms/related search terms (local language when helpful).
                               Always include the primary niche as the first entry.
  cities     (string[]|null)— When city is null: list up to 8 major cities of the country. Else null.

Rules:
- Respond ONLY with a JSON object containing exactly those 6 keys.
- Never add leadsCount or any other key.
- nicheTerms must be an array of 3–4 strings.
- cities must be an array of city name strings, or null.`;

  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await askAI(systemPrompt, `Instruction: "${instructionText}"`, { jsonMode: true });

      const country  = typeof result.country  === 'string' ? result.country.trim()  || null : null;
      const city     = typeof result.city     === 'string' ? result.city.trim()     || null : null;
      const niche    = typeof result.niche    === 'string' ? result.niche.trim().toLowerCase() : 'business';
      const criteria = typeof result.criteria === 'string' ? result.criteria.trim() || null : null;

      let nicheTerms = Array.isArray(result.nicheTerms)
        ? result.nicheTerms.filter(t => typeof t === 'string' && t.trim()).map(t => t.trim().toLowerCase())
        : [];
      if (nicheTerms.length === 0) nicheTerms = [niche];
      if (!nicheTerms.includes(niche)) nicheTerms.unshift(niche);
      nicheTerms = nicheTerms.slice(0, 4);

      let cities = null;
      if (!city) {
        if (Array.isArray(result.cities) && result.cities.length > 0) {
          cities = result.cities.filter(c => typeof c === 'string' && c.trim()).map(c => c.trim()).slice(0, 8);
        } else {
          const key = (country || '').toLowerCase();
          cities = FALLBACK_CITIES[key] || FALLBACK_CITIES['germany'];
          console.warn(`[SmartSearch] AI returned no cities for "${country}" — using fallback list`);
        }
      }

      return { country, city, niche, criteria, nicheTerms, cities };
    } catch (err) {
      lastErr = err;
      if (attempt === 1) {
        console.warn(`[SmartSearch] parseSmartSearchInstruction attempt 1 failed: ${err.message}. Retrying…`);
        await sleep(2000);
      }
    }
  }
  throw new Error(`AI failed to parse the search instruction: ${lastErr?.message || 'unknown error'}`);
}

// ── Step 2: collectCandidates ─────────────────────────────────────────────────

async function collectCandidates({
  nicheTerms, searchCities, country, leadsCount,
  projectDomains, tomtomCallCounter,
  isCancelled, budgetHit, updateProgress,
}) {
  const poolCap     = Math.max(leadsCount * 6, 120);
  const seenDomains = new Set(projectDomains);
  const candidates  = [];
  let   rateLimited = false;
  let   firstCall   = true;

  outer:
  for (const nicheTerm of nicheTerms) {
    for (const cityName of searchCities) {
      if (isCancelled() || budgetHit() || rateLimited) break outer;
      if (candidates.length >= poolCap) break outer;

      for (let page = 0; page < TOMTOM_MAX_PAGES; page++) {
        if (isCancelled() || budgetHit() || rateLimited) break;
        if (candidates.length >= poolCap) break;

        if (!firstCall) await sleep(TOMTOM_CALL_DELAY_MS);
        firstCall = false;

        const offset = page * TOMTOM_PAGE_SIZE;
        const { results, rateLimited: rl, exhausted } = await searchTomTom({
          niche: nicheTerm, country, city: cityName,
          limit: TOMTOM_PAGE_SIZE, offset, tomtomCallCounter,
        });

        if (rl) { rateLimited = true; break; }

        const pageParsed = results.map(parseTomTomResult).filter(b => !!b.website);

        for (const biz of pageParsed) {
          if (candidates.length >= poolCap) break;
          let domain;
          try { domain = new URL(biz.website).hostname.replace(/^www\./, ''); } catch { continue; }
          if (seenDomains.has(domain)) continue;
          seenDomains.add(domain);
          candidates.push(biz);
        }

        updateProgress(`Searching "${nicheTerm}" in ${cityName}… ${candidates.length} candidates`);
        console.log(`[SmartSearch] TomTom "${nicheTerm}" × "${cityName}" p${page+1}: ${results.length} raw → ${pageParsed.length} with site → pool=${candidates.length}`);

        if (exhausted || results.length < TOMTOM_PAGE_SIZE) break;
      }
    }
  }

  return { candidates, tomtomCallCount: tomtomCallCounter.count, rateLimited };
}

// ── Step 3: evaluateLeadsAgainstCriteria ─────────────────────────────────────

async function evaluateLeadsAgainstCriteria(criteria, candidates, threshold) {
  function pickSignals(s) {
    if (!s) return {};
    return {
      hasSSL:            s.hasSSL,
      sslError:          s.sslError || false,
      hasMobileViewport: s.hasMobileViewport,
      copyrightYear:     s.copyrightYear,
      doctype:           s.isHtml5 === false ? 'HTML4/XHTML' : s.isHtml5 === true ? 'HTML5' : null,
      jqueryVersion:     s.jqueryVersion,
      usesTableLayout:   s.usesTableLayout,
      hasDeprecatedTags: s.hasDeprecatedTags,
      hasMediaQueries:   s.hasMediaQueries,
    };
  }

  if (!criteria || !criteria.trim()) {
    return candidates.map(c => ({
      company: c.company, website: c.website,
      score: 100, match: true, reason: 'No specific criteria — all leads accepted.',
      signals: pickSignals(c.signals),
    }));
  }

  const systemPrompt = `You are a lead-quality scorer for a B2B lead-generation tool.

You receive a JSON array of candidate businesses with factual website signals.
Score each candidate 0-100 against the given criterion.

Scoring guidance for "outdated website" criteria:
  sslError=true              → +20  (invalid or expired SSL certificate — strong outdated signal)
  hasSSL=false               → +10  (plain HTTP site, no HTTPS)
  usesTableLayout=true       → +25  (strong outdated evidence)
  hasDeprecatedTags=true     → +20  (font/center/marquee tags)
  jqueryVersion starts 1.x   → +15  (old jQuery)
  hasMobileViewport=false    → +20  (no responsive design)
  doctype=HTML4/XHTML        → +15  (old doctype; isHtml5=false)
  usesFlash=true             → +20  (extremely outdated)
  copyrightYear ≤ now-3      → +10  (not recently updated)
  hasModernFramework=true    → −30  (modern framework present)
  siteUnreachable=true       → score 20 (insufficient data)

Do NOT treat hasModernFramework=false alone as evidence of outdated design.

Rules:
- Return a JSON array, one object per candidate (same order), each with:
    { "index": <0-based int>, "score": <0-100 int>, "reason": "<one sentence citing actual signal values>" }
- The reason MUST cite specific signal values (e.g. "expired SSL certificate, no viewport meta, jQuery 1.7").
- Respond ONLY with the JSON array.`;

  const results = [];

  for (let cs = 0; cs < candidates.length; cs += EVAL_CHUNK_SIZE) {
    const chunk = candidates.slice(cs, cs + EVAL_CHUNK_SIZE);
    const userPrompt = `Criterion: "${criteria}"\n\nCandidates:\n${
      JSON.stringify(chunk.map((c, i) => ({ index: i, company: c.company, website: c.website, signals: c.signals })), null, 2)
    }`;

    let evaluated = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const raw = await askAI(systemPrompt, userPrompt, { jsonMode: true });
        if (!Array.isArray(raw)) throw new Error('non-array');
        if (raw.length !== chunk.length) throw new Error(`length mismatch ${raw.length}≠${chunk.length}`);
        for (const item of raw) {
          if (typeof item.index !== 'number' || typeof item.score !== 'number')
            throw new Error('malformed item');
        }
        evaluated = raw;
        break;
      } catch (err) {
        if (attempt === 1) {
          const delay = err.message?.includes('429') ? EVAL_RETRY_DELAY_MS : 500;
          console.warn(`[SmartSearch] Eval chunk attempt 1 failed: ${err.message}. Retry in ${delay}ms`);
          await sleep(delay);
        } else {
          console.error(`[SmartSearch] Eval chunk at ${cs} failed after 2 attempts:`, err.message);
          evaluated = chunk.map((_, i) => ({ index: i, score: 0, reason: 'Evaluation failed.' }));
        }
      }
    }

    for (const item of evaluated) {
      const c = chunk[item.index];
      if (!c) continue;
      const score = Math.max(0, Math.min(100, Math.round(item.score)));
      const match = score >= threshold;
      const tag   = match ? '✓ MATCH' : '✗ reject';
      console.log(`[SmartSearch]   ${tag}  score=${score}  ${c.company}  ${c.website}`);
      console.log(`[SmartSearch]          reason: ${item.reason || '—'}`);
      results.push({
        company: c.company, website: c.website,
        score, match, reason: item.reason || '',
        signals: pickSignals(c.signals),
      });
    }

    if (cs + EVAL_CHUNK_SIZE < candidates.length) await sleep(EVAL_CHUNK_DELAY_MS);
  }

  return results;
}

// ── Step 4: runSmartSearch orchestrator ──────────────────────────────────────

async function runSmartSearch({ projectId, instructionText, leadsCount, strictness, updateJob, cancelFlag }) {
  const update      = typeof updateJob === 'function' ? updateJob : () => {};
  const isCancelled = () => cancelFlag?.cancelled === true;
  const threshold   = STRICTNESS_THRESHOLDS[strictness] ?? STRICTNESS_THRESHOLDS.normal;

  const jobStart  = Date.now();
  const elapsed   = () => Math.round((Date.now() - jobStart) / 1000);
  const budgetHit = () => (Date.now() - jobStart) >= SMART_SEARCH_MAX_MS;

  console.log(`[SmartSearch] ── Starting pipeline ──────────────────────────────────`);
  console.log(`[SmartSearch] project:${projectId} | leadsCount:${leadsCount} | strictness:${strictness}(≥${threshold})`);
  console.log(`[SmartSearch] instruction: "${instructionText}"`);

  // ── Pre-load project domains for deduplication ──────────────────────────
  const existingBatches  = await Batch.find({ projectId }, '_id');
  const existingBatchIds = existingBatches.map(b => b._id);
  const projectDomains   = new Set();
  const projectEmails    = new Set();
  if (existingBatchIds.length > 0) {
    const existing = await Lead.find(
      { batchId: { $in: existingBatchIds }, email: { $exists: true, $ne: '' } }, 'email website',
    ).lean();
    for (const l of existing) {
      if (l.email)   projectEmails.add(l.email.toLowerCase().trim());
      if (l.website) {
        try { projectDomains.add(new URL(l.website).hostname.replace(/^www\./, '')); } catch {}
      }
    }
    console.log(`[SmartSearch] Pre-loaded ${projectDomains.size} project domains, ${projectEmails.size} emails for dedup`);
  }

  // ════════════════════════════════════════════════════════════════════════
  // Stage 1: ANALYZING
  // ════════════════════════════════════════════════════════════════════════
  update({ stage: 'analyzing', progress: { stage: 'analyzing', detail: 'Parsing your instruction with AI…' } });

  let parsed;
  try { parsed = await parseSmartSearchInstruction(instructionText); }
  catch (err) { throw new Error(`AI parsing failed: ${err.message}`); }

  if (!parsed.country) {
    throw new Error(
      'Please mention a country or a recognizable city in your instruction ' +
      '(e.g. "in Germany" or "in Frankfurt"). Without a location the search cannot be targeted.'
    );
  }

  const { country, city, niche, criteria, nicheTerms, cities } = parsed;
  const searchCities = city ? [city] : (cities || FALLBACK_CITIES['germany']);

  console.log(`[SmartSearch] Parsed: country=${country} city=${city} niche=${niche} criteria=${criteria}`);
  console.log(`[SmartSearch] nicheTerms: [${nicheTerms.join(', ')}]`);
  console.log(`[SmartSearch] searchCities: [${searchCities.join(', ')}]`);

  update({
    parsedParams: { country, city, niche, criteria, leadsCount, nicheTerms, cities: searchCities },
    progress: { stage: 'analyzing', detail: `Will search ${nicheTerms.length} terms × ${searchCities.length} cities` },
  });

  // ════════════════════════════════════════════════════════════════════════
  // Stage 2: SEARCHING
  // ════════════════════════════════════════════════════════════════════════
  const tomtomCallCounter = { count: 0 };
  update({ stage: 'searching', progress: { stage: 'searching', detail: 'Searching TomTom…' } });

  const { candidates, rateLimited: searchRateLimited } = await collectCandidates({
    nicheTerms, searchCities, country, leadsCount,
    projectDomains, tomtomCallCounter,
    isCancelled, budgetHit,
    updateProgress: (detail) => update({ progress: { stage: 'searching', detail, candidatesFound: 0 } }),
  });

  console.log(`[SmartSearch] Searching done in ${elapsed()}s | ${candidates.length} candidates | ${tomtomCallCounter.count} TomTom calls`);
  update({ progress: { stage: 'searching', detail: `Found ${candidates.length} candidates`, candidatesFound: candidates.length } });

  let stoppedEarlyReason = searchRateLimited ? 'rate_limit' : null;

  if (candidates.length === 0 || isCancelled()) {
    const reason = isCancelled() ? 'cancelled' : (stoppedEarlyReason || 'no_candidates');
    update({ results: [], summary: {
      candidatesFound: 0, homepagesChecked: 0, passedPrefilter: 0,
      withEmail: 0, matched: 0, tomtomCallCount: tomtomCallCounter.count,
      stoppedEarlyReason: reason, fetchErrorCounts: {}, totalElapsedSec: elapsed(),
    }});
    return;
  }

  // ════════════════════════════════════════════════════════════════════════
  // Stage 3: CHECKING — homepage fetch → signals → pre-filter → email scrape
  // ════════════════════════════════════════════════════════════════════════
  update({ stage: 'checking', progress: {
    stage: 'checking', detail: `Checking ${candidates.length} homepages…`,
    total: candidates.length, homepagesChecked: 0, passedPrefilter: 0,
  }});

  const applyOutdatedFilter = isOutdatedCriteria(criteria);
  const seenEmails          = new Set();
  const withEmail           = [];  // { biz, signals, email, fetchError? }
  const fetchErrorCounts    = {};  // { code: count }

  let homepagesChecked = 0;
  let passedPrefilter  = 0;

  for (let bStart = 0; bStart < candidates.length; bStart += HOMEPAGE_CONCURRENCY) {
    if (isCancelled() || budgetHit()) {
      stoppedEarlyReason = isCancelled() ? 'cancelled' : 'time_limit';
      console.log(`[SmartSearch] Checking stopped: ${stoppedEarlyReason} at ${elapsed()}s`);
      break;
    }

    const bSlice = candidates.slice(bStart, bStart + HOMEPAGE_CONCURRENCY);

    // 3a: fetch all homepages in parallel (using retry ladder)
    const fetches = await runInBatches(
      bSlice.map(biz => () => fetchPageWithRetry(biz.website)),
      HOMEPAGE_CONCURRENCY,
    );
    homepagesChecked += bSlice.length;

    // Identify survivors (pre-filter)
    const survivors = [];
    for (let i = 0; i < bSlice.length; i++) {
      const biz     = bSlice[i];
      const fetched = fetches[i] || null;
      const signals = extractSignalsFromHtml(fetched);

      // Record fetch errors
      if (fetched && fetched.fetchError) {
        const code = fetched.fetchError.code;
        fetchErrorCounts[code] = (fetchErrorCounts[code] || 0) + 1;
      }

      // 3b: pre-filter
      if (applyOutdatedFilter && !passesOutdatedPrefilter(signals)) {
        console.log(`[SmartSearch] Pre-filter DROP: ${biz.website} (modern site)`);
        continue;
      }
      passedPrefilter++;
      survivors.push({ biz, fetched, signals });
    }

    // 3c: scrape emails for survivors
    const emailJobs = survivors.map(({ biz, fetched, signals }) => async () => {
      const email = await scrapeContactEmails(biz.website, fetched);
      return { biz, signals, email, fetchError: fetched?.fetchError || null };
    });
    const emailResults = await runInBatches(emailJobs, EMAIL_CONCURRENCY);

    for (const r of emailResults) {
      if (!r || !r.email) continue;
      const norm = r.email.toLowerCase().trim();
      if (projectEmails.has(norm) || seenEmails.has(norm)) continue;
      seenEmails.add(norm);
      withEmail.push({ biz: r.biz, signals: r.signals, email: norm, fetchError: r.fetchError });
    }

    update({ progress: {
      stage: 'checking',
      detail: `Checked ${homepagesChecked} of ${candidates.length} | ${passedPrefilter} passed filter | ${withEmail.length} with email`,
      total: candidates.length, homepagesChecked, passedPrefilter, withEmail: withEmail.length,
    }});
    console.log(`[SmartSearch] Checked ${homepagesChecked}/${candidates.length} | prefilter=${passedPrefilter} | withEmail=${withEmail.length} | ${elapsed()}s | errors=${JSON.stringify(fetchErrorCounts)}`);
  }

  console.log(`[SmartSearch] Checking done in ${elapsed()}s | homepages=${homepagesChecked} prefilter=${passedPrefilter} email=${withEmail.length}`);
  console.log(`[SmartSearch] Fetch error counts: ${JSON.stringify(fetchErrorCounts)}`);

  // ════════════════════════════════════════════════════════════════════════
  // Stage 4: FILTERING — AI scoring
  // ════════════════════════════════════════════════════════════════════════
  update({ stage: 'filtering', progress: {
    stage: 'filtering',
    detail: `Scoring ${withEmail.length} candidates with AI (strictness: ${strictness})…`,
    total: withEmail.length,
  }});

  const matchedLeads  = [];
  const rejectedLeads = [];

  if (withEmail.length > 0 && !isCancelled() && !budgetHit()) {
    const evalCandidates = withEmail.map(({ biz, signals }) => ({
      company: biz.name, website: biz.website, signals,
    }));

    const evalResults = await evaluateLeadsAgainstCriteria(criteria, evalCandidates, threshold);

    // Sort by score descending
    const sorted = evalResults.map((ev, i) => ({ ev, i })).sort((a, b) => b.ev.score - a.ev.score);

    for (const { ev, i } of sorted) {
      const { biz, email, fetchError } = withEmail[i];
      if (ev.match) {
        matchedLeads.push({
          company: biz.name, city: biz.city || city || country,
          website: biz.website, email, niche, score: ev.score, reason: ev.reason,
        });
        update({ results: [...matchedLeads] });
        if (matchedLeads.length >= leadsCount) break;
      } else if (rejectedLeads.length < 40) {
        rejectedLeads.push({
          company: biz.name, city: biz.city || city || country,
          website: biz.website, email, niche, score: ev.score, reason: ev.reason,
          signals:    ev.signals || {},
          fetchError: fetchError || null,
        });
      }
    }
  } else if (isCancelled() || budgetHit()) {
    stoppedEarlyReason = isCancelled() ? 'cancelled' : 'time_limit';
  }

  console.log(`[SmartSearch] Filtering done in ${elapsed()}s | ${matchedLeads.length} matches / ${withEmail.length} evaluated | ${rejectedLeads.length} rejected`);

  const finalReason = stoppedEarlyReason === 'time_limit' ? 'Time limit reached' : stoppedEarlyReason;

  const summary = {
    candidatesFound:    candidates.length,
    homepagesChecked,
    passedPrefilter,
    withEmail:          withEmail.length,
    matched:            matchedLeads.length,
    rejected:           rejectedLeads.length,
    threshold,
    fetchErrorCounts,
    tomtomCallCount:    tomtomCallCounter.count,
    stoppedEarlyReason: finalReason,
    totalElapsedSec:    elapsed(),
  };

  update({ results: matchedLeads, rejected: rejectedLeads, summary });

  console.log(`[SmartSearch] ── Pipeline complete in ${elapsed()}s ──────────────────`);
  console.log('[SmartSearch]', JSON.stringify(summary, null, 2));
}

module.exports = {
  parseSmartSearchInstruction,
  collectCandidates,
  extractSignalsFromHtml,
  passesOutdatedPrefilter,
  evaluateLeadsAgainstCriteria,
  runSmartSearch,
};
