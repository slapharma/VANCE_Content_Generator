import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseRssItems, filterNewItems, fetchSources, parseNewsNowHeadlines } from './fetch.js';

// ── parseRssItems ─────────────────────────────────────────────────────────────

describe('parseRssItems', () => {
  it('extracts title, url, and pubDate from RSS XML', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Test Article</title>
      <link>https://example.com/article</link>
      <pubDate>Thu, 01 Jan 2026 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

    const items = parseRssItems(xml);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'Test Article');
    assert.equal(items[0].url, 'https://example.com/article');
    assert.ok(items[0].pubDate instanceof Date);
    assert.equal(items[0].pubDate.getFullYear(), 2026);
    assert.equal(items[0].rawText, '');
  });

  it('handles CDATA-wrapped titles', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <title><![CDATA[CDATA Title & Special <chars>]]></title>
      <link>https://example.com/cdata</link>
      <pubDate>Fri, 02 Jan 2026 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

    const items = parseRssItems(xml);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, 'CDATA Title & Special <chars>');
    assert.equal(items[0].url, 'https://example.com/cdata');
  });

  it('returns empty array for XML with no items', () => {
    const xml = `<?xml version="1.0"?><rss><channel></channel></rss>`;
    const items = parseRssItems(xml);
    assert.deepEqual(items, []);
  });

  it('handles multiple items', () => {
    const xml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Article One</title>
      <link>https://example.com/one</link>
      <pubDate>Thu, 01 Jan 2026 00:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Article Two</title>
      <link>https://example.com/two</link>
      <pubDate>Fri, 02 Jan 2026 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

    const items = parseRssItems(xml);
    assert.equal(items.length, 2);
    assert.equal(items[0].title, 'Article One');
    assert.equal(items[1].title, 'Article Two');
  });
});

// ── filterNewItems ────────────────────────────────────────────────────────────

describe('filterNewItems', () => {
  const items = [
    { title: 'Old', url: 'https://example.com/old', pubDate: new Date('2025-01-01'), rawText: '' },
    { title: 'New', url: 'https://example.com/new', pubDate: new Date('2026-06-01'), rawText: '' },
    { title: 'Newer', url: 'https://example.com/newer', pubDate: new Date('2026-12-01'), rawText: '' },
  ];

  it('filters items older than lastRunAt', () => {
    const filtered = filterNewItems(items, '2026-01-01T00:00:00Z');
    assert.equal(filtered.length, 2);
    assert.equal(filtered[0].title, 'New');
    assert.equal(filtered[1].title, 'Newer');
  });

  it('returns all items when lastRunAt is null', () => {
    const filtered = filterNewItems(items, null);
    assert.equal(filtered.length, 3);
  });

  it('returns all items when lastRunAt is undefined', () => {
    const filtered = filterNewItems(items, undefined);
    assert.equal(filtered.length, 3);
  });

  it('returns empty array when all items are older than lastRunAt', () => {
    const filtered = filterNewItems(items, '2027-01-01T00:00:00Z');
    assert.equal(filtered.length, 0);
  });
});

// ── fetchSources ──────────────────────────────────────────────────────────────

describe('fetchSources', () => {
  it('with RSS source returns mapped items using mock fetch', async () => {
    const rssXml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Mocked RSS Item</title>
      <link>https://example.com/mocked</link>
      <pubDate>Thu, 01 Jan 2026 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

    const mockFetch = async () => ({
      ok: true,
      text: async () => rssXml,
    });

    const sources = [{ type: 'rss', url: 'https://example.com/feed.rss' }];
    const results = await fetchSources(sources, null, mockFetch);

    assert.equal(results.items.length, 1);
    assert.equal(results.items[0].title, 'Mocked RSS Item');
    assert.equal(results.items[0].url, 'https://example.com/mocked');
    assert.equal(results.items[0].sourceType, 'rss');
  });

  it('skips failed sources and continues with others (non-fatal)', async () => {
    const rssXml = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <item>
      <title>Good Source Item</title>
      <link>https://good.com/item</link>
      <pubDate>Thu, 01 Jan 2026 00:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;

    let callCount = 0;
    const mockFetch = async (url) => {
      callCount++;
      if (url.includes('bad')) {
        return { ok: false, status: 500 };
      }
      return {
        ok: true,
        text: async () => rssXml,
      };
    };

    const sources = [
      { type: 'rss', url: 'https://bad.com/feed.rss' },
      { type: 'rss', url: 'https://good.com/feed.rss' },
    ];

    const results = await fetchSources(sources, null, mockFetch);

    // Should only have results from the good source
    assert.equal(results.items.length, 1);
    assert.equal(results.items[0].title, 'Good Source Item');
  });

  it('warns and skips unsupported source types', async () => {
    const mockFetch = async () => ({ ok: true, text: async () => '' });
    const sources = [{ type: 'unknown', url: 'https://example.com' }];
    const results = await fetchSources(sources, null, mockFetch);
    assert.equal(results.items.length, 0);
  });
});

// ── parseNewsNowHeadlines ────────────────────────────────────────────────────

