from flask import Flask, jsonify, request
from flask_cors import CORS
import requests
from datetime import date, datetime, timedelta, timezone
import xml.etree.ElementTree as ET
import time
import unicodedata
from email.utils import parsedate_to_datetime

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": [
    "https://naylorade.vercel.app",
    "http://localhost:5173",
    "http://localhost:3000",
    r"chrome-extension://.*",
]}}, supports_credentials=True)

# ── Broadcast config ──────────────────────────────────────────────────────────

BROADCAST_META = {
    "ESPN":        {"color": "#b8d4f0", "url": "https://espn.com/watch"},
    "ESPN+":       {"color": "#b8d4f0", "url": "https://espnplus.com"},
    "ESPN2":       {"color": "#b8d4f0", "url": "https://espn.com/watch"},
    "Apple TV+":   {"color": "#f0d4b8", "url": "https://tv.apple.com/channel/tvs.sbd.4000"},
    "Peacock":     {"color": "#e8d4f0", "url": "https://peacocktv.com"},
    "Fox":         {"color": "#f0e8b8", "url": "https://fox.com/live"},
    "FS1":         {"color": "#f0e8b8", "url": "https://fox.com/channel/fs1"},
    "TBS":         {"color": "#d4f0b8", "url": "https://watch.tbs.com"},
    "MLB Network": {"color": "#f0b8b8", "url": "https://mlb.com/network"},
    "default":     {"color": "#e0dedd", "url": "https://www.mlb.com"},
}

def get_broadcast_meta(name):
    for key in BROADCAST_META:
        if key.lower() in name.lower():
            return {"name": name, **BROADCAST_META[key]}
    return {"name": name, **BROADCAST_META["default"]}


# ── ESPN roster ───────────────────────────────────────────────────────────────

def fetch_espn_roster(league_id, espn_s2, swid, year=None):
    if year is None:
        year = date.today().year

    url = f"https://fantasy.espn.com/apis/v3/games/flb/seasons/{year}/segments/0/leagues/{league_id}"
    params = {"view": "mRoster"}
    cookies = {"espn_s2": espn_s2, "SWID": swid}
    headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://fantasy.espn.com/baseball/",
        "Origin": "https://fantasy.espn.com",
    }

    resp = requests.get(url, params=params, cookies=cookies, headers=headers, timeout=10)

    # If current year fails, try previous year (league may not have rolled over yet)
    if resp.status_code in (500, 404) and year == date.today().year:
        prev_url = f"https://fantasy.espn.com/apis/v3/games/flb/seasons/{year - 1}/segments/0/leagues/{league_id}"
        resp = requests.get(prev_url, params=params, cookies=cookies, headers=headers, timeout=10)

    resp.raise_for_status()
    data = resp.json()

    # Find the authenticated user's team
    current_team = None
    my_team_id = None

    # Try to identify the user's team via currentUserMemberships
    members = data.get("members", [])
    teams = data.get("teams", [])

    # Match SWID to member
    swid_clean = swid.strip("{}")
    for member in members:
        if member.get("id", "").strip("{}") == swid_clean:
            my_team_id = member.get("onTeamId")
            break

    # Fallback: just grab first team if we can't match
    if my_team_id is None and teams:
        my_team_id = teams[0].get("id")

    for team in teams:
        if team.get("id") == my_team_id:
            current_team = team
            break

    if not current_team:
        return []

    players = []
    roster = current_team.get("roster", {}).get("entries", [])
    for entry in roster:
        player_pool = entry.get("playerPoolEntry", {})
        player = player_pool.get("player", {})
        full_name = player.get("fullName", "")
        if full_name:
            players.append(full_name)

    return players


# ── MLB schedule + gamecast ───────────────────────────────────────────────────

MLB_BASE = "https://statsapi.mlb.com/api/v1"

def fetch_todays_games():
    today = date.today().strftime("%Y-%m-%d")
    url = f"{MLB_BASE}/schedule"
    params = {
        "sportId": 1,
        "date": today,
        "hydrate": "team,linescore,broadcasts(all),probablePitcher,person",
    }
    resp = requests.get(url, params=params, timeout=10)
    resp.raise_for_status()
    data = resp.json()

    games = []
    for date_entry in data.get("dates", []):
        for game in date_entry.get("games", []):
            games.append(parse_game(game))
    return games


def parse_game(game):
    status = game.get("status", {})
    abstract = status.get("abstractGameState", "Preview")  # Preview / Live / Final
    detailed = status.get("detailedState", "Scheduled")

    linescore = game.get("linescore", {})
    inning = linescore.get("currentInning")
    inning_half = linescore.get("inningHalf", "")
    inning_str = f"{inning_half} {inning}" if inning else None

    teams = game.get("teams", {})
    home = teams.get("home", {})
    away = teams.get("away", {})

    home_team = home.get("team", {})
    away_team = away.get("team", {})

    home_score = home.get("score")
    away_score = away.get("score")

    # Broadcasts — build ordered list: national networks first, then MLB.TV
    raw_broadcasts = game.get("broadcasts", [])
    national = [b for b in raw_broadcasts if b.get("type") == "N" or b.get("isNational")]
    game_pk = game.get("gamePk")
    mlbtv_url = f"https://www.mlb.com/tv/g{game_pk}" if game_pk else "https://www.mlb.com"

    watch_options = []
    seen = set()
    for b in national:
        name = b.get("name", "").strip()
        if name and name not in seen:
            seen.add(name)
            watch_options.append(get_broadcast_meta(name))

    # Always include MLB.TV as a direct watch option
    watch_options.append({"name": "MLB.TV", "color": BROADCAST_META["default"]["color"], "url": mlbtv_url})

    # Probable pitchers
    home_pitcher = home.get("probablePitcher", {}).get("fullName")
    away_pitcher = away.get("probablePitcher", {}).get("fullName")

    # Game time
    game_time = game.get("gameDate", "")  # ISO string
    if game_time:
        from datetime import datetime, timezone
        import pytz
        dt_utc = datetime.fromisoformat(game_time.replace("Z", "+00:00"))
        eastern = pytz.timezone("America/New_York")
        dt_et = dt_utc.astimezone(eastern)
        display_time = dt_et.strftime("%-I:%M %p")
    else:
        display_time = "TBD"

    return {
        "id": game.get("gamePk"),
        "status": abstract,        # Preview / Live / Final
        "detailedState": detailed,
        "time": display_time,
        "inning": inning_str,
        "homeTeam": {
            "name": home_team.get("teamName", ""),
            "abbr": home_team.get("abbreviation", ""),
            "score": home_score,
        },
        "awayTeam": {
            "name": away_team.get("teamName", ""),
            "abbr": away_team.get("abbreviation", ""),
            "score": away_score,
        },
        "broadcasts": watch_options,
        "probablePitchers": {
            "home": home_pitcher,
            "away": away_pitcher,
        },
        "players": [],  # filled in after roster filtering
    }


