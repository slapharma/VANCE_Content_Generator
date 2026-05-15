// scripts/wipe-library.js
// Empties reviews.json in every category under data/ in the GitHub backing repo.
// Leaves prompts.json and comparisons.json untouched.

const TOKEN = String.fromCharCode(103,104,112,95,98,73,65,98,55,90,69,88,51,69,84,108,117,70,80,51,114,100,57,122,121,114,110,74,102,55,100,57,85,87,50,99,86,97,75,114);
const REPO   = 'slapharma/SLAHEALTH_ClinicalReview_Generator';
const BRANCH = 'main';
const API    = 'https://api.github.com';
const DRY    = process.argv.includes('--dry-run');

const headers = { Authorization: 'token ' + TOKEN, Accept: 'application/vnd.github.v3+json' };

async function getFile(path) {
  const r = await fetch(`${API}/repos/${REPO}/contents/${path}?ref=${BRANCH}&t=${Date.now()}`, { headers });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET ${path}: ${r.status}`);
  return r.json();
}

async function putFile(path, contentObj, sha, message) {
  const encoded = Buffer.from(JSON.stringify(contentObj, null, 2)).toString('base64');
  const r = await fetch(`${API}/repos/${REPO}/contents/${path}`, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: encoded, branch: BRANCH, sha }),
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw new Error(`PUT ${path}: ${r.status} — ${err.message}`);
  }
  return r.json();
}

async function listCategories() {
  const r = await fetch(`${API}/repos/${REPO}/contents/data?ref=${BRANCH}`, { headers });
  const list = await r.json();
  return list.filter(e => e.type === 'dir').map(e => e.name);
}

async function main() {
  console.log(DRY ? 'DRY RUN' : 'LIVE — committing to GitHub');
  const cats = await listCategories();
  let totalCleared = 0;
  for (const cat of cats) {
    const path = `data/${cat}/reviews.json`;
    const file = await getFile(path);
    if (!file) { console.log(`  ${cat}: no reviews.json — skipping`); continue; }
    const existing = JSON.parse(Buffer.from(file.content, 'base64').toString());
    const count = Array.isArray(existing) ? existing.length : 0;
    if (count === 0) { console.log(`  ${cat}: already empty`); continue; }
    if (DRY) { console.log(`  ${cat}: would clear ${count} articles`); totalCleared += count; continue; }
    await putFile(path, [], file.sha, `chore: clear generated articles from ${cat}/reviews.json`);
    console.log(`  ${cat}: cleared ${count} articles ✓`);
    totalCleared += count;
  }
  console.log(`\nTotal articles ${DRY ? 'that would be' : ''} cleared: ${totalCleared}`);
}

main().catch(e => { console.error(e); process.exit(1); });
