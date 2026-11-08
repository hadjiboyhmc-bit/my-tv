// Minimal M3U parser and writer. No dependencies.

const ATTR_RE = /([a-zA-Z0-9-]+)="([^"]*)"/g;

// Parse any M3U into raw entries: { title, attrs, opts, url }.
export function parseM3U(text) {
  const entries = [];
  let cur = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#EXTM3U')) continue;
    if (line.startsWith('#EXTINF')) {
      const comma = titleComma(line);
      const attrs = {};
      for (const m of line.slice(0, comma).matchAll(ATTR_RE)) attrs[m[1].toLowerCase()] = m[2];
      cur = { title: line.slice(comma + 1).trim(), attrs, opts: [] };
    } else if (line.startsWith('#EXTVLCOPT:') || line.startsWith('#KODIPROP:')) {
      cur?.opts.push(line);
    } else if (!line.startsWith('#') && cur) {
      cur.url = line;
      entries.push(cur);
      cur = null;
    }
  }
  return entries;
}

// The title is after the last comma outside quotes.
function titleComma(line) {
  let q = false, last = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') q = !q;
    else if (line[i] === ',' && !q) last = i;
  }
  return last === -1 ? line.length : last;
}

// Write playlist lines in the same shape iptv-org uses.
export function writeM3U(items, { guideUrls = [] } = {}) {
  const out = [guideUrls.length ? `#EXTM3U x-tvg-url="${guideUrls.join(',')}"` : '#EXTM3U'];
  for (const { s, group } of items) {
    let line = `#EXTINF:-1 tvg-id="${s.tvgId}" tvg-logo="${s.logo}"`;
    if (s.userAgent) line += ` http-user-agent="${s.userAgent}"`;
    if (s.referrer) line += ` http-referrer="${s.referrer}"`;
    line += ` group-title="${group.replace(/"/g, "'")}",${s.displayTitle}`;
    out.push(line);
    if (s.referrer) out.push(`#EXTVLCOPT:http-referrer=${s.referrer}`);
    if (s.userAgent) out.push(`#EXTVLCOPT:http-user-agent=${s.userAgent}`);
    for (const o of s.extraOpts || []) out.push(o);
    out.push(s.url);
  }
  return out.join('\n') + '\n';
}
