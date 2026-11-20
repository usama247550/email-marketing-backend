/**
 * Template tags this tool fills itself before the email is sent to Brevo.
 *
 * Brevo also uses {{ ... }} (for example {{contact.COMPANY}}). We do not
 * send Brevo contact fields. If one of those tags is left in the HTML,
 * Brevo replaces it with a blank and the email still goes out.
 *
 * Allowed names (case-sensitive, same as the Templates page buttons):
 *   companyName, company, firstName, name, email, city, website, senderName, websiteIssue
 */

'use strict';

const ALLOWED_VARIABLES = new Set([
  'companyName',
  'company',
  'firstName',
  'name',
  'email',
  'city',
  'website',
  'senderName',
  'websiteIssue',
]);

const TAG_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

const ALLOWED_LIST_TEXT =
  '{{companyName}}, {{firstName}}, {{city}}, {{website}}, {{email}}, {{senderName}}, {{websiteIssue}}';

function findTemplateTags(text) {
  if (!text) return [];
  const names = [];
  const pattern = new RegExp(TAG_PATTERN.source, 'g');
  let match;
  while ((match = pattern.exec(text)) !== null) {
    names.push(match[1].trim());
  }
  return names;
}

function findUnknownVariables(subject, body) {
  const seen = new Set();
  const unknown = [];
  for (const name of [...findTemplateTags(subject), ...findTemplateTags(body)]) {
    if (ALLOWED_VARIABLES.has(name) || seen.has(name)) continue;
    seen.add(name);
    unknown.push(name);
  }
  return unknown;
}

function unknownVariableMessage(unknown) {
  const tags = unknown.map((name) => `{{${name}}}`).join(', ');
  const verb = unknown.length === 1 ? 'is' : 'are';
  return (
    `${tags} ${verb} not a variable in this tool. ` +
    'The email would still send, but that part would be blank. ' +
    `Use one of: ${ALLOWED_LIST_TEXT}. ` +
    'For the company name, use {{companyName}}.'
  );
}

function assertTemplateVariables(subject, body) {
  const unknown = findUnknownVariables(subject, body);
  if (unknown.length === 0) return;
  const error = new Error(unknownVariableMessage(unknown));
  error.code = 'UNKNOWN_TEMPLATE_VARIABLES';
  error.unknown = unknown;
  throw error;
}

function replaceTemplateVariables(text, lead = {}, project = {}) {
  if (!text) return text || '';
  const company = lead.company || '[Company]';
  const firstName = lead.firstName || '[Name]';
  const sender = (project && (project.senderName || project.senderEmail)) || '[Sender]';

  return text
    .replace(/\{\{\s*companyName\s*\}\}/g, company)
    .replace(/\{\{\s*company\s*\}\}/g, company)
    .replace(/\{\{\s*firstName\s*\}\}/g, firstName)
    .replace(/\{\{\s*name\s*\}\}/g, firstName)
    .replace(/\{\{\s*email\s*\}\}/g, lead.email || '[Email]')
    .replace(/\{\{\s*city\s*\}\}/g, lead.city || '[City]')
    .replace(/\{\{\s*website\s*\}\}/g, lead.website || '[Website]')
    .replace(/\{\{\s*senderName\s*\}\}/g, sender)
    .replace(/\{\{\s*websiteIssue\s*\}\}/g, lead.websiteIssue || 'your website could bring in more local customers');
}

module.exports = {
  ALLOWED_VARIABLES,
  findUnknownVariables,
  unknownVariableMessage,
  assertTemplateVariables,
  replaceTemplateVariables,
};
