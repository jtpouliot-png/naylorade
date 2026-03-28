from flask import Flask, jsonify, request
from flask_cors import CORS
import requests
from datetime import date

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
    "default":     {"color": "#e0dedd", "url": "https://mlb.com"},
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

    # Broadcasts
    broadcasts = game.get("broadcasts", [])
    national = [b for b in broadcasts if b.get("type") == "N" or b.get("isNational")]
    broadcast_name = national[0].get("name", "Regional") if national else (broadcasts[0].get("name", "Regional") if broadcasts else "MLB.TV")

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
        "broadcast": get_broadcast_meta(broadcast_name),
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


def parse_live_feed(feed):
    lp = feed.get("liveData", {}).get("plays", {})
    current = lp.get("currentPlay", {})
    last_plays = lp.get("allPlays", [])

    # Last completed play description + who was batting/pitching in it
    last_play_desc = None
    last_play_batter = None
    last_play_pitcher = None
    for play in reversed(last_plays):
        about = play.get("about", {})
        if about.get("isComplete"):
            result = play.get("result", {})
            last_play_desc = result.get("description")
            matchup = play.get("matchup", {})
            last_play_batter = matchup.get("batter", {}).get("fullName")
            last_play_pitcher = matchup.get("pitcher", {}).get("fullName")
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

    return {
        "currentBatter": batter,
        "currentPitcher": pitcher,
        "lastPlay": last_play_desc,
        "lastPlayBatter": last_play_batter,
        "lastPlayPitcher": last_play_pitcher,
        "count": {
            "balls": count.get("balls", 0),
            "strikes": count.get("strikes", 0),
            "outs": count.get("outs", 0),
        },
        "bases": bases,
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
            found = [{"name": p, "position": "SP"} for p in roster if p in probable]
            if not found:
                found = get_players_in_game(game_id, roster)
        else:
            found = get_players_in_game(game_id, roster)

        if found:
            game["fantasyPlayers"] = found

    return jsonify({"games": games})


@app.route("/api/games/<int:game_id>/live", methods=["GET"])
def get_live(game_id):
    try:
        feed = fetch_live_feed(game_id)
        data = parse_live_feed(feed)
        return jsonify(data)
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok"})


if __name__ == "__main__":
    app.run(debug=True, port=5000)
