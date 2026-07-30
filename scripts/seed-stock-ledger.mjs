// scripts/seed-stock-ledger.mjs
//
// Backfill the one-use-only stock-photo ledger (lib/social/stock-ledger.js) from
// everything that already uses a Pexels/Unsplash photo: article heroes and promo
// campaign covers. Run this ONCE after deploying the ledger — without it the
// ledger starts empty, so a photo already published on the site is still fair game
// for the next article.
//
// Usage:
//   cd C:\Users\clift\Ai-Projects\VANCE-Content-Generator
//   vercel env pull .env.local
//   node --env-file=.env.local scripts/seed-stock-ledger.mjs            # dry run
//   node --env-file=.env.local scripts/seed-stock-ledger.mjs --write    # record them
//
// Safe to re-run: the ledger is a set, so re-seeding is a no-op for anything
// already in it.

import { kv } from '../lib/kv.js';
import {
  STOCK_USED_KEY, stockPhotoKeys, heroAsStockPhoto, coverAsStockPhoto, stockLedgerSize,
} from '../lib/social/stock-ledger.js';
import { PROMO_INDEX, promoKey } from '../lib/social/promo-store.js';

const WRITE = process.argv.includes('--write');

async function collectHeroes() {
  const ids = await kv.lrange('content:index', 0, -1);
  const photos = [];
  let scanned = 0;
  for (const id of ids) {
    const item = await kv.get(`content:${id}`);
    if (!item) continue;
    scanned++;
    const photo = heroAsStockPhoto(item);
    if (photo) photos.push({ photo, label: `${item.heroImageType} — ${item.title || id}` });
  }
  return { photos, scanned };
}

async function collectCovers() {
  const ids = (await kv.lrange(PROMO_INDEX, 0, -1)) || [];
  const photos = [];
  let scanned = 0;
  for (const id of ids) {
    const promo = await kv.get(promoKey(id));
    if (!promo) continue;
    scanned++;
    const photo = coverAsStockPhoto(promo);
    if (photo) photos.push({ photo, label: `cover — ${promo.name || id}` });
  }
  return { photos, scanned };
}

async function main() {
  console.log(WRITE ? 'LIVE — recording used photos' : 'DRY RUN — nothing will be written');
  console.log(`KV_PREFIX  : "${process.env.KV_PREFIX || '(none)'}"`);
  console.log(`Ledger key : ${STOCK_USED_KEY}`);
  console.log(`Ledger now : ${await stockLedgerSize()} key(s)\n`);

  const heroes = await collectHeroes();
  const covers = await collectCovers();
  const found = [...heroes.photos, ...covers.photos];

  console.log(`Articles scanned : ${heroes.scanned} (${heroes.photos.length} stock hero(es))`);
  console.log(`Campaigns scanned: ${covers.scanned} (${covers.photos.length} stock cover(s))`);

  const keys = [...new Set(found.flatMap((f) => stockPhotoKeys(f.photo)))];
  console.log(`Ledger keys      : ${keys.length}\n`);

  for (const { photo, label } of found) {
    console.log(`  ${photo.provider.padEnd(8)} ${String(photo.url).slice(0, 90)}  ← ${label}`);
  }

  if (!keys.length) {
    console.log('\nNothing to seed.');
    return;
  }
  if (!WRITE) {
    console.log('\nRe-run with --write to record these as used.');
    return;
  }
  // One SADD rather than one per photo: the whole point is a single set membership,
  // and Upstash charges per command.
  await kv.sadd(STOCK_USED_KEY, ...keys);
  console.log(`\nDone. Ledger now holds ${await stockLedgerSize()} key(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
