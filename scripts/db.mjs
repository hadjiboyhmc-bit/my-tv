// Loads the iptv-org database (channels, feeds, streams, logos, ...) and
// builds lookup tables. Downloads are cached in data/db/ for 6 hours.

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';

const FILES = ['channels', 'feeds', 'streams', 'logos', 'categories', 'countries',
  'languages', 'regions', 'subdivisions', 'cities', 'blocklist', 'guides'];
const MAX_AGE_MS = 6 * 3600 * 1000;

export async function loadDb(baseUrl, { refresh = false } = {}) {
  await mkdir('data/db', { recursive: true });
  const raw = {};
  await Promise.all(FILES.map(async (name) => {
    const path = `data/db/${name}.json`;
    const fresh = !refresh && await stat(path).then((s) => Date.now() - s.mtimeMs < MAX_AGE_MS, () => false);
    if (!fresh) {
      const res = await fetch(`${baseUrl}/${name}.json`, { signal: AbortSignal.timeout(120000) });
      if (!res.ok) throw new Error(`${name}.json: HTTP ${res.status}`);
      await writeFile(path, await res.text());
    }
    raw[name] = JSON.parse(await readFile(path, 'utf8'));
  }));

  const by = (arr, key) => new Map(arr.map((x) => [x[key], x]));
  const db = {
    raw,
    channels: by(raw.channels, 'id'),
    categories: by(raw.categories, 'id'),
    countries: by(raw.countries, 'code'),
    languages: by(raw.languages, 'code'),
    regions: by(raw.regions, 'code'),
    subdivisions: by(raw.subdivisions, 'code'),
    cities: by(raw.cities, 'code'),
    blocked: new Set(raw.blocklist.map((b) => b.channel)),
    feeds: new Map(),      // "channel@feed" -> feed
    mainFeed: new Map(),   // channel -> feed
    logos: new Map(),      // "channel@feed" or "channel@" -> url
  };

  for (const f of raw.feeds) {
    db.feeds.set(`${f.channel}@${f.id}`, f);
    if (f.is_main || !db.mainFeed.has(f.channel)) db.mainFeed.set(f.channel, f);
  }

  // Same choice as iptv-org's playlists: within the feed's own logos (or the
  // channel's general ones), transparent logos first, otherwise list order.
  const transparent = (l) => (l.tags || []).includes('transparent');
  for (const l of raw.logos) {
    const key = `${l.channel}@${l.feed || ''}`;
    const cur = db.logos.get(key);
    if (!cur || (transparent(l) && !transparent(cur))) db.logos.set(key, l);
  }
  for (const [k, l] of db.logos) db.logos.set(k, l.url);

  // Which countries each region covers, and the reverse.
  db.regionsOfCountry = new Map();
  for (const r of raw.regions) {
    for (const c of r.countries) {
      if (!db.regionsOfCountry.has(c)) db.regionsOfCountry.set(c, new Set());
      db.regionsOfCountry.get(c).add(r.code);
    }
  }
  return db;
}

// Expand a feed's broadcast_area ("c/DK", "r/EUR", "s/DK-84", "ct/DKAAR") the
// way iptv-org's playlists do:
//  - countries: only countries named directly (or via a subdivision/city);
//    a region does not put a channel in every one of its countries
//  - regions: every region that shares a country with the broadcast area
//  - international: names a region or more than one country
export function expandArea(db, areas = []) {
  const countries = new Set(), regions = new Set(), subdivisions = new Set(), cities = new Set();
  const regionCountries = new Set();
  let named_c = 0;
  for (const a of areas) {
    const [type, code] = a.split('/');
    if (type === 'c') { countries.add(code); named_c++; }
    else if (type === 's') { subdivisions.add(code); countries.add(code.split('-')[0]); }
    else if (type === 'ct') {
      const city = db.cities.get(code);
      cities.add(code);
      countries.add(city?.country || code.slice(0, 2));
      if (city?.subdivision) subdivisions.add(city.subdivision);
    }
    else if (type === 'r') {
      regions.add(code);
      for (const c of db.regions.get(code)?.countries || []) regionCountries.add(c);
    }
  }
  const named = [...regions];
  const reach = new Set([...countries, ...regionCountries]);
  for (const c of reach) for (const r of db.regionsOfCountry.get(c) || []) regions.add(r);
  // A subdivision also counts for its parents (Lleida -> Catalunya).
  for (const code of [...subdivisions]) {
    let p = db.subdivisions.get(code)?.parent;
    while (p && !subdivisions.has(p)) { subdivisions.add(p); p = db.subdivisions.get(p)?.parent; }
  }
  return { countries, regions, subdivisions, cities, worldwide: named.length > 0 || named_c > 1 };
}
