'use strict';

const axios = require('axios');

function normalizeApiKey(apiKey) {
  return typeof apiKey === 'string' ? apiKey.trim() : '';
}

function classifyBrevoKey(apiKey) {
  const trimmed = normalizeApiKey(apiKey);
  if (trimmed.startsWith('xsmtpsib-')) return 'smtp';
  if (trimmed.startsWith('xkeysib-')) return 'api';
  return 'unknown';
}

/**
 * @returns {Promise<{ ok: boolean, message?: string, accountEmail?: string, plan?: string, status?: number }>}
 */
async function validateBrevoApiKey(apiKey) {
  const trimmed = normalizeApiKey(apiKey);
  if (!trimmed) {
    return { ok: false, message: 'API key is empty' };
  }

  if (trimmed.startsWith('xsmtpsib-')) {
    return {
      ok: false,
      message:
        'This is an SMTP key (xsmtpsib-). The app needs a REST API key (xkeysib-). In Brevo: SMTP & API → API keys → Generate.',
    };
  }

  if (!trimmed.startsWith('xkeysib-')) {
    return {
      ok: false,
      message:
        'Invalid key format. Use a Brevo API key starting with xkeysib- (not SMTP xsmtpsib-).',
    };
  }

  try {
    const response = await axios.get('https://api.brevo.com/v3/account', {
      headers: { 'api-key': trimmed },
      timeout: 15000,
    });
    return {
      ok: true,
      accountEmail: response.data?.email,
      plan: response.data?.plan?.[0]?.type || response.data?.plan?.type,
    };
  } catch (error) {
    const msg =
      error.response?.data?.message ||
      error.response?.data?.error ||
      error.message ||
      'Brevo rejected this API key';
    return { ok: false, message: msg, status: error.response?.status };
  }
}

module.exports = {
  normalizeApiKey,
  classifyBrevoKey,
  validateBrevoApiKey,
};