describe('parseNewsNowHeadlines', () => {
  // Trimmed but structurally faithful excerpt of a real NewsNow topic page.
  const newsNowHtml = `
<div class="hl " data-id="1320709706">
   <span class="f f_US" c="US"></span>
   <div class="hl__inner"><a class="hll" href="https://c.newsnow.co.uk/A/1320709706?-58627:47757" target="_blank" rel="nofollow">Disease-Specific immune trajectories identified years before IBD onset</a> <span class="meta"><span class="src src-part" data-pub="CLIPAINADVISOR">Clinical Pain Advisor<i class="fas fa-cog"></i></span><span class="time" data-time="1785769615">16:06</span></span><span class="favtags"></span></div>
</div>
<div class="hl hl_inv" data-id="1320311426">
   <span class="f f_US" c="US"></span>
   <div class="hl__inner"><a class="hll" href="https://c.newsnow.co.uk/A/1320311426?-58627:47757" target="_blank" rel="nofollow">Crohn disease linked to increased risk for periprosthetic joint Infection</a> <span class="meta"><span class="src src-part" data-pub="CLIPAINADVISOR">Clinical Pain Advisor<i class="fas fa-cog"></i></span><span class="time" data-time="1785336143">15:42</span></span><span class="favtags"></span></div>
</div>`;

  it('extracts title, redirect url, publisher, and pubDate for each headline', () => {
    const items = parseNewsNowHeadlines(newsNowHtml);
    assert.equal(items.length, 2);
    assert.equal(items[0].title, 'Disease-Specific immune trajectories identified years before IBD onset');
    assert.equal(items[0].url, 'https://c.newsnow.co.uk/A/1320709706?-58627:47757');
    assert.equal(items[0].publisher, 'Clinical Pain Advisor');
    assert.ok(items[0].pubDate instanceof Date);
    assert.equal(items[1].title, 'Crohn disease linked to increased risk for periprosthetic joint Infection');
  });

  it('dedupes headlines that appear more than once (e.g. "most read" rails)', () => {
    const items = parseNewsNowHeadlines(newsNowHtml + newsNowHtml);
    assert.equal(items.length, 2);
  });

  it('returns an empty array when the page has no headline markup', () => {
    assert.deepEqual(parseNewsNowHeadlines('<html><body>no headlines here</body></html>'), []);
  });
});

// ── fetchSources: NewsNow ('url' source pointed at newsnow.co.uk) ───────────

describe('fetchSources with a NewsNow url source', () => {
  const topicPageHtml = `
<div class="hl " data-id="111">
   <div class="hl__inner"><a class="hll" href="https://c.newsnow.co.uk/A/111?x" target="_blank" rel="nofollow">Real story with a reachable publisher</a> <span class="meta"><span class="src src-part" data-pub="PUB1">Publisher One<i class="fas fa-cog"></i></span><span class="time" data-time="1785769615">16:06</span></span></div>
</div>
<div class="hl " data-id="222">
   <div class="hl__inner"><a class="hll" href="https://c.newsnow.co.uk/A/222?x" target="_blank" rel="nofollow">Story whose publisher blocks the fetch</a> <span class="meta"><span class="src src-part" data-pub="PUB2">Publisher Two<i class="fas fa-cog"></i></span><span class="time" data-time="1785769615">16:06</span></span></div>
</div>`;

  // NewsNow's click-tracking redirector doesn't send an HTTP redirect — it
  // serves this "loading" interstitial with the real URL embedded in a JS var,
  // then bounces client-side. The fetcher has to read that var itself.
  const interstitial = (destUrl) => `<script>var clickthroughConfig = { url: '${destUrl}', delay: 1000 };</script>`;

  it('parses each headline as a separate item and enriches from the real publisher page', async () => {
    const mockFetch = async (url) => {
      if (url.includes('newsnow.co.uk/h/')) return { ok: true, text: async () => topicPageHtml };
      if (url === 'https://c.newsnow.co.uk/A/111?x') return { ok: true, text: async () => interstitial('https://publisher-one.example/story') };
      if (url === 'https://c.newsnow.co.uk/A/222?x') return { ok: true, text: async () => interstitial('https://publisher-two.example/story') };
      if (url === 'https://publisher-one.example/story') {
        return { ok: true, url, text: async () => `<html><body>${'Real article body text. '.repeat(20)}</body></html>` };
      }
      if (url === 'https://publisher-two.example/story') throw new Error('blocked');
      throw new Error(`unexpected fetch: ${url}`);
    };

    const sources = [{ type: 'url', url: 'https://www.newsnow.co.uk/h/Lifestyle/Health/Gastrointestinal+Diseases' }];
    const results = await fetchSources(sources, null, mockFetch);

    // Only the reachable publisher's headline survives — the blocked one has
    // no usable text and is dropped rather than passed through empty.
    assert.equal(results.items.length, 1);
    assert.equal(results.items[0].title, 'Real story with a reachable publisher');
    assert.equal(results.items[0].url, 'https://publisher-one.example/story');
    assert.equal(results.items[0].sourceType, 'newsnow');
    assert.ok(results.items[0].rawText.includes('Real article body text.'));
  });
});
