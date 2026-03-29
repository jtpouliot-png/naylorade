# Naylorade — Claude Code Context

## What it is
Fantasy baseball stream guide. Shows today's MLB games filtered by your ESPN fantasy roster, with live play-by-play, browser notifications when your players are up, MLB.TV deep links, and player news from FanGraphs.

## Stack
- **Frontend**: React 18 + Vite, deployed on Vercel (`https://naylorade.vercel.app`)
- **Backend**: Python/Flask, deployed on Railway (auto-deploys on push to `main`)
- **Extension**: Chrome extension (Manifest V3) for ESPN roster sync
- **Repo**: `https://github.com/jtpouliot-png/naylorade`

## Repo layout
```
backend/app.py          Flask API
frontend/src/App.jsx    Entire React app (single file)
extension/popup.js      Chrome extension logic
extension/popup.html    Extension UI
extension/manifest.json MV3 manifest
```

## Backend API routes
- `GET  /api/games?roster=Name1,Name2`  — today's MLB games, annotated with `fantasyPlayers`
- `GET  /api/games/<id>/live?roster=...` — live feed + `rosterPlays` for historical seeding
- `POST /api/roster`                    — fetch ESPN fantasy roster (leagueId, espnS2, swid)
- `GET  /api/news?players=Name1,Name2`  — FanGraphs RSS + Google News, cached 10 min
- `GET  /api/health`

## Key data shapes

**Game object** (from `/api/games`):
```json
{
  "id": 12345,
  "status": "Preview|Live|Final",
  "time": "7:05 PM",
  "inning": "Top 3",
  "homeTeam": { "name": "Yankees", "abbr": "NYY", "score": 2 },
  "awayTeam": { "name": "Red Sox", "abbr": "BOS", "score": 1 },
  "broadcasts": [{ "name": "ESPN", "color": "#b8d4f0", "url": "...", "mlbtvUrl": "https://www.mlb.com/tv/g12345" }],
  "probablePitchers": { "home": "Gerrit Cole", "away": "Chris Sale" },
  "fantasyPlayers": [{ "name": "Aaron Judge", "position": "RF" }]
}
```

**Live feed object** (from `/api/games/<id>/live`):
```json
{
  "currentBatter": "Aaron Judge",
  "currentPitcher": "Chris Sale",
  "lastPlay": "Aaron Judge called out on strikes.",
  "lastPlayBatter": "Aaron Judge",
  "lastPlayPitcher": "Chris Sale",
  "lastPlayInning": 9,
  "lastPlayHalf": "top",
  "lastPlayOuts": 2,
  "count": { "balls": 1, "strikes": 2, "outs": 2 },
  "bases": { "first": false, "second": true, "third": false },
  "rosterPlays": [{ "description": "...", "batter": "...", "pitcher": "...", "startTime": "...", "inning": 3, "half": "top", "outs": 1 }]
}
```

## Frontend layout (3 panels)
1. **Left (260px)** — `myGames`: only games where roster players appear. Roster strip at bottom.
2. **Center (flex)** — `AllGamesBoard`: CSS grid of all today's games as `ScoreCard` components. Each card shows teams/scores, broadcast badges, player chips with positions, last play text, and FanGraphs/news per player.
3. **Right (300px)** — Player feed: real-time + historical plays for roster players. Shows inning/outs context per play.

## Key frontend state
- `roster` — player names from `localStorage("naylorade_roster")`
- `games` — all today's games
- `myGames` — `games.filter(g => g.fantasyPlayers?.length > 0)`
- `liveData` — `{ [gameId]: liveApiResponse }`, polled every 15s
- `newsData` — `{ [playerName]: [articles] }`, fetched on games load
- `feed` — play-by-play items, seeded historically on load, updated by polling
- `seenPlays` ref — deduplication set for feed entries
- `notifiedAtBat` ref — tracks last notified batter/pitcher per game

## Polling intervals
- Games refresh: every 60s
- Live feed (all live games): every 15s
- News: fetched once on games load (10 min server-side cache)
- Historical plays: seeded once on initial load via `loadHistoricalPlays`

## MLB.TV deep links
Format: `https://www.mlb.com/tv/g{gamePk}` — confirmed working.

## Chrome extension
Scrapes ESPN Fantasy roster from DOM using `.truncate` elements, writes to `localStorage("naylorade_roster")` in the Naylorade tab, then reloads it. Uses `chrome.scripting.executeScript` with `world: "MAIN"` to bypass ESPN's CSP.

## News sources
- **FanGraphs**: fetches `fangraphs.com/feed/` and `fangraphs.com/fantasy/feed/` directly, filters for player name mentions, shows all results (no analytical filter)
- **Fallback**: Google News restricted to `fangraphs.com`, `baseballprospectus.com`, `theathletic.com`, `theringer.com` — analytical filter applied
- **Excluded**: `cdn-ottoneu.fangraphs.com`
- Max 5 articles per player, cached 10 min server-side

## Deployment
- Push to `main` → Railway redeploys backend, Vercel redeploys frontend automatically
- Backend on Railway may take 1-2 min to redeploy; server-side caches reset on restart
- If badges/news look stale after a deploy, wait for cache TTL (10 min news, 15 min FanGraphs feed)

## Conventions
- All styles are inline JSX (no CSS files)
- Single-file frontend (`App.jsx`) — don't split into components unless asked
- Backend errors are logged with `flush=True` for Railway log visibility
- `fantasyPlayers` is `{name: string, position: string}[]` — not plain strings
- For preview games, pitchers only show if they're confirmed `probablePitchers` — never inferred from boxscore
