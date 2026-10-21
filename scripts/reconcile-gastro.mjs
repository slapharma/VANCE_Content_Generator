// Reconcile the "Blog Approved Titles_3rdJune2026" rule (Gastro/IBD Living) to
// reality: the N articles that actually sit in the pipeline.
//
//   • rule.stats.articlesGenerated / articlesPublished -> recomputed from the
//     live content records that belong to this rule (the content reset wiped
//     content but left the stale cumulative counters behind).
//   • consumedTitles -> the source titles that produced those pipeline articles,
//     so the next run skips them and the source-files view shows them processed.
//
// Dry run by default. Pass --apply to write.

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
if (!KV_URL || !KV_TOKEN) {
  console.error('KV_REST_API_URL and KV_REST_API_TOKEN must be set (run with: node --env-file=.env.local scripts/reconcile-gastro.mjs)');
  process.exit(1);
}
const RULE_KEY = 'automation:rule:rule_0102c605-e526-4e28-9720-6af838abd66d';
const APPLY    = process.argv.includes('--apply');

async function kvGet(key) {
  const r = await fetch(`${KV_URL}/get/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
  const j = await r.json();
  // A failed read must stop the run, not look like a missing record: the stats
  // written by --apply would otherwise undercount.
  if (!r.ok || j.error) throw new Error(`GET ${key} failed: ${r.status} ${JSON.stringify(j)}`);
  return j.result;
}
async function kvSet(key, obj) {
  const r = await fetch(`${KV_URL}/set/${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'text/plain' },
    body: JSON.stringify(obj),
  });
  return (await r.json()).result;
}
async function kvScan(pattern) {
  // Cursor stays a STRING: Upstash cursors exceed Number.MAX_SAFE_INTEGER, so
  // parseInt/Number would round them and the next page would be wrong or empty.
  const keys = []; let cursor = '0';
  do {
    const r = await fetch(`${KV_URL}/scan/${cursor}?match=${encodeURIComponent(pattern)}&count=300`, { headers: { Authorization: `Bearer ${KV_TOKEN}` } });
    const j = await r.json();
    if (!Array.isArray(j.result)) throw new Error('SCAN failed: ' + JSON.stringify(j));
    cursor = String(j.result[0]);
    keys.push(...j.result[1]);
  } while (cursor !== '0');
  return [...new Set(keys)]; // SCAN may return a key on more than one page

}
function parse(v) { if (v == null) return null; if (typeof v === 'object') return v; try { return JSON.parse(v); } catch { return null; } }

// ── 1. Load the rule ──────────────────────────────────────────────────────────
const rule = parse(await kvGet(RULE_KEY));
if (!rule) { console.error('Rule not found / unparseable'); process.exit(1); }
const RULE_ID = rule.id;
console.log('Rule:', rule.name, '| id:', RULE_ID, '| category:', rule.category);
console.log('Current stats:', JSON.stringify(rule.stats || {}));

// ── 2. Find live content for this rule ──────────────────────────────────────────
const contentKeys = await kvScan('content:*');
const mine = [];
const unreadable = [];
for (const k of contentKeys) {
  if (k === 'content:index') continue;
  const c = parse(await kvGet(k));
  if (!c) { unreadable.push(k); continue; }
  if (c.automationRuleId === RULE_ID) mine.push(c);
}
if (unreadable.length) console.log(`\n${unreadable.length} content key(s) were empty or unparseable: ${unreadable.join(', ')}`);
console.log(`\nLive content records for this rule: ${mine.length}`);
for (const c of mine) {
  console.log(`  - [${c.status}] "${c.title}"  src="${c.sourceDocName || ''}"`);
}
const publishedCount = mine.filter(c => c.status === 'auto_published' || c.status === 'published').length;

