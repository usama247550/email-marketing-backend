/**
 * services/nicheResolver.js
 *
 * Resolves an English niche name (possibly with typos) into one or more
 * local-language search terms suitable for TomTom POI search.
 *
 * Public API:
 *   resolveNicheTerms(nicheText, country)
 *     → { original, normalized, terms: string[], source: 'builtin'|'cache'|'ai'|'fallback' }
 *
 * Resolution order:
 *   1. Normalize (trim, lowercase, collapse spaces)
 *   2. Correct typos via built-in Levenshtein match (distance ≤ 2) against dictionary keys
 *   3. Look up in the built-in dictionary for DACH countries
 *   4. If not found: check MongoDB cache
 *   5. If not cached: call AI (25 s timeout, jsonMode)
 *   6. On any failure: fallback to [original niche text]
 *
 * English-speaking countries get the normalized English term, no AI.
 *
 * The Lead.niche field always stores the ORIGINAL English niche the user typed.
 * Only the TomTom search uses the translated terms.
 */

'use strict';

const { askAI }          = require('./aiService');
const NicheTranslation   = require('../models/NicheTranslation');

// ── Country helpers ───────────────────────────────────────────────────────────

/** Countries whose primary language is English — skip translation entirely. */
const ENGLISH_COUNTRIES = new Set([
  'united states', 'usa', 'united kingdom', 'uk', 'england', 'australia',
  'new zealand', 'canada', 'ireland', 'south africa', 'singapore',
  'jamaica', 'trinidad and tobago', 'malta', 'belize', 'barbados',
  'the bahamas', 'bahamas', 'guyana', 'kenya', 'ghana', 'nigeria',
  'zimbabwe', 'zambia', 'botswana', 'namibia', 'uganda', 'tanzania',
  'papua new guinea',
]);

/** DACH = Germany, Austria, Switzerland — use the built-in German dictionary. */
const DACH_COUNTRIES = new Set([
  'germany', 'deutschland', 'austria', 'österreich', 'oesterreich',
  'switzerland', 'schweiz', 'suisse',
]);

function normalizeName(s) {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isDACH(country) {
  return DACH_COUNTRIES.has(normalizeName(country));
}

function isEnglish(country) {
  return ENGLISH_COUNTRIES.has(normalizeName(country));
}

// ── Levenshtein distance (bounded) ────────────────────────────────────────────

/**
 * Returns the Levenshtein edit distance between a and b.
 * Early-exits when the distance exceeds maxDist to save CPU.
 */
function levenshtein(a, b, maxDist = 3) {
  const la = a.length, lb = b.length;
  if (Math.abs(la - lb) > maxDist) return maxDist + 1;
  // DP row
  let prev = Array.from({ length: lb + 1 }, (_, i) => i);
  for (let i = 1; i <= la; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v    = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      curr.push(v);
      if (v < rowMin) rowMin = v;
    }
    // Prune: if the minimum value in this row already exceeds maxDist
    // no future row can produce a smaller distance
    if (rowMin > maxDist) return maxDist + 1;
    prev = curr;
  }
  return prev[lb];
}

// ── Built-in German dictionary ────────────────────────────────────────────────
// Keys are normalized English terms; values are arrays of German TomTom search words.
// Terms are ordered most-useful-first.

