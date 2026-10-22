import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chatCompletion, hasTextProviderKey } from './llm-provider.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// ── env save/restore ─────────────────────────────────────────────────────────

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY'];
let savedEnv;

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(k => [k, process.env[k]]));
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function setKeys({ anthropic, openrouter }) {
  if (anthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = anthropic;
  if (openrouter === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = openrouter;
}

// ── fetch doubles ────────────────────────────────────────────────────────────

// Records every call. respond(callNumber) returns the Response (or throws).
function recordingFetch(respond) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url: String(url), init });
    return respond(calls.length);
  };
  return { fetchFn, calls };
}

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

const ANTHROPIC_OK = {
  id: 'msg_test_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4-5',
  content: [{ type: 'text', text: 'Hello from Claude' }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 12, output_tokens: 7 },
};

const OPENROUTER_OK = {
  choices: [{ message: { role: 'assistant', content: 'Hello from OpenRouter' } }],
};

const CLAUDE_REQUEST = {
  model: 'anthropic/claude-sonnet-4.5',
  messages: [{ role: 'user', content: 'Write a hook' }],
  max_tokens: 500,
};

// ── Claude slug with ANTHROPIC_API_KEY set ───────────────────────────────────

describe('chatCompletion: Claude slug with ANTHROPIC_API_KEY set', () => {
  it('sends the request to the Anthropic messages endpoint', async () => {
    setKeys({ anthropic: 'sk-ant-test', openrouter: 'or-test' });
    const { fetchFn, calls } = recordingFetch(() => jsonResponse(200, ANTHROPIC_OK));

    await chatCompletion({ ...CLAUDE_REQUEST, fetchFn });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, ANTHROPIC_URL);
  });

  it('uses the native Anthropic model ID in the request body', async () => {
    setKeys({ anthropic: 'sk-ant-test', openrouter: 'or-test' });
    const { fetchFn, calls } = recordingFetch(() => jsonResponse(200, ANTHROPIC_OK));

    await chatCompletion({ ...CLAUDE_REQUEST, fetchFn });

    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, 'claude-sonnet-4-5');
  });

  it('does not send temperature to Anthropic even when the caller passes one', async () => {
    setKeys({ anthropic: 'sk-ant-test', openrouter: 'or-test' });
    const { fetchFn, calls } = recordingFetch(() => jsonResponse(200, ANTHROPIC_OK));

    await chatCompletion({ ...CLAUDE_REQUEST, temperature: 0.7, fetchFn });

    const body = JSON.parse(calls[0].init.body);
    assert.equal(Object.hasOwn(body, 'temperature'), false);
  });

  it('moves the system message to the top-level system field', async () => {
    setKeys({ anthropic: 'sk-ant-test', openrouter: 'or-test' });
    const { fetchFn, calls } = recordingFetch(() => jsonResponse(200, ANTHROPIC_OK));

    await chatCompletion({
      model: 'anthropic/claude-sonnet-4.5',
      messages: [
        { role: 'system', content: 'You are a medical copywriter.' },
        { role: 'user', content: 'Write a hook' },
      ],
      fetchFn,
    });

    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.system, 'You are a medical copywriter.');
    assert.deepEqual(body.messages, [{ role: 'user', content: 'Write a hook' }]);
  });

  it('maps the Anthropic text reply to choices[0].message.content', async () => {
    setKeys({ anthropic: 'sk-ant-test', openrouter: 'or-test' });
    const { fetchFn } = recordingFetch(() => jsonResponse(200, ANTHROPIC_OK));

    const result = await chatCompletion({ ...CLAUDE_REQUEST, fetchFn });

    assert.equal(result.choices[0].message.content, 'Hello from Claude');
  });

  it('maps Anthropic token usage to prompt_tokens and completion_tokens', async () => {
    setKeys({ anthropic: 'sk-ant-test', openrouter: 'or-test' });
    const { fetchFn } = recordingFetch(() => jsonResponse(200, ANTHROPIC_OK));

    const result = await chatCompletion({ ...CLAUDE_REQUEST, fetchFn });

    assert.equal(result.usage.prompt_tokens, 12);
    assert.equal(result.usage.completion_tokens, 7);
  });
});

// ── Claude slug without ANTHROPIC_API_KEY ────────────────────────────────────

