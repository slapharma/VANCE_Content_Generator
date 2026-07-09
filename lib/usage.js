// lib/usage.js — LLM token-usage tracking + cost calculation.
// Events are appended to a Redis list. Costs are computed at summary time
// using live OpenRouter pricing (1h cache) with hardcoded premium-provider
// fallbacks so direct-API calls still get a price.

import { kv } from './kv.js';

const KEY = 'usage:llm:events';
const MAX_EVENTS = 20000;
const PRICING_CACHE_KEY = 'pricing:openrouter';
const PRICING_TTL_MS = 60 * 60 * 1000; // 1 hour
const PRICING_URL = 'https://openrouter.ai/api/v1/models';

// ── Hardcoded premium-provider fallbacks ──────────────────────────────────
// Used when (a) OpenRouter's catalog hasn't loaded yet, (b) a model was called
// directly via a provider's own SDK (not OpenRouter — e.g. callPremiumClaude/
// OpenAI/Gemini), or (c) a model isn't in OpenRouter's catalog at all. USD per
// 1k tokens — provider list prices are usually quoted per MILLION tokens, so
// every value here is that public figure divided by 1000. Current as of mid
// 2026; OpenRouter's live data takes precedence whenever it's available.
const FALLBACK_PRICING_PER_1K = {
  // Anthropic
  'anthropic/claude-opus-4-7':                { input: 0.015,   output: 0.075  },
  'anthropic/claude-opus-4-6':                { input: 0.015,   output: 0.075  },
  'anthropic/claude-opus-4-5':                { input: 0.005,   output: 0.025  },
  'anthropic/claude-sonnet-4-6':              { input: 0.003,   output: 0.015  },
  'anthropic/claude-haiku-4-5':               { input: 0.0008,  output: 0.004  },
  'anthropic/claude-3.5-sonnet':              { input: 0.003,   output: 0.015  },
  'anthropic/claude-3.5-haiku':               { input: 0.0008,  output: 0.004  },
  // OpenAI
  'openai/gpt-4o':                            { input: 0.0025,  output: 0.01   },
  'openai/gpt-4o-mini':                       { input: 0.00015, output: 0.0006 },
  'openai/o1':                                { input: 0.015,   output: 0.06   },
  'openai/o1-mini':                           { input: 0.003,   output: 0.012  },
  'openai/gpt-oss-120b:free':                 { input: 0,       output: 0      },
  // Google
  'google/gemini-2.5-pro':                    { input: 0.00125, output: 0.01   },
  'google/gemini-2.5-flash':                  { input: 0.000075,output: 0.0003 },
  'google/gemini-2.0-flash':                  { input: 0.0001,  output: 0.0004 }, // deprecated by Google 2026-06-01 — kept for historical events
  'google/gemini-2.5-flash-image-preview':    { input: 0,       output: 0      }, // images priced per-image, not per-token
  'google/gemini-3.1-flash-image-preview-20260226': { input: 0, output: 0      },
  'google/gemma-3-27b-it:free':               { input: 0,       output: 0      },
  'google/gemma-2-27b-it:free':               { input: 0,       output: 0      },
  // Meta
  'meta-llama/llama-3.3-70b-instruct':        { input: 0.00013, output: 0.0004 },
  'meta-llama/llama-3.3-70b-instruct:free':   { input: 0,       output: 0      },
  // MiniMax / others used in your fallback chains
  'minimax/minimax-m1:extended':              { input: 0,       output: 0      },
  'z-ai/glm-4.5-air:free':                    { input: 0,       output: 0      },
};

// ── Recorder ──────────────────────────────────────────────────────────────

