import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// GOLDEN_DIR set, to any value, means "the data is required". An empty value
// (an unset CI variable) resolves to a folder that does not exist, so each
// test fails. It never falls back to a skip.
const ENV_DIR = process.env.GOLDEN_DIR;
const DATA_REQUIRED = ENV_DIR !== undefined;
const HERE = fileURLToPath(new URL('.', import.meta.url));
const DIR = DATA_REQUIRED ? (ENV_DIR === '' ? path.join(HERE, 'GOLDEN_DIR-is-empty') : ENV_DIR) : HERE;
const DATA_FOLDERS = ['articles', 'sources', 'heroes'];

// The data (articles/, sources/, heroes/) is not in git: the repository is
// public. A checkout without the data skips these tests with a clear reason.
// When GOLDEN_DIR is set, the data must be there: a missing folder is a failure.
// A partial set (one or two of the three folders) is also a failure, not a skip.
const SKIP =
  !DATA_REQUIRED && !DATA_FOLDERS.some((sub) => fs.existsSync(path.join(DIR, sub)))
    ? 'golden-set data is not in this checkout: set GOLDEN_DIR to a folder that has it (see README.md)'
    : false;

function golden(name, fn) {
  test(name, { skip: SKIP }, fn);
}

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const MIN_HERO_BYTES = 100 * 1024;
// The set must not shrink without a deliberate change to these numbers.
const MIN_ARTICLES = 9;
const MIN_SOURCES = 12;
const MIN_HEROES = 6;
const TEXT_DEFECTS = [1, 2, 3, 4, 5, 6, 7];
const HERO_DEFECTS = [8, 9, 10];
// Defect 4 is "empty body, no numbers". It has no sentence to quote.
const NO_QUOTE_DEFECT = 4;

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(DIR, rel), 'utf8'));
}

function readText(rel) {
  return fs.readFileSync(path.join(DIR, rel), 'utf8');
}

function loadManifest() {
  return readJson('manifest.json');
}

function listFiles(sub) {
  return fs.readdirSync(path.join(DIR, sub)).map((name) => sub + '/' + name);
}

// The text of the FIRST element whose tag starts with `open`, or null.
// In a PubMed record the first <PMID> is the record's own id. Later ones
// belong to cited or related papers.
function firstElementText(xml, open) {
  const at = xml.indexOf(open);
  if (at < 0) return null;
  const close = xml.indexOf('>', at);
  const end = xml.indexOf('<', close);
  if (close < 0 || end < 0) return null;
  return xml.slice(close + 1, end).trim();
}

function defectNumbers(doc) {
  const seen = new Set();
  for (const d of doc.defects) seen.add(d.defect);
  return Array.from(seen).sort((a, b) => a - b);
}

function hasDigit(text) {
  for (const ch of text) {
    if (ch >= '0' && ch <= '9') return true;
  }
  return false;
}

golden('the set has its minimum size, with bad and good articles and pass and fail heroes', () => {
  const m = loadManifest();
  assert.ok(m.articles.length >= MIN_ARTICLES, 'too few articles: ' + m.articles.length);
  assert.ok(m.sources.length >= MIN_SOURCES, 'too few sources: ' + m.sources.length);
  assert.ok(m.heroes.length >= MIN_HEROES, 'too few heroes: ' + m.heroes.length);
  assert.ok(m.articles.some((a) => a.variant === 'bad'), 'no bad article');
  assert.ok(m.articles.some((a) => a.variant === 'good'), 'no good article');
  assert.ok(m.heroes.some((h) => h.expected === 'fail'), 'no hero that must fail');
  assert.ok(m.heroes.some((h) => h.expected === 'pass'), 'no hero that must pass');
});

golden('every manifest file exists and is non-empty, and every fixture file is in the manifest', () => {
  const m = loadManifest();
  const named = [];
  for (const a of m.articles) named.push(a.file);
  for (const s of m.sources) named.push(s.file);
  for (const h of m.heroes) named.push(h.file);

  for (const rel of named) {
    const full = path.join(DIR, rel);
    assert.ok(fs.existsSync(full), 'missing file: ' + rel);
    assert.ok(fs.statSync(full).size > 0, 'empty file: ' + rel);
  }

  const listed = new Set(named);
  for (const sub of ['articles', 'sources', 'heroes']) {
    for (const rel of listFiles(sub)) {
      assert.ok(listed.has(rel), 'file not in manifest: ' + rel);
    }
  }
});

