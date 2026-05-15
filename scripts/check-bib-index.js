import { kv } from '@vercel/kv';

const idx = await kv.lrange('bibliography:index', 0, -1);
console.log('Raw bibliography:index contents:', idx);

const survivor = await kv.get('bibliography:bib_08c25ba4-9a36-4eed-9518-5310dd6ae7dc');
console.log('IBD Treatment Guidelines record:', survivor ? `EXISTS (${survivor.paperCount} papers)` : 'MISSING');

const papers = await kv.lrange('bibliography:papers:bib_08c25ba4-9a36-4eed-9518-5310dd6ae7dc', 0, -1);
console.log('Its paper-list length:', papers.length);

const allBibKeys = await kv.keys('bibliography:bib_*');
console.log('All bibliography:bib_* keys in KV:', allBibKeys);