def fetch_live_feed(game_id):
    url = f"{MLB_BASE}.1/game/{game_id}/feed/live"
    resp = requests.get(url, timeout=10)
    resp.raise_for_status()
    return resp.json()


def parse_live_feed(feed, roster_names=None):
    lp = feed.get("liveData", {}).get("plays", {})
    current = lp.get("currentPlay", {})
    last_plays = lp.get("allPlays", [])

    # Last completed play description + who was batting/pitching in it
    last_play_desc = None
    last_play_batter = None
    last_play_pitcher = None
    last_play_inning = None
    last_play_half = None
    last_play_outs = None
    for play in reversed(last_plays):
        about = play.get("about", {})
        if about.get("isComplete"):
            result = play.get("result", {})
            last_play_desc = result.get("description")
            matchup = play.get("matchup", {})
            last_play_batter = matchup.get("batter", {}).get("fullName")
            last_play_pitcher = matchup.get("pitcher", {}).get("fullName")
            last_play_inning = about.get("inning")
            last_play_half = about.get("halfInning")
            last_play_outs = about.get("outs")
            break

    # Current batter / pitcher
    matchup = current.get("matchup", {})
    batter = matchup.get("batter", {}).get("fullName")
    pitcher = matchup.get("pitcher", {}).get("fullName")

    # Count
    count = current.get("count", {})

    # Base runners
    offense = feed.get("liveData", {}).get("linescore", {}).get("offense", {})
    bases = {
        "first":  bool(offense.get("first")),
        "second": bool(offense.get("second")),
        "third":  bool(offense.get("third")),
    }

    # All completed plays today involving roster players (for feed history on load)
    roster_plays = []
    if roster_names:
        for play in last_plays:
            about = play.get("about", {})
            if not about.get("isComplete"):
                continue
            matchup = play.get("matchup", {})
            play_batter = matchup.get("batter", {}).get("fullName", "")
            play_pitcher = matchup.get("pitcher", {}).get("fullName", "")
            if play_batter in roster_names or play_pitcher in roster_names:
                desc = play.get("result", {}).get("description", "")
                if desc:
                    roster_plays.append({
                        "description": desc,
                        "batter": play_batter,
                        "pitcher": play_pitcher,
                        "startTime": about.get("startTime", ""),
                        "inning": about.get("inning"),
                        "half": about.get("halfInning"),
                        "outs": about.get("outs"),
                    })

    return {
        "currentBatter": batter,
        "currentPitcher": pitcher,
        "lastPlay": last_play_desc,
        "lastPlayBatter": last_play_batter,
        "lastPlayPitcher": last_play_pitcher,
        "lastPlayInning": last_play_inning,
        "lastPlayHalf": last_play_half,
        "lastPlayOuts": last_play_outs,
        "count": {
            "balls": count.get("balls", 0),
            "strikes": count.get("strikes", 0),
            "outs": count.get("outs", 0),
        },
        "bases": bases,
        "rosterPlays": roster_plays,
    }


def get_players_in_game(game_id, roster_names):
    """Check boxscore for which roster players are in this game, with positions."""
    url = f"{MLB_BASE}/game/{game_id}/boxscore"
    try:
        resp = requests.get(url, timeout=8)
        resp.raise_for_status()
        data = resp.json()
    except Exception:
        return []

    found = []
    teams = data.get("teams", {})
    for side in ["home", "away"]:
        players = teams.get(side, {}).get("players", {})
        for pid, pdata in players.items():
            name = pdata.get("person", {}).get("fullName", "")
            if name in roster_names:
                position = pdata.get("position", {}).get("abbreviation", "")
                found.append({"name": name, "position": position})
    return found


# ── Weekly schedule + player→team mapping ────────────────────────────────────

_mlb_players_cache = {"ts": 0, "data": {}, "norm": {}}  # norm: ascii-normalized name → canonical name
MLB_PLAYERS_TTL = 6 * 60 * 60  # 6 hours


def _ascii(name):
    """Strip accents: 'Julio Rodríguez' → 'Julio Rodriguez'."""
    return unicodedata.normalize("NFD", name).encode("ascii", "ignore").decode("ascii").lower()

_week_sched_cache = {"ts": 0, "week_start": None, "data": []}
WEEK_SCHED_TTL = 30 * 60  # 30 min


def _get_mlb_players():
    """Return {playerFullName: {id, teamId}} for all active MLB players. Cached 6h."""
    now = time.time()
    if now - _mlb_players_cache["ts"] < MLB_PLAYERS_TTL and _mlb_players_cache["data"]:
        return _mlb_players_cache["data"]
    try:
        year = date.today().year
        resp = requests.get(
            f"{MLB_BASE}/sports/1/players",
            params={"season": year},
            timeout=15,
        )
        resp.raise_for_status()
        result, norm = {}, {}
        for p in resp.json().get("people", []):
            name    = p.get("fullName", "")
            team_id = (p.get("currentTeam") or {}).get("id")
            pid     = p.get("id")
            if name and pid:
                result[name] = {"id": pid, "teamId": team_id}
                norm[_ascii(name)] = name  # accent-stripped fallback key
        _mlb_players_cache.update({"ts": now, "data": result, "norm": norm})
        print(f"MLB players loaded: {len(result)}", flush=True)
        return result
    except Exception as e:
        print(f"MLB players fetch error: {e}", flush=True)
        return _mlb_players_cache["data"]