describe('chatCompletion: Claude slug without ANTHROPIC_API_KEY', () => {
  it('routes the request to OpenRouter', async () => {
    setKeys({ anthropic: undefined, openrouter: 'or-test' });
    const { fetchFn, calls } = recordingFetch(() => jsonResponse(200, OPENROUTER_OK));

    await chatCompletion({ ...CLAUDE_REQUEST, fetchFn });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, OPENROUTER_URL);
  });

  it('authorizes the OpenRouter request with OPENROUTER_API_KEY', async () => {
    setKeys({ anthropic: undefined, openrouter: 'or-test-key' });
    const { fetchFn, calls } = recordingFetch(() => jsonResponse(200, OPENROUTER_OK));

    await chatCompletion({ ...CLAUDE_REQUEST, fetchFn });

    assert.equal(calls[0].init.headers.Authorization, 'Bearer or-test-key');
  });

  it('keeps the OpenRouter slug in the body', async () => {
    setKeys({ anthropic: undefined, openrouter: 'or-test' });
    const { fetchFn, calls } = recordingFetch(() => jsonResponse(200, OPENROUTER_OK));

    await chatCompletion({ ...CLAUDE_REQUEST, fetchFn });

    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.model, 'anthropic/claude-sonnet-4.5');
  });

  it('passes temperature through to OpenRouter', async () => {
    setKeys({ anthropic: undefined, openrouter: 'or-test' });
    const { fetchFn, calls } = recordingFetch(() => jsonResponse(200, OPENROUTER_OK));

    await chatCompletion({ ...CLAUDE_REQUEST, temperature: 0.7, fetchFn });

    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.temperature, 0.7);
  });
});

// ── Unknown and non-Claude slugs ─────────────────────────────────────────────

describe('chatCompletion: slugs that are not in the Anthropic map', () => {
  it('sends an unlisted anthropic slug to OpenRouter even when ANTHROPIC_API_KEY is set', async () => {
    setKeys({ anthropic: 'sk-ant-test', openrouter: 'or-test' });
    const { fetchFn, calls } = recordingFetch(() => jsonResponse(200, OPENROUTER_OK));

    await chatCompletion({ ...CLAUDE_REQUEST, model: 'anthropic/claude-made-up', fetchFn });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, OPENROUTER_URL);
  });

  it('sends a non-Claude slug to OpenRouter even when ANTHROPIC_API_KEY is set', async () => {
    setKeys({ anthropic: 'sk-ant-test', openrouter: 'or-test' });
    const { fetchFn, calls } = recordingFetch(() => jsonResponse(200, OPENROUTER_OK));

    await chatCompletion({ ...CLAUDE_REQUEST, model: 'google/gemma-3-27b-it:free', fetchFn });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, OPENROUTER_URL);
  });
});

// ── Anthropic failure paths ──────────────────────────────────────────────────