golden('each manifest article entry agrees with its article file and its file name', () => {
  const m = loadManifest();
  for (const a of m.articles) {
    const doc = readJson(a.file);
    assert.ok(a.variant === 'bad' || a.variant === 'good', a.file + ' has an unknown variant');
    assert.equal(a.file, 'articles/' + a.id8 + '.' + a.variant + '.json', a.file + ' name does not agree with id8 and variant');
    assert.equal(doc.variant, a.variant, a.file + ' variant differs from the manifest');
    assert.equal(doc.id8, a.id8, a.file + ' id8 differs from the manifest');
    assert.ok(doc.id.startsWith(a.id8), a.file + ' id does not start with its id8');
    assert.equal(doc.sourcePmid, a.sourcePmid, a.file + ' sourcePmid differs from the manifest');
    assert.equal(doc.sourcePmcid, a.sourcePmcid, a.file + ' sourcePmcid differs from the manifest');
    assert.deepEqual(defectNumbers(doc), a.defects.slice().sort((x, y) => x - y), a.file + ' defects differ from the manifest');
    assert.ok(typeof doc.body === 'string' && doc.body.length > 500, a.file + ' has no real body');
  }
});

golden('every defect class 1 to 10 has bad and good files that really are bad and good for that class', () => {
  const m = loadManifest();
  const heroes = new Map(m.heroes.map((h) => [h.file, h]));
  for (const n of TEXT_DEFECTS.concat(HERO_DEFECTS)) {
    const key = String(n);
    const entry = m.coverage[key];
    assert.ok(entry, 'coverage has no entry for defect ' + key);
    assert.ok(entry.bad.length > 0, 'no bad file for defect ' + key);
    assert.ok(entry.good.length > 0, 'no good file for defect ' + key);
    for (const rel of entry.bad.concat(entry.good)) {
      assert.ok(fs.existsSync(path.join(DIR, rel)), 'coverage for defect ' + key + ' lists missing file: ' + rel);
    }
    if (TEXT_DEFECTS.includes(n)) {
      for (const rel of entry.bad) {
        const doc = readJson(rel);
        assert.equal(doc.variant, 'bad', rel + ' is listed as bad for defect ' + key + ' but is not a bad variant');
        assert.ok(doc.defects.some((d) => d.defect === n), rel + ' is listed as bad for defect ' + key + ' but has no such defect');
      }
      for (const rel of entry.good) {
        const doc = readJson(rel);
        assert.equal(doc.variant, 'good', rel + ' is listed as good for defect ' + key + ' but is not a good variant');
        assert.deepEqual(doc.defects, [], rel + ' is listed as good but has defects');
      }
    } else {
      for (const rel of entry.bad) {
        const h = heroes.get(rel);
        assert.ok(h, rel + ' is not a hero in the manifest');
        assert.equal(h.expected, 'fail', rel + ' is listed as bad for defect ' + key + ' but is expected to pass');
        assert.equal(h.defect, n, rel + ' is listed as bad for defect ' + key + ' but has defect ' + h.defect);
      }
      for (const rel of entry.good) {
        const h = heroes.get(rel);
        assert.ok(h, rel + ' is not a hero in the manifest');
        assert.equal(h.expected, 'pass', rel + ' is listed as good for defect ' + key + ' but is expected to fail');
        assert.equal(h.defect, null, rel + ' is listed as good but has a defect');
      }
    }
  }
});

golden('each hero entry is consistent: fail has a hero defect class, pass has none', () => {
  const m = loadManifest();
  for (const h of m.heroes) {
    if (h.expected === 'fail') {
      assert.ok(HERO_DEFECTS.includes(h.defect), h.file + ' must fail but has no hero defect class');
    } else {
      assert.equal(h.expected, 'pass', h.file + ' has an unknown expected value');
      assert.equal(h.defect, null, h.file + ' must pass but has a defect');
    }
    assert.ok(typeof h.note === 'string' && h.note.length > 0, h.file + ' has no note');
  }
});

golden('every bad article has defects, and each quote is a non-empty exact substring of its body', () => {
  const m = loadManifest();
  for (const a of m.articles) {
    if (a.variant !== 'bad') continue;
    const doc = readJson(a.file);
    assert.ok(doc.defects.length > 0, a.file + ' has no defects');
    for (const d of doc.defects) {
      assert.ok(TEXT_DEFECTS.includes(d.defect), a.file + ' has an unknown defect class ' + d.defect);
      assert.ok(typeof d.note === 'string' && d.note.length > 0, a.file + ' defect ' + d.defect + ' has no note');
      if (d.defect === NO_QUOTE_DEFECT) {
        assert.equal(d.quote, null, a.file + ' defect 4 must have a null quote');
        continue;
      }
      assert.ok(typeof d.quote === 'string' && d.quote.length >= 5, a.file + ' defect ' + d.defect + ' has no quote');
      assert.ok(doc.body.includes(d.quote), a.file + ' defect ' + d.defect + ': quote is not in the body');
    }
  }
});