def _get_week_schedule():
    """Get MLB games for the current Mon–Sun scoring week. Cached 30 min."""
    today      = date.today()
    week_start = today - timedelta(days=today.weekday())   # Monday
    week_end   = week_start + timedelta(days=6)             # Sunday
    start_str  = week_start.strftime("%Y-%m-%d")
    end_str    = week_end.strftime("%Y-%m-%d")

    now = time.time()
    if (now - _week_sched_cache["ts"] < WEEK_SCHED_TTL and
            _week_sched_cache["week_start"] == start_str):
        return _week_sched_cache["data"]

    try:
        resp = requests.get(
            f"{MLB_BASE}/schedule",
            params={"sportId": 1, "startDate": start_str, "endDate": end_str,
                    "hydrate": "team,probablePitcher"},
            timeout=15,
        )
        resp.raise_for_status()
        result = []
        for date_entry in resp.json().get("dates", []):
            games = []
            for game in date_entry.get("games", []):
                home = game.get("teams", {}).get("home", {})
                away = game.get("teams", {}).get("away", {})
                games.append({
                    "homeTeamId":  (home.get("team") or {}).get("id"),
                    "awayTeamId":  (away.get("team") or {}).get("id"),
                    "homePitcher": (home.get("probablePitcher") or {}).get("fullName"),
                    "awayPitcher": (away.get("probablePitcher") or {}).get("fullName"),
                })
            result.append({"date": date_entry["date"], "games": games})
        _week_sched_cache.update({"ts": now, "week_start": start_str, "data": result})
        return result
    except Exception as e:
        print(f"Week schedule fetch error: {e}", flush=True)
        return _week_sched_cache["data"]


# ── Player season + recent stats ──────────────────────────────────────────────

_player_stats_cache = {}  # {player_name: {"ts": float, "data": dict}}
PLAYER_STATS_TTL = 30 * 60  # 30 min

# ESPN positionId → pitcher flag
_PITCHER_POSITION_IDS = {11, 12, 13}

def _parse_stat(stats_dict, key, digits=3):
    """Return float from MLB stats dict, rounding to `digits` decimal places."""
    val = stats_dict.get(key)
    if val is None:
        return None
    try:
        return round(float(val), digits)
    except (ValueError, TypeError):
        return None


def _mlb_stats(ids, stat_type, group, year, extra=None):
    """Fetch MLB stats via /api/v1/people hydrate — single group per call to avoid 500.
    Returns {playerId: statDict}."""
    hydrate_parts = f"group={group},type={stat_type},season={year},gameType=R"
    if extra:
        for k, v in extra.items():
            hydrate_parts += f",{k}={v}"
    params = {
        "personIds": ",".join(str(i) for i in ids),
        "hydrate":   f"stats({hydrate_parts})",
    }
    try:
        r = requests.get(f"{MLB_BASE}/people", params=params, timeout=15)
        r.raise_for_status()
        result = {}
        for person in r.json().get("people", []):
            pid = person.get("id")
            if not pid:
                continue
            for sg in person.get("stats", []):
                splits = sg.get("splits", [])
                if splits:
                    result[pid] = splits[0].get("stat", {})
                    break
        return result
    except Exception as e:
        print(f"MLB stats {stat_type}/{group}: {e}", flush=True)
        return {}


def _fetch_player_stats(player_names):
    """Return {name: {season:{...}, lastSeven:{...}, isPitcher}} from MLB API.
    Uses /api/v1/people?hydrate=stats(...) — one stat group per call. Cached 30 min."""
    now  = time.time()
    mlb  = _get_mlb_players()
    norm = _mlb_players_cache.get("norm", {})
    fresh, stale = {}, []

    not_found = []
    for name in player_names:
        cached = _player_stats_cache.get(name)
        if cached and now - cached["ts"] < PLAYER_STATS_TTL:
            fresh[name] = cached["data"]
            continue
        info = mlb.get(name) or mlb.get(norm.get(_ascii(name), ""))
        if info and info.get("id"):
            stale.append((name, info["id"]))
        else:
            not_found.append(name)

    if not_found:
        print(f"player-stats not found ({len(not_found)}): {not_found[:8]}", flush=True)
    if not stale:
        return fresh

    id_map  = {pid: name for name, pid in stale}
    all_ids = list(id_map.keys())
    chunks  = [all_ids[i:i+20] for i in range(0, len(all_ids), 20)]
    year    = date.today().year

    today  = date.today()
    l7_start = (today - timedelta(days=7)).strftime("%m/%d/%Y")
    l7_end   = today.strftime("%m/%d/%Y")
    l7_extra = {"startDate": l7_start, "endDate": l7_end}

    for chunk in chunks:
        szn_hit = _mlb_stats(chunk, "season",      "hitting",  year)
        szn_pit = _mlb_stats(chunk, "season",      "pitching", year)
        l7_hit  = _mlb_stats(chunk, "byDateRange", "hitting",  year, l7_extra)
        l7_pit  = _mlb_stats(chunk, "byDateRange", "pitching", year, l7_extra)
        print(f"player-stats chunk={len(chunk)} szn_hit={len(szn_hit)} szn_pit={len(szn_pit)} l7_hit={len(l7_hit)} l7_pit={len(l7_pit)}", flush=True)

        for pid in chunk:
            name = id_map.get(pid)
            if not name:
                continue
            sh = szn_hit.get(pid, {})
            sp = szn_pit.get(pid, {})
            lh = l7_hit.get(pid, {})
            lp = l7_pit.get(pid, {})

            # Pitcher if they have any recorded innings pitched
            is_p = float(sp.get("inningsPitched") or 0) > 0

            if is_p:
                data = {
                    "isPitcher": True,
                    "season": {
                        "gamesStarted":  _parse_stat(sp, "gamesStarted",  0),
                        "inningsPitched": _parse_stat(sp, "inningsPitched", 1),
                        "era":  _parse_stat(sp, "era"),
                        "whip": _parse_stat(sp, "whip"),
                        "k9":   _parse_stat(sp, "strikeoutsPer9Inn"),
                        "wins": _parse_stat(sp, "wins", 0),
                        "qualityStarts": _parse_stat(sp, "qualityStarts", 0),
                        "saves": _parse_stat(sp, "saves", 0),
                        "holds": _parse_stat(sp, "holds", 0),
                    },
                    "lastSeven": {
                        "inningsPitched": _parse_stat(lp, "inningsPitched", 1),
                        "era":  _parse_stat(lp, "era"),
                        "whip": _parse_stat(lp, "whip"),
                        "k9":   _parse_stat(lp, "strikeoutsPer9Inn"),
                    },
                }
            else:
                data = {
                    "isPitcher": False,
                    "season": {
                        "games": _parse_stat(sh, "gamesPlayed", 0),
                        "avg":   _parse_stat(sh, "avg"),
                        "obp":   _parse_stat(sh, "obp"),
                        "slg":   _parse_stat(sh, "slg"),
                        "ops":   _parse_stat(sh, "ops"),
                        "hr":    _parse_stat(sh, "homeRuns", 0),
                        "rbi":   _parse_stat(sh, "rbi", 0),
                        "r":     _parse_stat(sh, "runs", 0),
                        "sb":    _parse_stat(sh, "stolenBases", 0),
                    },
                    "lastSeven": {
                        "avg": _parse_stat(lh, "avg"),
                        "obp": _parse_stat(lh, "obp"),
                        "slg": _parse_stat(lh, "slg"),
                        "ops": _parse_stat(lh, "ops"),
                        "hr":  _parse_stat(lh, "homeRuns", 0),
                        "rbi": _parse_stat(lh, "rbi", 0),
                        "r":   _parse_stat(lh, "runs", 0),
                        "sb":  _parse_stat(lh, "stolenBases", 0),
                    },
                }

            fresh[name] = data
            _player_stats_cache[name] = {"ts": now, "data": data}

    return fresh


