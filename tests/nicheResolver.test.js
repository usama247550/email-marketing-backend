'use strict';

// Isolated unit tests: no dotenv, mongoose connection, database, AI, TomTom, or website requests.
if (Object.prototype.hasOwnProperty.call(process.env, 'MONGODB_URI')) {
  throw new Error('Refusing to run niche resolver tests while MONGODB_URI is set.');
}

const assert = require('node:assert/strict');
const { createNicheResolver } = require('../services/nicheResolver');
const { collectForNiche, runMultiNicheSearch, releaseLeadFinderLock, TOMTOM_PAGE_SIZE } = require('../services/leadFinderService');

function makeCache() {
  const entries = new Map();
  return {
    entries,
    findOne({ key }) {
      return { lean: async () => entries.get(key) || null };
    },
    async findOneAndUpdate({ key }, value) {
      entries.set(key, value);
      return value;
    },
  };
}

function makeState(terms, coords = { lat: 52.52, lon: 13.405 }) {
  return {
    niche: 'test niche', terms, termIdx: 0, termOffsets: {}, termCityIdx: {},
    termCityOffsets: {}, termExhaustedCities: {}, deadTerms: new Set(),
    termConsecZeros: new Map(), exhaustedCities: new Set(), cityOffsets: {},
    cityIdx: 0, offset: 0, coords, exhausted: false,
  };
}

function makeModels(capturedLeads = []) {
  let nextBatchId = 1;
  class FakeBatch {
    constructor(fields) { Object.assign(this, fields); }
    async save() { this._id = { toString: () => `fake-batch-${nextBatchId++}` }; }
    static async find() { return []; }
    static async updateOne() {}
  }
  class FakeLead {
    static async find() { return { lean: async () => [] }; }
    static async insertMany(leads) { capturedLeads.push(...leads); }
  }
  return { Batch: FakeBatch, Lead: FakeLead };
}

