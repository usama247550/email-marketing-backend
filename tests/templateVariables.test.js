'use strict';

// No database, no Brevo, no network.
const assert = require('node:assert/strict');
const {
  findUnknownVariables,
  replaceTemplateVariables,
  assertTemplateVariables,
} = require('../services/templateVariables');

let checks = 0;
function check(label, fn) {
  fn();
  checks += 1;
  console.log(`PASS ${label}`);
}

check('Brevo-style tag is unknown', () => {
  assert.deepEqual(
    findUnknownVariables('Hello {{contact.COMPANY}}', '<p>{{companyName}}</p>'),
    ['contact.COMPANY']
  );
});

check('spaced Brevo tag is unknown', () => {
  assert.deepEqual(findUnknownVariables('', '{{ contact.COMPANY }}'), ['contact.COMPANY']);
});

check('our tags are allowed', () => {
  assert.deepEqual(
    findUnknownVariables(
      '{{companyName}} {{senderName}}',
      '{{firstName}} {{city}} {{website}} {{email}} {{company}} {{name}}'
    ),
    []
  );
});

check('assert throws a clear message for contact.COMPANY', () => {
  assert.throws(
    () => assertTemplateVariables('Hi {{contact.COMPANY}}', 'Body'),
    (error) => {
      assert.equal(error.code, 'UNKNOWN_TEMPLATE_VARIABLES');
      assert.match(error.message, /\{\{contact\.COMPANY\}\}/);
      assert.match(error.message, /\{\{companyName\}\}/);
      return true;
    }
  );
});

check('replace fills companyName and senderName', () => {
  const out = replaceTemplateVariables(
    'Hi {{companyName}} from {{senderName}}',
    { company: 'Caravan Store', firstName: 'Anna', email: 'a@b.de', city: 'Berlin', website: 'https://example.de' },
    { senderName: 'Usama', senderEmail: 'usama@arswift.com' }
  );
  assert.equal(out, 'Hi Caravan Store from Usama');
});

check('replace leaves an unknown tag untouched so send can be blocked', () => {
  assert.equal(
    replaceTemplateVariables('{{contact.COMPANY}}', { company: 'Caravan Store' }, {}),
    '{{contact.COMPANY}}'
  );
});

check('replace fills websiteIssue and uses a safe line when it is empty', () => {
  assert.equal(
    replaceTemplateVariables('I noticed {{websiteIssue}}.', { websiteIssue: 'your site is difficult to use on a phone' }, {}),
    'I noticed your site is difficult to use on a phone.'
  );
  assert.match(
    replaceTemplateVariables('{{websiteIssue}}', {}, {}),
    /local customers/
  );
});

console.log(`\n${checks} template variable checks passed.`);