const GERMAN_DICT = {
  // Food & Drink
  'restaurant':         ['Restaurant', 'Gasthaus', 'Gaststätte'],
  'restaurants':        ['Restaurant', 'Gasthaus', 'Gaststätte'],
  'cafe':               ['Café', 'Kaffeehaus', 'Coffee Shop'],
  'coffee shop':        ['Café', 'Kaffeehaus', 'Coffee Shop'],
  'bakery':             ['Bäckerei', 'Konditorei'],
  'pizzeria':           ['Pizzeria'],
  'bar':                ['Bar', 'Kneipe', 'Bistro'],
  'pub':                ['Kneipe', 'Bar', 'Wirtshaus'],
  'butcher':            ['Metzgerei', 'Fleischerei'],
  'butcher shop':       ['Metzgerei', 'Fleischerei'],

  // Trades
  'electrician':        ['Elektriker', 'Elektroinstallateur', 'Elektrobetrieb'],
  'plumber':            ['Klempner', 'Sanitär', 'Installateur'],
  'painter':            ['Maler', 'Malermeister'],
  'roofer':             ['Dachdecker'],
  'carpenter':          ['Tischler', 'Schreiner'],
  'carpenter shop':     ['Tischlerei', 'Schreinerei'],
  'cleaning service':   ['Reinigungsfirma', 'Gebäudereinigung'],
  'cleaning':           ['Reinigungsfirma', 'Gebäudereinigung'],

  // Health & Beauty
  'dentist':            ['Zahnarzt', 'Zahnarztpraxis'],
  'dental office':      ['Zahnarztpraxis', 'Zahnarzt'],
  'hairdresser':        ['Friseur', 'Friseursalon'],
  'hair salon':         ['Friseur', 'Friseursalon'],
  'barbershop':         ['Friseur', 'Barbershop'],
  'beauty salon':       ['Kosmetikstudio', 'Schönheitssalon'],
  'nail studio':        ['Nagelstudio'],
  'nail salon':         ['Nagelstudio'],
  'tanning salon':      ['Sonnenstudio', 'Solarium'],
  'solarium':           ['Solarium', 'Sonnenstudio'],
  'wellness center':    ['Wellnesscenter', 'Massagepraxis'],
  'wellness':           ['Wellnesscenter', 'Massagepraxis'],
  'spa':                ['Day Spa', 'Wellness', 'Massagepraxis'],
  'massage':            ['Massagepraxis', 'Massagestudio'],
  'fitness':            ['Fitnessstudio'],
  'gym':                ['Fitnessstudio', 'Turnhalle'],
  'fitness studio':     ['Fitnessstudio'],
  'women fitness':      ['Frauenfitness'],
  "women's fitness":    ['Frauenfitness'],
  'physiotherapy':      ['Physiotherapie', 'Physiotherapeut'],
  'physical therapy':   ['Physiotherapie', 'Physiotherapeut'],
  'tattoo studio':      ['Tattoostudio', 'Tattoo Studio'],
  'tattoo shop':        ['Tattoostudio', 'Tattoo Studio'],
  'tattoo':             ['Tattoostudio', 'Tattoo Studio'],
  'pharmacy':           ['Apotheke'],
  'optician':           ['Optiker'],
  'eye doctor':         ['Augenarzt', 'Optiker'],

  // Jewelry & Valuables
  'jewelry store':      ['Juwelier', 'Schmuckgeschäft'],
  'jeweler':            ['Juwelier', 'Schmuckgeschäft'],
  'jewellery':          ['Juwelier', 'Schmuckgeschäft'],
  'goldsmith':          ['Goldschmied'],
  'coin dealer':        ['Münzhändler', 'Münzen'],
  'coin shop':          ['Münzhändler', 'Münzen'],
  'pawn shop':          ['Pfandleihhaus', 'Pfandhaus'],
  'antique dealer':     ['Antiquitätenhändler', 'Antiquitäten'],
  'antiques':           ['Antiquitäten', 'Antiquitätenladen'],
  'gold buyer':         ['Goldankauf'],
  'auction house':      ['Auktionshaus'],
  'auction':            ['Auktionshaus'],
  'metal detector shop':['Metalldetektor'],
  'safe deposit':       ['Schließfach', 'Tresor'],
  'safe':               ['Tresor', 'Safe'],

  // Professional Services
  'lawyer':             ['Rechtsanwalt', 'Anwaltskanzlei'],
  'attorney':           ['Rechtsanwalt', 'Anwaltskanzlei'],
  'law firm':           ['Anwaltskanzlei', 'Rechtsanwalt'],
  'accountant':         ['Steuerberater'],
  'tax advisor':        ['Steuerberater'],
  'real estate agent':  ['Immobilienmakler'],
  'real estate':        ['Immobilienmakler'],
  'photographer':       ['Fotograf', 'Fotostudio'],
  'driving school':     ['Fahrschule'],
  'web design agency':  ['Webdesign Agentur', 'Webagentur'],
  'web agency':         ['Webagentur', 'Webdesign Agentur'],

  // Retail
  'florist':            ['Blumengeschäft', 'Florist'],
  'flower shop':        ['Blumengeschäft', 'Florist'],
  'hotel':              ['Hotel'],

  // Automotive
  'car repair':         ['Autowerkstatt', 'KFZ-Werkstatt'],
  'auto repair':        ['Autowerkstatt', 'KFZ-Werkstatt'],
  'car dealer':         ['Autohaus'],
  'car dealership':     ['Autohaus'],
};

// Pre-computed sorted list of dictionary keys for Levenshtein search
const DICT_KEYS = Object.keys(GERMAN_DICT).sort();

// ── Typo correction ───────────────────────────────────────────────────────────

/**
 * Find the closest dictionary key to `normalized` within edit distance maxDist.
 * Returns the best-matching key or null.
 */
function correctTypo(normalized, maxDist = 2) {
  let best = null, bestDist = maxDist + 1;
  for (const key of DICT_KEYS) {
    const d = levenshtein(normalized, key, maxDist);
    if (d < bestDist) {
      bestDist = d;
      best     = key;
      if (d === 0) break; // exact match
    }
  }
  return bestDist <= maxDist ? best : null;
}

// ── AI call ───────────────────────────────────────────────────────────────────

const AI_TIMEOUT_MS = 25_000;

