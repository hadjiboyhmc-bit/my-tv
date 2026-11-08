// Probe every stream in data/channels.json and record which ones answer.
// A stream counts as working when it returns HTTP 2xx and either looks like
// an HLS playlist (#EXTM3U) or has a video/audio/mpegurl content type.
//
// Usage: node scripts/check.mjs [--country dk]
// Only http(s) streams can be probed; rtmp/mmsh/srt are left unchecked.

import { readFile, writeFile } from 'node:fs/promises';

const config = JSON.parse(await readFile('config.json', 'utf8'));
const { timeoutMs, concurrency } = config.check;
let channels = JSON.parse(await readFile('data/channels.json', 'utf8'))
  .filter((c) => /^https?:\/\//i.test(c.url));

const ci = process.argv.indexOf('--country');
if (ci !== -1) {
  const want = process.argv[ci + 1].toUpperCase();
  channels = channels.filter((c) => c.countries.includes(want));
}

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

async function probe(c) {
  const headers = { 'user-agent': c.userAgent || DEFAULT_UA };
  if (c.referrer) headers.referer = c.referrer;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(c.url, { headers, signal: ctrl.signal, redirect: 'follow' });
    if (!res.ok) return { ok: false, why: `HTTP ${res.status}` };
    const type = res.headers.get('content-type') || '';
    // Read only the first chunk; video streams never end.
    const reader = res.body.getReader();
    const { value } = await reader.read();
    reader.cancel().catch(() => {});
    const head = value ? new TextDecoder().decode(value.slice(0, 64)) : '';
    const ok = head.trimStart().startsWith('#EXTM3U') || /mpegurl|video|audio|octet-stream|mp2t/i.test(type);
    return ok ? { ok: true } : { ok: false, why: `not a stream (${type || 'no type'})` };
  } catch (err) {
    return { ok: false, why: err.name === 'AbortError' ? 'timeout' : (err.cause?.code || err.message) };
  } finally {
    clearTimeout(timer);
  }
}

const results = {};
let done = 0, ok = 0;
const queue = [...channels];
const started = Date.now();

async function worker() {
  while (queue.length) {
    const c = queue.shift();
    const r = await probe(c);
    results[c.url] = r;
    done++;
    if (r.ok) ok++;
    if (done % 250 === 0 || done === channels.length) {
      const s = ((Date.now() - started) / 1000).toFixed(0);
      console.log(`${done}/${channels.length} checked, ${ok} working (${s}s)`);
    }
  }
}
await Promise.all(Array.from({ length: concurrency }, worker));

// Merge with earlier results so a --country run does not wipe the rest.
let previous = {};
try { previous = JSON.parse(await readFile('data/status.json', 'utf8')).results || {}; } catch {}

await writeFile('data/status.json', JSON.stringify({
  checkedAt: new Date().toISOString(),
  results: { ...previous, ...results },
}));

const reasons = {};
for (const r of Object.values(results)) if (!r.ok) reasons[r.why] = (reasons[r.why] || 0) + 1;
console.log(`\nWorking: ${ok} of ${channels.length}`);
console.log('Most common failures:');
for (const [why, n] of Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${String(n).padStart(5)}  ${why}`);
}
console.log('\nRun `npm run build` again to write dist/working/.');
