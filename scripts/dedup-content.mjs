/**
 * dedup-content.mjs
 * Removes duplicate articles created by overlapping/concurrent automation runs.
 * Groups content by normalized title; keeps the NEWEST copy per title (latest
 * createdAt) and deletes the older siblings — along with their automation:job
 * records and their entries in content:index / automation:jobs:index.
 *
 *   node scripts/dedup-content.mjs            — dry run (shows the plan)
 *   node scripts/dedup-content.mjs --delete   — actually delete
 */

const KV_URL   = 'https://nearby-werewolf-76207.upstash.io';
const KV_TOKEN = 'gQAAAAAAASmvAAIncDI3MjExMjExZWM1NGE0MGNlYjYxNzZiODg1ODEzNWY5MnAyNzYyMDc';
const DRY_RUN  = !process.argv.includes('--delete');

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
const lrem = (key, val) => rest(`/lrem/${encodeURIComponent(key)}/0/${encodeURIComponent(val)}`);
const del  = (key)      => rest(`/del/${encodeURIComponent(key)}`);

(async () => {
  console.log(`\n=== Content dedup ${DRY_RUN ? '[DRY RUN]' : '[LIVE DELETE]'} ===\n`);

  // 1. Load all content, group by normalized title.
  const cKeys = (await scan('content:*')).filter(k => k !== 'content:index');
  const items = [];
  for (const k of cKeys) { const c = parse(await g(k)); if (c && c.id) items.push(c); }

  const groups = {};
  for (const c of items) {
    const key = (c.title || '').replace(/^Gastro Living:\s*/i, '').trim().toLowerCase();
    (groups[key] = groups[key] || []).push(c);
  }

  // 2. For each duplicate group keep newest createdAt, mark the rest for deletion.
  const deleteContentIds = new Set();
  const keepers = [];
  for (const arr of Object.values(groups)) {
    if (arr.length === 1) { keepers.push(arr[0]); continue; }
    arr.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    keepers.push(arr[0]);
    arr.slice(1).forEach(c => deleteContentIds.add(c.id));
  }

  // 3. Find automation jobs that point at a doomed content id.
  const jKeys = await scan('automation:job:*');
  const deleteJobIds = [];
  for (const k of jKeys) {
    const j = parse(await g(k));
    if (j && j.contentId && deleteContentIds.has(j.contentId)) deleteJobIds.push(j.id);
  }

  console.log(`Content items:            ${items.length}`);
  console.log(`Distinct titles:          ${Object.keys(groups).length}`);
  console.log(`Duplicate copies to DELETE: ${deleteContentIds.size}`);
  console.log(`Associated jobs to DELETE:  ${deleteJobIds.length}`);
  console.log(`Articles remaining after:   ${items.length - deleteContentIds.size}\n`);

  console.log('Keeping (one per title):');
  keepers.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  keepers.forEach(c => console.log(`  KEEP  ${c.id}  ${(c.title || '').slice(0, 64)}  [${c.createdAt}]`));

  if (DRY_RUN) {
    console.log('\nDry run — no changes. Re-run with --delete to apply.');
    return;
  }

  // 4. Delete duplicate content + remove from content:index.
  let done = 0;
  for (const id of deleteContentIds) {
    await lrem('content:index', id);
    await del(`content:${id}`);
    done++;
  }
  console.log(`\nDeleted ${done} duplicate content records.`);

  // 5. Delete associated jobs + remove from jobs index.
  let jdone = 0;
  for (const id of deleteJobIds) {
    await lrem('automation:jobs:index', id);
    await del(`automation:job:${id}`);
    jdone++;
  }
  console.log(`Deleted ${jdone} associated job records.`);
  console.log('Done.');
})().catch(e => { console.error(e); process.exit(1); });
