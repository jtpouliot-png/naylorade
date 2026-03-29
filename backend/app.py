from flask import Flask, jsonify, request
from flask_cors import CORS
import requests
from datetime import date, datetime, timedelta, timezone
import xml.etree.ElementTree as ET
import time
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
    0:  ("AB",   "At Bats",          False),
    1:  ("H",    "Hits",             False),
    2:  ("AVG",  "Batting Avg",      False),
    3:  ("OBP",  "On-Base %",        False),
    4:  ("SLG",  "Slugging %",       False),
    5:  ("HR",   "Home Runs",        False),
    6:  ("R",    "Runs",             False),
    7:  ("RBI",  "RBIs",             False),
    8:  ("BB",   "Walks",            False),
    10: ("SO",   "K (Batter)",       True),
    11: ("SB",   "Stolen Bases",     False),
    12: ("CS",   "Caught Stealing",  True),
    14: ("OPS",  "OPS",              False),
    17: ("OPS",  "OPS",              False),
    20: ("R",    "Runs",             False),
    21: ("RBI",  "RBIs",             False),
    23: ("SB",   "Stolen Bases",     False),
    34: ("IP",   "Innings Pitched",  False),
    37: ("HA",   "Hits Allowed",     True),
    38: ("ER",   "Earned Runs",      True),
    39: ("BBA",  "BB Allowed",       True),
    41: ("WHIP", "WHIP",             True),
    45: ("W",    "Wins",             False),
    46: ("L",    "Losses",           True),
    47: ("ERA",  "ERA",              True),
    48: ("K",    "Strikeouts",       False),
    53: ("W",    "Wins",             False),
    54: ("L",    "Losses",           True),
    57: ("SV",   "Saves",            False),
    62: ("K/9",  "K per 9",          False),
    63: ("QS",   "Quality Starts",   False),
    64: ("ER",   "Earned Runs",      True),
    72: ("HLD",  "Holds",            False),
    74: ("NSV",  "Saves+Holds",      False),
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


def process_espn_matchup(roster_data, matchup_data, swid):
    """Process pre-fetched ESPN data (fetched in-browser by extension) into matchup analytics."""

    # scoringPeriodId and member/team info come from rosterData
    current_period = roster_data.get("scoringPeriodId", 1)

    swid_clean = swid.strip("{}")
    my_team_id = None
    for member in roster_data.get("members", []):
        if member.get("id", "").strip("{}") == swid_clean:
            my_team_id = member.get("onTeamId")
            break
    if my_team_id is None and roster_data.get("teams"):
        my_team_id = roster_data["teams"][0]["id"]

    team_map = {}
    for t in roster_data.get("teams", []):
        tid = t.get("id")
        if tid is None:
            continue
        loc  = t.get("location", "")
        nick = t.get("nickname", "")
        team_map[tid] = (f"{loc} {nick}".strip()) or f"Team {tid}"

    # Matchup scoring comes from matchupData if available, fall back to rosterData
    schedule_source = matchup_data if (matchup_data and matchup_data.get("schedule")) else roster_data
    print(f"schedule_source keys: {list(schedule_source.keys())} schedule_len={len(schedule_source.get('schedule', []))}", flush=True)

    all_period_stats = {}
    my_side = opp_side = None
    for matchup in schedule_source.get("schedule", []):
        if matchup.get("matchupPeriodId") != current_period:
            continue
        for side_key in ("home", "away"):
            side = matchup.get(side_key) or {}
            tid = side.get("teamId")
            if tid:
                sbs = (side.get("cumulativeScore") or {}).get("scoreByStat") or {}
                all_period_stats[tid] = sbs
        home = matchup.get("home") or {}
        away = matchup.get("away") or {}
        if home.get("teamId") == my_team_id:
            my_side, opp_side = home, away
        elif away.get("teamId") == my_team_id:
            my_side, opp_side = away, home

    if my_side is None:
        print(f"No matchup found for team {my_team_id} in period {current_period}", flush=True)
        return None

    opp_team_id = (opp_side or {}).get("teamId")
    my_cumul  = (my_side  or {}).get("cumulativeScore") or {}
    opp_cumul = (opp_side or {}).get("cumulativeScore") or {}
    my_sbs    = my_cumul.get("scoreByStat")  or {}
    opp_sbs   = opp_cumul.get("scoreByStat") or {}

    print(f"my_team={my_team_id} opp={opp_team_id} my_sbs_keys={list(my_sbs.keys())[:6]}", flush=True)

    # Season stats from roster entries
    all_season_stats = {}
    for team in roster_data.get("teams", []):
        tid = team.get("id")
        entries = (team.get("roster") or {}).get("entries", [])
        all_season_stats[tid] = _aggregate_roster_stats(entries)

    all_stat_id_strs = set(my_sbs.keys()) | set(opp_sbs.keys())
    categories = []
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

    return {
        "myTeam":          {"id": my_team_id,  "name": team_map.get(my_team_id,  "My Team")},
        "opponent":        {"id": opp_team_id, "name": team_map.get(opp_team_id, "Opponent")},
        "record":          {"wins": my_cumul.get("wins", 0), "losses": my_cumul.get("losses", 0), "ties": my_cumul.get("ties", 0)},
        "categories":      categories,
        "scoringPeriodId": current_period,
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
    roster_data  = body.get("rosterData")
    matchup_data = body.get("matchupData")
    swid         = body.get("swid", "").strip()

    if not roster_data or not swid:
        return jsonify({"error": "rosterData and swid are required"}), 400

    try:
        result = process_espn_matchup(roster_data, matchup_data, swid)
        if result is None:
            return jsonify({"error": "No active matchup found for this team"}), 404
        return jsonify(result)
    except Exception as e:
        import traceback
        print(f"Matchup error: {traceback.format_exc()}", flush=True)
        return jsonify({"error": str(e)}), 500


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    app.run(debug=True, port=5000)