describe('chatCompletion: Anthropic failure paths', () => {
  it('returns error code 429 when Anthropic rate-limits the request', async () => {
    setKeys({ anthropic: 'sk-ant-test', openrouter: 'or-test' });
    const { fetchFn } = recordingFetch(() => jsonResponse(429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } },
      { 'retry-after-ms': '1' }));

    const result = await chatCompletion({ ...CLAUDE_REQUEST, fetchFn });

    assert.equal(result.error.code, 429);
    assert.equal(result.choices, undefined);
  });

  it('returns error code 529 when Anthropic is overloaded', async () => {
    setKeys({ anthropic: 'sk-ant-test', openrouter: 'or-test' });
    const { fetchFn } = recordingFetch(() => jsonResponse(529,
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
      { 'retry-after-ms': '1' }));

    const result = await chatCompletion({ ...CLAUDE_REQUEST, fetchFn });

    assert.equal(result.error.code, 529);
  });

  it('returns error code 400 for a rejected request', async () => {
    setKeys({ anthropic: 'sk-ant-test', openrouter: 'or-test' });
    const { fetchFn } = recordingFetch(() => jsonResponse(400,
      { type: 'error', error: { type: 'invalid_request_error', message: 'bad request' } }));

    const result = await chatCompletion({ ...CLAUDE_REQUEST, fetchFn });

    assert.equal(result.error.code, 400);
  });

  it('does not retry a 400 from Anthropic', async () => {
    setKeys({ anthropic: 'sk-ant-test', openrouter: 'or-test' });
    const { fetchFn, calls } = recordingFetch(() => jsonResponse(400,
      { type: 'error', error: { type: 'invalid_request_error', message: 'bad request' } }));

    await chatCompletion({ ...CLAUDE_REQUEST, fetchFn });

    assert.equal(calls.length, 1);
  });

  it('does not retry a 429 itself (the caller chain falls through instead)', async () => {
    setKeys({ anthropic: 'sk-ant-test', openrouter: 'or-test' });
    const { fetchFn, calls } = recordingFetch(() => jsonResponse(429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'Rate limited' } },
      { 'retry-after-ms': '1' }));

    await chatCompletion({ ...CLAUDE_REQUEST, fetchFn });

    assert.equal(calls.length, 1);
  });

  it('returns a 503 when max_tokens is spent with no text', async () => {
    setKeys({ anthropic: 'sk-ant-test', openrouter: 'or-test' });
    const { fetchFn } = recordingFetch(() => jsonResponse(200, {
      ...ANTHROPIC_OK,
      content: [{ type: 'thinking', thinking: '' }],
      stop_reason: 'max_tokens',
    }));

    const result = await chatCompletion({ ...CLAUDE_REQUEST, fetchFn });

    assert.equal(result.error.code, 503);
    assert.equal(result.choices, undefined);
  });

  it('reports a truncated reply with finish_reason length', async () => {
    setKeys({ anthropic: 'sk-ant-test', openrouter: 'or-test' });
    const { fetchFn } = recordingFetch(() => jsonResponse(200, { ...ANTHROPIC_OK, stop_reason: 'max_tokens' }));

    const result = await chatCompletion({ ...CLAUDE_REQUEST, fetchFn });

    assert.equal(result.choices[0].finish_reason, 'length');
  });

  it('returns error code refusal when stop_reason is refusal', async () => {
    setKeys({ anthropic: 'sk-ant-test', openrouter: 'or-test' });
    const { fetchFn } = recordingFetch(() => jsonResponse(200, {
      ...ANTHROPIC_OK,
      content: [],
      stop_reason: 'refusal',
      stop_details: { category: 'cyber' },
    }));

    const result = await chatCompletion({ ...CLAUDE_REQUEST, fetchFn });

    assert.equal(result.error.code, 'refusal');
    assert.equal(result.choices, undefined);
  });

  it('names the refusal category in the refusal error message', async () => {
    setKeys({ anthropic: 'sk-ant-test', openrouter: 'or-test' });
    const { fetchFn } = recordingFetch(() => jsonResponse(200, {
      ...ANTHROPIC_OK,
      content: [],
      stop_reason: 'refusal',
      stop_details: { category: 'cyber' },
    }));

    const result = await chatCompletion({ ...CLAUDE_REQUEST, fetchFn });

    assert.equal(result.error.message, 'Claude declined the request (cyber)');
  });

  it('returns a 503 when fetch throws, so the chain falls through', async () => {
    setKeys({ anthropic: 'sk-ant-test', openrouter: 'or-test' });
    const { fetchFn } = recordingFetch(() => { throw new TypeError('fetch failed'); });

    const result = await chatCompletion({ ...CLAUDE_REQUEST, fetchFn });

    assert.equal(result.error.code, 503);
  });

  it('returns no-key without calling OpenRouter when its key is unset', async () => {
    setKeys({ anthropic: 'sk-ant-test' });
    const { fetchFn, calls } = recordingFetch(() => jsonResponse(200, {}));

    const result = await chatCompletion({ model: 'google/gemma-3-27b-it', messages: [{ role: 'user', content: 'x' }], fetchFn });

    assert.equal(result.error.code, 'no-key');
    assert.equal(calls.length, 0);
  });
});

// ── hasTextProviderKey ───────────────────────────────────────────────────────

describe('hasTextProviderKey', () => {
  it('returns true when only ANTHROPIC_API_KEY is set', () => {
    setKeys({ anthropic: 'sk-ant-test', openrouter: undefined });
    assert.equal(hasTextProviderKey(), true);
  });

  it('returns true when only OPENROUTER_API_KEY is set', () => {
    setKeys({ anthropic: undefined, openrouter: 'or-test' });
    assert.equal(hasTextProviderKey(), true);
  });

  it('returns false when neither key is set', () => {
    setKeys({ anthropic: undefined, openrouter: undefined });
    assert.equal(hasTextProviderKey(), false);
  });
});
