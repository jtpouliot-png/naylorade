const DEFAULT_APP_URL = "https://naylorade.vercel.app";

// ── DOM refs ──────────────────────────────────────────────────────────────────
const espnStatus     = document.getElementById("espn-status");
const leagueIdInput  = document.getElementById("league-id");
const syncBtn        = document.getElementById("sync-btn");
const openBtn        = document.getElementById("open-btn");
const errorBox       = document.getElementById("error-box");
const playerListWrap = document.getElementById("player-list-wrap");
const playerList     = document.getElementById("player-list");
const successMsg     = document.getElementById("success-msg");
const appUrlInput    = document.getElementById("app-url");
const saveSettingsBtn= document.getElementById("save-settings-btn");

let hasESPNCookies = false;

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const saved = await chrome.storage.local.get(["appUrl", "leagueId", "lastRoster"]);
  appUrlInput.value = saved.appUrl || DEFAULT_APP_URL;
  if (saved.leagueId) leagueIdInput.value = saved.leagueId;

  if (saved.lastRoster?.length) {
    showPlayers(saved.lastRoster, false);
    openBtn.style.display = "block";
  }

  await checkESPNCookies();
  await detectLeagueId();
  updateSyncBtn();
}

// ── ESPN cookies ──────────────────────────────────────────────────────────────
async function checkESPNCookies() {
  try {
    const urls = ["https://fantasy.espn.com", "https://www.espn.com"];
    for (const url of urls) {
      const [s2, swid] = await Promise.all([
        chrome.cookies.get({ url, name: "espn_s2" }),
        chrome.cookies.get({ url, name: "SWID" }),
      ]);
      if (s2 && swid) {
        hasESPNCookies = true;
        espnStatus.innerHTML = `<div class="dot green"></div><span>Logged in — cookies found</span>`;
        return;
      }
    }
    hasESPNCookies = false;
    espnStatus.innerHTML = `<div class="dot red"></div><span>Not logged in — <a href="https://fantasy.espn.com/baseball" target="_blank" style="color:#1a1917">open ESPN Fantasy</a> first</span>`;
  } catch {
    espnStatus.innerHTML = `<div class="dot red"></div><span>Could not read cookies</span>`;
  }
}

// ── League ID detection ───────────────────────────────────────────────────────
async function detectLeagueId() {
  try {
    // Query all tabs — currentWindow:true in a popup context points to the popup window, not the browser
    const allTabs = await chrome.tabs.query({});
    const espnTab = allTabs.find(t => t.url?.includes("espn.com") && t.url?.includes("leagueId="));
    const match = (espnTab?.url || "").match(/leagueId=(\d+)/);
    if (match && !leagueIdInput.value) leagueIdInput.value = match[1];
  } catch { }
}

// ── Sync button state ─────────────────────────────────────────────────────────
function updateSyncBtn() {
  syncBtn.disabled = !(hasESPNCookies && leagueIdInput.value.trim());
}

leagueIdInput.addEventListener("input", updateSyncBtn);

// ── Sync ──────────────────────────────────────────────────────────────────────
syncBtn.addEventListener("click", async () => {
  clearError();
  const leagueId = leagueIdInput.value.trim();
  const appUrl   = normalizeUrl(appUrlInput.value.trim() || DEFAULT_APP_URL);

  if (!leagueId)        return showError("Enter your ESPN league ID.");
  if (!hasESPNCookies)  return showError("ESPN cookies not found. Log into ESPN Fantasy first.");

  await chrome.storage.local.set({ leagueId, appUrl });
  setSyncing(true);

  try {
    const cookieUrls = ["https://fantasy.espn.com", "https://www.espn.com"];
    let s2Cookie, swidCookie;
    for (const u of cookieUrls) {
      const [a, b] = await Promise.all([
        chrome.cookies.get({ url: u, name: "espn_s2" }),
        chrome.cookies.get({ url: u, name: "SWID" }),
      ]);
      if (a && b) { s2Cookie = a; swidCookie = b; break; }
    }
    const creds = { leagueId, espnS2: s2Cookie?.value || "", swid: swidCookie?.value || "" };

    // Fetch league data first (navigates ESPN tab to API URLs, then back)
    const espnData = await fetchESPNLeagueData(leagueId);

    // Extract player names from API data — more reliable than DOM scraping
    let players = extractPlayersFromRosterData(espnData.rosterData, creds.swid);
    if (!players.length) {
      // Fall back to DOM scraping if API extraction fails
      players = await fetchESPNRoster();
    }
    if (!players.length) throw new Error("No players found in your ESPN roster.");

    await chrome.storage.local.set({ lastRoster: players });
    await pushToNaylorade(players, appUrl, creds, espnData);

    showPlayers(players, true);
    openBtn.style.display = "block";
  } catch (e) {
    showError(e.message);
  } finally {
    setSyncing(false);
  }
});

