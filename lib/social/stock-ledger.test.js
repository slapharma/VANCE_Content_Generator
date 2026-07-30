// Identity derivation for the one-use-only stock ledger. Pure functions only — no
// KV — so this runs with plain `node --test` like the rest of the suite.
//
// What these lock down: the same photo must produce a matching key whichever shape
// it arrives in (search result, automation hit, stored hero, legacy URL-only hero),
// because that is the whole basis of "never offer or use it twice". And AI /
// uploaded images must produce NO keys, so they never occupy the ledger.

import { test } from 'node:test';
import assert from 'node:assert';
import { stockPhotoKeys, heroAsStockPhoto, coverAsStockPhoto } from './stock-ledger.js';

const PEXELS_LARGE = 'https://images.pexels.com/photos/1181772/pexels-photo-1181772.jpeg?auto=compress&cs=tinysrgb&w=1260';
const PEXELS_SMALL = 'https://images.pexels.com/photos/1181772/pexels-photo-1181772.jpeg?auto=compress&w=650';
const UNSPLASH_REG = 'https://images.unsplash.com/photo-1523240795612-9a054b0db644?ixlib=rb-4.0&w=1080';
const UNSPLASH_SM  = 'https://images.unsplash.com/photo-1523240795612-9a054b0db644?w=400';

test('stockPhotoKeys keys a Pexels photo by id and image path', () => {
  const keys = stockPhotoKeys({ id: 'pexels_1181772', provider: 'pexels', url: PEXELS_LARGE });
  assert.deepStrictEqual(keys, [
    'id:pexels:1181772',
    'img:images.pexels.com/photos/1181772/pexels-photo-1181772.jpeg',
  ]);
});

test('two sizes of the same Pexels photo share keys', () => {
  const a = stockPhotoKeys({ id: 'pexels_1181772', provider: 'pexels', url: PEXELS_LARGE });
  const b = stockPhotoKeys({ id: '1181772', provider: 'pexels', url: PEXELS_SMALL });
  assert.deepStrictEqual(a, b);
});

test('a Pexels photo is recognised from its URL alone (no id)', () => {
  const keys = stockPhotoKeys({ provider: 'pexels', url: PEXELS_SMALL });
  assert.ok(keys.includes('id:pexels:1181772'), 'id recovered from the image path');
  assert.ok(keys.includes('img:images.pexels.com/photos/1181772/pexels-photo-1181772.jpeg'));
});

test('two sizes of the same Unsplash photo share the path key', () => {
  const fromSearch = stockPhotoKeys({ id: 'unsplash_n7a2OJDSZns', provider: 'unsplash', url: UNSPLASH_REG });
  const fromLegacy = stockPhotoKeys({ provider: 'unsplash', url: UNSPLASH_SM });
  assert.ok(fromSearch.includes('id:unsplash:n7a2OJDSZns'));
  const shared = fromSearch.filter((k) => fromLegacy.includes(k));
  assert.deepStrictEqual(shared, ['img:images.unsplash.com/photo-1523240795612-9a054b0db644']);
});

test('non-stock images produce no keys', () => {
  assert.deepStrictEqual(stockPhotoKeys({ provider: 'ai', url: 'https://cdn.example/ai.png' }), []);
  assert.deepStrictEqual(stockPhotoKeys({ provider: 'pexels', url: 'data:image/jpeg;base64,AAA' }), []);
  assert.deepStrictEqual(stockPhotoKeys(null), []);
  assert.deepStrictEqual(stockPhotoKeys({}), []);
});

test('heroAsStockPhoto only claims stock heroes', () => {
  assert.ok(heroAsStockPhoto({ heroImageUrl: PEXELS_LARGE, heroImageType: 'pexels' }));
  assert.strictEqual(heroAsStockPhoto({ heroImageUrl: 'https://cdn/x.png', heroImageType: 'ai' }), null);
  assert.strictEqual(heroAsStockPhoto({ heroImageUrl: 'data:image/jpeg;base64,A', heroImageType: 'upload' }), null);
  assert.strictEqual(heroAsStockPhoto({ heroImageUrl: null, heroImageType: 'pexels' }), null);
  // Legacy items typed 'category-fallback' etc. carry a provider in the credit only.
  const fromCredit = heroAsStockPhoto({
    heroImageUrl: UNSPLASH_REG, heroImageType: null, heroImageCredit: { provider: 'unsplash' },
  });
  assert.strictEqual(fromCredit?.provider, 'unsplash');
});

test('heroAsStockPhoto prefers the stored provider photo id', () => {
  const photo = heroAsStockPhoto({
    heroImageUrl: UNSPLASH_REG, heroImageType: 'unsplash', heroImagePhotoId: 'unsplash_n7a2OJDSZns',
  });
  assert.ok(stockPhotoKeys(photo).includes('id:unsplash:n7a2OJDSZns'));
});

test('coverAsStockPhoto only claims stock covers', () => {
  assert.ok(coverAsStockPhoto({ coverImageUrl: PEXELS_LARGE, coverSource: 'stock', coverCredit: { provider: 'pexels' } }));
  assert.strictEqual(coverAsStockPhoto({ coverImageUrl: PEXELS_LARGE, coverSource: 'generated', coverCredit: null }), null);
  assert.strictEqual(coverAsStockPhoto({ coverImageUrl: null, coverSource: 'stock' }), null);
});
