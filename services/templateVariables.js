/**
 * Template tags this tool fills itself before the email is sent to Brevo.
 *
 * Brevo also uses {{ ... }} (for example {{contact.COMPANY}}). We do not
 * send Brevo contact fields. If one of those tags is left in the HTML,
 * Brevo replaces it with a blank and the email still goes out.
 *
 * Allowed names (case-sensitive, same as the Templates page buttons):
 *   companyName, company, firstName, name, email, city, website, senderName,
 *   websiteIssue (EN fallback), websiteIssueDe (DE fallback when empty)
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
  'websiteIssueDe',
]);

const TAG_PATTERN = /\{\{\s*([^{}]+?)\s*\}\}/g;

const ALLOWED_LIST_TEXT =
  '{{companyName}}, {{firstName}}, {{city}}, {{website}}, {{email}}, {{senderName}}, {{websiteIssue}}, {{websiteIssueDe}}';

const DEFAULT_WEBSITE_ISSUE = 'your website could bring in more local customers';
const DEFAULT_WEBSITE_ISSUE_DE =
  'Ihre Website könnte Ihnen mehr Anfragen aus der Region bringen';

/**
 * Rich-text editors sometimes split {{websiteIssue}} with <span> etc. Brevo blanks
 * any {{tag}} we fail to replace. Merge tag text back to plain {{name}} first.
 */
function normalizeMergeTagsInHtml(text) {
  if (!text || typeof text !== 'string') return text || '';
  let normalized = text
    .replace(/\uFF5B/g, '{')
    .replace(/\uFF5D/g, '}');

  return normalized.replace(/\{\{([\s\S]*?)\}\}/g, (full, inner) => {
    const name = inner
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/gi, ' ')
      .trim()
      .replace(/\s+/g, '');
    if (ALLOWED_VARIABLES.has(name)) return `{{${name}}}`;
    for (const allowed of ALLOWED_VARIABLES) {
      if (name.toLowerCase() === allowed.toLowerCase()) return `{{${allowed}}}`;
    }
    return full;
  });
}

function resolveWebsiteIssue(lead, fallback = DEFAULT_WEBSITE_ISSUE) {
  if (!lead) return fallback;
  const raw = typeof lead.get === 'function' ? lead.get('websiteIssue') : lead.websiteIssue;
  if (raw == null) return fallback;
  const trimmed = String(raw).trim();
  return trimmed || fallback;
}

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
  const subj = normalizeMergeTagsInHtml(subject);
  const bod = normalizeMergeTagsInHtml(body);
  for (const name of [...findTemplateTags(subj), ...findTemplateTags(bod)]) {
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
  const html = normalizeMergeTagsInHtml(text);
  const company = lead.company || '[Company]';
  const firstName = lead.firstName || '[Name]';
  const sender = (project && (project.senderName || project.senderEmail)) || '[Sender]';

  return html
    .replace(/\{\{\s*companyName\s*\}\}/g, company)
    .replace(/\{\{\s*company\s*\}\}/g, company)
    .replace(/\{\{\s*firstName\s*\}\}/g, firstName)
    .replace(/\{\{\s*name\s*\}\}/g, firstName)
    .replace(/\{\{\s*email\s*\}\}/g, lead.email || '[Email]')
    .replace(/\{\{\s*city\s*\}\}/g, lead.city || '[City]')
    .replace(/\{\{\s*website\s*\}\}/g, lead.website || '[Website]')
    .replace(/\{\{\s*senderName\s*\}\}/g, sender)
    .replace(/\{\{\s*websiteIssue\s*\}\}/gi, resolveWebsiteIssue(lead, DEFAULT_WEBSITE_ISSUE))
    .replace(/\{\{\s*websiteIssueDe\s*\}\}/gi, resolveWebsiteIssue(lead, DEFAULT_WEBSITE_ISSUE_DE));
}

module.exports = {
  ALLOWED_VARIABLES,
  DEFAULT_WEBSITE_ISSUE,
  DEFAULT_WEBSITE_ISSUE_DE,
  normalizeMergeTagsInHtml,
  resolveWebsiteIssue,
  findUnknownVariables,
  unknownVariableMessage,
  assertTemplateVariables,
  replaceTemplateVariables,
};