async function fetchTermsFromAI(niche, country, askAIImpl = askAI, timeoutMs = AI_TIMEOUT_MS) {
  const systemPrompt =
    'You are a multilingual business-category expert. ' +
    'Given a business type and a country, return the correct English spelling (if the input has a typo) ' +
    'and up to 3 short search words in the main local language(s) of that country that a mapping/POI service ' +
    'would match for this business type. Prefer the most-used local words first. ' +
    'Return ONLY a JSON object with one key "terms" whose value is an array of 1–3 short strings. ' +
    'No explanations, no sentences — only short noun/trade words.';

  const userPrompt =
    `Business type: "${niche}"\nCountry: "${country}"\n` +
    'Respond with JSON like: {"terms":["Elektriker","Elektrobetrieb"]}';

  // Wrap askAI in a race against a tight timeout
  let timeoutHandle;
  let result;
  try {
    result = await Promise.race([
      askAIImpl(systemPrompt, userPrompt, { jsonMode: true }),
      new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`AI call timed out after ${timeoutMs} ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeoutHandle);
  }

  // Validate the response
  if (!result || !Array.isArray(result.terms)) throw new Error('AI returned invalid shape');
  const seenTerms = new Set();
  const terms = [];
  for (const value of result.terms) {
    if (typeof value !== 'string') continue;
    const term = value.trim();
    if (term.length < 2 || term.length > 40) continue;
    if (term.split(/\s+/).length > 4) continue;
    if (/[.!?:;]/.test(term)) continue;
    const dedupeKey = term.toLocaleLowerCase();
    if (seenTerms.has(dedupeKey)) continue;
    seenTerms.add(dedupeKey);
    terms.push(term);
    if (terms.length === 3) break;
  }
  if (terms.length === 0) throw new Error('AI returned empty terms array');
  return terms;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Resolve niche text to a list of TomTom-friendly search terms.
 *
 * @param {string} nicheText   Raw niche as the user typed it.
 * @param {string} country     Country name as selected by the user.
 * @returns {Promise<{
 *   original:   string,
 *   normalized: string,
 *   terms:      string[],
 *   source:     'builtin'|'cache'|'ai'|'fallback',
 * }>}
 */
function createNicheResolver({ askAI: askAIImpl = askAI, cache = NicheTranslation, timeoutMs = AI_TIMEOUT_MS } = {}) {
  async function resolveNicheTerms(nicheText, country) {
  const original   = nicheText;
  const normalized = normalizeName(nicheText);

  // ── 1. English-speaking country — no translation ─────────────────────────
  if (isEnglish(country)) {
    const terms = [normalized];
    console.log(`[NicheResolver] "${original}" (${country}) → ${JSON.stringify(terms)} [english]`);
    return { original, normalized, terms, source: 'builtin' };
  }

  // ── 2. DACH: try built-in dictionary (with typo correction) ─────────────
  if (isDACH(country)) {
    // Exact match first
    if (GERMAN_DICT[normalized]) {
      const terms = GERMAN_DICT[normalized];
      console.log(`[NicheResolver] "${original}" → ${JSON.stringify(terms)} [builtin:exact]`);
      return { original, normalized, terms, source: 'builtin' };
    }
    // Typo correction
    const corrected = correctTypo(normalized);
    if (corrected && GERMAN_DICT[corrected]) {
      const terms = GERMAN_DICT[corrected];
      console.log(`[NicheResolver] "${original}" → corrected to "${corrected}" → ${JSON.stringify(terms)} [builtin:typo]`);
      return { original, normalized, terms, source: 'builtin' };
    }
    // Fall through to AI (some niche not in dictionary)
  }

  // ── 3. MongoDB cache ─────────────────────────────────────────────────────
  const cacheKey = `${normalizeName(country)}:${normalized}`;
  try {
    const cached = await cache.findOne({ key: cacheKey }).lean();
    if (cached && Array.isArray(cached.terms) && cached.terms.length > 0) {
      console.log(`[NicheResolver] "${original}" (${country}) → ${JSON.stringify(cached.terms)} [cache]`);
      return { original, normalized, terms: cached.terms, source: 'cache' };
    }
  } catch (dbErr) {
    console.warn(`[NicheResolver] Cache read failed for "${cacheKey}": ${dbErr.message}`);
  }

  // ── 4. AI call ───────────────────────────────────────────────────────────
  try {
    const terms = await fetchTermsFromAI(normalized, country, askAIImpl, timeoutMs);
    // Save to cache (best-effort; don't throw on failure)
    try {
      await cache.findOneAndUpdate(
        { key: cacheKey },
        { key: cacheKey, niche: normalized, country, terms, source: 'ai', createdAt: new Date() },
        { upsert: true, new: true },
      );
    } catch (saveErr) {
      console.warn(`[NicheResolver] Cache save failed for "${cacheKey}": ${saveErr.message}`);
    }
    console.log(`[NicheResolver] "${original}" (${country}) → ${JSON.stringify(terms)} [ai]`);
    return { original, normalized, terms, source: 'ai' };
  } catch (aiErr) {
    // ── 5. Fallback ──────────────────────────────────────────────────────
    console.warn(`[NicheResolver] AI failed for "${original}" (${country}): ${aiErr.message} — falling back to original text`);
    return { original, normalized, terms: [original], source: 'fallback' };
  }
  }

  return resolveNicheTerms;
}

const resolveNicheTerms = createNicheResolver();

module.exports = {
  resolveNicheTerms,
  createNicheResolver,
  // Exposed for testing
  levenshtein,
  correctTypo,
  normalizeName,
  isDACH,
  isEnglish,
  GERMAN_DICT,
};
