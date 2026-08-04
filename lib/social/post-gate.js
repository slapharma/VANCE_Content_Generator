// lib/social/post-gate.js
//
// A spacing gate for Instagram posts that works ACROSS serverless invocations.
//
// Every article publish runs in its own invocation and fires its own carousel
// post (api/publish/index.js defers carouselOnPublish), so nothing inside a
// single process can space them out. On 2026-08-04 roughly twenty articles
// published together: ~120 slide images were offered to Meta's crawler inside
// ninety seconds, and fifteen decks came back with "Only photo or video can be
// accepted as media type" (9004/2207052) — Meta's generic "I could not fetch
// that URL". Decks either side of the burst posted fine, and every slide URL
// served 200 image/jpeg afterwards, so the images were never the problem: the
// burst was.
//
// The gate is a KV key that only one invocation can create at a time and that
// NOTHING deletes — it expires on its own after `gapMs`, so the next poster can
// start only once that window has elapsed. Holding by expiry rather than by
// release is deliberate: an invocation that dies mid-post cannot wedge the gate
// shut, which a released lock would risk.
//
// The wait is bounded. Blocking a publish invocation indefinitely would trade
// one failure mode for a worse one (a function timeout), so once maxWaitMs is
// up the caller proceeds ungated and leans on the retry in
// instagram-carousel.js instead.

import { kv } from '../kv.js';

const GATE_KEY   = 'social:gate:instagram';
const GAP_MS     = 15_000;
const MAX_WAIT_MS = 45_000;
const POLL_MS    = 2_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for this invocation's turn to post.
 *
 * Never throws: a gate that cannot be reached must not stop a post going out.
 *
 * @param {object} [opts]
 * @param {number} [opts.gapMs] - minimum spacing between two post starts
 * @param {number} [opts.maxWaitMs] - give up waiting after this and post anyway
 * @returns {Promise<{gated: boolean, waitedMs: number, reason?: string}>}
 *   `gated: true` means we hold the window; `false` means we are going ahead
 *   without it, with `reason` saying why.
 */
export async function acquirePostGate({ gapMs = GAP_MS, maxWaitMs = MAX_WAIT_MS } = {}) {
  const startedAt = Date.now();
  const deadline = startedAt + maxWaitMs;

  for (;;) {
    try {
      // NX so only the first caller in the window wins; PX so the window closes
      // by itself. @vercel/kv returns 'OK' on success and null when the key
      // already exists.
      const won = await kv.set(GATE_KEY, new Date().toISOString(), { nx: true, px: gapMs });
      if (won) return { gated: true, waitedMs: Date.now() - startedAt };
    } catch (err) {
      // KV down — spacing is an optimisation, posting is the job.
      return { gated: false, waitedMs: Date.now() - startedAt, reason: `gate unavailable: ${err.message}` };
    }

    if (Date.now() + POLL_MS > deadline) {
      return { gated: false, waitedMs: Date.now() - startedAt, reason: 'gate busy — proceeding ungated' };
    }
    await sleep(POLL_MS);
  }
}