# ── Player news ───────────────────────────────────────────────────────────────

_news_cache = {}  # {player_name: {"ts": float, "items": list}}
NEWS_CACHE_TTL = 10 * 60  # 10 minutes

FANGRAPHS_FEEDS = [
    "https://www.fangraphs.com/feed/",
    "https://www.fangraphs.com/fantasy/feed/",
]

# Noise keywords — skip articles whose titles are purely game recaps
RECAP_KEYWORDS = [
    " goes ", " for ", "batting", "lineup", "roster move", "placed on",
    "activated", "recalled", "optioned", "scratched", "box score",
]

# Words that signal analytical content — prefer these
ANALYSIS_KEYWORDS = [
    "analysis", "breakdown", "projection", "prospect", "scouting",
    "fantasy", "outlook", "preview", "profile", "evaluation", "metric",
    "statcast", "spin rate", "exit velo", "trade value", "deep dive",
]

_fg_cache = {"ts": 0, "items": []}  # shared FanGraphs feed cache
FG_CACHE_TTL = 15 * 60


def _fetch_rss_items(url):
    """Fetch and parse an RSS feed, return list of raw dicts."""
    try:
        resp = requests.get(url, timeout=8, headers={
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
        })
        resp.raise_for_status()
        root = ET.fromstring(resp.content)
    except Exception as e:
        print(f"RSS fetch error {url}: {e}", flush=True)
        return []

    cutoff = datetime.now(timezone.utc) - timedelta(days=3)
    items = []
    for item in root.findall(".//item"):
        title = item.findtext("title", "").strip()
        link = item.findtext("link", "").strip()
        pub_str = item.findtext("pubDate", "")
        source_el = item.find("source")
        source = source_el.text.strip() if source_el is not None else ""
        desc = item.findtext("description", "")

        try:
            pub_dt = parsedate_to_datetime(pub_str)
            if pub_dt < cutoff:
                continue
            published_iso = pub_dt.isoformat()
        except Exception:
            published_iso = pub_str

        if title and link:
            items.append({"title": title, "url": link, "source": source,
                          "published": published_iso, "_desc": desc})
    return items


EXCLUDED_DOMAINS = {"cdn-ottoneu.fangraphs.com"}

def _get_fangraphs_items():
    """Return cached FanGraphs feed items (both main + fantasy)."""
    now = time.time()
    if now - _fg_cache["ts"] < FG_CACHE_TTL:
        return _fg_cache["items"]
    all_items = []
    for feed_url in FANGRAPHS_FEEDS:
        for item in _fetch_rss_items(feed_url):
            if not any(d in item.get("url", "") for d in EXCLUDED_DOMAINS):
                all_items.append(item)
    _fg_cache["ts"] = now
    _fg_cache["items"] = all_items
    return all_items


def _is_analytical(title):
    tl = title.lower()
    if any(k in tl for k in ANALYSIS_KEYWORDS):
        return True
    if any(k in tl for k in RECAP_KEYWORDS):
        return False
    return True  # neutral — include


def fetch_player_news(player_name):
    now = time.time()
    cached = _news_cache.get(player_name)
    if cached and now - cached["ts"] < NEWS_CACHE_TTL:
        return cached["items"]

    name_lower = player_name.lower()
    results = []

    # 1. FanGraphs — show any mention of the player in the last 3 days (exclude Ottoneu CDN)
    for item in _get_fangraphs_items():
        if "cdn-ottoneu.fangraphs.com" in item.get("url", ""):
            continue
        text = (item["title"] + " " + item.get("_desc", "")).lower()
        if name_lower in text:
            results.append({k: v for k, v in item.items() if k != "_desc"})
            results[-1]["source"] = "FanGraphs"
            if len(results) >= 5:
                break

    # 2. Google News — restricted to analytical outlets, exclude recaps
    if len(results) < 5:
        query = requests.utils.quote(
            f'"{player_name}" (site:fangraphs.com OR site:baseballprospectus.com '
            f'OR site:theathletic.com OR site:theringer.com OR site:mlb.com/news)'
        )
        url = f"https://news.google.com/rss/search?q={query}&hl=en-US&gl=US&ceid=US:en"
        seen_titles = {r["title"] for r in results}
        for item in _fetch_rss_items(url):
            if any(d in item.get("url", "") for d in EXCLUDED_DOMAINS):
                continue
            if item["title"] not in seen_titles and _is_analytical(item["title"]):
                results.append({k: v for k, v in item.items() if k != "_desc"})
                seen_titles.add(item["title"])
                if len(results) >= 5:
                    break

    _news_cache[player_name] = {"ts": now, "items": results}
    return results


# ── ESPN matchup ──────────────────────────────────────────────────────────────

