import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isCronRequest, isInternalRequest, internalHeaders, internalSecret } from './api-auth.js';

const withEnv = async (vars, fn) => {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
};

const req = (headers = {}) => ({ headers });

test('an unset secret never authenticates anything', async () => {
  // The failure mode this guards: with `===`, a missing CRON_SECRET turns
  // `headers['x-cron'] === ''` into a match, so *omitting* the header would
  // authenticate as an internal call on any misconfigured deployment.
  await withEnv({ CRON_SECRET: undefined, INTERNAL_API_SECRET: undefined }, () => {
    assert.equal(internalSecret(), '');
    assert.equal(isCronRequest(req({})), false);
    assert.equal(isCronRequest(req({ authorization: 'Bearer ' })), false);
    assert.equal(isCronRequest(req({ authorization: 'Bearer undefined' })), false);
    assert.equal(isInternalRequest(req({})), false);
    assert.equal(isInternalRequest(req({ 'x-cron': '' })), false);
    assert.equal(isInternalRequest(req({ 'x-internal-secret': '' })), false);
    assert.deepEqual(internalHeaders(), {});
  });
});

test('cron is recognised only with the exact bearer token', async () => {
  await withEnv({ CRON_SECRET: 's3cr3t' }, () => {
    assert.equal(isCronRequest(req({ authorization: 'Bearer s3cr3t' })), true);
    assert.equal(isCronRequest(req({ authorization: 'Bearer s3cr3T' })), false);
    assert.equal(isCronRequest(req({ authorization: 's3cr3t' })), false);
    assert.equal(isCronRequest(req({ authorization: 'Bearer s3cr3t extra' })), false);
    assert.equal(isCronRequest(req({})), false);
  });
});

test('internal calls are recognised on either header', async () => {
  await withEnv({ CRON_SECRET: 's3cr3t', INTERNAL_API_SECRET: undefined }, () => {
    assert.equal(isInternalRequest(req({ 'x-internal-secret': 's3cr3t' })), true);
    assert.equal(isInternalRequest(req({ 'x-cron': 's3cr3t' })), true); // legacy, from api/cron/publish.js
    assert.equal(isInternalRequest(req({ 'x-internal-secret': 'nope' })), false);
    assert.deepEqual(internalHeaders(), { 'x-internal-secret': 's3cr3t' });
  });
});

test('INTERNAL_API_SECRET takes precedence but cron stays on CRON_SECRET', async () => {
  await withEnv({ CRON_SECRET: 'cron-one', INTERNAL_API_SECRET: 'internal-one' }, () => {
    assert.equal(isInternalRequest(req({ 'x-internal-secret': 'internal-one' })), true);
    assert.equal(isInternalRequest(req({ 'x-internal-secret': 'cron-one' })), false);
    assert.equal(isCronRequest(req({ authorization: 'Bearer cron-one' })), true);
  });
});