golden('an article with defect 4 has no number in its body outside its wrong citation', () => {
  const m = loadManifest();
  let checked = 0;
  for (const a of m.articles) {
    const doc = readJson(a.file);
    if (!doc.defects.some((d) => d.defect === NO_QUOTE_DEFECT)) continue;
    checked += 1;
    let rest = doc.body;
    for (const d of doc.defects) {
      if (d.defect === 1 && typeof d.quote === 'string') rest = rest.split(d.quote).join('');
    }
    assert.ok(!hasDigit(rest), a.file + ' is marked as an empty body but holds a number outside the citation');
  }
  assert.ok(checked > 0, 'no article has defect 4');
});

golden('good articles have no defects and no quote from the bad variant with the same id8 appears in them', () => {
  const m = loadManifest();
  for (const a of m.articles) {
    if (a.variant !== 'good') continue;
    const good = readJson(a.file);
    assert.deepEqual(good.defects, [], a.file + ' has defects');
    const bad = readJson('articles/' + a.id8 + '.bad.json');
    assert.notEqual(good.body, bad.body, a.file + ' has the same body as its bad variant');
    for (const d of bad.defects) {
      if (d.quote === null) continue;
      assert.ok(!good.body.includes(d.quote), a.file + ' body still contains the bad quote for defect ' + d.defect);
    }
  }
});

golden('each source file holds the record it is named for', () => {
  const m = loadManifest();
  for (const s of m.sources) {
    const xml = readText(s.file);
    if (s.kind === 'pubmed') {
      assert.equal(s.file, 'sources/pubmed_' + s.id + '.xml', s.file + ' name does not agree with its id');
      assert.equal(firstElementText(xml, '<PMID'), s.id, s.file + ' is not the record for PMID ' + s.id);
      assert.ok(xml.includes('<AbstractText'), s.file + ' has no AbstractText');
    } else {
      assert.equal(s.kind, 'pmc', s.file + ' has an unknown kind');
      assert.equal(s.file, 'sources/pmc_' + s.id + '.xml', s.file + ' name does not agree with its id');
      assert.ok(xml.includes('<article-id pub-id-type="pmcid">' + s.id + '<'), s.file + ' is not the record for ' + s.id);
      assert.ok(xml.includes('<body'), s.file + ' has no body element');
    }
  }
});

golden('each article has its source files, and a PMC file is the full text of the same paper', () => {
  const m = loadManifest();
  const sources = new Set(m.sources.map((s) => s.file));
  for (const a of m.articles) {
    const doc = readJson(a.file);
    const pubPath = 'sources/pubmed_' + doc.sourcePmid + '.xml';
    assert.ok(sources.has(pubPath), a.file + ' has no ' + pubPath + ' in the manifest');
    if (doc.sourcePmcid !== null) {
      const pmcPath = 'sources/pmc_' + doc.sourcePmcid + '.xml';
      assert.ok(sources.has(pmcPath), a.file + ' has no ' + pmcPath + ' in the manifest');
      assert.ok(
        readText(pmcPath).includes('<article-id pub-id-type="pmid">' + doc.sourcePmid + '<'),
        pmcPath + ' is not the full text of PMID ' + doc.sourcePmid,
      );
    }
  }
});

golden('citedPmid differs from sourcePmid only for defect-1 articles, and source roles agree', () => {
  const m = loadManifest();
  const correct = new Set();
  const wrong = new Set();
  for (const a of m.articles) {
    const doc = readJson(a.file);
    correct.add(doc.sourcePmid);
    if (doc.defects.some((d) => d.defect === 1)) {
      assert.notEqual(doc.citedPmid, doc.sourcePmid, a.file + ' cites its own source');
      wrong.add(doc.citedPmid);
    } else {
      assert.equal(doc.citedPmid, doc.sourcePmid, a.file + ' cites a different PMID than its source');
    }
  }
  assert.ok(wrong.size > 0, 'no wrongly cited paper in the set');
  const pubmed = m.sources.filter((s) => s.kind === 'pubmed');
  for (const pmid of wrong) {
    assert.ok(pubmed.some((s) => s.id === pmid), 'no PubMed file for the wrongly cited PMID ' + pmid);
  }
  for (const s of pubmed) {
    const want = wrong.has(s.id) ? 'wrongly-cited' : 'correct';
    assert.equal(s.role, want, s.file + ' has the wrong role');
    assert.ok(wrong.has(s.id) || correct.has(s.id), s.file + ' is not used by an article');
  }
});

golden('each hero file starts with JPEG magic bytes and is larger than 100 kB', () => {
  const m = loadManifest();
  for (const h of m.heroes) {
    const buf = fs.readFileSync(path.join(DIR, h.file));
    assert.ok(buf.length > MIN_HERO_BYTES, h.file + ' is not larger than 100 kB');
    assert.ok(buf.subarray(0, 3).equals(JPEG_MAGIC), h.file + ' does not start with FF D8 FF');
  }
});