async function run() {
  let checks = 0;
  const check = (label, fn) => { fn(); checks++; console.log(`PASS ${label}`); };

  let aiCalls = 0;
  const cache = makeCache();
  const resolver = createNicheResolver({
    cache,
    askAI: async () => { aiCalls++; throw new Error('Unexpected fake AI call'); },
  });

  const electrician = await resolver('Electrician', 'Germany');
  check('(a) Electrician + Germany uses built-in German terms without AI', () => {
    assert.equal(electrician.source, 'builtin');
    assert.deepEqual(electrician.terms, ['Elektriker', 'Elektroinstallateur', 'Elektrobetrieb']);
    assert.equal(aiCalls, 0);
  });

  const typo = await resolver('Resturent', 'Germany');
  check('(b) Resturent resolves to restaurant terms', () => {
    assert.equal(typo.source, 'builtin');
    assert.deepEqual(typo.terms, ['Restaurant', 'Gasthaus', 'Gaststätte']);
  });

  let unknownAiCalls = 0;
  const unknownCache = makeCache();
  const unknownResolver = createNicheResolver({
    cache: unknownCache,
    askAI: async (_system, _user, options) => {
      unknownAiCalls++;
      assert.equal(options.jsonMode, true);
      return { terms: ['Elektriker', ' Elektroinstallateur ', 'ELEKTRIKER'] };
    },
  });
  const aiResolved = await unknownResolver('solar technician', 'Italy');
  const aiCached = await unknownResolver('solar technician', 'Italy');
  check('(c) unknown niche calls fake AI once, caches valid terms, then uses cache', () => {
    assert.equal(unknownAiCalls, 1);
    assert.deepEqual(aiResolved.terms, ['Elektriker', 'Elektroinstallateur']);
    assert.equal(aiResolved.source, 'ai');
    assert.equal(aiCached.source, 'cache');
    assert.equal(unknownCache.entries.size, 1);
  });

  const fallbackScenarios = [
    ['AI failure', async () => { throw new Error('fake AI failure'); }],
    ['AI timeout', () => new Promise(() => {})],
    ['not an array', async () => ({ terms: 'Elektriker' })],
    ['array containing only numbers', async () => ({ terms: [1, 2] })],
    ['empty array', async () => ({ terms: [] })],
    ['sentence output', async () => ({ terms: ['This is a sentence.'] })],
  ];
  for (const [label, fakeAskAI] of fallbackScenarios) {
    const fallbackCache = makeCache();
    const fallbackResolver = createNicheResolver({ cache: fallbackCache, askAI: fakeAskAI, timeoutMs: 8 });
    const fallback = await fallbackResolver(`obscure ${label}`, 'France');
    check(`(d) ${label} falls back without caching or crashing`, () => {
      assert.equal(fallback.source, 'fallback');
      assert.deepEqual(fallback.terms, [`obscure ${label}`]);
      assert.equal(fallbackCache.entries.size, 0);
    });
  }

  let englishAiCalls = 0;
  const english = await createNicheResolver({
    cache: makeCache(), askAI: async () => { englishAiCalls++; return { terms: ['never'] }; },
  })(' Electrician ', 'United Kingdom');
  check('(e) English-speaking country skips translation', () => {
    assert.deepEqual(english.terms, ['electrician']);
    assert.equal(englishAiCalls, 0);
  });

  const deadState = makeState(['ZeroTerm', 'OtherTerm'], null);
  const deadCalls = [];
  const deadCounter = { count: 0 };
  const deadResult = await collectForNiche({
    niche: 'English niche', city: '', country: 'Germany', poolTarget: 20,
    seenDomains: new Set(), nicheState: deadState, tomtomCallCounter: deadCounter,
    isAllCitiesGermany: true, cancelFlag: { cancelled: false }, runStart: Date.now(),
    citiesCoveredMap: new Map(), maxCalls: 8,
    searchTomTomByCoordFn: async ({ niche }) => {
      deadCounter.count++;
      deadCalls.push(niche);
      if (niche === 'ZeroTerm') return { results: [], rateLimited: false, exhausted: true };
      const n = deadCalls.filter(x => x === niche).length;
      return {
        results: [{ poi: { name: `Other ${n}`, url: `https://other${n}.example` }, address: { municipality: 'Berlin' } }],
        rateLimited: false, exhausted: false,
      };
    },
  });
  check('(f) all-cities dead term stops after 3 empty cities and later calls use other term within cap', () => {
    assert.equal(deadState.deadTerms.has('ZeroTerm'), true);
    assert.equal(deadCalls.filter(term => term === 'ZeroTerm').length, 3);
    assert.deepEqual(deadCalls.slice(-2), ['OtherTerm', 'OtherTerm']);
    assert.equal(deadResult.capReached, true);
    assert.ok(deadCounter.count <= 8);
  });

  const singleState = makeState(['EmptyTerm']);
  const singleCounter = { count: 0 };
  await collectForNiche({
    niche: 'English niche', city: 'Berlin', country: 'Germany', poolTarget: 5,
    seenDomains: new Set(), nicheState: singleState, tomtomCallCounter: singleCounter,
    isAllCitiesGermany: false, cancelFlag: { cancelled: false }, runStart: Date.now(),
    citiesCoveredMap: new Map(), maxCalls: 5,
    searchTomTomByCoordFn: async () => {
      singleCounter.count++;
      return { results: [], rateLimited: false, exhausted: true };
    },
  });
  check('(f) single-city term with zero page-one results dies immediately', () => {
    assert.equal(singleState.deadTerms.has('EmptyTerm'), true);
    assert.equal(singleCounter.count, 1);
  });

  async function runFinder({ maxCalls, searchTomTomByCoord, cursor, city = '', leads = [], email }) {
    const models = makeModels(leads);
    const fakeCounter = { count: 0 };
    const summary = await runMultiNicheSearch({
      projectId: 'fake-project', country: 'Germany', city, niches: ['Electrician'],
      totalLeads: 1, cursor, cancelFlag: { cancelled: false }, onProgress: () => {},
      dependencies: {
        ...models,
        getTomTomMaxCalls: () => maxCalls,
        resolveNicheTerms: async original => ({ original, normalized: original.toLowerCase(), terms: ['Elektriker'], source: 'builtin' }),
        geocodeCity: async () => ({ lat: 52.52, lon: 13.405 }),
        searchTomTomByCoord: async args => {
          const result = await searchTomTomByCoord(args, fakeCounter);
          args.tomtomCallCounter.count = fakeCounter.count;
          return result;
        },
        scrapeEmailForSite: async () => email === undefined ? 'owner@example.test' : email,
      },
    });
    return { summary, leads, fakeCounter };
  }

  const capOnly = await runFinder({
    maxCalls: 1,
    searchTomTomByCoord: async (_args, counter) => {
      counter.count++;
      return { results: [], rateLimited: false, exhausted: false };
    },
  });
  check('(g) own call cap produces call_cap', () => assert.equal(capOnly.summary.stopReason, 'call_cap'));

  const realRateLimit = await runFinder({
    maxCalls: 10,
    searchTomTomByCoord: async (_args, counter) => {
      counter.count++;
      return { results: [], rateLimited: true, exhausted: false, status: 403 };
    },
  });
  check('(g) fake HTTP 403 produces rate_limit', () => assert.equal(realRateLimit.summary.stopReason, 'rate_limit'));

  const cityCap = await runFinder({
    maxCalls: 1, city: 'Berlin', email: null,
    searchTomTomByCoord: async (_args, counter) => {
      counter.count++;
      return {
        results: Array.from({ length: TOMTOM_PAGE_SIZE }, (_, i) => ({
          poi: { name: `Result ${i}`, url: 'https://same.example' }, address: { municipality: 'Berlin' },
        })),
        rateLimited: false, exhausted: false,
      };
    },
  });
  check('(g) single-city path reports call_cap for the configured cap', () => assert.equal(cityCap.summary.stopReason, 'call_cap'));

  const cityRateLimit = await runFinder({
    maxCalls: 10, city: 'Berlin',
    searchTomTomByCoord: async (_args, counter) => {
      counter.count++;
      return { results: [], rateLimited: true, exhausted: false, status: 403 };
    },
  });
  check('(g) single-city path reports rate_limit for fake HTTP 403', () => assert.equal(cityRateLimit.summary.stopReason, 'rate_limit'));

  const cursorRun = await runFinder({
    maxCalls: 1,
    cursor: { Electrician: { offset: 5, cityIdx: 2, cityOffsets: { Berlin: 5 }, exhaustedCities: [] } },
    searchTomTomByCoord: async (_args, counter) => {
      counter.count++;
      return { results: [], rateLimited: false, exhausted: false };
    },
  });
  check('(h) old cursor without term data is loaded and upgraded safely', () => {
    assert.equal(cursorRun.summary.endCursor.Electrician.offset, 5);
    assert.deepEqual(cursorRun.summary.endCursor.Electrician.terms, ['Elektriker']);
  });

  const savedLeads = [];
  const leadRun = await runFinder({
    maxCalls: 10,
    city: 'Berlin',
    leads: savedLeads,
    searchTomTomByCoord: async (_args, counter) => {
      counter.count++;
      return {
        results: [{ poi: { name: 'A business', url: 'https://business.example' }, address: { municipality: 'Berlin' } }],
        rateLimited: false, exhausted: false,
      };
    },
  });
  check('(i) persisted Lead.niche remains the original English input', () => {
    assert.equal(leadRun.summary.totalFound, 1);
    assert.equal(savedLeads[0].niche, 'Electrician');
  });

  releaseLeadFinderLock();
  console.log(`\n${checks} mock-only checks passed. No MongoDB, AI, TomTom, or email network calls were made.`);
}

run().catch(error => {
  releaseLeadFinderLock();
  console.error(error);
  process.exitCode = 1;
});