// ── 3. Map each article back to its source title ─────────────────────────────────
// Upload rows live in src.rows[].title / src.titlesOnly. The exact source title is
// the trailing segment of sourceDocName ("file.xlsx — Some Title") or, failing a
// filename prefix, the whole sourceDocName; fall back to the article title.
const uploadSources = (rule.sources || []).filter(s => s && s.type === 'upload');
const allSourceTitles = new Set();
for (const s of uploadSources) {
  (Array.isArray(s.rows) ? s.rows : []).forEach(r => r && r.title && allSourceTitles.add(r.title));
  (Array.isArray(s.titlesOnly) ? s.titlesOnly : []).forEach(t => t && allSourceTitles.add(t));
}
function deriveSourceTitle(c) {
  const candidates = [];
  if (c.sourceDocName) {
    const dash = c.sourceDocName.lastIndexOf(' — ');
    candidates.push(dash >= 0 ? c.sourceDocName.slice(dash + 3).trim() : c.sourceDocName.trim());
    candidates.push(c.sourceDocName.trim());
  }
  candidates.push((c.title || '').trim());
  for (const cand of candidates) if (allSourceTitles.has(cand)) return cand;
  return null; // no exact match against known source titles
}
const matched = [];
const unmatched = [];
for (const c of mine) {
  const t = deriveSourceTitle(c);
  if (t) matched.push(t); else unmatched.push(c.title);
}
console.log(`\nMatched ${matched.length} article(s) to source titles:`);
matched.forEach(t => console.log('   ✓', t));
if (unmatched.length) {
  console.log(`\n${unmatched.length} article(s) could NOT be matched to a source title (will not be marked consumed):`);
  unmatched.forEach(t => console.log('   ✗', t));
}

// ── 4. Compute the reconciled rule ──────────────────────────────────────────────
const newConsumed = uploadSources.map(s => {
  const existing = Array.isArray(s.consumedTitles) ? s.consumedTitles : [];
  const titlesInThisSource = new Set([
    ...(Array.isArray(s.rows) ? s.rows.map(r => r && r.title).filter(Boolean) : []),
    ...(Array.isArray(s.titlesOnly) ? s.titlesOnly : []),
  ]);
  const additions = [...new Set(matched)].filter(t => titlesInThisSource.has(t) && !existing.includes(t));
  return { src: s, additions, resulting: [...existing, ...additions] };
});

console.log('\n── Proposed changes ─────────────────────────────────────');
console.log(`stats.articlesGenerated: ${rule.stats?.articlesGenerated ?? 0}  ->  ${mine.length}`);
console.log(`stats.articlesPublished: ${rule.stats?.articlesPublished ?? 0}  ->  ${publishedCount}`);
newConsumed.forEach((nc, i) => {
  console.log(`source[${i}] "${nc.src.originalFilename || nc.src.url || 'upload'}" consumedTitles: +${nc.additions.length} (total ${nc.resulting.length})`);
  nc.additions.forEach(t => console.log('      +', t));
});

if (!APPLY) {
  console.log('\nDRY RUN — re-run with --apply to write these changes.');
  process.exit(0);
}

// ── 5. Apply ─────────────────────────────────────────────────────────────────────
if (unreadable.length) {
  console.error('\nRefusing to --apply: some content records could not be read, so the counts may be low.');
  process.exit(1);
}
// Re-read the rule right before writing, so a run that finished during the
// content scan (totalRuns, lastRunAt, new consumedTitles) is not overwritten
// by the snapshot from step 1. Only stats and consumedTitles are changed.
const fresh = parse(await kvGet(RULE_KEY));
if (!fresh) { console.error('Rule vanished before write'); process.exit(1); }
const additionsAll = new Set(newConsumed.flatMap(nc => nc.additions));
for (const s of (fresh.sources || [])) {
  if (!s || s.type !== 'upload') continue;
  const inSource = new Set([
    ...(Array.isArray(s.rows) ? s.rows.map(r => r && r.title).filter(Boolean) : []),
    ...(Array.isArray(s.titlesOnly) ? s.titlesOnly : []),
  ]);
  const existing = Array.isArray(s.consumedTitles) ? s.consumedTitles : [];
  s.consumedTitles = [...new Set([...existing, ...[...additionsAll].filter(t => inSource.has(t))])];
}
fresh.stats = { ...fresh.stats, articlesGenerated: mine.length, articlesPublished: publishedCount };
fresh.updatedAt = new Date().toISOString();
const w = await kvSet(RULE_KEY, fresh);
console.log('\nKV write:', w);
if (w !== 'OK') { console.error('KV write did not return OK'); process.exit(1); }

// Verify
const v = parse(await kvGet(RULE_KEY));
console.log('Verify stats:', JSON.stringify(v.stats));
const vConsumed = (v.sources || []).filter(s => s.type === 'upload').reduce((n, s) => n + (s.consumedTitles?.length || 0), 0);
console.log('Verify total consumedTitles across upload sources:', vConsumed);
console.log('Done.');
