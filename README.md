# my-tv

A personal copy of the [iptv-org](https://github.com/iptv-org/iptv) system: the
same playlists built from the same public channel database, rebuilt daily, plus
some extras. It loads into IBO Player, VLC, Kodi, TiviMate and similar players.

Only free, publicly offered channels are included. Like the original, NSFW and
blocklisted channels are left out.

## What you get

**The same as iptv-org** (checked with `npm run compare`: 818 of 820 shared
playlists list exactly the same streams, and the other 2 differ only by streams
the original added that day):

| Playlist | Contents |
|----------|----------|
| `index.m3u` | Every channel, one stream per channel feed |
| `index.category.m3u` | Grouped by category |
| `index.language.m3u` | Grouped by language |
| `index.country.m3u` | Grouped by country |
| `categories/<id>.m3u` | e.g. `news`, `sports`, `kids`, `movies`, `undefined` |
| `languages/<code>.m3u` | e.g. `dan`, `swe`, `eng`, `undefined` |
| `countries/<code>.m3u` | e.g. `dk`, `se`, `uk`, plus `int` for international channels |
| `regions/<code>.m3u` | e.g. `nord`, `eur`, `eu`, `ww` |
| `subdivisions/<code>.m3u` | States and provinces, e.g. `us-ca`, `es-ct` |
| `cities/<code>.m3u` | Local city channels |

It uses the same channel IDs, names, logos, labels (`[Geo-blocked]`,
`[Not 24/7]`) and user-agent settings, and picks the same stream when a channel
has several.

**Extras the original does not have:**

| Feature | Where |
|---------|-------|
| More channels from [Free-TV/IPTV](https://github.com/Free-TV/IPTV) (about 950 not in iptv-org) | merged into every playlist |
| Your own channels | `data/custom.m3u` |
| Your favourites in one list | `mine.m3u` |
| Only streams that answered the daily check | `working/...` (same layout) |
| TV guide (EPG) for your countries | `guides/guide.xml.gz`, linked in every playlist |
| Searchable channel browser | `index.html` |
| JSON API | `api/streams.json`, `api/playlists.json`, `api/meta.json` |
| Playlist overview with counts | `PLAYLISTS.md` |
| One playlist per source | `sources/<name>.m3u` |

## How it works

```
iptv-org database (31k channels, 18k streams, logos, feeds, areas)
        +  Free-TV playlist  +  data/custom.m3u
                 │
                 ▼
        scripts/build.mjs ──► dist/  (all playlists, API, web page)
                 │                ▲
                 ├─► data/guide.channels.xml ──► iptv-org/epg grabber ──► guide.xml.gz
                 │                │
                 └─► data/channels.json ──► scripts/check.mjs ──► data/status.json
                                                     │
                       scripts/build.mjs (again) ◄───┘  adds working/ and the guide
```

| File | What it does |
|------|--------------|
| `config.json` | Sources, filters, favourites, TV guide countries |
| `scripts/db.mjs` | Downloads and indexes the iptv-org database (cached 6 hours) |
| `scripts/build.mjs` | Builds every playlist, the API, PLAYLISTS.md, the web page and the guide channel list |
| `scripts/check.mjs` | Tests every stream and records which ones answer |
| `scripts/compare.mjs` | Compares the output with iptv-org's published playlists |
| `scripts/m3u.mjs` | Reads and writes M3U |
| `site/index.html` | The channel browser |
| `.github/workflows/update.yml` | Daily: build, grab guide, check, rebuild, publish |

No dependencies. Needs Node.js 20 or newer.

## Put it online (one-time setup)

1. Create a new repository on GitHub and push this folder to it.
2. In the repository, go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Go to **Actions → Update playlists → Run workflow**. A full run takes about
   15 to 30 minutes, mostly the stream check and the TV guide. After that it runs
   by itself every day.
4. Open `https://<your-github-username>.github.io/<repo-name>/` to browse
   channels and copy playlist links.

## Load it into IBO Player

1. On IBO Player's website, enter your TV's MAC address and device key.
2. Add a playlist with a name and the URL, for example
   `https://<your-github-username>.github.io/<repo-name>/countries/dk.m3u`, or
   `/mine.m3u` for your favourites, or `/index.m3u` for everything.
3. Restart IBO Player on the TV.

The TV guide link is already in each playlist's header. If IBO Player does not
pick it up on its own, add `https://<user>.github.io/<repo>/guides/guide.xml.gz`
as the EPG URL in its settings.

A playlist of everything (12,000+ channels) loads slowly on most TVs. A country
playlist or `mine.m3u` is much nicer to use.

## Run it on your computer

```bash
npm run build      # build dist/ (a few seconds; downloads the database the first time)
npm run check:dk   # test only the Danish streams (about 10 seconds)
npm run check      # test every stream (about 5 minutes)
npm run build      # rebuild, now with dist/working/
npm run compare    # compare with iptv-org's published playlists
npm run all        # fresh database + check + build
```

## Customise

- **Favourites:** `favourites.countries` (e.g. `dk`, `se`, `uk`; the
  database uses `uk`, not `gb`) and `favourites.categories` in `config.json`.
- **TV guide countries:** `guides.countries`. Each extra country makes the daily
  run longer. `guides.preferSites` decides which guide site is used when several
  cover a channel.
- **Your own channels:** add them to `data/custom.m3u`.
- **More sources:** add any M3U URL to `extraSources`.
- **Filters:** `onePerFeed: false` keeps every stream the database knows about
  (about 18,000 instead of 11,500), not just the best one per channel.

## Things to know

- **Use the normal playlists, not `working/`, in IBO Player.** The daily check
  runs on GitHub's servers in the US, so streams that only work from Denmark
  fail there and are left out of `working/`. Run `npm run all` at home for a
  check made from Denmark.
- **Links die all the time.** That is why it rebuilds daily. The database is
  kept up to date by iptv-org's volunteers.
- **Privacy:** Pages on a free GitHub account needs a public repository. That
  shows the code and the public playlists, nothing personal. Private
  repositories with Pages need a paid plan, and the site is still reachable by
  anyone who has the URL. The web page asks search engines not to index it.
- A few streams use rtmp, mmsh or DASH, which some players cannot play.