export async function recordLlmUsage({
  model, usage, source = 'unknown', userId = null,
  outcome = 'success',  // 'success' | 'failure'
  variant = null,        // { id, label } when called as part of an A/B test
  failureReason = null,
}) {
  if (!model) return;
  const u = usage || {};
  const entry = {
    model,
    prompt_tokens:     Number(u.prompt_tokens     ?? u.promptTokens     ?? 0) || 0,
    completion_tokens: Number(u.completion_tokens ?? u.completionTokens ?? 0) || 0,
    total_tokens:      Number(u.total_tokens      ?? u.totalTokens      ?? 0) || 0,
    at: new Date().toISOString(),
    source,
    outcome,
    ...(variant ? { variantId: variant.id, variantLabel: variant.label } : {}),
    ...(failureReason ? { failureReason: String(failureReason).slice(0, 200) } : {}),
    ...(userId ? { userId } : {}),
  };
  if (!entry.total_tokens) entry.total_tokens = entry.prompt_tokens + entry.completion_tokens;
  try {
    await kv.lpush(KEY, JSON.stringify(entry));
    await kv.ltrim(KEY, 0, MAX_EVENTS - 1);
  } catch (err) {
    console.error('recordLlmUsage failed:', err.message);
  }
}

// Record a failed attempt (no token usage) so failure rate per variant is correct.
// Use when a model is *tried* (first attempt of the fallback chain) and the provider
// rejected the call before any tokens were billed.
export async function recordLlmFailure({ model, source, variant = null, failureReason = null }) {
  return recordLlmUsage({
    model, source, variant,
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    outcome: 'failure',
    failureReason,
  });
}

// ── Pricing fetcher (cached) ──────────────────────────────────────────────

