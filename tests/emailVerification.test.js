'use strict';

if (Object.prototype.hasOwnProperty.call(process.env, 'MONGODB_URI')) {
  throw new Error('Refusing to run while MONGODB_URI is set.');
}

const assert = require('node:assert/strict');
const {
  domainFromWebsite,
  emailDomain,
  domainsRelated,
} = require('../services/emailVerification');

let checks = 0;
function check(label, fn) {
  fn();
  checks += 1;
  console.log(`PASS ${label}`);
}

check('domainFromWebsite strips www', () => {
  assert.equal(domainFromWebsite('https://www.dental.de/kontakt'), 'dental.de');
});

check('domainsRelated matches subdomains', () => {
  assert.equal(domainsRelated('dental.de', 'mail.dental.de'), true);
  assert.equal(domainsRelated('dental.de', 'other.com'), false);
});

check('emailDomain parses address', () => {
  assert.equal(emailDomain('Owner@Dental.DE'), 'dental.de');
});

console.log(`\n${checks} email verification checks passed.`);