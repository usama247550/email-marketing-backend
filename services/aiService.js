/**
 * services/aiService.js
 *
 * Reusable OpenRouter AI client for the backend.
 *
 * Designed to be called from any service or controller that needs AI inference —
 * starting with the Smart Search feature, but intentionally generic.
 *
 * Usage:
 *   const { askAI } = require('./aiService');
 *
 *   // Plain text response
 *   const text = await askAI('You are a helpful assistant.', 'What is 2+2?');
 *
 *   // Structured JSON response
 *   const obj = await askAI(
 *     'You are a data extractor.',
 *     'Extract the city and country from: "Frankfurt, Germany"',
 *     { jsonMode: true }
 *   );
 *   // obj => { city: 'Frankfurt', country: 'Germany' }
 */

'use strict';

const axios = require('axios');

// ── Config ────────────────────────────────────────────────────────────────────

const OPENROUTER_URL    = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_MODEL     = 'nvidia/nemotron-3-super-120b-a12b:free';
const REQUEST_TIMEOUT   = 60_000;  // 60 s — AI inference can be slow
const JSON_SYSTEM_ADDON =
  '\n\nIMPORTANT: Respond with ONLY valid JSON. ' +
  'No markdown fences, no explanatory text, no comments — pure JSON only.';

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Strip markdown code fences that some models wrap around JSON despite instructions.
 * Handles ```json ... ```, ``` ... ```, and leading/trailing whitespace.
 */
function stripMarkdownFences(text) {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();
}

/**
 * Make one completion request to OpenRouter.
 * Returns the raw response content string, or throws on HTTP / network error.
 */
async function callOpenRouter(systemPrompt, userPrompt, model) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OPENROUTER_API_KEY is not set in environment variables.');

  const resp = await axios.post(
    OPENROUTER_URL,
    {
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt   },
      ],
    },
    {
      timeout: REQUEST_TIMEOUT,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
      },
    },
  );

  // OpenRouter mirrors the OpenAI response shape
  const content = resp.data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || content.trim() === '') {
    throw new Error(
      `OpenRouter returned an empty or unexpected response: ` +
      JSON.stringify(resp.data).slice(0, 300),
    );
  }

  return content;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * askAI — send a prompt to OpenRouter and return the result.
 *
 * @param {string} systemPrompt  Instructions / persona for the model.
 * @param {string} userPrompt    The user's message / question.
 * @param {object} [options]
 * @param {string}  [options.model]     Override the default model.
 * @param {boolean} [options.jsonMode]  If true, instruct model to return pure JSON
 *                                      and parse the response before returning.
 *
 * @returns {Promise<string|object>}
 *   - string  when jsonMode is false/omitted
 *   - object  when jsonMode is true (parsed JSON)
 *
 * @throws {Error} On API errors, timeouts, or unparseable JSON (after one retry).
 */
async function askAI(systemPrompt, userPrompt, options = {}) {
  const model      = options.model    ?? DEFAULT_MODEL;
  const jsonMode   = options.jsonMode ?? false;

  // Append JSON instruction to the system prompt when jsonMode is on
  const effectiveSystem = jsonMode
    ? systemPrompt + JSON_SYSTEM_ADDON
    : systemPrompt;

  // ── Plain text path ──────────────────────────────────────────────────────
  if (!jsonMode) {
    try {
      return await callOpenRouter(effectiveSystem, userPrompt, model);
    } catch (err) {
      throw buildAiError(err);
    }
  }

  // ── JSON path — attempt once, retry on parse failure ────────────────────
  let rawContent;

  // Attempt 1
  try {
    rawContent = await callOpenRouter(effectiveSystem, userPrompt, model);
  } catch (err) {
    throw buildAiError(err);
  }

  const parsed1 = tryParseJson(rawContent);
  if (parsed1 !== null) return parsed1;

  console.warn('[AI] JSON parse failed on attempt 1, retrying…\nRaw:', rawContent.slice(0, 200));

  // Attempt 2 — retry the API call
  try {
    rawContent = await callOpenRouter(effectiveSystem, userPrompt, model);
  } catch (err) {
    throw buildAiError(err);
  }

  const parsed2 = tryParseJson(rawContent);
  if (parsed2 !== null) return parsed2;

  throw new Error(
    `AI returned invalid JSON after 2 attempts. ` +
    `Last response (first 300 chars): ${rawContent.slice(0, 300)}`,
  );
}

/**
 * Try to parse a string as JSON, stripping markdown fences first.
 * Returns the parsed value on success, or null on failure (never throws).
 */
function tryParseJson(text) {
  try {
    return JSON.parse(stripMarkdownFences(text));
  } catch {
    return null;
  }
}

/**
 * Wrap raw axios/network errors with a clear, user-friendly message.
 */
function buildAiError(err) {
  const status = err.response?.status;

  if (status === 401) return new Error('OpenRouter: invalid or missing API key (401).');
  if (status === 429) return new Error('OpenRouter: rate limit reached — try again shortly (429).');
  if (status === 402) return new Error('OpenRouter: account has insufficient credits (402).');
  if (status >= 500)  return new Error(`OpenRouter: server error (${status}) — try again later.`);
  if (err.code === 'ECONNABORTED' || err.message?.includes('timeout'))
    return new Error(`OpenRouter request timed out after ${REQUEST_TIMEOUT / 1000}s.`);

  return new Error(`OpenRouter error: ${err.message}`);
}

module.exports = { askAI };