async function fetchOpenRouterPricing() {
  try {
    const r = await fetch(PRICING_URL, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const data = await r.json();
    const map = {};
    for (const m of (data?.data || [])) {
      if (!m.id || !m.pricing) continue;
      // OpenRouter prices are USD per token (strings). Convert to per-1k for consistency.
      map[m.id] = {
        input:  Number(m.pricing.prompt    || 0) * 1000,
        output: Number(m.pricing.completion || 0) * 1000,
        // Some models also have image / request pricing — useful for image-gen tracking later
        request: Number(m.pricing.request   || 0),
        image:   Number(m.pricing.image     || 0),
      };
    }
    return map;
  } catch (err) {
    console.error('fetchOpenRouterPricing failed:', err.message);
    return null;
  }
}

async function getPricingMap() {
  try {
    const cached = await kv.get(PRICING_CACHE_KEY);
    if (cached?.fetchedAt && (Date.now() - new Date(cached.fetchedAt).getTime()) < PRICING_TTL_MS) {
      return cached.models || {};
    }
  } catch {}
  const fresh = await fetchOpenRouterPricing();
  if (fresh) {
    try { await kv.set(PRICING_CACHE_KEY, { fetchedAt: new Date().toISOString(), models: fresh }); } catch {}
    return fresh;
  }
  // Live fetch failed — return stale cache if any, else empty so fallbacks take over
  try {
    const cached = await kv.get(PRICING_CACHE_KEY);
    if (cached?.models) return cached.models;
  } catch {}
  return {};
}

// Family-pattern fallback: catches model strings that don't exactly match a
// FALLBACK_PRICING_PER_1K key — e.g. a dated snapshot a user typed directly
// into the premium-provider model field (`claude-4.5-sonnet-20250929`) — by
// recognizing which model family/tier it belongs to. Order matters: more
// specific patterns (mini/lite variants) must be checked before their parent.
const FAMILY_PRICE_PATTERNS = [
  { re: /claude.*opus/i,        price: FALLBACK_PRICING_PER_1K['anthropic/claude-opus-4-6'] },
  { re: /claude.*sonnet/i,      price: FALLBACK_PRICING_PER_1K['anthropic/claude-sonnet-4-6'] },
  { re: /claude.*haiku/i,       price: FALLBACK_PRICING_PER_1K['anthropic/claude-haiku-4-5'] },
  { re: /gpt-4o-mini/i,         price: FALLBACK_PRICING_PER_1K['openai/gpt-4o-mini'] },
  { re: /gpt-4o/i,              price: FALLBACK_PRICING_PER_1K['openai/gpt-4o'] },
  { re: /o1-mini/i,             price: FALLBACK_PRICING_PER_1K['openai/o1-mini'] },
  { re: /\bo1\b/i,              price: FALLBACK_PRICING_PER_1K['openai/o1'] },
  { re: /gemini.*2\.5.*pro/i,   price: FALLBACK_PRICING_PER_1K['google/gemini-2.5-pro'] },
  { re: /gemini.*2\.5.*flash/i, price: FALLBACK_PRICING_PER_1K['google/gemini-2.5-flash'] },
  { re: /gemini.*2\.0.*flash/i, price: FALLBACK_PRICING_PER_1K['google/gemini-2.0-flash'] },
  { re: /llama-3\.3-70b/i,      price: FALLBACK_PRICING_PER_1K['meta-llama/llama-3.3-70b-instruct'] },
];

function familyFallbackPricing(model) {
  const m = String(model || '');
  const hit = FAMILY_PRICE_PATTERNS.find(p => p.re.test(m));
  return hit ? hit.price : { input: 0, output: 0 };
}

function pricingFor(model, liveMap) {
  // Live OpenRouter data wins
  if (liveMap[model]) return liveMap[model];
  // Exact hardcoded premium fallback (also catches direct-API calls bypassing OpenRouter)
  if (FALLBACK_PRICING_PER_1K[model]) return FALLBACK_PRICING_PER_1K[model];
  // Family-pattern fallback for dated/custom snapshot strings we don't have an exact entry for
  const family = familyFallbackPricing(model);
  if (family.input || family.output) return family;
  // Truly unknown — treat as free; surfaces as $0 in the dashboard so it's visible-but-honest
  return { input: 0, output: 0 };
}

function costFor(event, rate) {
  // rate.input / rate.output are USD per 1k tokens
  const inCost  = (event.prompt_tokens     / 1000) * (rate.input  || 0);
  const outCost = (event.completion_tokens / 1000) * (rate.output || 0);
  return inCost + outCost;
}

// ── Summary ───────────────────────────────────────────────────────────────

export async function summarizeUsage() {
  const [raw, liveMap] = await Promise.all([
    kv.lrange(KEY, 0, -1),
    getPricingMap(),
  ]);
  const events = raw
    .map(r => { try { return typeof r === 'string' ? JSON.parse(r) : r; } catch { return null; } })
    .filter(Boolean);

  const now = Date.now();
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;
  const WEEK4 = 28 * DAY;

  const byModel = new Map();
  const byUser = new Map();
  let firstEventAt = null;

  for (const e of events) {
    const ts = new Date(e.at).getTime();
    if (!firstEventAt || ts < firstEventAt) firstEventAt = ts;
    const rate = pricingFor(e.model, liveMap);
    const cost = costFor(e, rate);
    const cur = byModel.get(e.model) || {
      model: e.model,
      rate, // USD per 1k tokens — surfaces in the dashboard so users can see what each model costs
      total: { calls: 0, prompt: 0, completion: 0, tokens: 0, costUsd: 0 },
      d28:   { calls: 0, prompt: 0, completion: 0, tokens: 0, costUsd: 0 },
      d1:    { calls: 0, prompt: 0, completion: 0, tokens: 0, costUsd: 0 },
      h1:    { calls: 0, prompt: 0, completion: 0, tokens: 0, costUsd: 0 },
      lastAt: null,
    };
    cur.total.calls++;
    cur.total.prompt     += e.prompt_tokens;
    cur.total.completion += e.completion_tokens;
    cur.total.tokens     += e.total_tokens;
    cur.total.costUsd    += cost;
    if (now - ts <= WEEK4) {
      cur.d28.calls++;
      cur.d28.prompt     += e.prompt_tokens;
      cur.d28.completion += e.completion_tokens;
      cur.d28.tokens     += e.total_tokens;
      cur.d28.costUsd    += cost;
    }
    if (now - ts <= DAY) {
      cur.d1.calls++;
      cur.d1.prompt     += e.prompt_tokens;
      cur.d1.completion += e.completion_tokens;
      cur.d1.tokens     += e.total_tokens;
      cur.d1.costUsd    += cost;
    }
    if (now - ts <= HOUR) {
      cur.h1.calls++;
      cur.h1.prompt     += e.prompt_tokens;
      cur.h1.completion += e.completion_tokens;
      cur.h1.tokens     += e.total_tokens;
      cur.h1.costUsd    += cost;
    }
    if (!cur.lastAt || ts > new Date(cur.lastAt).getTime()) cur.lastAt = e.at;
    byModel.set(e.model, cur);

    // ── Per-user rollup (userId is null for system-triggered work — automation
    // runs, AI revisions, scheduled social generation — which has no requester) ──
    const userKey = e.userId || '__unattributed__';
    const uCur = byUser.get(userKey) || {
      userId: e.userId || null,
      models: new Set(),
      total: { calls: 0, tokens: 0, costUsd: 0 },
      d28:   { calls: 0, tokens: 0, costUsd: 0 },
      d1:    { calls: 0, tokens: 0, costUsd: 0 },
      h1:    { calls: 0, tokens: 0, costUsd: 0 },
      lastAt: null,
    };
    uCur.models.add(e.model);
    uCur.total.calls++;
    uCur.total.tokens  += e.total_tokens;
    uCur.total.costUsd += cost;
    if (now - ts <= WEEK4) { uCur.d28.calls++; uCur.d28.tokens += e.total_tokens; uCur.d28.costUsd += cost; }
    if (now - ts <= DAY) { uCur.d1.calls++; uCur.d1.tokens += e.total_tokens; uCur.d1.costUsd += cost; }
    if (now - ts <= HOUR) { uCur.h1.calls++; uCur.h1.tokens += e.total_tokens; uCur.h1.costUsd += cost; }
    if (!uCur.lastAt || ts > new Date(uCur.lastAt).getTime()) uCur.lastAt = e.at;
    byUser.set(userKey, uCur);
  }

  const models = [...byModel.values()].sort((a, b) => b.total.costUsd - a.total.costUsd || b.total.tokens - a.total.tokens);
  const users = [...byUser.values()]
    .map(u => ({ ...u, models: [...u.models] }))
    .sort((a, b) => b.total.costUsd - a.total.costUsd || b.total.tokens - a.total.tokens);

  // ── Per-variant aggregation (A/B test comparison) ─────────────────────
  // Each variant rolls up: calls, successes, failures, tokens, cost, $/success.
  const byVariant = new Map();
  for (const e of events) {
    if (!e.variantId) continue;
    const rate = pricingFor(e.model, liveMap);
    const cost = costFor(e, rate);
    const key = e.variantId;
    const cur = byVariant.get(key) || {
      variantId: e.variantId,
      label: e.variantLabel || e.variantId,
      models: new Set(),
      calls: 0,
      successes: 0,
      failures: 0,
      tokens: 0,
      costUsd: 0,
      lastFailureReason: null,
    };
    cur.models.add(e.model);
    cur.calls++;
    if (e.outcome === 'failure') {
      cur.failures++;
      if (e.failureReason) cur.lastFailureReason = e.failureReason;
    } else {
      cur.successes++;
    }
    cur.tokens   += e.total_tokens;
    cur.costUsd  += cost;
    byVariant.set(key, cur);
  }
  const variants = [...byVariant.values()].map(v => ({
    variantId: v.variantId,
    label: v.label,
    models: [...v.models],
    calls: v.calls,
    successes: v.successes,
    failures: v.failures,
    successRate: v.calls > 0 ? v.successes / v.calls : 0,
    tokens: v.tokens,
    costUsd: v.costUsd,
    // Effective cost per successful generation — the key A/B comparison metric
    costPerSuccess: v.successes > 0 ? v.costUsd / v.successes : null,
    lastFailureReason: v.lastFailureReason,
  })).sort((a, b) => b.calls - a.calls);

  return {
    models,
    users,
    variants,
    overall: {
      total:      models.reduce((acc, m) => acc + m.total.tokens, 0),
      d28:        models.reduce((acc, m) => acc + m.d28.tokens, 0),
      d1:         models.reduce((acc, m) => acc + m.d1.tokens, 0),
      h1:         models.reduce((acc, m) => acc + m.h1.tokens, 0),
      calls:      models.reduce((acc, m) => acc + m.total.calls, 0),
      costUsd:    models.reduce((acc, m) => acc + m.total.costUsd, 0),
      costUsdD28: models.reduce((acc, m) => acc + m.d28.costUsd, 0),
      costUsdD1:  models.reduce((acc, m) => acc + m.d1.costUsd, 0),
      costUsdH1:  models.reduce((acc, m) => acc + m.h1.costUsd, 0),
    },
    eventCount: events.length,
    firstEventAt: firstEventAt ? new Date(firstEventAt).toISOString() : null,
    pricingSource: Object.keys(liveMap).length ? 'openrouter-live' : 'fallback-only',
  };
}
