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
  const [selectedGame, setSelectedGame] = useState(null);
  const [liveData, setLiveData] = useState({});
  const [setupOpen, setSetupOpen] = useState(false);
  const [rosterText, setRosterText] = useState(() => (storage("naylorade_roster") || []).join("\n"));
  const [feed, setFeed] = useState([]); // [{time, player, game, text, id}]
  const seenPlays = useRef(new Set());

  const loadGames = useCallback(async (rosterList) => {
    if (!rosterList?.length) return;
    setGamesLoading(true);
    setGamesError(null);
    try {
      const param = encodeURIComponent(rosterList.join(","));
      const data = await apiFetch(`/api/games?roster=${param}`);
      setGames(data.games || []);
      setSelectedGame(g => g || data.games?.[0] || null);
    } catch (e) {
      setGamesError(e.message);
    } finally {
      setGamesLoading(false);
    }
  }, []);

  function saveRoster() {
    const players = rosterText.split("\n").map(p => p.trim()).filter(Boolean);
    setRoster(players);
    storage("naylorade_roster", players);
    setSetupOpen(false);
    loadGames(players);
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
          const batterLastName = data.lastPlayBatter?.split(" ").slice(-1)[0]?.toLowerCase();
          const pitcherLastName = data.lastPlayPitcher?.split(" ").slice(-1)[0]?.toLowerCase();
          const matchedPlayer = currentRoster.find(p => {
            const lastName = p.split(" ").slice(-1)[0].toLowerCase();
            return lastName === batterLastName || lastName === pitcherLastName;
          });

          if (matchedPlayer) {
            const playId = `${game.id}-${play.slice(0, 40)}`;
            if (!seenPlays.current.has(playId)) {
              seenPlays.current.add(playId);
              const gameLabel = `${game.awayTeam.abbr} @ ${game.homeTeam.abbr}`;
              setFeed(prev => [{
                id: playId,
                time: timeNow(),
                player: matchedPlayer,
                game: gameLabel,
                text: play,
              }, ...prev].slice(0, 100));
            }
          }
        }
      } catch { }
    }
    setLiveData(prev => ({ ...prev, ...updates }));
  }, []);

  useEffect(() => {
    if (!roster.length) return;
    loadGames(roster);
    const interval = setInterval(() => loadGames(roster), 60_000);
    return () => clearInterval(interval);
  }, [roster, loadGames]);

  useEffect(() => {
    if (!games.length || !roster.length) return;
    pollAllLive(games, roster);
    const interval = setInterval(() => pollAllLive(games, roster), 15_000);
    return () => clearInterval(interval);
  }, [games, roster, pollAllLive]);

  const live = selectedGame ? liveData[selectedGame.id] : null;
  const playingCount = roster.filter(p => games.some(g => g.fantasyPlayers?.includes(p))).length;

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
        .game-card { padding: 16px 18px; border-bottom: 1px solid var(--border); cursor: pointer; transition: background 0.15s; }
        .game-card:hover { background: #f0eeeb; }
        .game-card.selected { background: var(--surface); border-left: 2px solid var(--text-primary); }
        .watch-btn { display: flex; align-items: center; gap: 10px; padding: 14px 20px; background: var(--text-primary); color: var(--bg); text-decoration: none; font-size: 12px; font-weight: 500; letter-spacing: 0.04em; margin-bottom: 28px; transition: opacity 0.15s; }
        .watch-btn:hover { opacity: 0.82; }
        .btn-primary { background: var(--text-primary); color: var(--bg); border: none; padding: 10px 28px; font-family: var(--font-sans); font-size: 11px; font-weight: 600; letter-spacing: 0.06em; cursor: pointer; transition: opacity 0.15s; }
        .btn-primary:hover { opacity: 0.82; }
        .btn-outline { background: transparent; border: 1px solid var(--border-strong); color: var(--text-secondary); padding: 5px 14px; cursor: pointer; font-size: 11px; transition: all 0.15s; font-family: var(--font-sans); }
        .btn-outline:hover { border-color: var(--text-primary); color: var(--text-primary); }
        .btn-ghost { background: transparent; border: none; color: var(--text-muted); padding: 5px 10px; cursor: pointer; font-size: 11px; font-family: var(--font-sans); transition: color 0.15s; }
        .btn-ghost:hover { color: var(--text-primary); }
        .player-chip { display: inline-flex; align-items: center; font-size: 10px; font-weight: 500; padding: 3px 9px; border-radius: 100px; border: 1px solid var(--border-strong); color: var(--text-secondary); background: var(--surface); }
        .gc-player-card { flex: 1; min-width: 130px; padding: 12px 14px; border: 1px solid var(--border); background: var(--surface); transition: border-color 0.15s; }
        .gc-player-card.active { border-color: var(--text-primary); }
        .roster-textarea { width: 100%; height: 200px; background: var(--bg); border: 1px solid var(--border-strong); color: var(--text-primary); padding: 12px; font-family: var(--font-mono); font-size: 12px; outline: none; resize: none; line-height: 1.8; transition: border-color 0.15s; border-radius: 0; }
        .roster-textarea:focus { border-color: var(--text-primary); }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.25} }
        .live-dot { animation: pulse 1.8s ease-in-out infinite; }
        @keyframes fadeSlide { from{opacity:0;transform:translateY(5px)} to{opacity:1;transform:translateY(0)} }
        .fadeslide { animation: fadeSlide 0.5s ease; }
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
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {roster.length > 0 && (
              <span style={{ fontSize: 11, color: "var(--text-muted)", marginRight: 4 }}>
                {gamesLoading ? <span className="spinner" /> : `${playingCount} playing today`}
              </span>
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

        {/* Empty state */}
        {!roster.length && !setupOpen && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "calc(100vh - 57px)", gap: 14 }}>
            <div style={{ fontSize: 32 }}>⚾</div>
            <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em" }}>Add your fantasy roster</div>
            <div style={{ fontSize: 13, color: "var(--text-muted)", textAlign: "center", maxWidth: 300, lineHeight: 1.6 }}>Enter your players and we'll filter today's MLB games to only the ones that matter</div>
            <button className="btn-primary" style={{ marginTop: 8 }} onClick={() => setSetupOpen(true)}>Get Started</button>
          </div>
        )}

        {/* Main 3-panel layout */}
        {roster.length > 0 && (
          <div style={{ display: "flex", height: setupOpen ? "calc(100vh - 340px)" : "calc(100vh - 57px)", overflow: "hidden" }}>

            {/* Panel 1: Game list */}
            <div style={{ width: 260, borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)", flexShrink: 0 }}>
              <div style={{ padding: "9px 18px", fontSize: 9, fontWeight: 500, letterSpacing: "0.12em", color: "var(--text-muted)", textTransform: "uppercase", borderBottom: "1px solid var(--border)", background: "var(--surface)" }}>
                Today's Games
              </div>
              <div style={{ overflowY: "auto", flex: 1 }}>
                {gamesError && <div style={{ padding: "16px 18px", fontSize: 12, color: "#c0392b" }}>⚠ {gamesError}</div>}
                {!gamesLoading && !gamesError && games.length === 0 && (
                  <div style={{ padding: "24px 18px", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6 }}>No games with your players today.</div>
                )}
                {games.map(game => (
                  <GameCard key={game.id} game={game} selected={selectedGame?.id === game.id} onClick={() => setSelectedGame(game)} />
                ))}
              </div>
              {/* Roster strip */}
              <div style={{ borderTop: "1px solid var(--border)", padding: "12px 18px", background: "var(--surface)" }}>
                <div style={{ fontSize: 9, fontWeight: 500, letterSpacing: "0.12em", color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 8 }}>Roster</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 150, overflowY: "auto" }}>
                  {roster.map(p => {
                    const isPlaying = games.some(g => g.fantasyPlayers?.includes(p));
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

            {/* Panel 2: Gamecast */}
            <div style={{ flex: 1, overflowY: "auto", background: "var(--surface)", borderRight: "1px solid var(--border)" }}>
              {selectedGame
                ? <Gamecast game={selectedGame} live={live} />
                : <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-muted)", fontSize: 13 }}>Select a game</div>
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

function FeedItem({ item }) {
  return (
    <div className="feed-item" style={{ padding: "12px 18px", borderBottom: "1px solid var(--border)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 5 }}>
        <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-primary)" }}>{item.player.split(" ").slice(-1)[0]}</span>
        <span style={{ fontSize: 10, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>{item.time}</span>
      </div>
      <div style={{ fontSize: 10, color: "var(--text-muted)", marginBottom: 5, letterSpacing: "0.04em" }}>{item.game}</div>
      <div style={{ fontSize: 12, color: "var(--text-primary)", lineHeight: 1.6 }}>{item.text}</div>
    </div>
  );
}

function GameCard({ game, selected, onClick }) {
  const isLive = game.status === "Live";
  return (
    <div className={`game-card${selected ? " selected" : ""}`} onClick={onClick}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        {isLive ? (
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <div className="live-dot" style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--text-primary)", flexShrink: 0 }} />
            <span style={{ fontSize: 10, fontWeight: 600 }}>Live · {game.inning}</span>
          </div>
        ) : (
          <span style={{ fontSize: 10, color: "var(--text-muted)" }}>{game.time}</span>
        )}
        <span style={{ fontSize: 9, fontWeight: 500, padding: "2px 8px", borderRadius: 100, background: game.broadcast?.color || "#e0dedd", color: "var(--text-primary)" }}>
          {game.broadcast?.name}
        </span>
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
        {(game.fantasyPlayers || []).map(p => (
          <span key={p} className="player-chip">{p.split(" ").slice(-1)[0]}</span>
        ))}
      </div>
    </div>
  );
}

function Gamecast({ game, live }) {
  const isLive = game.status === "Live";
  const batter = live?.currentBatter;
  const pitcher = live?.currentPitcher;
  const lastPlay = live?.lastPlay;
  const count = live?.count;
  const bases = live?.bases;

  return (
    <div style={{ padding: 28, maxWidth: 620 }}>
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 9, fontWeight: 500, letterSpacing: "0.12em", color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 12 }}>
          {isLive ? `Live · ${game.inning}` : `Today · ${game.time}`}
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 16 }}>
          {[game.awayTeam, null, game.homeTeam].map((team, i) =>
            team === null
              ? <div key="at" style={{ fontSize: 14, color: "var(--text-muted)", paddingBottom: isLive ? 10 : 4 }}>@</div>
              : (
                <div key={team.abbr} style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 34, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1 }}>{team.abbr}</div>
                  <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 3 }}>{team.name}</div>
                  {team.score !== null && team.score !== undefined && (
                    <div style={{ fontSize: 46, fontWeight: 200, letterSpacing: "-0.04em", lineHeight: 1.1, marginTop: 4 }}>{team.score}</div>
                  )}
                </div>
              )
          )}
        </div>
      </div>

      <a href={game.broadcast?.url || "#"} target="_blank" rel="noreferrer" className="watch-btn">
        Watch on {game.broadcast?.name}
        <span style={{ marginLeft: "auto", opacity: 0.45 }}>↗</span>
      </a>

      <Section title="Your Players">
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {(game.fantasyPlayers || []).map(p => {
            const isActive = isLive && (p === batter || p === pitcher);
            return (
              <div key={p} className={`gc-player-card${isActive ? " active" : ""}`}>
                <div style={{ fontSize: 13, fontWeight: 600, letterSpacing: "-0.01em", marginBottom: 3 }}>{p}</div>
                <div style={{ fontSize: 9, fontWeight: 500, color: isActive ? "var(--text-primary)" : "var(--text-muted)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
                  {isLive && p === batter ? "At bat" : isLive && p === pitcher ? "Pitching" : isLive ? "On field" : "Starting"}
                </div>
                {isActive && <div style={{ marginTop: 7, height: 2, background: "var(--text-primary)", borderRadius: 1 }} />}
              </div>
            );
          })}
        </div>
      </Section>

      {isLive && count && (
        <Section title="At Bat">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontSize: 15, fontWeight: 600, letterSpacing: "-0.01em", marginBottom: 2 }}>{batter || "—"}</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>vs. {pitcher || "—"}</div>
            </div>
            <div style={{ display: "flex", gap: 18 }}>
              {[["B", count.balls, 4, "#b8d4f0"], ["S", count.strikes, 3, "#f0d4b8"], ["O", count.outs, 3, "#1a1917"]].map(([label, val, max, col]) => (
                <div key={label} style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 9, fontWeight: 500, color: "var(--text-muted)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 5 }}>{label}</div>
                  <div style={{ display: "flex", gap: 4 }}>
                    {Array.from({ length: max }).map((_, i) => (
                      <div key={i} style={{ width: 10, height: 10, borderRadius: "50%", background: i < val ? col : "var(--border)", border: i < val ? "none" : "1px solid var(--border-strong)", transition: "background 0.3s" }} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Section>
      )}

      {lastPlay && (
        <Section title="Last Play">
          <p key={lastPlay} className="fadeslide" style={{ fontSize: 14, lineHeight: 1.7 }}>{lastPlay}</p>
        </Section>
      )}

      {isLive && bases && (
        <Section title="On Base">
          <Diamond bases={bases} />
        </Section>
      )}
    </div>
  );
}

function Diamond({ bases }) {
  const fill = (on) => on ? "#b8d4f0" : "white";
  const stroke = "#d0cdc8";
  return (
    <svg width="90" height="80" viewBox="0 0 110 95">
      <polygon points="55,8 95,48 55,88 15,48" fill="none" stroke={stroke} strokeWidth="1.5" />
      <line x1="55" y1="88" x2="55" y2="8" stroke="#e8e6e2" strokeWidth="1" />
      <line x1="15" y1="48" x2="95" y2="48" stroke="#e8e6e2" strokeWidth="1" />
      <rect x="49" y="2" width="12" height="12" rx="2" fill={fill(bases.second)} stroke={stroke} strokeWidth="1" transform="rotate(45 55 8)" />
      <rect x="89" y="42" width="12" height="12" rx="2" fill={fill(bases.first)} stroke={stroke} strokeWidth="1" transform="rotate(45 95 48)" />
      <rect x="9" y="42" width="12" height="12" rx="2" fill={fill(bases.third)} stroke={stroke} strokeWidth="1" transform="rotate(45 15 48)" />
      <polygon points="55,90 50,86 52,80 58,80 60,86" fill="#1a1917" />
    </svg>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ fontSize: 9, fontWeight: 500, letterSpacing: "0.12em", color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 12, paddingBottom: 7, borderBottom: "1px solid var(--border)" }}>
        {title}
      </div>
      {children}
    </div>
  );
}
