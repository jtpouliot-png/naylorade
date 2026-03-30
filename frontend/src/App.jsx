import { useState, useEffect, useCallback, useRef } from "react";

const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:5000";

function storage(key, val) {
  if (val !== undefined) localStorage.setItem(key, JSON.stringify(val));
  else { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
}

async function apiFetch(path, opts = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function timeNow() {
  return new Date().toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

export default function App() {
  const [roster, setRoster] = useState(() => storage("naylorade_roster") || []);
  const [games, setGames] = useState([]);
  const [gamesLoading, setGamesLoading] = useState(false);
  const [gamesError, setGamesError] = useState(null);
  const [liveData, setLiveData] = useState({});
  const [newsData, setNewsData] = useState({});
  const [setupOpen, setSetupOpen] = useState(false);
  const [rosterText, setRosterText] = useState(() => (storage("naylorade_roster") || []).join("\n"));
  const [feed, setFeed] = useState([]); // [{time, player, game, text, id}]
  const [notifPermission, setNotifPermission] = useState(() => typeof Notification !== "undefined" ? Notification.permission : "denied");
  const seenPlays = useRef(new Set());
  const notifiedAtBat = useRef({}); // {gameId: {batter, pitcher}} — last state we notified about

  const [view, setView] = useState("stream");
  const [matchupData, setMatchupData] = useState(null);
  const [matchupLoading, setMatchupLoading] = useState(false);
  const [matchupError, setMatchupError] = useState(null);

  const loadHistoricalPlays = useCallback(async (currentGames, currentRoster) => {
    const relevantGames = currentGames.filter(g => g.status === "Live" || g.status === "Final");
    if (!relevantGames.length) return;
    const rosterParam = encodeURIComponent(currentRoster.join(","));
    const historyItems = [];
    for (const game of relevantGames) {
      try {
        const data = await apiFetch(`/api/games/${game.id}/live?roster=${rosterParam}`);
        const gameLabel = `${game.awayTeam.abbr} @ ${game.homeTeam.abbr}`;
        for (const play of data.rosterPlays || []) {
          const player = currentRoster.find(p => p === play.batter || p === play.pitcher);
          if (!player) continue;
          const playId = `${game.id}-${player}-${play.description.slice(0, 40)}`;
          if (!seenPlays.current.has(playId)) {
            seenPlays.current.add(playId);
            const t = play.startTime ? new Date(play.startTime).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "";
            historyItems.push({ id: playId, time: t, player, game: gameLabel, text: play.description, inning: play.inning, half: play.half, outs: play.outs });
          }
        }
      } catch { }
    }
    if (historyItems.length) {
      setFeed(prev => {
        const combined = [...historyItems, ...prev];
        const seen = new Set();
        return combined.filter(item => seen.has(item.id) ? false : (seen.add(item.id), true)).slice(0, 200);
      });
    }
  }, []);

  const loadGames = useCallback(async (rosterList, seedHistory = false) => {
    if (!rosterList?.length) return;
    setGamesLoading(true);
    setGamesError(null);
    try {
      const param = encodeURIComponent(rosterList.join(","));
      const data = await apiFetch(`/api/games?roster=${param}`);
      const loadedGames = data.games || [];
      setGames(loadedGames);
      if (seedHistory) loadHistoricalPlays(loadedGames, rosterList);

      // Fetch news for players in games where they appear
      const playersInGames = [...new Set(
        loadedGames.flatMap(g => (g.fantasyPlayers || []).map(fp => fp.name))
      )];
      if (playersInGames.length) {
        const newsParam = encodeURIComponent(playersInGames.join(","));
        apiFetch(`/api/news?players=${newsParam}`)
          .then(d => setNewsData(d.news || {}))
          .catch(() => {});
      }
    } catch (e) {
      setGamesError(e.message);
    } finally {
      setGamesLoading(false);
    }
  }, [loadHistoricalPlays]);

  const loadMatchup = useCallback(async () => {
    const espnData = storage("naylorade_espn_data");
    if (!espnData?.rosterData || !espnData?.swid) return;
    setMatchupLoading(true);
    setMatchupError(null);
    try {
      const data = await apiFetch("/api/matchup", {
        method: "POST",
        body: JSON.stringify({ rosterData: espnData.rosterData, matchupData: espnData.matchupData, rosterApiData: espnData.rosterApiData, swid: espnData.swid, teamId: espnData.teamId }),
      });
      setMatchupData(data);
    } catch (e) {
      setMatchupError(e.message);
    } finally {
      setMatchupLoading(false);
    }
  }, []);

  async function requestNotifications() {
    if (typeof Notification === "undefined") return;
    const result = await Notification.requestPermission();
    setNotifPermission(result);
  }

  function saveRoster() {
    const players = rosterText.split("\n").map(p => p.trim()).filter(Boolean);
    setRoster(players);
    storage("naylorade_roster", players);
    setSetupOpen(false);
    loadGames(players);
    if (Notification.permission === "default") requestNotifications();
  }

  function clearRoster() {
    setRoster([]); setRosterText(""); setGames([]);
    storage("naylorade_roster", []);
  }

  // Poll all live games and build feed
  const pollAllLive = useCallback(async (currentGames, currentRoster) => {
    const liveGames = currentGames.filter(g => g.status === "Live");
    if (!liveGames.length) return;

    const updates = {};
    for (const game of liveGames) {
      try {
        const data = await apiFetch(`/api/games/${game.id}/live`);
        updates[game.id] = data;

        // Check last play — only add to feed if player was batting or pitching (offensive plays only)
        const play = data.lastPlay;
        if (play) {
          const matchedPlayers = currentRoster.filter(p =>
            p === data.lastPlayBatter || p === data.lastPlayPitcher
          );

          const gameLabel = `${game.awayTeam.abbr} @ ${game.homeTeam.abbr}`;
          for (const matchedPlayer of matchedPlayers) {
            const playId = `${game.id}-${matchedPlayer}-${play.slice(0, 40)}`;
            if (!seenPlays.current.has(playId)) {
              seenPlays.current.add(playId);
              setFeed(prev => [{
                id: playId,
                time: timeNow(),
                player: matchedPlayer,
                game: gameLabel,
                text: play,
                inning: data.lastPlayInning,
                half: data.lastPlayHalf,
                outs: data.lastPlayOuts,
              }, ...prev].slice(0, 100));
            }
          }
        }

        // Browser notification when a rostered player steps up to bat or starts pitching
        if (Notification.permission === "granted") {
          const prev = notifiedAtBat.current[game.id] || {};
          const gameLabel = `${game.awayTeam.abbr} @ ${game.homeTeam.abbr}`;
          const mlbtv = (game.broadcasts || []).find(b => b.name === "MLB.TV");
          const watchUrl = mlbtv?.url || game.broadcasts?.[0]?.url;
          const broadcastName = (game.broadcasts || []).filter(b => b.name !== "MLB.TV").map(b => b.name).join("/") || "MLB.TV";

          if (data.currentBatter && data.currentBatter !== prev.batter && currentRoster.includes(data.currentBatter)) {
            const n = new Notification(`${data.currentBatter.split(" ").slice(-1)[0]} up to bat`, {
              body: `${gameLabel} · Watch on ${broadcastName}`,
              tag: `bat-${game.id}-${data.currentBatter}`,
            });
            if (watchUrl) n.onclick = () => { window.open(watchUrl, "_blank"); n.close(); };
          }

          if (data.currentPitcher && data.currentPitcher !== prev.pitcher && currentRoster.includes(data.currentPitcher)) {
            const n = new Notification(`${data.currentPitcher.split(" ").slice(-1)[0]} now pitching`, {
              body: `${gameLabel} · Watch on ${broadcastName}`,
              tag: `pitch-${game.id}-${data.currentPitcher}`,
            });
            if (watchUrl) n.onclick = () => { window.open(watchUrl, "_blank"); n.close(); };
          }

          notifiedAtBat.current[game.id] = { batter: data.currentBatter, pitcher: data.currentPitcher };
        }
      } catch { }
    }
    setLiveData(prev => ({ ...prev, ...updates }));
  }, []);

  useEffect(() => {
    if (!roster.length) return;
    loadGames(roster, true); // seed historical plays on first load
    const interval = setInterval(() => loadGames(roster), 60_000);
    return () => clearInterval(interval);
  }, [roster, loadGames]);

  useEffect(() => {
    if (!games.length || !roster.length) return;
    pollAllLive(games, roster);
    const interval = setInterval(() => pollAllLive(games, roster), 15_000);
    return () => clearInterval(interval);
  }, [games, roster, pollAllLive]);

  useEffect(() => {
    if (view === "analytics" && !matchupData && !matchupLoading && !matchupError) {
      loadMatchup();
    }
  }, [view, matchupData, matchupLoading, matchupError, loadMatchup]);

  const myGames = games.filter(g => g.fantasyPlayers?.length > 0);
  const playingCount = myGames.length;

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=DM+Mono:wght@300;400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        :root {
          --bg: #f7f6f4; --surface: #ffffff;
          --border: #e8e6e2; --border-strong: #d0cdc8;
          --text-primary: #1a1917; --text-secondary: #6b6760; --text-muted: #a8a5a0;
          --font-sans: 'Geist', 'Helvetica Neue', sans-serif;
          --font-mono: 'DM Mono', 'Courier New', monospace;
        }
        body { background: var(--bg); color: var(--text-primary); font-family: var(--font-sans); }
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: var(--border-strong); border-radius: 2px; }
        .game-card { padding: 16px 18px; border-bottom: 1px solid var(--border); }
        .game-card:hover { background: #f0eeeb; }
        .btn-primary { background: var(--text-primary); color: var(--bg); border: none; padding: 10px 28px; font-family: var(--font-sans); font-size: 11px; font-weight: 600; letter-spacing: 0.06em; cursor: pointer; transition: opacity 0.15s; }
        .btn-primary:hover { opacity: 0.82; }
        .btn-outline { background: transparent; border: 1px solid var(--border-strong); color: var(--text-secondary); padding: 5px 14px; cursor: pointer; font-size: 11px; transition: all 0.15s; font-family: var(--font-sans); }
        .btn-outline:hover { border-color: var(--text-primary); color: var(--text-primary); }
        .btn-ghost { background: transparent; border: none; color: var(--text-muted); padding: 5px 10px; cursor: pointer; font-size: 11px; font-family: var(--font-sans); transition: color 0.15s; }
        .btn-ghost:hover { color: var(--text-primary); }
        .player-chip { display: inline-flex; align-items: center; font-size: 10px; font-weight: 500; padding: 3px 9px; border-radius: 100px; border: 1px solid var(--border-strong); color: var(--text-secondary); background: var(--surface); }
        .roster-textarea { width: 100%; height: 200px; background: var(--bg); border: 1px solid var(--border-strong); color: var(--text-primary); padding: 12px; font-family: var(--font-mono); font-size: 12px; outline: none; resize: none; line-height: 1.8; transition: border-color 0.15s; border-radius: 0; }
        .roster-textarea:focus { border-color: var(--text-primary); }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.25} }
        .live-dot { animation: pulse 1.8s ease-in-out infinite; }
        @keyframes feedIn { from{opacity:0;transform:translateY(-8px)} to{opacity:1;transform:translateY(0)} }
        .feed-item { animation: feedIn 0.4s ease; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .spinner { width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--text-primary); border-radius: 50%; animation: spin 0.7s linear infinite; display: inline-block; vertical-align: middle; }
      `}</style>

      <div style={{ background: "var(--bg)", minHeight: "100vh" }}>
        {/* Header */}
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "13px 24px", borderBottom: "1px solid var(--border)", background: "var(--surface)" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.02em" }}>Naylorade</span>
            <span style={{ fontSize: 10, color: "var(--text-muted)", letterSpacing: "0.06em", textTransform: "uppercase" }}>Stream Guide</span>
          </div>
          <div style={{ display: "flex", gap: 2, background: "var(--bg)", border: "1px solid var(--border)", borderRadius: 4, padding: 2 }}>
            {[["stream", "Stream"], ["analytics", "Matchup"]].map(([v, label]) => (
              <button key={v} onClick={() => setView(v)}
                style={{ background: view === v ? "var(--surface)" : "transparent", border: "none", padding: "4px 14px", fontSize: 11, fontWeight: view === v ? 600 : 400, color: view === v ? "var(--text-primary)" : "var(--text-muted)", cursor: "pointer", fontFamily: "var(--font-sans)", borderRadius: 3, transition: "all 0.15s" }}>
                {label}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {roster.length > 0 && (
              <span style={{ fontSize: 11, color: "var(--text-muted)", marginRight: 4 }}>
                {gamesLoading ? <span className="spinner" /> : `${playingCount} game${playingCount !== 1 ? "s" : ""} with your players`}
              </span>
            )}
            {roster.length > 0 && notifPermission !== "granted" && notifPermission !== "denied" && (
              <button className="btn-outline" onClick={requestNotifications} title="Get notified when your players are up to bat">
                Enable Alerts
              </button>
            )}
            {roster.length > 0 && notifPermission === "granted" && (
              <span style={{ fontSize: 11, color: "var(--text-muted)" }} title="Notifications on">🔔</span>
            )}
            {roster.length > 0 && <button className="btn-ghost" onClick={clearRoster}>Clear</button>}
            <button className="btn-outline" onClick={() => setSetupOpen(o => !o)}>
              {roster.length ? "Edit Roster" : "Set Up Roster"}
            </button>
          </div>
        </header>

        {/* Roster Setup */}
        {setupOpen && (
          <div style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)", padding: "20px 24px", maxWidth: 460 }}>
            <div style={{ fontSize: 11, fontWeight: 500, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 6 }}>Your Roster</div>
            <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12, lineHeight: 1.6 }}>One player name per line, exactly as ESPN spells them.</div>
            <textarea className="roster-textarea" placeholder={"Shohei Ohtani\nPaul Skenes\nGunnar Henderson\n..."} value={rosterText} onChange={e => setRosterText(e.target.value)} />
            <div style={{ display: "flex", gap: 10, marginTop: 12 }}>
              <button className="btn-primary" onClick={saveRoster}>Save Roster</button>
              <button className="btn-ghost" onClick={() => setSetupOpen(false)}>Cancel</button>
            </div>
          </div>
        )}

        {/* Empty state — stream only */}
        {!roster.length && !setupOpen && view === "stream" && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "calc(100vh - 57px)", gap: 14 }}>
            <div style={{ fontSize: 32 }}>⚾</div>
            <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em" }}>Add your fantasy roster</div>
            <div style={{ fontSize: 13, color: "var(--text-muted)", textAlign: "center", maxWidth: 300, lineHeight: 1.6 }}>Enter your players and we'll filter today's MLB games to only the ones that matter</div>
            <button className="btn-primary" style={{ marginTop: 8 }} onClick={() => setSetupOpen(true)}>Get Started</button>
          </div>
        )}

        {/* Analytics view */}
        {view === "analytics" && (
          <div style={{ height: setupOpen ? "calc(100vh - 340px)" : "calc(100vh - 57px)", overflowY: "auto" }}>
            <MatchupView
              data={matchupData}
              loading={matchupLoading}
              error={matchupError}
              onRefresh={loadMatchup}
              hasEspnData={!!storage("naylorade_espn_data")?.rosterData}
            />
          </div>
        )}

        {/* Main 3-panel layout */}
        {roster.length > 0 && view === "stream" && (
          <div style={{ display: "flex", height: setupOpen ? "calc(100vh - 340px)" : "calc(100vh - 57px)", overflow: "hidden" }}>

            {/* Panel 1: My Games (filtered) */}
            <div style={{ width: 260, borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)", flexShrink: 0 }}>
              <div style={{ padding: "9px 18px", fontSize: 9, fontWeight: 500, letterSpacing: "0.12em", color: "var(--text-muted)", textTransform: "uppercase", borderBottom: "1px solid var(--border)", background: "var(--surface)" }}>
                Your Games
              </div>
              <div style={{ overflowY: "auto", flex: 1 }}>
                {gamesError && <div style={{ padding: "16px 18px", fontSize: 12, color: "#c0392b" }}>⚠ {gamesError}</div>}
                {!gamesLoading && !gamesError && myGames.length === 0 && (
                  <div style={{ padding: "24px 18px", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6 }}>None of your players are in today's games.</div>
                )}
                {myGames.map(game => (
                  <GameCard key={game.id} game={game} />
                ))}
              </div>
              {/* Roster strip */}
              <div style={{ borderTop: "1px solid var(--border)", padding: "12px 18px", background: "var(--surface)" }}>
                <div style={{ fontSize: 9, fontWeight: 500, letterSpacing: "0.12em", color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 8 }}>Roster</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 150, overflowY: "auto" }}>
                  {roster.map(p => {
                    const isPlaying = myGames.some(g => g.fantasyPlayers?.some(fp => fp.name === p));
                    return (
                      <div key={p} style={{ display: "flex", alignItems: "center", gap: 7, opacity: isPlaying ? 1 : 0.35 }}>
                        <div style={{ width: 5, height: 5, borderRadius: "50%", background: isPlaying ? "var(--text-primary)" : "var(--border-strong)", flexShrink: 0 }} />
                        <span style={{ fontSize: 11, fontWeight: isPlaying ? 500 : 400 }}>{p}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Panel 2: All Games Board */}
            <div style={{ flex: 1, overflowY: "auto", background: "var(--bg)", borderRight: "1px solid var(--border)" }}>
              <div style={{ padding: "9px 18px", fontSize: 9, fontWeight: 500, letterSpacing: "0.12em", color: "var(--text-muted)", textTransform: "uppercase", borderBottom: "1px solid var(--border)", background: "var(--surface)", position: "sticky", top: 0, zIndex: 1 }}>
                All Games Today
              </div>
              {gamesLoading
                ? <div style={{ padding: "24px 18px" }}><span className="spinner" /></div>
                : <AllGamesBoard games={games} liveData={liveData} newsData={newsData} />
              }
            </div>

            {/* Panel 3: Live Feed */}
            <div style={{ width: 300, display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)", flexShrink: 0 }}>
              <div style={{ padding: "9px 18px", fontSize: 9, fontWeight: 500, letterSpacing: "0.12em", color: "var(--text-muted)", textTransform: "uppercase", borderBottom: "1px solid var(--border)", background: "var(--surface)", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <span>Player Feed</span>
                {feed.length > 0 && (
                  <button className="btn-ghost" style={{ fontSize: 9, padding: "2px 6px" }} onClick={() => setFeed([])}>Clear</button>
                )}
              </div>
              <div style={{ overflowY: "auto", flex: 1, padding: "12px 0" }}>
                {feed.length === 0 && (
                  <div style={{ padding: "24px 18px", fontSize: 12, color: "var(--text-muted)", lineHeight: 1.7, textAlign: "center" }}>
                    <div style={{ fontSize: 22, marginBottom: 10 }}>📋</div>
                    Plays involving your players will appear here in real time.
                    {games.filter(g => g.status === "Live").length === 0 && (
                      <div style={{ marginTop: 10, fontSize: 11 }}>Waiting for games to start...</div>
                    )}
                  </div>
                )}
                {feed.map((item) => (
                  <FeedItem key={item.id} item={item} />
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function ordinal(n) {
  if (n === 1) return "1st";
  if (n === 2) return "2nd";
  if (n === 3) return "3rd";
  return `${n}th`;
}

function FeedItem({ item }) {
  const situation = item.inning != null
    ? `${item.half === "top" ? "Top" : "Bot"} ${ordinal(item.inning)} · ${item.outs} ${item.outs === 1 ? "out" : "outs"}`
    : null;
  return (
    <div className="feed-item" style={{ padding: "12px 18px", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-primary)" }}>{item.player.split(" ").slice(-1)[0]}</span>
        <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{item.time}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
        <span style={{ fontSize: 10, color: "var(--text-muted)", letterSpacing: "0.04em" }}>{item.game}</span>
        {situation && (
          <>
            <span style={{ fontSize: 10, color: "var(--border-strong)" }}>·</span>
            <span style={{ fontSize: 10, fontWeight: 500, color: "var(--text-secondary)" }}>{situation}</span>
          </>
        )}
      </div>
      <div style={{ fontSize: 12, color: "var(--text-primary)", lineHeight: 1.6 }}>{item.text}</div>
    </div>
  );
}

function GameCard({ game }) {
  const isLive = game.status === "Live";
  return (
    <div className="game-card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        {isLive ? (
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div className="live-dot" style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--text-primary)", flexShrink: 0 }} />
            <span style={{ fontSize: 10, fontWeight: 600 }}>Live · {game.inning}</span>
          </div>
        ) : (
          <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{game.time}</span>
        )}
        <div style={{ display: "flex", gap: 3, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {(game.broadcasts || []).map(b => (
            <a key={b.name} href={b.url || "#"} target="_blank" rel="noreferrer"
              style={{ fontSize: 9, fontWeight: 500, padding: "2px 7px", borderRadius: 100, background: b.color || "#e0dedd", color: "var(--text-primary)", textDecoration: "none" }}>
              {b.name}
            </a>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
        {[game.awayTeam, null, game.homeTeam].map((team, i) =>
          team === null
            ? <div key="at" style={{ fontSize: 10, color: "var(--text-muted)" }}>@</div>
            : (
              <div key={team.abbr} style={{ flex: 1, textAlign: "center" }}>
                <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.01em" }}>{team.abbr}</div>
                <div style={{ fontSize: 8, color: "var(--text-muted)", marginTop: 1 }}>{team.name}</div>
                {team.score !== null && team.score !== undefined && (
                  <div style={{ fontSize: 24, fontWeight: 300, letterSpacing: "-0.02em", marginTop: 3 }}>{team.score}</div>
                )}
              </div>
            )
        )}
      </div>
      <div style={{ display: "flex", gap: 3, flexWrap: "wrap" }}>
        {(game.fantasyPlayers || []).map(fp => (
          <span key={fp.name} className="player-chip">
            {fp.position && <span style={{ opacity: 0.55, marginRight: 3 }}>{fp.position}</span>}
            {fp.name.split(" ").slice(-1)[0]}
          </span>
        ))}
      </div>
    </div>
  );
}

// ── Analytics components ───────────────────────────────────────────────────

function pctColor(pct) {
  if (pct == null) return "var(--text-muted)";
  if (pct >= 67) return "#2d6a4f";
  if (pct >= 34) return "#856404";
  return "#9b2226";
}

function pctLabel(pct) {
  if (pct == null) return "–";
  const s = pct === 1 ? "st" : pct === 2 ? "nd" : pct === 3 ? "rd" : "th";
  return `${pct}${s}`;
}

function formatStatScore(abbr, score) {
  if (score == null) return "–";
  if (["AVG", "OBP", "SLG", "OPS"].includes(abbr)) return score.toFixed(3);
  if (["ERA", "WHIP"].includes(abbr)) return score.toFixed(2);
  if (["IP", "K/9"].includes(abbr)) return score.toFixed(1);
  return Math.round(score).toString();
}

function PctBadge({ pct, label }) {
  return (
    <div style={{ fontSize: 10, marginTop: 2, display: "flex", alignItems: "center", gap: 3 }}>
      <span style={{ color: pctColor(pct), fontWeight: 500 }}>{pctLabel(pct)}</span>
      <span style={{ color: "var(--text-muted)" }}>{label}</span>
    </div>
  );
}

function CategoryRow({ cat, isLast }) {
  const isWin  = cat.result === "WIN";
  const isLoss = cat.result === "LOSS";
  return (
    <div style={{
      display: "grid", gridTemplateColumns: "130px 1fr 44px 1fr",
      padding: "11px 16px",
      borderBottom: isLast ? "none" : "1px solid var(--border)",
      background: isLoss ? "#fff8f8" : "var(--surface)",
      alignItems: "start",
    }}>
      <div>
        <div style={{ fontSize: 12, fontWeight: 600 }}>{cat.abbr}</div>
        <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 1 }}>{cat.name}</div>
      </div>
      <div style={{ textAlign: "right", paddingRight: 10 }}>
        <div style={{ fontSize: 15, fontWeight: isWin ? 700 : 400 }}>{formatStatScore(cat.abbr, cat.myScore)}</div>
        <PctBadge pct={cat.myPercentile} label="wk" />
        {cat.mySeasonPct != null && <PctBadge pct={cat.mySeasonPct} label="szn" />}
      </div>
      <div style={{ textAlign: "center", paddingTop: 1 }}>
        <span style={{
          fontSize: 9, fontWeight: 700, padding: "2px 5px", borderRadius: 3, letterSpacing: "0.05em",
          background: isWin ? "#d4edda" : isLoss ? "#f8d7da" : "#f0eeeb",
          color:      isWin ? "#155724" : isLoss ? "#721c24" : "var(--text-muted)",
        }}>
          {cat.result === "WIN" ? "W" : cat.result === "LOSS" ? "L" : "T"}
        </span>
      </div>
      <div style={{ paddingLeft: 10 }}>
        <div style={{ fontSize: 15, fontWeight: isLoss ? 700 : 400 }}>{formatStatScore(cat.abbr, cat.oppScore)}</div>
        <PctBadge pct={cat.oppPercentile} label="wk" />
        {cat.oppSeasonPct != null && <PctBadge pct={cat.oppSeasonPct} label="szn" />}
      </div>
    </div>
  );
}

function LeagueRankings({ stats, myTeamId, oppTeamId }) {
  if (!stats?.length) return null;
  return (
    <div style={{ marginTop: 28 }}>
      <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 10 }}>
        League Rankings — This Week
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 8 }}>
        {stats.map(stat => (
          <div key={stat.statId} style={{ border: "1px solid var(--border)", borderRadius: 4, background: "var(--surface)", padding: "10px 12px" }}>
            <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 7 }}>
              {stat.abbr} <span style={{ fontWeight: 400, color: "var(--text-muted)", fontSize: 10 }}>{stat.name}</span>
            </div>
            {stat.teams.map(t => (
              <div key={t.teamId} style={{
                display: "flex", justifyContent: "space-between", alignItems: "center",
                padding: "2px 4px", marginBottom: 1, borderRadius: 3, fontSize: 11,
                background: t.isMe ? "#d4edda" : t.isOpp ? "#fff3cd" : "transparent",
              }}>
                <span style={{ color: t.isMe ? "#155724" : "var(--text-primary)" }}>
                  <span style={{ color: "var(--text-muted)", marginRight: 4, fontSize: 10 }}>{t.rank}.</span>
                  {t.isMe ? "You" : t.name}
                </span>
                <span style={{ fontWeight: t.isMe ? 700 : 400, fontVariantNumeric: "tabular-nums" }}>
                  {formatStatScore(stat.abbr, t.score)}
                </span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function MatchupView({ data, loading, error, onRefresh, hasEspnData }) {
  if (!hasEspnData && !data && !loading) return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "60vh", gap: 12 }}>
      <div style={{ fontSize: 28 }}>📊</div>
      <div style={{ fontSize: 15, fontWeight: 600 }}>Sync to see your matchup</div>
      <div style={{ fontSize: 12, color: "var(--text-muted)", textAlign: "center", maxWidth: 300, lineHeight: 1.7 }}>
        Click <strong>Sync Roster</strong> in the Naylorade extension to load your ESPN matchup data.
      </div>
    </div>
  );
  if (loading) return <div style={{ padding: 40, textAlign: "center" }}><span className="spinner" /></div>;
  if (error) return (
    <div style={{ padding: "32px 40px" }}>
      <div style={{ fontSize: 12, color: "#9b2226", marginBottom: 12 }}>⚠ {error}</div>
      <button className="btn-primary" onClick={onRefresh}>Retry</button>
    </div>
  );
  if (!data) return (
    <div style={{ padding: "32px 40px" }}>
      <button className="btn-primary" onClick={onRefresh}>Load Matchup</button>
    </div>
  );

  const { myTeam, opponent, record, categories, leagueWeekStats, scoringPeriodId } = data;
  const { wins = 0, losses = 0, ties = 0 } = record;
  const isWinning = wins > losses, isLosing = losses > wins;

  // League scoring categories in display order
  const LEAGUE_ORDER = ['R', 'HR', 'RBI', 'SB', 'OBP', 'SLG', 'QS', 'W', 'ERA', 'WHIP', 'K/9', 'SVHD'];
  const LEAGUE_SET = new Set(LEAGUE_ORDER);
  const catByAbbr = Object.fromEntries(categories.map(c => [c.abbr, c]));
  const leagueCats = LEAGUE_ORDER.map(a => catByAbbr[a]).filter(Boolean);
  const otherCats  = categories.filter(c => !LEAGUE_SET.has(c.abbr));

  const grouped = {
    LOSS: leagueCats.filter(c => c.result === "LOSS"),
    TIE:  leagueCats.filter(c => c.result === "TIE"),
    WIN:  leagueCats.filter(c => c.result === "WIN"),
  };
  const sections = [
    { label: "Need to improve", cats: grouped.LOSS, accent: "#9b2226" },
    { label: "Too close to call", cats: grouped.TIE,  accent: "var(--text-muted)" },
    { label: "Winning",          cats: grouped.WIN,  accent: "#2d6a4f" },
  ].filter(s => s.cats.length > 0);

  const leagueWeekCats = LEAGUE_ORDER.map(a => leagueWeekStats?.find(s => s.abbr === a)).filter(Boolean);
  const otherWeekStats = leagueWeekStats?.filter(s => !LEAGUE_SET.has(s.abbr));

  const colHeader = (label, right) => (
    <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-muted)", textAlign: right ? "right" : "left", paddingRight: right ? 10 : 0, paddingLeft: right ? 0 : 10 }}>
      {label}
    </div>
  );

  return (
    <div style={{ padding: "24px 32px", maxWidth: 680 }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 6 }}>
          Week {scoringPeriodId}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
          <span style={{ fontSize: 18, fontWeight: 700 }}>{myTeam.name}</span>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>vs</span>
          <span style={{ fontSize: 18, fontWeight: 700, color: "var(--text-secondary)" }}>{opponent.name}</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{
            fontSize: 13, fontWeight: 700, padding: "4px 12px", borderRadius: 4,
            background: isWinning ? "#d4edda" : isLosing ? "#f8d7da" : "#f0eeeb",
            color:      isWinning ? "#155724" : isLosing ? "#721c24" : "var(--text-secondary)",
          }}>
            {wins}–{losses}{ties > 0 ? `–${ties}` : ""}
          </span>
          <span style={{ fontSize: 12, color: "var(--text-muted)" }}>
            {isWinning ? `Leading · ${losses} ${losses === 1 ? "category" : "categories"} to improve`
             : isLosing ? `Trailing · ${losses} ${losses === 1 ? "category" : "categories"} to close`
             : "Tied"}
          </span>
        </div>
      </div>

      {/* League scoring categories */}
      <div style={{ display: "grid", gridTemplateColumns: "130px 1fr 44px 1fr", padding: "6px 16px", background: "var(--bg)", border: "1px solid var(--border)", borderBottom: "none", borderRadius: "4px 4px 0 0" }}>
        <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-muted)" }}>Category</div>
        {colHeader("You", true)}
        <div />
        {colHeader("Opp", false)}
      </div>
      <div style={{ border: "1px solid var(--border)", borderRadius: "0 0 4px 4px", overflow: "hidden" }}>
        {sections.map((section, si) => (
          <div key={section.label}>
            <div style={{ padding: "6px 16px", background: "var(--bg)", borderTop: si > 0 ? "1px solid var(--border)" : "none", fontSize: 9, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: section.accent }}>
              {section.label}
            </div>
            {section.cats.map((cat, i) => (
              <CategoryRow key={cat.statId} cat={cat} isLast={i === section.cats.length - 1 && si === sections.length - 1} />
            ))}
          </div>
        ))}
      </div>

      <div style={{ marginTop: 14, display: "flex", gap: 8, alignItems: "center" }}>
        <button className="btn-outline" onClick={onRefresh}>Refresh</button>
        <span style={{ fontSize: 10, color: "var(--text-muted)", marginLeft: 4 }}>wk = this week vs league · szn = full season vs league</span>
      </div>

      <LeagueRankings stats={leagueWeekCats} myTeamId={myTeam.id} oppTeamId={opponent.id} />

      {/* Other stats */}
      {otherCats.length > 0 && (
        <div style={{ marginTop: 28 }}>
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--text-muted)", marginBottom: 8 }}>Other Stats</div>
          <div style={{ display: "grid", gridTemplateColumns: "130px 1fr 44px 1fr", padding: "6px 16px", background: "var(--bg)", border: "1px solid var(--border)", borderBottom: "none", borderRadius: "4px 4px 0 0" }}>
            <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--text-muted)" }}>Stat</div>
            {colHeader("You", true)}
            <div />
            {colHeader("Opp", false)}
          </div>
          <div style={{ border: "1px solid var(--border)", borderRadius: "0 0 4px 4px", overflow: "hidden" }}>
            {otherCats.map((cat, i) => (
              <CategoryRow key={cat.statId} cat={cat} isLast={i === otherCats.length - 1} />
            ))}
          </div>
          {otherWeekStats?.length > 0 && (
            <LeagueRankings stats={otherWeekStats} myTeamId={myTeam.id} oppTeamId={opponent.id} />
          )}
        </div>
      )}
    </div>
  );
}

// ── Game board components ──────────────────────────────────────────────────

function AllGamesBoard({ games, liveData, newsData }) {
  if (!games.length) {
    return <div style={{ padding: "24px 18px", fontSize: 13, color: "var(--text-muted)" }}>No games today.</div>;
  }
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 1 }}>
      {games.map(game => (
        <ScoreCard key={game.id} game={game} live={liveData[game.id]} newsData={newsData} />
      ))}
    </div>
  );
}

function timeAgo(isoStr) {
  if (!isoStr) return "";
  const diff = (Date.now() - new Date(isoStr)) / 1000;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

function ScoreCard({ game, live, newsData }) {
  const isLive = game.status === "Live";
  const isFinal = game.status === "Final";
  return (
    <div style={{ background: "var(--surface)", padding: "18px 20px", borderBottom: "1px solid var(--border)", borderRight: "1px solid var(--border)" }}>
      {/* Status + broadcast */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        {isLive ? (
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div className="live-dot" style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--text-primary)", flexShrink: 0 }} />
            <span style={{ fontSize: 10, fontWeight: 600 }}>Live · {game.inning}</span>
          </div>
        ) : (
          <span style={{ fontSize: 10, color: isFinal ? "var(--text-secondary)" : "var(--text-muted)", fontWeight: isFinal ? 500 : 400 }}>
            {isFinal ? "Final" : game.time}
          </span>
        )}
        <div style={{ display: "flex", gap: 3, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {(game.broadcasts || []).map(b => (
            <a key={b.name} href={b.url || "#"} target="_blank" rel="noreferrer"
              style={{ fontSize: 9, fontWeight: 500, padding: "2px 7px", borderRadius: 100, background: b.color || "#e0dedd", color: "var(--text-primary)", textDecoration: "none", letterSpacing: "0.04em" }}>
              {b.name}
            </a>
          ))}
        </div>
      </div>
      {/* Teams + scores */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        {[game.awayTeam, null, game.homeTeam].map((team, i) =>
          team === null
            ? <div key="at" style={{ fontSize: 11, color: "var(--text-muted)" }}>@</div>
            : (
              <div key={team.abbr} style={{ flex: 1, textAlign: "center" }}>
                <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em" }}>{team.abbr}</div>
                <div style={{ fontSize: 8, color: "var(--text-muted)", marginTop: 1 }}>{team.name}</div>
                {team.score !== null && team.score !== undefined && (
                  <div style={{ fontSize: 30, fontWeight: 200, letterSpacing: "-0.03em", lineHeight: 1.1, marginTop: 2 }}>{team.score}</div>
                )}
              </div>
            )
        )}
      </div>
      {/* Player chips */}
      {(game.fantasyPlayers || []).length > 0 && (
        <div style={{ display: "flex", gap: 3, flexWrap: "wrap", marginBottom: isLive && live?.lastPlay ? 10 : 0 }}>
          {(game.fantasyPlayers || []).map(fp => (
            <span key={fp.name} className="player-chip">
              {fp.position && <span style={{ opacity: 0.55, marginRight: 3 }}>{fp.position}</span>}
              {fp.name.split(" ").slice(-1)[0]}
            </span>
          ))}
        </div>
      )}
      {/* Last play for live games */}
      {isLive && live?.lastPlay && (
        <div style={{ fontSize: 11, color: "var(--text-secondary)", lineHeight: 1.5, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
          {live.lastPlay}
        </div>
      )}
      {/* News per player */}
      {(game.fantasyPlayers || []).some(fp => newsData?.[fp.name]?.length > 0) && (
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border)" }}>
          {(game.fantasyPlayers || []).map(fp => {
            const items = newsData?.[fp.name];
            if (!items?.length) return null;
            return (
              <div key={fp.name} style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 9, fontWeight: 600, letterSpacing: "0.06em", color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 4 }}>
                  {fp.name.split(" ").slice(-1)[0]}
                </div>
                {items.map((item, i) => (
                  <a key={i} href={item.url} target="_blank" rel="noreferrer"
                    style={{ display: "block", textDecoration: "none", marginBottom: 5 }}>
                    <div style={{ fontSize: 11, color: "var(--text-primary)", lineHeight: 1.45 }}>{item.title}</div>
                    <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 2 }}>
                      {item.source}{item.source && item.published ? " · " : ""}{timeAgo(item.published)}
                    </div>
                  </a>
                ))}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