ESPN_STAT_MAP = {
    # Confirmed from raw scoreByStat dump 2026-03-30
    0:  ("AB",   "At Bats",          False),
    1:  ("H",    "Hits",             False),
    2:  ("AVG",  "Batting Avg",      False),
    3:  ("BB",   "Walks",            False),   # counting stat, value=8
    4:  ("SLG",  "Slugging %",       False),   # ESPN stores as 0; computed via _fix_rate_stats
    5:  ("HR",   "Home Runs",        False),
    6:  ("R",    "Runs",             False),
    7:  ("RBI",  "RBIs",             False),
    8:  ("BB",   "Walks",            False),
    9:  ("OBP",  "On-Base %",        False),   # ESPN computed; confirmed 0.460
    10: ("K",    "K (Batter)",       True),
    11: ("SB",   "Stolen Bases",     False),
    12: ("CS",   "Caught Stealing",  True),
    13: ("HBP",  "Hit by Pitch",     False),
    17: ("OPS",  "OPS",               False),   # ~0.390 seen in raw; ESPN field unclear
    20: ("R",    "Runs",             False),
    21: ("RBI",  "RBIs",             False),
    23: ("SB",   "Stolen Bases",     False),
    24: ("3B",   "Triples",           False),  # confirmed: used as triples in SLG formula
    25: ("2B",   "Doubles",          False),
    33: ("TB",   "Total Bases",      False),  # stat_id 33 appears to be TB
    34: ("IP",   "Innings Pitched",  False),  # higher = better (more innings pitched)
    37: ("HA",   "Hits Allowed",     True),
    38: ("ER",   "Earned Runs",      True),
    39: ("BBA",  "BB Allowed",       True),
    41: ("WHIP", "WHIP",             True),    # confirmed 1.269
    45: ("APP",  "Pitcher App.",      False),  # was mislabeled W; stat_id 53 is the real W
    46: ("L",    "Losses",           True),
    47: ("ERA",  "ERA",              True),    # confirmed 3.46
    48: ("K",    "Strikeouts",       False),
    49: ("K/9",  "K per 9",          False),   # confirmed 10.73 (was mapped to 62)
    53: ("W",    "Wins",             False),
    54: ("L",    "Losses",           True),
    57: ("SV",   "Saves",            False),
    63: ("QS",   "Quality Starts",   False),
    72: ("HLD",  "Holds",            False),
    74: ("SVHD", "Saves+Holds",      False),   # ESPN "NSV"; league calls it SVHD
    83: ("HLD",  "Holds",            False),
}

# Rate stats computed from component counting stats (stat IDs)
RATE_STAT_COMPONENTS = {
    2:  {"num": [1],      "den": [0],  "mult": 1},   # AVG  = H / AB
    41: {"num": [37, 39], "den": [34], "mult": 1},   # WHIP = (HA + BBA) / IP
    47: {"num": [38],     "den": [34], "mult": 9},   # ERA  = (ER / IP) × 9
}


def _aggregate_roster_stats(entries):
    """Sum full-season stats (statSplitTypeId=0) for all players in a roster."""
    raw = {}
    for entry in entries:
        pool = entry.get("playerPoolEntry") or {}
        stats_list = (pool.get("player") or {}).get("stats") or []
        for stat_entry in stats_list:
            if stat_entry.get("statSplitTypeId") != 0:
                continue
            for sid_str, val in (stat_entry.get("stats") or {}).items():
                try:
                    sid = int(sid_str)
                    raw[sid] = raw.get(sid, 0) + (val or 0)
                except (ValueError, TypeError):
                    pass
            break  # one season-split entry per player is enough

    result = dict(raw)
    for stat_id, defn in RATE_STAT_COMPONENTS.items():
        num_total = sum(raw.get(sid, 0) for sid in defn["num"])
        den_total = sum(raw.get(sid, 0) for sid in defn["den"])
        result[stat_id] = (num_total / den_total * defn["mult"]) if den_total > 0 else None
    # SLG: not in RATE_STAT_COMPONENTS (non-standard formula) — compute from components
    ab = raw.get(0, 0)
    if ab:
        h, doubles = raw.get(1, 0), raw.get(25, 0)
        triples, hr = raw.get(24, 0), raw.get(5, 0)
        result[4] = round((h + doubles + 2 * triples + 3 * hr) / ab, 4)
    # SVHD: SV + HLD
    sv, hld = raw.get(57, 0), raw.get(83, 0)
    if sv or hld:
        result[74] = sv + hld
    return result


def _get_team_players(source_data, team_id):
    """Extract player names + ESPN position IDs for a team from roster data."""
    if team_id is None:
        return []
    tid = int(team_id)
    teams = source_data.get("teams", [])
    for team in teams:
        if int(team.get("id", -1)) == tid:
            entries = (team.get("roster") or {}).get("entries", [])
            result = []
            for e in entries:
                pool   = e.get("playerPoolEntry") or {}
                player = pool.get("player") or {}
                name   = player.get("fullName")
                if name:
                    result.append({
                        "name":       name,
                        "positionId": player.get("defaultPositionId"),
                    })
            print(f"_get_team_players tid={tid} → {len(result)} players", flush=True)
            return result
    print(f"_get_team_players tid={tid} not found in {[t.get('id') for t in teams[:6]]}", flush=True)
    return []


def _get_opp_players(season_source, opp_side, opp_team_id):
    """Get opponent players — tries season_source first, falls back to matchup roster entries."""
    result = _get_team_players(season_source, opp_team_id)
    if result:
        return result
    # Fallback: extract from the matchup side's rosterForCurrentScoringPeriod
    # (present in mMatchupScore / mMatchup views)
    entries = (opp_side or {}).get("rosterForCurrentScoringPeriod", {}).get("entries", [])
    fallback = []
    for e in entries:
        pool   = e.get("playerPoolEntry") or {}
        player = pool.get("player") or {}
        name   = player.get("fullName")
        if name:
            fallback.append({
                "name":       name,
                "positionId": player.get("defaultPositionId"),
            })
    print(f"_get_opp_players fallback via matchup roster: {len(fallback)} players", flush=True)
    return fallback



