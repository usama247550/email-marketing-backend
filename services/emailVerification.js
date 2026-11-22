'use strict';

const dns = require('dns').promises;

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.de', '10minutemail.com',
  'tempmail.com', 'temp-mail.org', 'yopmail.com', 'throwaway.email', 'sharklasers.com',
  'trashmail.com', 'getnada.com', 'maildrop.cc', 'fakeinbox.com',
]);

const FREE_MAIL_PROVIDERS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.de', 'hotmail.com', 'outlook.com',
  'live.com', 'icloud.com', 'gmx.de', 'gmx.net', 'web.de', 't-online.de', 'aol.com',
]);

const SYNTAX_RE = /^[^\s@]{1,64}@[^\s@]{1,253}\.[a-z]{2,}$/;

function domainFromWebsite(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return '';
  try {
    const href = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    let host = new URL(href).hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    return host;
  } catch {
    return '';
  }
}

function emailDomain(email) {
  if (!email) return '';
  const parts = String(email).toLowerCase().trim().split('@');
  return parts[1] || '';
}

function domainsRelated(siteHost, mailDomain) {
  if (!siteHost || !mailDomain) return false;
  if (siteHost === mailDomain) return true;
  if (mailDomain.endsWith(`.${siteHost}`)) return true;
  if (siteHost.endsWith(`.${mailDomain}`)) return true;
  return false;
}

async function domainAcceptsMail(domain, timeoutMs = 4500) {
  if (!domain) return false;
  try {
    const mx = await Promise.race([
      dns.resolveMx(domain),
      new Promise((_, reject) => setTimeout(() => reject(new Error('mx_timeout')), timeoutMs)),
    ]);
    if (Array.isArray(mx) && mx.length > 0) return true;
  } catch (_) { /* fall through */ }

  try {
    const a = await Promise.race([
      dns.resolve4(domain),
      new Promise((_, reject) => setTimeout(() => reject(new Error('a_timeout')), timeoutMs)),
    ]);
    return Array.isArray(a) && a.length > 0;
  } catch (_) {
    return false;
  }
}

/**
 * Free checks before send (no paid API): syntax, disposable, MX, domain vs website.
 * @returns {{ verified: boolean, reason: string }}
 */
async function verifyEmailAddress(email, website = '') {
  const normalized = String(email || '').toLowerCase().trim();
  if (!SYNTAX_RE.test(normalized)) {
    return { verified: false, reason: 'Invalid email format' };
  }

  const domain = emailDomain(normalized);
  if (DISPOSABLE_DOMAINS.has(domain)) {
    return { verified: false, reason: 'Disposable email domain' };
  }

  const siteHost = domainFromWebsite(website);
  if (siteHost && domain && !FREE_MAIL_PROVIDERS.has(domain)) {
    if (!domainsRelated(siteHost, domain)) {
      return { verified: false, reason: 'Email domain does not match website' };
    }
  }

  const mailOk = await domainAcceptsMail(domain);
  if (!mailOk) {
    return { verified: false, reason: 'Domain has no mail server (MX)' };
  }

  return { verified: true, reason: 'OK' };
}

function rankEmailsByWebsite(emails, website) {
  const site = domainFromWebsite(website);
  const score = (e) => {
    const d = emailDomain(e);
    if (site && domainsRelated(site, d)) return 0;
    if (FREE_MAIL_PROVIDERS.has(d)) return 1;
    return 2;
  };
  return [...emails].sort((a, b) => score(a) - score(b));
}

module.exports = {
  verifyEmailAddress,
  domainFromWebsite,
  emailDomain,
  domainsRelated,
  rankEmailsByWebsite,
  DISPOSABLE_DOMAINS,
};