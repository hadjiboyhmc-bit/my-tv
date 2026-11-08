// Build every playlist, the JSON API, PLAYLISTS.md and the web page.
//
//   node scripts/build.mjs            use cached database (max 6 h old)
//   node scripts/build.mjs --refresh  force a fresh database download
//
// If data/status.json exists (from scripts/check.mjs), dist/working/ is also
// written with only the streams that answered. If data/guides/guide.xml.gz
// exists (from the guide grabber), it is published and linked as the TV guide.

import { readFile, writeFile, mkdir, rm, copyFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadDb, expandArea } from './db.mjs';
import { parseM3U, writeM3U } from './m3u.mjs';

const config = JSON.parse(await readFile('config.json', 'utf8'));
const SITE_URL = (process.env.SITE_URL || '').replace(/\/$/, '');
const t0 = Date.now();

const db = await loadDb(config.database, { refresh: process.argv.includes('--refresh') });
console.log(`database: ${db.channels.size} channels, ${db.raw.streams.length} streams`);

// ---------------------------------------------------------------- streams --

function enrich({ channel, feed, title, url, quality, labels = [], userAgent, referrer, source, extraOpts, fallback = {} }) {
  const ch = channel ? db.channels.get(channel) : null;
  const feedId = feed || (ch && db.mainFeed.get(ch.id)?.id) || null;
  const f = ch && feedId ? db.feeds.get(`${ch.id}@${feedId}`) : null;

  let area = expandArea(db, f?.broadcast_area);
  if (!f && ch?.country) area = expandArea(db, [`c/${ch.country}`]);
  if (!ch && fallback.country) {
    // Other lists use ISO "GB"; the database uses "UK".
    const c = fallback.country === 'GB' && !db.countries.has('GB') ? 'UK' : fallback.country;
    area = expandArea(db, [`c/${c}`]);
  }

  return {
    channel: ch?.id || null,
    feed: ch ? feedId : null,
    tvgId: ch ? (feedId ? `${ch.id}@${feedId}` : ch.id) : (fallback.tvgId || ''),
    title,
    displayTitle: title + (quality ? ` (${quality})` : '') + labels.map((l) => ` [${l}]`).join(''),
    url,
    quality: quality || null,
    labels,
    userAgent: userAgent || '',
    referrer: referrer || '',
    extraOpts: extraOpts || [],
    logo: (ch && (db.logos.get(`${ch.id}@${feedId}`) || db.logos.get(`${ch.id}@`))) || fallback.logo || '',
    categories: ch?.categories || [],
    // Unknown language codes count as undefined, as in iptv-org's playlists.
    languages: (f?.languages || []).filter((c) => db.languages.has(c)),
    countries: [...area.countries],
    regions: [...area.regions],
    subdivisions: [...area.subdivisions],
    cities: [...area.cities],
    worldwide: area.worldwide,
    nsfw: !!ch?.is_nsfw,
    blocked: !!(ch && db.blocked.has(ch.id)),
    closed: !!ch?.closed,
    source,
  };
}

// Like iptv-org's own playlists: one stream per channel feed, skipping streams
// with no channel or an unknown feed. Within a feed, prefer streams without
// warning labels, then the highest quality, then the first listed.
let dbStreams = db.raw.streams;
if (config.filters.onePerFeed) {
  const q = (s) => parseInt(s.quality) || 0;
  const best = new Map();
  dbStreams.forEach((s, i) => {
    if (!s.channel || !db.feeds.has(`${s.channel}@${s.feed}`)) return;
    const k = `${s.channel}@${s.feed}`, cur = best.get(k);
    const better = !cur ||
      (s.labels.length > 0) - (cur.s.labels.length > 0) < 0 ||
      ((s.labels.length > 0) === (cur.s.labels.length > 0) && q(s) > q(cur.s));
    if (better) best.set(k, { s, i });
  });
  dbStreams = [...best.values()].sort((a, b) => a.i - b.i).map((x) => x.s);
}