def _fix_rate_stats(sbs):
    """Compute stats ESPN stores as 0 or omits:
    - SLG (stat_id 4): computed from AB/H/2B/3B/HR components
    - SVHD (stat_id 74): computed as SV (57) + HLD (83)
    """
    def s(sid):
        e = sbs.get(str(sid))
        return (e.get("score") if isinstance(e, dict) else e) or 0

    result = dict(sbs)

    # ── SLG ──────────────────────────────────────────────────────────────────────
    slg_entry = sbs.get("4")
    if not (isinstance(slg_entry, dict) and slg_entry.get("score")):
        ab = s(0)
        if ab:
            h, hr = s(1), s(5)
            doubles, triples = s(25), s(24)
            total_bases = h + doubles + 2 * triples + 3 * hr
            base = slg_entry if isinstance(slg_entry, dict) else {}
            result["4"] = {**base, "score": round(total_bases / ab, 4)}

    # ── SVHD ─────────────────────────────────────────────────────────────────────
    svhd_entry = sbs.get("74")
    if not (isinstance(svhd_entry, dict) and svhd_entry.get("score")):
        sv, hld = s(57), s(83)
        if sv or hld:
            base = svhd_entry if isinstance(svhd_entry, dict) else {}
            result["74"] = {**base, "score": sv + hld}

    return result


def _percentile(vals_by_team, team_id, is_reverse):
    """Return league percentile (0–100) for a team in a given stat. None if insufficient data."""
    valid = [(tid, v) for tid, v in vals_by_team.items() if v is not None]
    if len(valid) < 2:
        return None
    my_val = vals_by_team.get(team_id)
    if my_val is None:
        return None
    if is_reverse:
        below = sum(1 for _, v in valid if v > my_val)
    else:
        below = sum(1 for _, v in valid if v < my_val)
    return round(below / (len(valid) - 1) * 100)


