'use strict';

// No database, no TomTom, no AI, no website requests.
if (Object.prototype.hasOwnProperty.call(process.env, 'MONGODB_URI')) {
  throw new Error('Refusing to run while MONGODB_URI is set.');
}

const assert = require('node:assert/strict');
const {
  citiesForCountry,
  GERMANY_CITIES,
  USA_CITIES,
  detectWebsiteIssue,
  collectForNiche,
} = require('../services/leadFinderService');
const { findUnknownVariables, replaceTemplateVariables } = require('../services/templateVariables');

let checks = 0;
function check(label, fn) {
  fn();
  checks += 1;
  console.log(`PASS ${label}`);
}

check('Germany still uses the German city list', () => {
  assert.equal(citiesForCountry('Germany'), GERMANY_CITIES);
  assert.equal(citiesForCountry('Deutschland'), GERMANY_CITIES);
});

check('United States uses the US city list', () => {
  const cities = citiesForCountry('United States');
  assert.equal(cities, USA_CITIES);
  assert.equal(cities[0].name, 'New York');
  assert.ok(cities.length >= 20);
});

check('a country without a city list is not rotated', () => {
  assert.equal(citiesForCountry('France'), null);
});

check('missing https is reported first', () => {
  const html = '<html><head><meta name="viewport" content="width=device-width"><title>Shop</title><meta name="description" content="Local shop"></head></html>';
  assert.match(detectWebsiteIssue(html, 'http://shop.example'), /https/);
});

check('a desktop-only page is reported', () => {
  const html = '<html><head><title>Shop</title><meta name="description" content="Local shop"></head></html>';
  assert.match(detectWebsiteIssue(html, 'https://shop.example'), /phone/);
});

check('a page with no description is an SEO issue', () => {
  const html = '<html><head><meta name="viewport" content="width=device-width"><title>Shop</title></head></html>';
  assert.match(detectWebsiteIssue(html, 'https://shop.example'), /description/);
});

check('a healthy page gets a safe line, not a made-up defect', () => {
  const year = new Date().getFullYear();
  const html = `<html><head><meta name="viewport" content="width=device-width"><title>Shop</title><meta name="description" content="Local shop"></head><body>Copyright ${year}</body></html>`;
  assert.match(detectWebsiteIssue(html, 'https://shop.example'), /local customers/);
});

check('websiteIssue is an allowed template tag', () => {
  assert.deepEqual(findUnknownVariables('{{websiteIssue}}', ''), []);
  assert.equal(
    replaceTemplateVariables('I noticed {{websiteIssue}}.', { websiteIssue: 'your site is difficult to use on a phone' }, {}),
    'I noticed your site is difficult to use on a phone.'
  );
});

(async () => {
  const calls = [];
  const counter = { count: 0 };
  await collectForNiche({
    niche: 'dentist',
    city: '',
    country: 'United States',
    poolTarget: 1,
    seenDomains: new Set(),
    nicheState: {
      niche: 'dentist', terms: ['dentist'], termIdx: 0, termOffsets: {}, termCityIdx: {},
      termCityOffsets: {}, termExhaustedCities: {}, deadTerms: new Set(),
      termConsecZeros: new Map(), exhaustedCities: new Set(), cityOffsets: {},
      cityIdx: 0, offset: 0, coords: null, exhausted: false,
    },
    tomtomCallCounter: counter,
    isAllCitiesGermany: false,
    cityList: USA_CITIES,
    cancelFlag: { cancelled: false },
    runStart: Date.now(),
    citiesCoveredMap: new Map(),
    maxCalls: 2,
    searchTomTomByCoordFn: async (args) => {
      calls.push({ country: args.country, lat: args.lat, lon: args.lon, niche: args.niche });
      return {
        results: [{ poi: { name: 'Smile Dental', url: 'https://smile.example' }, address: { municipality: 'New York' } }],
        rateLimited: false,
        exhausted: false,
      };
    },
  });

  check('all-cities USA asks TomTom for a US city, not Germany', () => {
    assert.equal(calls.length, 1);
    assert.equal(calls[0].country, 'United States');
    assert.equal(calls[0].niche, 'dentist');
    assert.equal(calls[0].lat, USA_CITIES[0].lat);
    assert.equal(calls[0].lon, USA_CITIES[0].lon);
    assert.equal(counter.count, 0);
  });

  console.log(`\n${checks} USA finder checks passed.`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
