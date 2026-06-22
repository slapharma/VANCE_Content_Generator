/**
 * check-dup-prose.mjs
 * Pulls every content item from live KV and checks whether any two articles
 * share duplicate BODY PROSE (not just duplicate titles).
 *
 * Reports three things per suspicious pair:
 *   - normalized-body exact match
 *   - Jaccard similarity over word-5-grams (shingles)
 *   - count of identical paragraphs shared between the two bodies
 *
 *   node scripts/check-dup-prose.mjs
 */

const KV_URL   = 'https://nearby-werewolf-76207.upstash.io';
const KV_TOKEN = 'gQAAAAAAASmvAAIncDI3MjExMjExZWM1NGE0MGNlYjYxNzZiODg1ODEzNWY5MnAyNzYyMDc';

async function rest(path) {
  const r = await fetch(`${KV_URL}${path}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  if (!r.ok) throw new Error(`KV ${r.status}: ${await r.text()}`);
  return r.json();
}
const g = async k => (await rest(`/get/${encodeURIComponent(k)}`)).result;
const parse = v => { try { return typeof v === 'object' ? v : JSON.parse(v); } catch { return null; } };
async function scan(pat) {
  let c = 0, ks = [];
  do { const j = await rest(`/scan/${c}?match=${encodeURIComponent(pat)}&count=400`); c = parseInt(j.result[0], 10); ks.push(...j.result[1]); } while (c !== 0);
  return ks;
}

// strip html tags, collapse whitespace, lowercase
const stripHtml = s => (s || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;/gi, ' ');
const normWords = s => stripHtml(s).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
const normText  = s => normWords(s).join(' ');

function shingles(words, n = 5) {
  const set = new Set();
  for (let i = 0; i + n <= words.length; i++) set.add(words.slice(i, i + n).join(' '));
  return set;
}
function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, big] = a.size < b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}
// split body into paragraphs (by block tags / blank lines), normalized
function paragraphs(body) {
  return stripHtml((body || '').replace(/<\/(p|div|h[1-6]|li|blockquote)>/gi, '\n'))
    .split(/\n+/).map(p => normText(p)).filter(p => p.split(' ').length >= 8); // ignore tiny fragments
}

(async () => {
  const cKeys = (await scan('content:*')).filter(k => k !== 'content:index');
  const items = [];
  for (const k of cKeys) { const c = parse(await g(k)); if (c && c.id) items.push(c); }

  console.log(`\nLoaded ${items.length} content items from KV.\n`);

  // Precompute
  const docs = items.map(c => {
    const words = normWords(c.body);
    return {
      id: c.id,
      title: (c.title || '').slice(0, 70),
      createdAt: c.createdAt,
      wordCount: words.length,
      norm: words.join(' '),
      shingles: shingles(words, 5),
      paras: new Set(paragraphs(c.body)),
    };
  });

  // empty/very-short bodies are worth flagging too
  const shorties = docs.filter(d => d.wordCount < 50);

  // Identify cross-article boilerplate: any paragraph appearing in >=4 articles
  // (disclaimers, CTAs, footers). Exclude these from "shared content" scoring.
  const paraFreq = new Map();
  for (const d of docs) for (const p of d.paras) paraFreq.set(p, (paraFreq.get(p) || 0) + 1);
  const boilerplate = new Set([...paraFreq].filter(([, n]) => n >= 4).map(([p]) => p));
  for (const d of docs) d.uniqueParas = new Set([...d.paras].filter(p => !boilerplate.has(p)));

  const pairs = [];
  for (let i = 0; i < docs.length; i++) {
    for (let j = i + 1; j < docs.length; j++) {
      const a = docs[i], b = docs[j];
      const exact = a.norm.length > 0 && a.norm === b.norm;
      const jac = jaccard(a.shingles, b.shingles);
      let sharedParas = 0;
      const [small, big] = a.uniqueParas.size < b.uniqueParas.size ? [a.uniqueParas, b.uniqueParas] : [b.uniqueParas, a.uniqueParas];
      for (const p of small) if (big.has(p)) sharedParas++;
      // Real duplication only: high shingle overlap, OR multiple shared non-boilerplate paragraphs
      if (exact || jac >= 0.30 || sharedParas >= 2) {
        pairs.push({ a, b, exact, jac, sharedParas });
      }
    }
  }

  pairs.sort((x, y) => (y.exact - x.exact) || (y.jac - x.jac) || (y.sharedParas - x.sharedParas));

  console.log(`Detected ${boilerplate.size} shared boilerplate paragraphs (excluded from scoring).\n`);
  console.log(`=== DUPLICATE / NEAR-DUPLICATE pairs (exact | Jaccard>=0.30 | >=2 shared non-boilerplate paras): ${pairs.length} ===\n`);
  for (const p of pairs) {
    const tag = p.exact ? 'EXACT-DUP' : p.jac >= 0.7 ? 'NEAR-DUP' : p.jac >= 0.3 ? 'HIGH-OVERLAP' : 'PARTIAL';
    console.log(`[${tag}] jaccard=${p.jac.toFixed(3)} sharedUniqueParas=${p.sharedParas}`);
    console.log(`   A ${p.a.id} (${p.a.wordCount}w) "${p.a.title}"`);
    console.log(`   B ${p.b.id} (${p.b.wordCount}w) "${p.b.title}"`);
  }

  if (shorties.length) {
    console.log(`\n=== Suspiciously short / empty bodies (<50 words): ${shorties.length} ===`);
    shorties.forEach(d => console.log(`   ${d.id} (${d.wordCount}w) "${d.title}"`));
  }

  if (!pairs.length) console.log('No duplicate or near-duplicate body prose detected. ✅');
  console.log('');
})().catch(e => { console.error(e); process.exit(1); });
