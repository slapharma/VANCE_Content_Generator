// lib/social/stock-ledger.js
//
// One-use-only ledger for stock photos (Pexels AND Unsplash).
//
// Why this exists: the automation hero picker took `results[0]` of the first
// query that returned anything, so every article whose title broadened to the
// same query got the same photo, and the manual picker cheerfully re-offered a
// photo that was already live on the site. A stock photo is now spent the moment
// it is used: the automation skips anything in this ledger, /api/social/stock
// hides it from every result grid, and every code path that persists a stock
// image records it here.
//
// Identity is deliberately double-keyed, and a photo counts as used if EITHER
// key is present:
//
//   id:pexels:12345                                   provider photo id
//   img:images.pexels.com/photos/12345/pexels-photo…  image path, query stripped
//
// The id key is exact and is what live code paths write. The path key is what
// makes images recorded *before* this ledger existed recognisable too (heroes
// stored with nothing but a URL, seeded by scripts/seed-stock-ledger.mjs) — both
// providers serve every size of a photo from one path, with the dimensions in the
// query string, so the path alone identifies the photo.
//
// Failure policy: reads fail OPEN (a KV blip must not empty an operator's search
// grid or block an automation run) and writes fail SILENT. The consequence of a
// KV outage is therefore a possible duplicate, not a broken pipeline.

import { kv } from '../kv.js';

// Namespaced like vance:hero-prompts rather than the bare content:* keys, because
// this is app configuration/state that survives a content reset — see the
// 'stockimages' target in lib/admin/reset.js for the deliberate way to clear it.
export const STOCK_USED_KEY = 'vance:stock:used-images';

// images.pexels.com/photos/12345/pexels-photo-12345.jpeg — the numeric segment is
// the photo id every Pexels size shares. Also matches www.pexels.com/photo/slug-12345/.
const PEXELS_IMG_ID_RE  = /\/photos\/(\d+)(?:\/|$)/;
const PEXELS_PAGE_ID_RE = /pexels\.com\/photo\/[^/]*?(\d+)\/?$/i;

function normProvider(value) {
  const v = String(value || '').toLowerCase();
  if (v.includes('unsplash')) return 'unsplash';
  if (v.includes('pexels')) return 'pexels';
  return '';
}

/** `pexels_12345` / `unsplash:n7a2OJDSZns` / a raw id → the id without its prefix. */
function bareId(id) {
  const s = String(id ?? '').trim();
  if (!s) return '';
  const m = /^(?:pexels|unsplash)[_:](.+)$/i.exec(s);
  return (m ? m[1] : s).trim();
}

/**
 * Provider photo id, from an explicit id when the caller has one (every live path
 * does) or from a Pexels URL when it does not.
 *
 * Unsplash ids are NOT recovered from URLs: a modern Unsplash photo page is
 * `/photos/<slug>-<id>` and ids may themselves contain hyphens, so there is no
 * unambiguous split. The path key below covers those cases instead.
 */
function photoId(photo, provider) {
  const explicit = bareId(photo.id ?? photo.photoId ?? photo.providerId);
  if (explicit) return explicit;
  if (provider !== 'pexels') return '';
  for (const candidate of [photo.url, photo.sourceUrl, photo.photoUrl]) {
    const s = String(candidate || '');
    const m = PEXELS_IMG_ID_RE.exec(s) || PEXELS_PAGE_ID_RE.exec(s);
    if (m) return m[1];
  }
  return '';
}

