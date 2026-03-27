import { useState, useEffect, useCallback } from "react";

// ── Config ────────────────────────────────────────────────────────────────────
const API_BASE = import.meta.env.VITE_API_URL || "http://localhost:5000";

// ── Helpers ───────────────────────────────────────────────────────────────────
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

// ── App ───────────────────────────────────────────────────────────────────────
export default function App() {
  // Credentials
  const [creds, setCreds] = useState(() => storage("naylorade_creds") || { leagueId: "", espnS2: "", swid: "" });
  const [setupOpen, setSetupOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [credsError, setCredsError] = useState(null);

  // Roster + games
  const [roster, setRoster] = useState(() => storage("naylorade_roster") || []);
  const [games, setGames] = useState([]);
  const [gamesLoading, setGamesLoading] = useState(false);
  const [gamesError, setGamesError] = useState(null);

  // Selected game + live data
  const [selectedGame, setSelectedGame] = useState(null);
  const [liveData, setLiveData] = useState({});

  // ── Load games ──────────────────────────────────────────────────────────────
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

  // ── Connect ESPN ────────────────────────────────────────────────────────────
  async function connectESPN() {
    setConnecting(true);
    setCredsError(null);
    try {
      const data = await apiFetch("/api/roster", {
        method: "POST",
        body: JSON.stringify(creds),
      });
      const players = data.players || [];
      setRoster(players);
      storage("naylorade_roster", players);
      storage("naylorade_creds", creds);
      setSetupOpen(false);
      await loadGames(players);
    } catch (e) {
      setCredsError(e.message);
    } finally {
      setConnecting(false);
    }
  }

  // ── Poll games every 30s ────────────────────────────────────────────────────
  useEffect(() => {
    if (!roster.length) return;
    loadGames(roster);
    const interval = setInterval(() => loadGames(roster), 30_000);
    return () => clearInterval(interval);
  }, [roster, loadGames]);

  // ── Poll live feed for selected live game every 15s ─────────────────────────
  useEffect(() => {
    if (!selectedGame || selectedGame.status !== "Live") return;
    const id = selectedGame.id;

    async function fetchLive() {
      try {
        const data = await apiFetch(`/api/games/${id}/live`);
        setLiveData(prev => ({ ...prev, [id]: data }));
      } catch { /* silent */ }
    }

    fetchLive();
    const interval = setInterval(fetchLive, 15_000);
    return () => clearInterval(interval);
  }, [selectedGame]);

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
        .game-card { padding: 18px 20px; border-bottom: 1px solid var(--border); cursor: pointer; transition: background 0.15s; }
        .game-card:hover { background: #f0eeeb; }
        .game-card.selected { background: var(--surface); border-left: 2px solid var(--text-primary); }
        .watch-btn { display: flex; align-items: center; gap: 10px; padding: 14px 20px; background: var(--text-primary); color: var(--bg); text-decoration: none; font-size: 12px; font-weight: 500; letter-spacing: 0.04em; margin-bottom: 28px; transition: opacity 0.15s; }
        .watch-btn:hover { opacity: 0.82; }
        .setup-input { background: var(--bg); border: 1px solid var(--border-strong); color: var(--text-primary); padding: 8px 12px; font-family: var(--font-mono); font-size: 12px; outline: none; width: 100%; transition: border-color 0.15s; border-radius: 0; }
        .setup-input:focus { border-color: var(--text-primary); }
        .btn-primary { background: var(--text-primary); color: var(--bg); border: none; padding: 10px 28px; font-family: var(--font-sans); font-size: 11px; font-weight: 600; letter-spacing: 0.06em; cursor: pointer; transition: opacity 0.15s; }
        .btn-primary:hover:not(:disabled) { opacity: 0.82; }
        .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
        .btn-outline { background: transparent; border: 1px solid var(--border-strong); color: var(--text-secondary); padding: 5px 14px; cursor: pointer; font-size: 11px; font-weight: 400; transition: all 0.15s; }
        .btn-outline:hover { border-color: var(--text-primary); color: var(--text-primary); }
        .player-chip { display: inline-flex; align-items: center; font-size: 10px; font-weight: 500; padding: 3px 10px; border-radius: 100px; border: 1px solid var(--border-strong); color: var(--text-secondary); background: var(--surface); }
        .gc-player-card { flex: 1; min-width: 140px; padding: 14px 16px; border: 1px solid var(--border); background: var(--surface); transition: border-color 0.15s; }
        .gc-player-card.active { border-color: var(--text-primary); }
        @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.25} }
        .live-dot { animation: pulse 1.8s ease-in-out infinite; }
        @keyframes fadeSlide { from{opacity:0;transform:translateY(5px)} to{opacity:1;transform:translateY(0)} }
        .fadeslide { animation: fadeSlide 0.5s ease; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .spinner { width: 16px; height: 16px; border: 2px solid var(--border); border-top-color: var(--text-primary); border-radius: 50%; animation: spin 0.7s linear infinite; display: inline-block; }
      `}</style>

      <div style={{ background: "var(--bg)", minHeight: "100vh" }}>

        {/* Header */}
        <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 28px", borderBottom: "1px solid var(--border)", background: "var(--surface)" }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
            <span style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em" }}>Naylorade</span>
            <span style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 400, letterSpacing: "0.06em", textTransform: "uppercase" }}>Stream Guide</span>
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
            {new Date().toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            {roster.length > 0 && (
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
                {gamesLoading ? <span className="spinner" /> : `${playingCount} playing today`}
              </span>
            )}
            <button className="btn-outline" onClick={() => setSetupOpen(o => !o)}>
              {roster.length ? "⚙ ESPN" : "Connect ESPN"}
            </button>
          </div>
        </header>

        {/* Setup Panel */}
        {setupOpen && (
          <div style={{ background: "var(--surface)", borderBottom: "1px solid var(--border)", padding: "20px 28px" }}>
            <div style={{ fontSize: 11, fontWeight: 500, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 16 }}>ESPN Connection</div>
            <div style={{ display: "flex", gap: 16, flexWrap: "wrap", maxWidth: 680 }}>
              {[
                ["League ID", "text", "leagueId", "123456"],
                ["espn_s2 Cookie", "password", "espnS2", "Paste from browser..."],
                ["SWID", "text", "swid", "{XXXXXXXX-XXXX-...}"],
              ].map(([label, type, key, ph]) => (
                <div key={key} style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 180 }}>
                  <label style={{ fontSize: 10, color: "var(--text-muted)", fontWeight: 500, letterSpacing: "0.06em" }}>{label}</label>
                  <input
                    className="setup-input"
                    type={type}
                    placeholder={ph}
                    value={creds[key]}
                    onChange={e => setCreds(c => ({ ...c, [key]: e.target.value }))}
                  />
                </div>
              ))}
            </div>
            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 12, lineHeight: 1.7 }}>
              Chrome → DevTools → Application → Cookies → ESPN.com → copy <code style={{ fontFamily: "var(--font-mono)" }}>espn_s2</code> and <code style={{ fontFamily: "var(--font-mono)" }}>SWID</code>
            </div>
            {credsError && <div style={{ marginTop: 10, fontSize: 12, color: "#c0392b" }}>⚠ {credsError}</div>}
            <button className="btn-primary" style={{ marginTop: 16 }} disabled={connecting} onClick={connectESPN}>
              {connecting ? "Connecting..." : "Load Roster"}
            </button>
          </div>
        )}

        {/* Empty state */}
        {!roster.length && !setupOpen && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "calc(100vh - 57px)", gap: 14 }}>
            <div style={{ fontSize: 32 }}>⚾</div>
            <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em" }}>Connect your ESPN league</div>
            <div style={{ fontSize: 13, color: "var(--text-muted)" }}>We'll filter today's games to only your players</div>
            <button className="btn-primary" style={{ marginTop: 8 }} onClick={() => setSetupOpen(true)}>Get Started</button>
          </div>
        )}

        {/* Main layout */}
        {roster.length > 0 && (
          <div style={{ display: "flex", height: setupOpen ? "calc(100vh - 196px)" : "calc(100vh - 57px)", overflow: "hidden" }}>

            {/* Left panel */}
            <div style={{ width: 300, borderRight: "1px solid var(--border)", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--bg)" }}>
              <div style={{ padding: "10px 20px", fontSize: 10, fontWeight: 500, letterSpacing: "0.1em", color: "var(--text-muted)", textTransform: "uppercase", borderBottom: "1px solid var(--border)", background: "var(--surface)" }}>
                Today's Games
              </div>

              <div style={{ overflowY: "auto", flex: 1 }}>
                {gamesError && (
                  <div style={{ padding: "16px 20px", fontSize: 12, color: "#c0392b" }}>⚠ {gamesError}</div>
                )}
                {!gamesLoading && !gamesError && games.length === 0 && (
                  <div style={{ padding: "24px 20px", fontSize: 13, color: "var(--text-muted)", lineHeight: 1.6 }}>
                    No games with your players today. Enjoy the day off.
                  </div>
                )}
                {games.map(game => (
                  <GameCard key={game.id} game={game} selected={selectedGame?.id === game.id} onClick={() => setSelectedGame(game)} />
                ))}
              </div>

              {/* Roster */}
              <div style={{ borderTop: "1px solid var(--border)", padding: "14px 20px", background: "var(--surface)" }}>
                <div style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.1em", color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 10 }}>Roster</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 5, maxHeight: 180, overflowY: "auto" }}>
                  {roster.map(p => {
                    const isPlaying = games.some(g => g.fantasyPlayers?.includes(p));
                    return (
                      <div key={p} style={{ display: "flex", alignItems: "center", gap: 8, opacity: isPlaying ? 1 : 0.35 }}>
                        <div style={{ width: 5, height: 5, borderRadius: "50%", background: isPlaying ? "var(--text-primary)" : "var(--border-strong)", flexShrink: 0 }} />
                        <span style={{ fontSize: 11, fontWeight: isPlaying ? 500 : 400, color: isPlaying ? "var(--text-primary)" : "var(--text-muted)" }}>{p}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Gamecast */}
            <div style={{ flex: 1, overflowY: "auto", background: "var(--surface)" }}>
              {selectedGame
                ? <Gamecast game={selectedGame} live={live} />
                : <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", color: "var(--text-muted)", fontSize: 13 }}>Select a game</div>
              }
            </div>
          </div>
        )}
      </div>
    </>
  );
}

// ── GameCard ──────────────────────────────────────────────────────────────────
function GameCard({ game, selected, onClick }) {
  const isLive = game.status === "Live";
  return (
    <div className={`game-card${selected ? " selected" : ""}`} onClick={onClick}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        {isLive ? (
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div className="live-dot" style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--text-primary)", flexShrink: 0 }} />
            <span style={{ fontSize: 11, fontWeight: 600, color: "var(--text-primary)" }}>Live · {game.inning}</span>
          </div>
        ) : (
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{game.time}</span>
        )}
        <span style={{ fontSize: 10, fontWeight: 500, padding: "2px 10px", borderRadius: 100, background: game.broadcast?.color || "#e0dedd", color: "var(--text-primary)" }}>
          {game.broadcast?.name}
        </span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        {[game.awayTeam, null, game.homeTeam].map((team, i) =>
          team === null
            ? <div key="at" style={{ fontSize: 11, color: "var(--text-muted)" }}>@</div>
            : (
              <div key={team.abbr} style={{ flex: 1, textAlign: "center" }}>
                <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.01em" }}>{team.abbr}</div>
                <div style={{ fontSize: 9, color: "var(--text-muted)", marginTop: 2 }}>{team.name}</div>
                {team.score !== null && team.score !== undefined && (
                  <div style={{ fontSize: 28, fontWeight: 300, letterSpacing: "-0.02em", marginTop: 4 }}>{team.score}</div>
                )}
              </div>
            )
        )}
      </div>

      <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
        {(game.fantasyPlayers || []).map(p => (
          <span key={p} className="player-chip">{p.split(" ").slice(-1)[0]}</span>
        ))}
      </div>
    </div>
  );
}

// ── Gamecast ──────────────────────────────────────────────────────────────────
function Gamecast({ game, live }) {
  const isLive = game.status === "Live";
  const batter  = live?.currentBatter  || game.currentBatter;
  const pitcher = live?.currentPitcher || game.currentPitcher;
  const lastPlay = live?.lastPlay || game.lastPlay;
  const count    = live?.count;
  const bases    = live?.bases;

  return (
    <div style={{ padding: 36, maxWidth: 700 }}>

      {/* Score header */}
      <div style={{ marginBottom: 28 }}>
        <div style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.1em", color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 14 }}>
          {isLive ? `Live · ${game.inning}` : `Today · ${game.time}`}
        </div>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 20 }}>
          {[game.awayTeam, null, game.homeTeam].map((team, i) =>
            team === null
              ? <div key="at" style={{ fontSize: 16, color: "var(--text-muted)", paddingBottom: isLive ? 12 : 6 }}>@</div>
              : (
                <div key={team.abbr} style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 38, fontWeight: 700, letterSpacing: "-0.03em", lineHeight: 1 }}>{team.abbr}</div>
                  <div style={{ fontSize: 10, color: "var(--text-muted)", marginTop: 4 }}>{team.name}</div>
                  {team.score !== null && team.score !== undefined && (
                    <div style={{ fontSize: 52, fontWeight: 200, letterSpacing: "-0.04em", lineHeight: 1.1, marginTop: 6 }}>{team.score}</div>
                  )}
                </div>
              )
          )}
        </div>
      </div>

      {/* Watch button */}
      <a href={game.broadcast?.url || "#"} target="_blank" rel="noreferrer" className="watch-btn">
        Watch on {game.broadcast?.name}
        <span style={{ marginLeft: "auto", opacity: 0.45 }}>↗</span>
      </a>

      {/* Your players */}
      <Section title="Your Players">
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          {(game.fantasyPlayers || []).map(p => {
            const isActive = isLive && (p === batter || p === pitcher);
            return (
              <div key={p} className={`gc-player-card${isActive ? " active" : ""}`}>
                <div style={{ fontSize: 14, fontWeight: 600, letterSpacing: "-0.01em", marginBottom: 4 }}>{p}</div>
                <div style={{ fontSize: 10, fontWeight: 500, color: isActive ? "var(--text-primary)" : "var(--text-muted)", letterSpacing: "0.04em", textTransform: "uppercase" }}>
                  {isLive && p === batter ? "At bat" : isLive && p === pitcher ? "Pitching" : isLive ? "On field" : "Starting"}
                </div>
                {isActive && <div style={{ marginTop: 8, height: 2, background: "var(--text-primary)", borderRadius: 1 }} />}
              </div>
            );
          })}
        </div>
      </Section>

      {/* Count (live only) */}
      {isLive && count && (
        <Section title="At Bat">
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "-0.01em", marginBottom: 3 }}>{batter || "—"}</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>vs. {pitcher || "—"}</div>
            </div>
            <div style={{ display: "flex", gap: 20 }}>
              {[["B", count.balls, 4, "#b8d4f0"], ["S", count.strikes, 3, "#f0d4b8"], ["O", count.outs, 3, "#1a1917"]].map(([label, val, max, col]) => (
                <div key={label} style={{ textAlign: "center" }}>
                  <div style={{ fontSize: 9, fontWeight: 500, color: "var(--text-muted)", letterSpacing: "0.1em", textTransform: "uppercase", marginBottom: 6 }}>{label}</div>
                  <div style={{ display: "flex", gap: 4 }}>
                    {Array.from({ length: max }).map((_, i) => (
                      <div key={i} style={{ width: 11, height: 11, borderRadius: "50%", background: i < val ? col : "var(--border)", border: i < val ? "none" : "1px solid var(--border-strong)", transition: "background 0.3s" }} />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </Section>
      )}

      {/* Last play */}
      {lastPlay && (
        <Section title={isLive ? "Last Play" : "Game Note"}>
          <p key={lastPlay} className="fadeslide" style={{ fontSize: 15, fontWeight: 400, lineHeight: 1.7, color: "var(--text-primary)" }}>
            {lastPlay}
          </p>
        </Section>
      )}

      {/* Diamond (live only) */}
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
    <svg width="100" height="88" viewBox="0 0 110 95">
      <polygon points="55,8 95,48 55,88 15,48" fill="none" stroke={stroke} strokeWidth="1.5" />
      <line x1="55" y1="88" x2="55" y2="8" stroke="#e8e6e2" strokeWidth="1" />
      <line x1="15" y1="48" x2="95" y2="48" stroke="#e8e6e2" strokeWidth="1" />
      {/* 2B */}
      <rect x="49" y="2" width="12" height="12" rx="2" fill={fill(bases.second)} stroke={stroke} strokeWidth="1" transform="rotate(45 55 8)" />
      {/* 1B */}
      <rect x="89" y="42" width="12" height="12" rx="2" fill={fill(bases.first)} stroke={stroke} strokeWidth="1" transform="rotate(45 95 48)" />
      {/* 3B */}
      <rect x="9" y="42" width="12" height="12" rx="2" fill={fill(bases.third)} stroke={stroke} strokeWidth="1" transform="rotate(45 15 48)" />
      {/* Home */}
      <polygon points="55,90 50,86 52,80 58,80 60,86" fill="#1a1917" />
    </svg>
  );
}

function Section({ title, children }) {
  return (
    <div style={{ marginBottom: 28 }}>
      <div style={{ fontSize: 10, fontWeight: 500, letterSpacing: "0.1em", color: "var(--text-muted)", textTransform: "uppercase", marginBottom: 14, paddingBottom: 8, borderBottom: "1px solid var(--border)" }}>
        {title}
      </div>
      {children}
    </div>
  );
}
