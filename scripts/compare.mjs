// Compare dist/ with iptv-org's published playlists, to confirm this build
// still produces the same channel lists as the original.
//
//   node scripts/compare.mjs              every playlist both have
//   node scripts/compare.mjs countries/dk.m3u languages/dan.m3u

import { readFile, readdir } from 'node:fs/promises';

const ORIGINAL = 'https://iptv-org.github.io/iptv';
const urls = (text) => new Set(text.split(/\r?\n/).filter((l) => l && !l.startsWith('#')));

// Only the database part is comparable; extra sources are ours alone.
const api = JSON.parse(await readFile('dist/api/streams.json', 'utf8'));
const fromDb = new Set(api.filter((s) => s.source === 'iptv-org').map((s) => s.url));

let files = process.argv.slice(2);
if (!files.length) {
  files = (await readdir('dist', { recursive: true }))
    .filter((f) => f.endsWith('.m3u') && !f.startsWith('working') && !f.startsWith('sources') && f !== 'mine.m3u');
}

const results = [];
const queue = [...files];
async function worker() {
  while (queue.length) {
    const f = queue.shift();
    let res;
    for (let i = 0; i < 3 && !res; i++) {
      res = await fetch(`${ORIGINAL}/${f}`, { signal: AbortSignal.timeout(20000) }).catch(() => null);
    }
    if (!res) { results.push({ f, error: 'could not fetch' }); continue; }
    if (!res.ok) { results.push({ f, onlyMine: true }); continue; }
    const orig = urls(await res.text());
    const mine = new Set([...urls(await readFile(`dist/${f}`, 'utf8'))].filter((u) => fromDb.has(u)));
    results.push({
      f, orig: orig.size, mine: mine.size,
      missing: [...orig].filter((u) => !mine.has(u)).length,
      extra: [...mine].filter((u) => !orig.has(u)).length,
    });
  }
}
await Promise.all(Array.from({ length: 8 }, worker));

const compared = results.filter((r) => r.orig !== undefined);
const same = compared.filter((r) => r.missing + r.extra <= 5);
console.log(`${compared.length} playlists compared, ${same.length} match`);
console.log('(up to 5 streams of difference counts as a match: the original updates during the day)\n');
for (const r of compared.filter((r) => r.missing + r.extra > 5)) {
  console.log(`  differs  ${r.f}: original ${r.orig}, mine ${r.mine}, missing ${r.missing}, extra ${r.extra}`);
}
const only = results.filter((r) => r.onlyMine).length;
if (only) console.log(`  ${only} playlists exist only here (channels from the extra sources)`);
for (const r of results.filter((r) => r.error)) console.log(`  error    ${r.f}: ${r.error}`);