/** Host + path of an image URL, lowercased, query and hash dropped. */
function imagePath(url) {
  const s = String(url || '').trim();
  if (!s || s.startsWith('data:')) return '';
  try {
    const u = new URL(s);
    return (u.host + u.pathname).toLowerCase().replace(/\/+$/, '');
  } catch {
    return s.split(/[?#]/)[0].toLowerCase().replace(/^https?:\/\//, '').replace(/\/+$/, '') || '';
  }
}

/**
 * Every ledger key a photo is known by. Accepts the shapes used across the app:
 * search results ({ id, provider, url, sourceUrl }), automation hits, and stored
 * hero/cover records ({ heroImageUrl, heroImageType, heroImageCredit }).
 * Returns [] for anything that is not a stock photo (AI, uploads, blanks).
 */
export function stockPhotoKeys(photo) {
  if (!photo || typeof photo !== 'object') return [];
  const provider = normProvider(
    photo.provider ?? photo.heroImageType ?? photo.credit?.provider ?? photo.heroImageCredit?.provider,
  );
  if (!provider) return [];
  const keys = [];
  const id = photoId(photo, provider);
  if (id) keys.push(`id:${provider}:${id}`);
  const path = imagePath(photo.url ?? photo.heroImageUrl ?? photo.coverImageUrl);
  if (path) keys.push(`img:${path}`);
  return [...new Set(keys)];
}

/** Normalise a stored article hero into a photo the ledger understands. */
export function heroAsStockPhoto(item) {
  if (!item || !item.heroImageUrl) return null;
  const provider = normProvider(item.heroImageType || item.heroImageCredit?.provider);
  if (!provider) return null;
  return {
    provider,
    url: item.heroImageUrl,
    sourceUrl: item.heroImageCredit?.photoUrl || null,
    id: item.heroImagePhotoId || null,
  };
}

/** Normalise a promo campaign's stock cover into a photo the ledger understands. */
export function coverAsStockPhoto(promo) {
  if (!promo || !promo.coverImageUrl) return null;
  const provider = normProvider(promo.coverCredit?.provider || (promo.coverSource === 'stock' ? 'pexels' : ''));
  if (!provider || promo.coverSource !== 'stock') return null;
  return {
    provider,
    url: promo.coverImageUrl,
    sourceUrl: promo.coverCredit?.photoUrl || null,
    id: promo.coverPhotoId || null,
  };
}

/** Record photos as spent. Idempotent; never throws. */
export async function markStockUsed(photoOrPhotos) {
  const list = Array.isArray(photoOrPhotos) ? photoOrPhotos : [photoOrPhotos];
  const keys = [...new Set(list.flatMap(stockPhotoKeys))];
  if (!keys.length) return 0;
  try {
    await kv.sadd(STOCK_USED_KEY, ...keys);
    return keys.length;
  } catch (err) {
    console.warn('[stock-ledger] could not record used photo:', err.message);
    return 0;
  }
}

/**
 * Drop the photos that have already been used. Order is preserved, and on a KV
 * failure the input is returned untouched — see the fail-open policy above.
 */
export async function filterUnusedStock(photos) {
  const list = Array.isArray(photos) ? photos : [];
  if (!list.length) return list;
  const keyed = list.map((p) => ({ photo: p, keys: stockPhotoKeys(p) }));
  const allKeys = [...new Set(keyed.flatMap((k) => k.keys))];
  if (!allKeys.length) return list;
  let used;
  try {
    const flags = await kv.smismember(STOCK_USED_KEY, allKeys);
    used = new Set(allKeys.filter((_, i) => flags?.[i] === 1));
  } catch (err) {
    console.warn('[stock-ledger] used-photo lookup failed, offering everything:', err.message);
    return list;
  }
  if (!used.size) return list;
  return keyed.filter((k) => !k.keys.some((key) => used.has(key))).map((k) => k.photo);
}

/** True when this exact photo has been used before. Fails open (false). */
export async function isStockUsed(photo) {
  const keys = stockPhotoKeys(photo);
  if (!keys.length) return false;
  try {
    const flags = await kv.smismember(STOCK_USED_KEY, keys);
    return (flags || []).some((f) => f === 1);
  } catch {
    return false;
  }
}

/** Ledger size (key count, so roughly 2 per photo). For diagnostics/scripts. */
export async function stockLedgerSize() {
  try {
    return (await kv.scard(STOCK_USED_KEY)) || 0;
  } catch {
    return 0;
  }
}