// ── Fetch ESPN league data via a hidden background tab ────────────────────────
// Loads fantasy.espn.com in a background tab, then fetches API data using
// the isolated world (native fetch, not ESPN's overridden one) with cookies.
async function fetchESPNLeagueData(leagueId) {
  const base = "https://fantasy.espn.com/apis/v3/games/flb/seasons";
  const year = new Date().getFullYear();

  // Load the ESPN Fantasy landing page so cookies + referer are established
  const tempTab = await chrome.tabs.create({ url: "https://fantasy.espn.com/baseball/", active: false });
  const tabId = tempTab.id;
  await waitForTabLoad(tabId);
  const tabInfo = await chrome.tabs.get(tabId);
  const tabFinalUrl = tabInfo.url;

  // Use window.__nativeFetch saved at document_start before ESPN overrides fetch.
  // Must run in MAIN world to access the saved reference.
  async function apiFetch(url) {
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: async (url) => {
        const f = window.__nativeFetch || window.fetch;
        try {
          const r = await f(url, {
            credentials: "include",
            headers: { "Accept": "application/json" },
          });
          const t = await r.text();
          return t.trim().startsWith("{") ? t : `ERR:${r.status}:${t.slice(0, 80)}`;
        } catch (e) {
          return `ERR:0:${e.message}`;
        }
      },
      args: [url],
    });
    const raw = res?.[0]?.result || "";
    if (raw.startsWith("ERR:")) return { data: null, err: raw };
    return { data: JSON.parse(raw), err: null };
  }

  try {
    let roster = await apiFetch(`${base}/${year}/segments/0/leagues/${leagueId}?view=mRoster`);
    if (!roster.data) roster = await apiFetch(`${base}/${year - 1}/segments/0/leagues/${leagueId}?view=mRoster`);
    if (!roster.data) {
      throw new Error(`Could not load ESPN roster data. Tab loaded at: ${tabFinalUrl} — ${roster.err}`);
    }

    const dataYear = roster.data.seasonId || year;
    let matchup = await apiFetch(`${base}/${dataYear}/segments/0/leagues/${leagueId}?view=mMatchupScore`);
    if (!matchup.data) matchup = await apiFetch(`${base}/${dataYear - 1}/segments/0/leagues/${leagueId}?view=mMatchupScore`);

    return { rosterData: roster.data, matchupData: matchup.data || null };
  } finally {
    chrome.tabs.remove(tabId).catch(() => {});
  }
}

// ── Extract player names from mRoster API data ────────────────────────────────
function extractPlayersFromRosterData(rosterData, swid) {
  const teams = rosterData?.teams || [];
  // Find the team owned by this user via SWID
  const myTeam = teams.find(t => t.primaryOwner === swid) || teams[0];
  if (!myTeam) return [];
  return (myTeam.roster?.entries || [])
    .map(e => e.playerPoolEntry?.player?.fullName)
    .filter(Boolean);
}

// ── Read roster from ESPN page DOM (fallback) ─────────────────────────────────
async function fetchESPNRoster() {
  const allTabs2 = await chrome.tabs.query({});
  const espnTabs = allTabs2.filter(t => t.url?.includes("fantasy.espn.com") || t.url?.includes("espn.com/fantasy"));
  if (!espnTabs.length) return [];

  const results = await chrome.scripting.executeScript({
    target: { tabId: espnTabs[0].id },
    world: "MAIN",
    func: () => {
      const names = [...document.querySelectorAll(".truncate")]
        .map(el => el.textContent.trim())
        .filter(n => n.includes(" ") && /^[A-Z]/.test(n) && !/[()0-9]/.test(n));
      return [...new Set(names)];
    },
  });

  return results?.[0]?.result || [];
}

// ── Push roster into Naylorade ────────────────────────────────────────────────
async function pushToNaylorade(players, appUrl, creds, espnData) {
  const allTabs = await chrome.tabs.query({});
  const existing = allTabs.find(t => t.url?.startsWith(appUrl));

  let tab;
  if (existing) {
    tab = existing;
    await chrome.tabs.update(tab.id, { active: true });
  } else {
    tab = await chrome.tabs.create({ url: appUrl });
    await waitForTabLoad(tab.id);
  }

  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (players, creds, espnData) => {
      localStorage.setItem("naylorade_roster", JSON.stringify(players));
      if (creds?.espnS2 && creds?.swid) {
        localStorage.setItem("naylorade_espn_creds", JSON.stringify(creds));
      }
      if (espnData) {
        localStorage.setItem("naylorade_espn_data", JSON.stringify({ ...espnData, swid: creds?.swid }));
      }
      window.location.reload();
    },
    args: [players, creds, espnData || null],
  });
}

function waitForTabLoad(tabId) {
  return new Promise(resolve => {
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

// ── Open Naylorade ────────────────────────────────────────────────────────────
openBtn.addEventListener("click", async () => {
  const appUrl = normalizeUrl(appUrlInput.value.trim() || DEFAULT_APP_URL);
  const allTabs = await chrome.tabs.query({});
  const existing = allTabs.find(t => t.url?.startsWith(appUrl));
  if (existing) {
    await chrome.tabs.update(existing.id, { active: true });
  } else {
    await chrome.tabs.create({ url: appUrl });
  }
  window.close();
});

// ── Settings ──────────────────────────────────────────────────────────────────
saveSettingsBtn.addEventListener("click", async () => {
  await chrome.storage.local.set({ appUrl: appUrlInput.value.trim() });
  saveSettingsBtn.textContent = "Saved ✓";
  setTimeout(() => saveSettingsBtn.textContent = "Save Settings", 1500);
});

// ── UI helpers ────────────────────────────────────────────────────────────────
function showPlayers(players, isNew) {
  playerList.innerHTML = players
    .map(p => `<div class="player-item"><div class="player-dot"></div>${p}</div>`)
    .join("");
  successMsg.textContent = isNew
    ? `${players.length} players synced to Naylorade`
    : `Last synced: ${players.length} players`;
  playerListWrap.style.display = "block";
}

function showError(msg) {
  errorBox.innerHTML = `<div class="error">${msg}</div>`;
  errorBox.style.display = "block";
}

function clearError() {
  errorBox.style.display = "none";
  errorBox.innerHTML = "";
}

function setSyncing(on) {
  syncBtn.disabled = on;
  syncBtn.innerHTML = on ? '<span class="spinner"></span>Syncing...' : "Sync Roster";
}

function normalizeUrl(url) {
  url = url.trim().replace(/\/$/, "");
  if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
  return url;
}

// ── Start ─────────────────────────────────────────────────────────────────────
init();
