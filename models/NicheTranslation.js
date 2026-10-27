/**
 * models/NicheTranslation.js
 *
 * Cache for niche-to-local-language translations resolved by nicheResolver.js.
 * Key format: "<country_lowercase>:<normalized_niche>"
 * e.g. "france:dentist"
 */

'use strict';

const mongoose = require('mongoose');

const nicheTranslationSchema = new mongoose.Schema({
  // Unique lookup key: "<country_lowercase>:<normalized_niche>"
  key: {
    type:     String,
    required: true,
    unique:   true,
    index:    true,
  },
  niche:   { type: String, required: true },   // original (normalized) niche text
  country: { type: String, required: true },   // country as supplied
  terms:   { type: [String], required: true }, // up to 3 local-language search words
  source:  { type: String, default: 'ai' },    // "ai" (only source that gets cached)
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('NicheTranslation', nicheTranslationSchema);
