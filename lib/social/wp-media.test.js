// Alt text on uploaded media. Plain `node --test`, with fetch replaced by a
// recorder, so nothing reaches WordPress.
//
// What these lock down: a hero with NO credit (an AI image, or the category
// fallback) still gets alt text on its WP media item. Before this, alt_text was
// written only inside `if (credit?.plain)`, so those heroes were published with
// none, and 76 posts from Oct-Nov 2026 had to be back-filled by hand.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import { uploadImageBufferToWp, altFromTitle } from './wp-media.js';

const realFetch = globalThis.fetch;
let calls;

beforeEach(() => {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    if (init.method === 'POST' && String(url).endsWith('/wp-json/wp/v2/media')) {
      return { ok: true, json: async () => ({ id: 77, source_url: 'https://x/y.jpg' }), text: async () => '' };
    }
    return { ok: true, json: async () => ({}), text: async () => '' };
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const base = { filename: 'a-hero.jpg', siteUrl: 'https://wp.test', authHeader: 'Basic x', logPrefix: 'test' };
const metaCalls = () => calls.filter(c => c.url.endsWith('/wp-json/wp/v2/media/77'));

test('no credit and an alt: alt_text is written (the regression)', async () => {
  const out = await uploadImageBufferToWp(Buffer.from('x'), { ...base, alt: 'A clinician reviewing a chart' });
  assert.deepStrictEqual(out, { id: 77, url: 'https://x/y.jpg' });
  assert.strictEqual(metaCalls().length, 1);
  const body = JSON.parse(metaCalls()[0].init.body);
  assert.strictEqual(body.alt_text, 'A clinician reviewing a chart');
  assert.ok(!('caption' in body) && !('description' in body), 'no credit, so no caption or description');
});

test('credit and an alt: alt_text is the alt, credit goes to caption and description', async () => {
  await uploadImageBufferToWp(Buffer.from('x'), {
    ...base, alt: 'Gut health', credit: { plain: 'Photo by A on Unsplash', html: '<a>A</a>' },
  });
  const body = JSON.parse(metaCalls()[0].init.body);
  assert.strictEqual(body.alt_text, 'Gut health');
  assert.strictEqual(body.caption, '<a>A</a>');
  assert.strictEqual(body.description, '<a>A</a>');
});

test('credit and no alt: behaves as before (credit line is the alt)', async () => {
  await uploadImageBufferToWp(Buffer.from('x'), { ...base, credit: { plain: 'Photo by A on Pexels' } });
  const body = JSON.parse(metaCalls()[0].init.body);
  assert.strictEqual(body.alt_text, 'Photo by A on Pexels');
  assert.strictEqual(body.caption, 'Photo by A on Pexels');
});

test('no credit and no alt: no metadata request at all', async () => {
  await uploadImageBufferToWp(Buffer.from('x'), base);
  assert.strictEqual(metaCalls().length, 0);
});

test('a failed metadata write does not lose the image', async () => {
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith('/wp-json/wp/v2/media')) {
      return { ok: true, json: async () => ({ id: 77, source_url: 'https://x/y.jpg' }), text: async () => '' };
    }
    throw new Error('network down');
  };
  const out = await uploadImageBufferToWp(Buffer.from('x'), { ...base, alt: 'Something' });
  assert.deepStrictEqual(out, { id: 77, url: 'https://x/y.jpg' });
});

test('altFromTitle: empty, short, long, and whitespace', () => {
  assert.strictEqual(altFromTitle(''), '');
  assert.strictEqual(altFromTitle(null), '');
  assert.strictEqual(altFromTitle('  Gut   health  '), 'Gut health');
  const long = 'Dual-targeting drug shows promise in Crohn’s disease after a large extended phase two trial across many centres in Europe';
  const out = altFromTitle(long);
  assert.ok(out.length <= 125, `length ${out.length}`);
  assert.ok(long.startsWith(out), 'cut is a prefix of the title');
  assert.ok(!/[\s,;:\-]$/.test(out), 'no dangling punctuation');
});
