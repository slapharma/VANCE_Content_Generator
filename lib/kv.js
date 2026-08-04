// lib/kv.js
// Drop-in replacement for @vercel/kv that namespaces all keys with KV_PREFIX.
// Set KV_PREFIX=vance in Vercel env vars to isolate this project's data when
// sharing a Redis database with another project. If KV_PREFIX is unset the
// wrapper is transparent — same behaviour as @vercel/kv directly.

import { kv as _kv } from '@vercel/kv';

const PREFIX = process.env.KV_PREFIX ? `${process.env.KV_PREFIX}:` : '';

function p(key) {
  return `${PREFIX}${key}`;
}

export const kv = {
  // strings
  get:    (key)                    => _kv.get(p(key)),
  set:    (key, value, opts)       => _kv.set(p(key), value, ...(opts ? [opts] : [])),
  del:    (key)                    => _kv.del(p(key)),
  mget:   (...keys)                => _kv.mget(...keys.map(p)),
  keys:   (pattern)                => _kv.keys(p(pattern)),
  // lists
  lpush:  (key, ...values)         => _kv.lpush(p(key), ...values),
  rpush:  (key, ...values)         => _kv.rpush(p(key), ...values),
  lrange: (key, start, stop)       => _kv.lrange(p(key), start, stop),
  llen:   (key)                    => _kv.llen(p(key)),
  ltrim:  (key, start, stop)       => _kv.ltrim(p(key), start, stop),
  lrem:   (key, count, value)      => _kv.lrem(p(key), count, value),
  // sets (used by the one-use-only stock-image ledger)
  sadd:       (key, ...members)    => _kv.sadd(p(key), ...members),
  srem:       (key, ...members)    => _kv.srem(p(key), ...members),
  sismember:  (key, member)        => _kv.sismember(p(key), member),
  smismember: (key, members)       => _kv.smismember(p(key), members),
  smembers:   (key)                => _kv.smembers(p(key)),
  scard:      (key)                => _kv.scard(p(key)),
  // sorted sets (used by social cron queue)
  zadd:          (key, ...args)              => _kv.zadd(p(key), ...args),
  zrange:        (key, start, stop, opts)    => _kv.zrange(p(key), start, stop, ...(opts ? [opts] : [])),
  // There is no `zrangebyscore` on @upstash/redis — the standalone ZRANGEBYSCORE
  // command was deprecated in Redis 6.2 in favour of `ZRANGE ... BYSCORE`, and
  // the client only ever implemented the latter. This wrapper had been exposing
  // a method that did not exist underneath it, so every call threw
  // `_kv.zrangebyscore is not a function` at runtime. Same command, same
  // ascending-by-score result; it just has to be spelled as an option.
  zrangebyscore: (key, min, max, opts)       => _kv.zrange(p(key), min, max, { ...(opts || {}), byScore: true }),
  zrem:          (key, ...members)           => _kv.zrem(p(key), ...members),
};
