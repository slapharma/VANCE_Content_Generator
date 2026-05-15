// lib/ab-test.js — Lightweight A/B testing harness for LLM model selection.
//
// One global, singleton test. When enabled, every server-side LLM call that
// opts in picks a variant by weighted random, uses that model first, and
// records outcome (success/failure) on the usage event so the dashboard can
// compute effective cost per successful generation.
//
// Storage: single KV key `ab:test:default`.

import { kv } from './kv.js';
import { randomUUID } from 'crypto';

const KEY = 'ab:test:default';

export async function getAbConfig() {
  const cfg = await kv.get(KEY);
  return cfg || { enabled: false, name: 'Default A/B', variants: [] };
}

export async function saveAbConfig(cfg) {
  // Normalize: ensure ids, valid weights, model strings
  const variants = (Array.isArray(cfg?.variants) ? cfg.variants : [])
    .filter(v => v && typeof v.model === 'string' && v.model.trim())
    .map(v => ({
      id: v.id || randomUUID(),
      label: (v.label || v.model).slice(0, 80),
      model: v.model.trim(),
      weight: Math.max(0, Number(v.weight) || 1),
    }))
    .filter(v => v.weight > 0); // zero-weight variants effectively disabled
  const out = {
    enabled: !!cfg?.enabled && variants.length >= 2, // need at least 2 variants to be a real test
    name: (cfg?.name || 'Default A/B').slice(0, 120),
    variants,
    updatedAt: new Date().toISOString(),
  };
  await kv.set(KEY, out);
  return out;
}

// Pick a variant by weighted random. Returns null if test disabled / empty.
export function pickVariant(cfg) {
  if (!cfg?.enabled || !cfg.variants?.length) return null;
  const total = cfg.variants.reduce((s, v) => s + (v.weight || 0), 0);
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (const v of cfg.variants) {
    r -= v.weight;
    if (r <= 0) return v;
  }
  return cfg.variants[cfg.variants.length - 1];
}

// Convenience: fetch + pick. Caller can pass a `defaultModel` to use when test disabled.
export async function pickModelForGeneration(defaultModel) {
  try {
    const cfg = await getAbConfig();
    const v = pickVariant(cfg);
    if (v) return { model: v.model, variant: { id: v.id, label: v.label }, testEnabled: true };
  } catch {}
  return { model: defaultModel, variant: null, testEnabled: false };
}