let streams = dbStreams.map((s) => enrich({
  channel: s.channel, feed: s.feed, title: s.title, url: s.url, quality: s.quality,
  labels: s.labels, userAgent: s.user_agent, referrer: s.referrer, source: 'iptv-org',
}));

// Extra M3U sources. Entries whose tvg-id matches a database channel get its
// metadata; the rest keep what the playlist says.
for (const src of config.extraSources) {
  try {
    let text;
    if (src.file) {
      if (!existsSync(src.file)) continue;
      text = await readFile(src.file, 'utf8');
    } else {
      const res = await fetch(src.url, { signal: AbortSignal.timeout(60000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    }
    const entries = parseM3U(text);
    for (const e of entries) {
      const [cid, fid] = (e.attrs['tvg-id'] || '').split('@');
      const vlc = (k) => e.opts.find((o) => o.startsWith(`#EXTVLCOPT:http-${k}=`))?.split('=').slice(1).join('=');
      streams.push(enrich({
        channel: db.channels.has(cid) ? cid : null,
        feed: fid && db.feeds.has(`${cid}@${fid}`) ? fid : null,
        title: e.title.replace(/\s*[ⓈⓉⒼⓎ]+\s*$/u, '').trim(),
        url: e.url,
        userAgent: e.attrs['http-user-agent'] || vlc('user-agent'),
        referrer: e.attrs['http-referrer'] || vlc('referrer'),
        extraOpts: e.opts.filter((o) => !/^#EXTVLCOPT:http-(user-agent|referrer)=/.test(o)),
        source: src.name,
        fallback: {
          tvgId: e.attrs['tvg-id'] || '',
          logo: e.attrs['tvg-logo'] || '',
          country: (e.attrs['tvg-country'] || '').split(/[;,]/)[0].toUpperCase() || null,
        },
      }));
    }
    console.log(`${src.name}: ${entries.length} streams`);
  } catch (err) {
    console.warn(`${src.name}: failed (${err.message}), skipped`);
  }
}

// De-duplicate by URL; the database version wins. With onePerFeed, an extra
// source only adds channels the database has no stream for.
const seen = new Set(), feedsCovered = new Set();
streams = streams.filter((s) => {
  const key = s.url.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (seen.has(key)) return false;
  if (config.filters.onePerFeed && s.channel) {
    if (s.source !== 'iptv-org' && feedsCovered.has(s.tvgId)) return false;
    feedsCovered.add(s.tvgId);
  }
  seen.add(key);
  return true;
});

const F = config.filters;
streams = streams.filter((s) =>
  !(F.excludeNsfw && s.nsfw) &&
  !(F.excludeBlocklist && s.blocked) &&
  !(F.excludeClosedChannels && s.closed) &&
  !(F.skipNonHttp && !/^https?:\/\//i.test(s.url)));

streams.sort((a, b) => a.displayTitle.localeCompare(b.displayTitle) || a.url.localeCompare(b.url));

// Stream check results, if any.
const status = existsSync('data/status.json') ? JSON.parse(await readFile('data/status.json', 'utf8')) : null;
for (const s of streams) s.working = status ? (status.results[s.url]?.ok ?? null) : null;

// -------------------------------------------------------------- playlists --

await rm('dist', { recursive: true, force: true });
await mkdir('dist', { recursive: true });

const guideUrls = [...config.extraGuideUrls];
const hasGuide = existsSync('data/guides/guide.xml.gz');
if (hasGuide) {
  await mkdir('dist/guides', { recursive: true });
  await copyFile('data/guides/guide.xml.gz', 'dist/guides/guide.xml.gz');
  guideUrls.unshift(SITE_URL ? `${SITE_URL}/guides/guide.xml.gz` : 'guides/guide.xml.gz');
}

const catName = (id) => db.categories.get(id)?.name || id;
const langName = (c) => db.languages.get(c)?.name || c;
const countryName = (c) => db.countries.get(c)?.name || c;
const regionName = (c) => db.regions.get(c)?.name || c;
const subName = (c) => db.subdivisions.get(c)?.name || c;
const cityName = (c) => db.cities.get(c)?.name || c;
const catGroup = (s) => s.categories.length ? s.categories.map(catName).sort().join(';') : 'Undefined';

const index = { playlists: [] };
async function emit(path, items, meta = {}) {
  if (!items.length) return;
  const dir = path.split('/').slice(0, -1).join('/');
  if (dir) await mkdir(dir, { recursive: true });
  await writeFile(path, writeM3U(items, { guideUrls }));
  index.playlists.push({ path: path.replace(/^dist\//, ''), count: items.length, ...meta });
}

// Group streams by a key function that returns several keys per stream.
function groupBy(list, keysOf) {
  const m = new Map();
  for (const s of list) for (const k of keysOf(s)) {
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(s);
  }
  return m;
}
const plain = (list) => list.map((s) => ({ s, group: catGroup(s) }));

async function emitSet(root, list) {
  const kind = root === 'dist' ? 'all' : 'working';
  const byCat = groupBy(list, (s) => s.categories.length ? s.categories : ['undefined']);
  const byLang = groupBy(list, (s) => s.languages.length ? s.languages : ['undefined']);
  const byCountry = groupBy(list, (s) => s.worldwide ? ['INT', ...s.countries] : (s.countries.length ? s.countries : ['UNDEFINED']));
  const byRegion = groupBy(list, (s) => s.regions);
  const bySub = groupBy(list, (s) => s.subdivisions);
  const byCity = groupBy(list, (s) => s.cities);
  const bySource = groupBy(list, (s) => [s.source]);

  const sortedKeys = (m, name, last = []) =>
    [...m.keys()].filter((k) => !last.includes(k)).sort((a, b) => name(a).localeCompare(name(b)))
      .concat(last.filter((k) => m.has(k)));

  // index.*
  await emit(`${root}/index.m3u`, plain(list), { kind, type: 'index', name: 'All channels' });
  await emit(`${root}/index.category.m3u`,
    sortedKeys(byCat, catName, ['undefined']).flatMap((k) => byCat.get(k).map((s) => ({ s, group: k === 'undefined' ? 'Undefined' : catName(k) }))),
    { kind, type: 'index', name: 'Grouped by category' });
  await emit(`${root}/index.language.m3u`,
    sortedKeys(byLang, langName, ['undefined']).flatMap((k) => byLang.get(k).map((s) => ({ s, group: k === 'undefined' ? 'Undefined' : langName(k) }))),
    { kind, type: 'index', name: 'Grouped by language' });
  const cName = (k) => k === 'INT' ? 'International' : k === 'UNDEFINED' ? 'Undefined' : countryName(k);
  await emit(`${root}/index.country.m3u`,
    sortedKeys(byCountry, cName, ['INT', 'UNDEFINED']).flatMap((k) => byCountry.get(k).map((s) => ({ s, group: cName(k) }))),
    { kind, type: 'index', name: 'Grouped by country' });

  // One file per category / language / country / region / subdivision
  for (const [k, l] of byCat) await emit(`${root}/categories/${k}.m3u`, plain(l), { kind, type: 'category', code: k, name: k === 'undefined' ? 'Undefined' : catName(k) });
  for (const [k, l] of byLang) await emit(`${root}/languages/${k}.m3u`, plain(l), { kind, type: 'language', code: k, name: k === 'undefined' ? 'Undefined' : langName(k) });
  for (const [k, l] of byCountry) await emit(`${root}/countries/${k.toLowerCase()}.m3u`, plain(l), { kind, type: 'country', code: k.toLowerCase(), name: cName(k), flag: db.countries.get(k)?.flag || '' });
  for (const [k, l] of byRegion) await emit(`${root}/regions/${k.toLowerCase()}.m3u`, plain(l), { kind, type: 'region', code: k.toLowerCase(), name: regionName(k) });
  for (const [k, l] of bySub) await emit(`${root}/subdivisions/${k.toLowerCase()}.m3u`, plain(l), { kind, type: 'subdivision', code: k.toLowerCase(), name: subName(k), country: k.split('-')[0].toLowerCase(), parent: db.subdivisions.get(k)?.parent?.toLowerCase() || null });
  for (const [k, l] of byCity) await emit(`${root}/cities/${k.toLowerCase()}.m3u`, plain(l), { kind, type: 'city', code: k.toLowerCase(), name: cityName(k), country: (db.cities.get(k)?.country || k.slice(0, 2)).toLowerCase(), parent: db.cities.get(k)?.subdivision?.toLowerCase() || null });
  for (const [k, l] of bySource) await emit(`${root}/sources/${k}.m3u`, plain(l), { kind, type: 'source', code: k, name: k });

  // mine.m3u: favourite countries, favourite categories first
  const favC = config.favourites.countries.map((c) => c.toUpperCase());
  const favCat = config.favourites.categories;
  const rank = (s) => { const i = favCat.findIndex((c) => s.categories.includes(c)); return i === -1 ? favCat.length : i; };
  const mine = [];
  for (const c of favC) {
    const l = [...(byCountry.get(c) || [])].sort((a, b) => rank(a) - rank(b) || a.displayTitle.localeCompare(b.displayTitle));
    for (const s of l) mine.push({ s, group: `${countryName(c)} - ${s.categories[0] ? catName(s.categories[0]) : 'Undefined'}` });
  }
  await emit(`${root}/mine.m3u`, mine, { kind, type: 'index', name: 'My favourites' });
}

await emitSet('dist', streams);
if (status) await emitSet('dist/working', streams.filter((s) => s.working));

// -------------------------------------------------------------------- API --

await mkdir('dist/api', { recursive: true });
await writeFile('dist/api/streams.json', JSON.stringify(streams.map((s) => ({
  channel: s.channel, feed: s.feed, title: s.title, url: s.url, quality: s.quality, labels: s.labels,
  logo: s.logo, categories: s.categories, languages: s.languages, countries: s.countries,
  worldwide: s.worldwide, user_agent: s.userAgent || null, referrer: s.referrer || null,
  source: s.source, working: s.working,
}))));
await writeFile('dist/api/playlists.json', JSON.stringify(index.playlists));
await writeFile('dist/api/meta.json', JSON.stringify({
  builtAt: new Date().toISOString(),
  checkedAt: status?.checkedAt || null,
  streams: streams.length,
  working: status ? streams.filter((s) => s.working).length : null,
  guide: hasGuide ? 'guides/guide.xml.gz' : null,
  categories: Object.fromEntries([...db.categories].map(([k, v]) => [k, v.name])),
  countries: Object.fromEntries([...db.countries].map(([k, v]) => [k, { name: v.name, flag: v.flag }])),
  languages: Object.fromEntries([...new Set(streams.flatMap((s) => s.languages))].map((c) => [c, langName(c)])),
}));

// ------------------------------------------------------ PLAYLISTS.md + web --

const base = SITE_URL || '.';
const table = (type, kind = 'all') => {
  const rows = index.playlists.filter((p) => p.type === type && p.kind === kind)
    .sort((a, b) => (a.code === 'undefined' || a.code === 'int') - (b.code === 'undefined' || b.code === 'int') || a.name.localeCompare(b.name));
  return ['| Name | Channels | Playlist |', '|------|---------:|----------|',
    ...rows.map((p) => `| ${p.flag ? p.flag + ' ' : ''}${p.name} | ${p.count} | \`${base}/${p.path}\` |`)].join('\n');
};
await writeFile('dist/PLAYLISTS.md', [
  '# Playlists', '',
  `Built ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC. ${streams.length} streams` +
    (status ? `, ${streams.filter((s) => s.working).length} answered the last check (${status.checkedAt.slice(0, 10)}).` : '.'),
  '', 'Every playlist below also exists under `working/` with only the streams that answered the last check.', '',
  '## Main', '', table('index'), '',
  '## By category', '', table('category'), '',
  '## By language', '', table('language'), '',
  '## By country', '', 'Subdivisions and cities are listed under their country.', '', countryTree(), '',
  '## By region', '', table('region'), '',
  '## By source', '', table('source'), '',
].join('\n'));

// Countries with their subdivisions and cities nested underneath, like
// iptv-org's PLAYLISTS.md.
function countryTree() {
  const all = index.playlists.filter((p) => p.kind === 'all');
  const subs = all.filter((p) => p.type === 'subdivision');
  const cities = all.filter((p) => p.type === 'city');
  const line = (p, depth) => `${'  '.repeat(depth)}- ${p.flag ? p.flag + ' ' : ''}${p.name} (${p.count}) \`${base}/${p.path}\``;
  const byName = (a, b) => a.name.localeCompare(b.name);
  const out = [];
  const walkSub = (s, depth) => {
    out.push(line(s, depth));
    for (const c of cities.filter((c) => c.parent === s.code).sort(byName)) out.push(line(c, depth + 1));
    for (const k of subs.filter((k) => k.parent === s.code).sort(byName)) walkSub(k, depth + 1);
  };
  const countries = all.filter((p) => p.type === 'country')
    .sort((a, b) => (['int', 'undefined'].includes(a.code) - ['int', 'undefined'].includes(b.code)) || byName(a, b));
  for (const c of countries) {
    out.push(line(c, 0));
    for (const s of subs.filter((s) => s.country === c.code && !s.parent).sort(byName)) walkSub(s, 1);
    for (const k of cities.filter((k) => k.country === c.code && !k.parent).sort(byName)) out.push(line(k, 1));
  }
  return out.join('\n');
}

await copyFile('site/index.html', 'dist/index.html');
await writeFile('dist/.nojekyll', '');

// ------------------------------------------------ inputs for other scripts --

await mkdir('data', { recursive: true });
await writeFile('data/channels.json', JSON.stringify(streams.map((s) => ({
  title: s.displayTitle, countries: s.countries, url: s.url, userAgent: s.userAgent, referrer: s.referrer,
}))));

// TV guide channel list for the iptv-org/epg grabber.
const gC = new Set(config.guides.countries.map((c) => c.toUpperCase()));
const wanted = new Map();
for (const s of streams) {
  if (s.channel && s.countries.some((c) => gC.has(c))) wanted.set(s.tvgId, s);
}
const pref = config.guides.preferSites;
const siteRank = (site) => { const i = pref.indexOf(site); return i === -1 ? pref.length : i; };
const guideFor = new Map();
for (const g of db.raw.guides) {
  if (!g.channel) continue;
  const key = g.feed ? `${g.channel}@${g.feed}` : null;
  for (const tvgId of key ? [key] : [...wanted.keys()].filter((k) => k.split('@')[0] === g.channel)) {
    if (!wanted.has(tvgId)) continue;
    const cur = guideFor.get(tvgId);
    if (!cur || siteRank(g.site) < siteRank(cur.site) || (key && !cur.feed && siteRank(g.site) === siteRank(cur.site))) guideFor.set(tvgId, g);
  }
}
const x = (v) => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
await writeFile('data/guide.channels.xml', [
  '<?xml version="1.0" encoding="UTF-8"?>', '<channels>',
  ...[...guideFor].map(([tvgId, g]) =>
    `  <channel site="${x(g.site)}" lang="${x(g.lang)}" xmltv_id="${x(tvgId)}" site_id="${x(g.site_id)}">${x(g.site_name)}</channel>`),
  '</channels>', ''].join('\n'));

// ---------------------------------------------------------------- summary --

const count = (t) => index.playlists.filter((p) => p.kind === 'all' && p.type === t).length;
console.log(`\n${streams.length} streams after filters -> ${index.playlists.length} playlists in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
console.log(`  ${count('category')} categories, ${count('language')} languages, ${count('country')} countries, ${count('region')} regions, ${count('subdivision')} subdivisions`);
if (status) console.log(`  working: ${streams.filter((s) => s.working).length} (checked ${status.checkedAt})`);
console.log(`  TV guide: ${guideFor.size} channels mapped${hasGuide ? ', guide.xml.gz published' : ' (no guide grabbed yet)'}`);
