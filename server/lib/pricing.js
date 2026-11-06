'use strict';
// Estimated cost of AI usage. Anthropic does NOT expose a live "credit balance"
// for a normal API key, so we estimate spend ourselves from the token usage the
// API reports on every response. Prices are USD per 1,000,000 tokens
// (source: claude-api skill pricing table, cached 2026-10-06). The real prepaid
// balance lives in the Anthropic Console (console.anthropic.com).
const PRICES = {
  'claude-opus-5-5':  { in: 4,    out: 20 },
  'claude-opus-5':    { in: 5,    out: 25 },
  'claude-opus-4-8':  { in: 5,    out: 25 },
  'claude-sonnet-5-5':{ in: 2,    out: 10 },
  'claude-sonnet-5':  { in: 2,    out: 10 },
  'claude-haiku-5-5': { in: 0.10, out: 0.50 },
  'claude-fable-5-1': { in: 10,   out: 50 },
  // OpenAI (approximate USD/1M tokens — estimates for the spend tracker)
  'gpt-4o':          { in: 2.5,  out: 10 },
  'gpt-4o-mini':     { in: 0.15, out: 0.60 },
  'gpt-4.1':         { in: 2,    out: 8 },
  'gpt-4.1-mini':    { in: 0.40, out: 1.60 },
  // Google Gemini (approximate; flash tiers are free/very cheap)
  'gemini-2.5-flash':{ in: 0.30, out: 2.50 },
  'gemini-2.0-flash':{ in: 0.10, out: 0.40 },
  'gemini-1.5-flash':{ in: 0.075,out: 0.30 },
  'gemini-2.5-pro':  { in: 1.25, out: 10 }
};
const DEFAULT = 'claude-opus-5-5';

function priceFor(model) {
  const m = String(model || '');
  if (PRICES[m]) return PRICES[m];
  if (/^(gpt|o[0-9])/i.test(m)) return PRICES['gpt-4o'];        // unknown OpenAI → gpt-4o
  if (/^gemini/i.test(m)) return PRICES['gemini-2.5-flash'];     // unknown Gemini → flash
  return PRICES[DEFAULT];
}

// usage = { input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens }
// Standard multipliers: cache reads ≈ 0.1× input, cache writes ≈ 1.25× input.
function costOf(model, usage) {
  const p = priceFor(model);
  const u = usage || {};
  const inp = u.input_tokens || 0;
  const out = u.output_tokens || 0;
  const cr = u.cache_read_input_tokens || 0;
  const cc = u.cache_creation_input_tokens || 0;
  return (inp * p.in + out * p.out + cr * p.in * 0.1 + cc * p.in * 1.25) / 1e6;
}

module.exports = { PRICES, DEFAULT, priceFor, costOf };