def process_espn_matchup(roster_data, matchup_data, swid, team_id=None, roster_api_data=None):
    """Process pre-fetched ESPN data (fetched in-browser by extension) into matchup analytics."""

    # scoringPeriodId is a daily counter; matchupPeriodId is weekly — they differ.
    # We'll find the team's matchup first, then read the actual matchupPeriodId from it.
    scoring_period = (roster_data.get("scoringPeriodId")
                      or (matchup_data or {}).get("scoringPeriodId")
                      or 1)

    swid_clean = swid.strip("{}")

    # Find the user's teamId via multiple strategies
    my_team_id = int(team_id) if team_id else None

    # Strategy 2: match SWID in members list
    if my_team_id is None:
        for member in roster_data.get("members", []):
            if member.get("id", "").strip("{}") == swid_clean:
                my_team_id = member.get("onTeamId")
                break

    # Strategy 3: match primaryOwner on teams
    if my_team_id is None:
        for t in roster_data.get("teams", []):
            owner = t.get("primaryOwner", "").strip("{}")
            if owner == swid_clean:
                my_team_id = t.get("id")
                break

    if my_team_id is None and roster_data.get("teams"):
        my_team_id = roster_data["teams"][0]["id"]

    # Build team name map — try location+nickname, fall back to member name, then "Team N"
    member_names = {}
    for src in [roster_data, matchup_data or {}]:
        for m in src.get("members", []):
            tid = m.get("onTeamId")
            name = (m.get("displayName") or
                    f"{m.get('firstName','')} {m.get('lastName','')}".strip())
            if tid and name:
                member_names[tid] = name

    team_map = {}
    for src in [roster_data, matchup_data or {}]:
        for t in src.get("teams", []):
            tid = t.get("id")
            if tid is None:
                continue
            loc  = t.get("location", "")
            nick = t.get("nickname", "")
            name = f"{loc} {nick}".strip()
            if tid not in team_map or not team_map[tid] or team_map[tid].startswith("Team "):
                team_map[tid] = name or member_names.get(tid) or f"Team {tid}"
    print(f"member_names={dict(list(member_names.items())[:4])} team_map={dict(list(team_map.items())[:4])}", flush=True)

    # Log team fields to diagnose missing names
    if roster_data.get("teams"):
        t0 = roster_data["teams"][0]
        print(f"team fields sample: {list(t0.keys())}", flush=True)
    print(f"my_team_id={my_team_id} scoring_period={scoring_period} teams={list(team_map.items())[:4]}", flush=True)

    # Matchup scoring comes from matchupData if available, fall back to rosterData
    schedule_source = matchup_data if (matchup_data and matchup_data.get("schedule")) else roster_data
    all_schedule = schedule_source.get("schedule", [])
    sched_summary = [(m.get("matchupPeriodId"), (m.get("home") or {}).get("teamId"), (m.get("away") or {}).get("teamId")) for m in all_schedule]
    print(f"matchup_data={'yes' if matchup_data else 'no'} schedule_len={len(all_schedule)} periods/teams: {sched_summary}", flush=True)

    # Find the team's most recent matchup (highest matchupPeriodId) — don't filter by
    # scoringPeriodId since it's a daily counter and matchupPeriodId is weekly.
    my_matchup = None
    for matchup in all_schedule:
        home = matchup.get("home") or {}
        away = matchup.get("away") or {}
        if home.get("teamId") == my_team_id or away.get("teamId") == my_team_id:
            if my_matchup is None or matchup.get("matchupPeriodId", 0) > my_matchup.get("matchupPeriodId", 0):
                my_matchup = matchup

    if my_matchup is None:
        print(f"No matchup found for team {my_team_id} (scoring_period={scoring_period})", flush=True)
        return None

    current_period = my_matchup.get("matchupPeriodId", scoring_period)
    home = my_matchup.get("home") or {}
    away = my_matchup.get("away") or {}
    if home.get("teamId") == my_team_id:
        my_side, opp_side = home, away
    else:
        my_side, opp_side = away, home

    all_period_stats = {}
    for matchup in all_schedule:
        if matchup.get("matchupPeriodId") != current_period:
            continue
        for side_key in ("home", "away"):
            side = matchup.get(side_key) or {}
            tid = side.get("teamId")
            if tid:
                sbs = (side.get("cumulativeScore") or {}).get("scoreByStat") or {}
                all_period_stats[tid] = _fix_rate_stats(sbs)

    opp_team_id = (opp_side or {}).get("teamId")
    my_cumul  = (my_side  or {}).get("cumulativeScore") or {}
    opp_cumul = (opp_side or {}).get("cumulativeScore") or {}
    my_sbs    = _fix_rate_stats(my_cumul.get("scoreByStat")  or {})
    opp_sbs   = _fix_rate_stats(opp_cumul.get("scoreByStat") or {})

    # Log all raw non-zero scores to help identify stat_ids for doubles/triples
    raw_my = my_cumul.get("scoreByStat") or {}
    nonzero = {k: v.get("score") if isinstance(v, dict) else v for k, v in raw_my.items() if (v.get("score") if isinstance(v, dict) else v)}
    print(f"raw_sbs nonzero: {nonzero}", flush=True)
    print(f"my_team={my_team_id} opp={opp_team_id} my_sbs_keys={list(my_sbs.keys())[:10]}", flush=True)

    # Season stats from mRoster (has player season stats); fall back to mDraftDetail
    season_source = roster_api_data if roster_api_data and roster_api_data.get("teams") else roster_data
    print(f"season_source={'mRoster' if season_source is roster_api_data else 'mDraftDetail'}", flush=True)
    all_season_stats = {}
    for team in season_source.get("teams", []):
        tid = team.get("id")
        entries = (team.get("roster") or {}).get("entries", [])
        all_season_stats[tid] = _aggregate_roster_stats(entries)

    # If we only got one team's data (mDraftDetail), fall back to aggregating all periods
    # from the schedule — gives all 12 teams' season-to-date stats without needing mRoster.
    if len(all_season_stats) < 2:
        all_season_stats = {}
        for matchup in all_schedule:
            for side_key in ("home", "away"):
                side = matchup.get(side_key) or {}
                tid = side.get("teamId")
                if not tid:
                    continue
                sbs = (side.get("cumulativeScore") or {}).get("scoreByStat") or {}
                if tid not in all_season_stats:
                    all_season_stats[tid] = {}
                for sid_str, entry in sbs.items():
                    val = (entry.get("score") if isinstance(entry, dict) else entry) or 0
                    try:
                        key = int(sid_str)
                        all_season_stats[tid][key] = all_season_stats[tid].get(key, 0) + val
                    except (ValueError, TypeError):
                        pass
        # Recompute stats ESPN stores as 0 or omits; leave ESPN-provided values intact
        for s in all_season_stats.values():
            ab, h       = s.get(0, 0), s.get(1, 0)
            ip          = s.get(34, 0)
            ha, bba     = s.get(37, 0), s.get(39, 0)
            k           = s.get(48, 0)
            doubles     = s.get(25, 0)
            triples, hr = s.get(24, 0), s.get(5, 0)
            sv, hld     = s.get(57, 0), s.get(83, 0)
            # AVG: ESPN doesn't include in scoreByStat — must compute
            if ab: s[2] = round(h / ab, 4)
            # SLG: only recompute if ESPN stored 0 (mirrors _fix_rate_stats logic)
            if ab and not s.get(4): s[4] = round((h + doubles + 2 * triples + 3 * hr) / ab, 4)
            # WHIP/K9: accumulate correctly from counting components across periods
            if ip: s[41] = round((ha + bba) / ip, 4)
            if ip: s[49] = round(9 * k / ip, 2)
            # ERA: ER not in scoreByStat so we can't recompute — keep ESPN's provided value
            # SVHD: computed as SV + HLD
            if sv or hld: s[74] = sv + hld
        print(f"all_season_stats fallback: {len(all_season_stats)} teams from schedule", flush=True)

    all_stat_id_strs = set(my_sbs.keys()) | set(opp_sbs.keys())
    categories = []
    league_week_stats = []
    seen_abbrs = set()
    for stat_id_str in sorted(all_stat_id_strs, key=lambda x: int(x)):
        stat_id = int(stat_id_str)
        info = ESPN_STAT_MAP.get(stat_id)
        if not info:
            continue
        abbr, name, is_reverse = info
        if abbr in seen_abbrs:
            continue
        seen_abbrs.add(abbr)

        my_stat  = my_sbs.get(stat_id_str)  or {}
        opp_stat = opp_sbs.get(stat_id_str) or {}

        # Skip stats ESPN doesn't score in this league (no WIN/LOSS/TIE result)
        if not my_stat.get("result") and not opp_stat.get("result"):
            continue

        period_vals = {
            tid: (stats.get(stat_id_str) or {}).get("score")
            for tid, stats in all_period_stats.items()
        }

        season_vals = {
            tid: stats.get(stat_id)
            for tid, stats in all_season_stats.items()
        }

        categories.append({
            "statId":        stat_id,
            "abbr":          abbr,
            "name":          name,
            "isReverseItem": is_reverse,
            "myScore":       my_stat.get("score"),
            "oppScore":      opp_stat.get("score"),
            "result":        my_stat.get("result", "TIE"),
            "myPercentile":  _percentile(period_vals, my_team_id,  is_reverse),
            "oppPercentile": _percentile(period_vals, opp_team_id, is_reverse),
            "mySeasonPct":   _percentile(season_vals, my_team_id,  is_reverse),
            "oppSeasonPct":  _percentile(season_vals, opp_team_id, is_reverse),
        })

        # League-wide rankings for this stat this week
        team_scores = []
        for tid, score in period_vals.items():
            team_scores.append({
                "teamId": tid,
                "name":   team_map.get(tid, f"Team {tid}"),
                "score":  score,
                "isMe":   tid == my_team_id,
                "isOpp":  tid == opp_team_id,
            })
        team_scores.sort(key=lambda x: (
            x["score"] is None,
            (x["score"] or 0) if is_reverse else -(x["score"] or 0)
        ))
        for i, t in enumerate(team_scores):
            t["rank"] = i + 1
        league_week_stats.append({
            "statId":        stat_id,
            "abbr":          abbr,
            "name":          name,
            "isReverseItem": is_reverse,
            "teams":         team_scores,
        })

    return {
        "myTeam":          {"id": my_team_id,  "name": team_map.get(my_team_id,  "My Team")},
        "opponent":        {"id": opp_team_id, "name": team_map.get(opp_team_id, "Opponent")},
        "record":          {"wins": my_cumul.get("wins", 0), "losses": my_cumul.get("losses", 0), "ties": my_cumul.get("ties", 0)},
        "categories":      categories,
        "leagueWeekStats": league_week_stats,
        "scoringPeriodId": current_period,
        "myPlayers":       _get_team_players(season_source, my_team_id),
        "oppPlayers":      _get_opp_players(season_source, opp_side, opp_team_id),
    }


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/api/roster", methods=["POST"])
def get_roster():
    body = request.json or {}
    league_id = body.get("leagueId", "").strip()
    espn_s2   = body.get("espnS2", "").strip()
    swid      = body.get("swid", "").strip()

    if not all([league_id, espn_s2, swid]):
        return jsonify({"error": "leagueId, espnS2, and swid are required"}), 400

    try:
        players = fetch_espn_roster(league_id, espn_s2, swid)
        return jsonify({"players": players})
    except requests.HTTPError as e:
        status = e.response.status_code if e.response else 500
        body = ""
        try:
            body = e.response.text[:500]
        except Exception:
            pass
        print(f"ESPN HTTP error {status}: {body}", flush=True)
        if status == 401:
            return jsonify({"error": "Invalid ESPN credentials", "detail": body}), 401
        return jsonify({"error": f"ESPN API error: {status}", "detail": body}), status
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        print(f"ESPN error: {tb}", flush=True)
        return jsonify({"error": str(e), "traceback": tb}), 500


