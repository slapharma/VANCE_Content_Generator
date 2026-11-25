import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import handler from './run.js';
import { kv } from '../../kv.js';

// generateArticle is not exported, so these tests drive the default handler through its
// fetchFn seam, the same way api/automation/run-lock.test.js does. kv is an in-memory fake.
// Every fetch is recorded. PubMed calls go to eutils. Any other URL is the LLM, and the stub
// makes the LLM call throw, so the test sees whether generation reached the model at all.

const RULE_ID = 'rule_bib';
const RULE_NAME = 'Clinical review rule';
const RULE_KEY = `automation:rule:${RULE_ID}`;
const LOCK_KEY = `automation:rule:${RULE_ID}:run-lock`;
const CLEAR_PROMPTS_FLAG = 'migration:clear-rule-prompts:v1';
const BACKFILL_FLAG = 'migration:backfill-pending-jobs:v1';
const BIB_ID = 'bib1';
const PAPER_ID = 'paper1';
const PAPER_TITLE = 'A trial of something';
const PMID = '98765';
const DOI = '10.1234/test.2024.001';
const EUTILS_HOST = 'eutils.ncbi.nlm.nih.gov';

const LONG_ABSTRACT = 'Background: Chronic gut inflammation is common and often under-treated. Methods: In this randomised trial, 120 adults received the study product or placebo for twelve weeks. The primary endpoint was the change in faecal calprotectin from baseline. Results: Calprotectin fell by 35 percent in the active arm compared with 4 percent in the placebo arm (p = 0.01). Adverse events were mild and similar between the two arms. Conclusions: The product reduced intestinal inflammatory markers over twelve weeks in this small trial.';

const REAL_KV = { ...kv };
const ORIGINAL_ENV = { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY, OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY };

let state;

function resetState() {
  state = { values: new Map(), lists: new Map() };
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

const fakeKv = {
  async get(key) {
    return state.values.has(key) ? clone(state.values.get(key)) : null;
  },
  // Redis SET NX: refuses when the key already exists, and returns null in that case.
  async set(key, value, opts) {
    if (opts?.nx && state.values.has(key)) return null;
    state.values.set(key, clone(value));
    return 'OK';
  },
  async del(key) {
    state.values.delete(key);
    return 1;
  },
  async lrange(key) {
    return [...(state.lists.get(key) ?? [])];
  },
  async lpush(key, ...values) {
    const list = state.lists.get(key) ?? [];
    list.unshift(...values);
    state.lists.set(key, list);
    return list.length;
  },
  async ltrim(key, start, stop) {
    const list = state.lists.get(key) ?? [];
    state.lists.set(key, list.slice(start, stop + 1));
    return 'OK';
  },
};

function ruleFixture() {
  return {
    id: RULE_ID,
    name: RULE_NAME,
    enabled: true,
    category: 'clinical-review',
    sources: [{ type: 'bibliography', bibId: BIB_ID, mode: 'all' }],
    generation: { maxArticlesPerRun: 1, model: 'test/model-a', prompt: 'Write a clinical review.' },
    stats: {},
  };
}

function storePaper(paper) {
  state.values.set(`bibliography:${BIB_ID}`, { id: BIB_ID, name: 'Test bibliography' });
  state.lists.set(`bibliography:papers:${BIB_ID}`, [PAPER_ID]);
  state.values.set(`bibliography:paper:${PAPER_ID}`, clone(paper));
}

function fakeRes() {
  const res = { statusCode: null, body: undefined };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

beforeEach(() => {
  resetState();
  Object.assign(kv, fakeKv);
  // Only the OpenRouter key is set, so every non-Claude model goes to OpenRouter and not Anthropic.
  delete process.env.ANTHROPIC_API_KEY;
  process.env.OPENROUTER_API_KEY = 'test-key';
  // Both one-shot migrations are marked done, so they write nothing during these runs.
  state.values.set(CLEAR_PROMPTS_FLAG, { at: '2026-01-01T00:00:00.000Z', cleared: 0 });
  state.values.set(BACKFILL_FLAG, { at: '2026-01-01T00:00:00.000Z', added: 0, scanned: 0 });
  state.values.set(RULE_KEY, ruleFixture());
});

afterEach(() => {
  Object.assign(kv, REAL_KV);
  if (ORIGINAL_ENV.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = ORIGINAL_ENV.ANTHROPIC_API_KEY;
  if (ORIGINAL_ENV.OPENROUTER_API_KEY === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = ORIGINAL_ENV.OPENROUTER_API_KEY;
});

describe('bibliography item with no abstract', () => {
  it('refuses to generate and never calls the LLM', async () => {
    // Arrange: the stored paper has no abstract, and PubMed cannot be reached.
    storePaper({
      id: PAPER_ID, title: PAPER_TITLE, authors: ['Karłowicz K'], journal: 'Journal of Test Medicine',
      year: 2024, doi: DOI, url: '', pmid: '', abstract: '', processed: false, addedAt: '2026-01-01T00:00:00.000Z',
    });
    const calls = [];
    const fetchFn = async (url) => { calls.push(String(url)); throw new Error(`network down: ${url}`); };
    const res = fakeRes();

    // Act
    await handler({ method: 'POST', body: { ruleId: RULE_ID } }, res, { fetchFn });

    // Assert
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.processed, 0);
    assert.equal(res.body.errors.length, 1);
    assert.ok(res.body.errors[0].includes(`No abstract available for "${PAPER_TITLE}"`), res.body.errors[0]);
    assert.deepEqual(calls.filter(u => !u.includes(EUTILS_HOST)), []);
  });
});

describe('bibliography item with an abstract', () => {
  it('sends the paper to the LLM, so the refusal above is specific to the missing abstract', async () => {
    // Arrange: the stored paper already holds a full abstract and PMID, so no PubMed call is needed.
    storePaper({
      id: PAPER_ID, title: PAPER_TITLE, authors: ['Karłowicz K'], journal: 'Journal of Test Medicine',
      year: 2024, doi: DOI, url: '', pmid: PMID, abstract: LONG_ABSTRACT, processed: false, addedAt: '2026-01-01T00:00:00.000Z',
    });
    const calls = [];
    const fetchFn = async (url) => { calls.push(String(url)); throw new Error('stub LLM reached'); };
    const res = fakeRes();

    // Act
    await handler({ method: 'POST', body: { ruleId: RULE_ID } }, res, { fetchFn });

    // Assert
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].includes(EUTILS_HOST), calls[0]);
    assert.equal(res.body.errors.length, 1);
    assert.ok(res.body.errors[0].includes('stub LLM reached'), res.body.errors[0]);
  });
});