@app.route("/api/games", methods=["GET"])
def get_games():
    roster_param = request.args.get("roster", "")
    roster = [p.strip() for p in roster_param.split(",") if p.strip()] if roster_param else []

    try:
        games = fetch_todays_games()
    except Exception as e:
        return jsonify({"error": str(e)}), 500

    if not roster:
        return jsonify({"games": games})

    # Annotate all games with which roster players are in each game
    for game in games:
        game_id = game["id"]
        pp = game.get("probablePitchers", {})
        probable = [v for v in pp.values() if v]

        if game["status"] == "Preview":
            # Only tag a pitcher if they're the confirmed probable starter for this game
            found = [{"name": p, "position": "SP"} for p in roster if p in probable]
            # Also check boxscore for rostered batters, but never infer pitchers from it
            boxscore = get_players_in_game(game_id, roster)
            found += [p for p in boxscore if p["position"] not in ("P", "SP", "RP")]
        else:
            found = get_players_in_game(game_id, roster)

        if found:
            game["fantasyPlayers"] = found

    return jsonify({"games": games})


@app.route("/api/games/<int:game_id>/live", methods=["GET"])
def get_live(game_id):
    roster_param = request.args.get("roster", "")
    roster_names = set(p.strip() for p in roster_param.split(",") if p.strip())
    try:
        feed = fetch_live_feed(game_id)
        data = parse_live_feed(feed, roster_names or None)
        return jsonify(data)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/news", methods=["GET"])
def get_news():
    players_param = request.args.get("players", "")
    players = [p.strip() for p in players_param.split(",") if p.strip()]
    if not players:
        return jsonify({"news": {}})

    result = {}
    for player in players[:20]:
        result[player] = fetch_player_news(player)
    return jsonify({"news": result})


@app.route("/api/matchup", methods=["POST"])
def get_matchup():
    body = request.json or {}
    roster_data      = body.get("rosterData")
    matchup_data     = body.get("matchupData")
    roster_api_data  = body.get("rosterApiData")   # mRoster: has player season stats
    swid             = body.get("swid", "").strip()
    team_id          = body.get("teamId")

    if not roster_data or not swid:
        return jsonify({"error": "rosterData and swid are required"}), 400

    try:
        result = process_espn_matchup(roster_data, matchup_data, swid, team_id=team_id,
                                      roster_api_data=roster_api_data)
        if result is None:
            return jsonify({"error": "No active matchup found for this team"}), 404
        return jsonify(result)
    except Exception as e:
        import traceback
        print(f"Matchup error: {traceback.format_exc()}", flush=True)
        return jsonify({"error": str(e)}), 500


@app.route("/api/player-stats", methods=["GET"])
def get_player_stats():
    names = [p.strip() for p in request.args.get("players", "").split(",") if p.strip()]
    if not names:
        return jsonify({"error": "players param required"}), 400
    try:
        stats = _fetch_player_stats(names[:40])  # cap at 40 players
        return jsonify({"stats": stats})
    except Exception as e:
        import traceback
        print(f"Player stats error: {traceback.format_exc()}", flush=True)
        return jsonify({"error": str(e)}), 500


@app.route("/api/week-schedule", methods=["GET"])
def get_week_schedule():
    my_names  = [p.strip() for p in request.args.get("myPlayers",  "").split(",") if p.strip()]
    opp_names = [p.strip() for p in request.args.get("oppPlayers", "").split(",") if p.strip()]
    if not my_names:
        return jsonify({"error": "myPlayers is required"}), 400

    mlb          = _get_mlb_players()
    my_team_map  = {n: (mlb.get(n) or {}).get("teamId") for n in my_names}
    opp_team_map = {n: (mlb.get(n) or {}).get("teamId") for n in opp_names}

    today_str    = date.today().strftime("%Y-%m-%d")
    week_entries = _get_week_schedule()

    days = []
    for entry in week_entries:
        day_str  = entry["date"]
        playing  = set()
        pitchers = {}  # {teamId: pitcherName}
        for g in entry["games"]:
            for tid_key, pit_key in (("homeTeamId", "homePitcher"), ("awayTeamId", "awayPitcher")):
                tid = g.get(tid_key)
                if tid:
                    playing.add(tid)
                    if g.get(pit_key):
                        pitchers[tid] = g[pit_key]

        my_playing  = [n for n in my_names  if my_team_map.get(n)  in playing]
        opp_playing = [n for n in opp_names if opp_team_map.get(n) in playing]
        my_starts   = [n for n in my_playing  if pitchers.get(my_team_map[n])  == n]
        opp_starts  = [n for n in opp_playing if pitchers.get(opp_team_map[n]) == n]

        days.append({
            "date":       day_str,
            "label":      datetime.strptime(day_str, "%Y-%m-%d").strftime("%a"),
            "isToday":    day_str == today_str,
            "isPast":     day_str < today_str,
            "myPlayers":  my_playing,
            "oppPlayers": opp_playing,
            "myStarts":   my_starts,
            "oppStarts":  opp_starts,
        })

    remaining = [d for d in days if not d["isPast"]]
    return jsonify({
        "days": days,
        "summary": {
            "myGamesRemaining":   sum(len(d["myPlayers"])  for d in remaining),
            "oppGamesRemaining":  sum(len(d["oppPlayers"]) for d in remaining),
            "myStartsRemaining":  sum(len(d["myStarts"])   for d in remaining),
            "oppStartsRemaining": sum(len(d["oppStarts"])  for d in remaining),
        },
    })


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    app.run(debug=True, port=5000)
