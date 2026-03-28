const DEFAULT_APP_URL = "https://naylorade.vercel.app";
const DEFAULT_API_URL = "";

// ── DOM refs ──────────────────────────────────────────────────────────────────
const espnStatus     = document.getElementById("espn-status");
const leagueIdInput  = document.getElementById("league-id");
const syncBtn        = document.getElementById("sync-btn");
const openBtn        = document.getElementById("open-btn");
const errorBox       = document.getElementById("error-box");
const playerListWrap = document.getElementById("player-list-wrap");
const playerList     = document.getElementById("player-list");
const successMsg     = document.getElementById("success-msg");
const apiUrlInput    = document.getElementById("api-url");
const appUrlInput    = document.getElementById("app-url");
const saveSettingsBtn= document.getElementById("save-settings-btn");

let swid = null;

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const saved = await chrome.storage.local.get(["apiUrl", "appUrl", "leagueId", "lastRoster"]);
  apiUrlInput.value = saved.apiUrl || "";
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
    const [s2Cookie, swidCookie] = await Promise.all([
      chrome.cookies.get({ url: "https://www.espn.com", name: "espn_s2" }),
      chrome.cookies.get({ url: "https://www.espn.com", name: "SWID" }),
    ]);

    swid = swidCookie?.value || null;

    if (s2Cookie && swidCookie) {
      espnStatus.innerHTML = `<div class="dot green"></div><span>Logged in — cookies found</span>`;
    } else {
      espnStatus.innerHTML = `<div class="dot red"></div><span>Not logged in — <a href="https://www.espn.com/fantasy/baseball" target="_blank" style="color:#1a1917">open ESPN Fantasy</a> first</span>`;
    }
  } catch {
    espnStatus.innerHTML = `<div class="dot red"></div><span>Could not read cookies</span>`;
  }
}

// ── League ID detection ───────────────────────────────────────────────────────
async function detectLeagueId() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const match = (tab?.url || "").match(/leagueId=(\d+)/);
    if (match && !leagueIdInput.value) leagueIdInput.value = match[1];
  } catch { }
}

// ── Sync button state ─────────────────────────────────────────────────────────
function updateSyncBtn() {
  syncBtn.disabled = !(swid && leagueIdInput.value.trim());
}

leagueIdInput.addEventListener("input", updateSyncBtn);

// ── Sync roster — calls ESPN directly from the browser ────────────────────────
syncBtn.addEventListener("click", async () => {
  clearError();
  const leagueId = leagueIdInput.value.trim();
  const appUrl   = normalizeUrl(appUrlInput.value.trim() || DEFAULT_APP_URL);

  if (!leagueId) return showError("Enter your ESPN league ID.");
  if (!swid)     return showError("ESPN cookies not found. Log into ESPN Fantasy first.");

  await chrome.storage.local.set({ leagueId, appUrl });
  setSyncing(true);

  try {
    const players = await fetchESPNRoster(leagueId);
    if (!players.length) throw new Error("No players found — check your league ID.");

    await chrome.storage.local.set({ lastRoster: players });
    await pushToNaylorade(players, appUrl);

    showPlayers(players, true);
    openBtn.style.display = "block";
  } catch (e) {
    showError(e.message);
  } finally {
    setSyncing(false);
  }
});

// ── Fetch roster via executeScript MAIN world (bypasses ESPN CSP) ─────────────
async function fetchESPNRoster(leagueId) {
  const espnTabs = [
    ...await chrome.tabs.query({ url: "*://fantasy.espn.com/*" }),
    ...await chrome.tabs.query({ url: "*://www.espn.com/fantasy/*" }),
  ];
  if (!espnTabs.length) {
    throw new Error("No ESPN Fantasy tab found — open espn.com/fantasy first.");
  }

  const results = await chrome.scripting.executeScript({
    target: { tabId: espnTabs[0].id },
    world: "MAIN",
    func: () => {
      // Dig into __NEXT_DATA__ and return its structure for inspection
      const nd = window.__NEXT_DATA__;
      if (!nd) return { source: "none" };

      function summarize(obj, depth = 0) {
        if (depth > 4 || obj === null || obj === undefined) return typeof obj;
        if (Array.isArray(obj)) return `Array(${obj.length}) of ${summarize(obj[0], depth + 1)}`;
        if (typeof obj === "object") return Object.fromEntries(Object.keys(obj).slice(0, 15).map(k => [k, summarize(obj[k], depth + 1)]));
        return typeof obj === "string" && obj.length > 40 ? obj.slice(0, 40) + "…" : obj;
      }

      const pp = nd?.props?.pageProps;
      return { source: "__NEXT_DATA__", structure: Object.keys(pp || {}) };
    },
  });

  const result = results?.[0]?.result;
  if (!result) throw new Error("Could not read ESPN page — make sure it is fully loaded.");

  // Got player links directly
  if (result.source === "links" && result.players?.length) {
    return [...new Set(result.players)];
  }

  // Always dump what we found for debugging
  throw new Error("Structure:\n" + JSON.stringify(result.structure ?? result, null, 2).slice(0, 800));
}

function parseRoster(data) {
  const members = data.members || [];
  const teams   = data.teams   || [];

  // Match the logged-in user's team via SWID
  const swidClean = (swid || "").replace(/[{}]/g, "");
  let myTeamId = null;
  for (const member of members) {
    if ((member.id || "").replace(/[{}]/g, "") === swidClean) {
      myTeamId = member.onTeamId;
      break;
    }
  }
  if (myTeamId === null && teams.length) myTeamId = teams[0].id;

  const myTeam = teams.find(t => t.id === myTeamId);
  if (!myTeam) return [];

  return (myTeam.roster?.entries || [])
    .map(e => e.playerPoolEntry?.player?.fullName)
    .filter(Boolean);
}

// ── Push roster into Naylorade ────────────────────────────────────────────────
async function pushToNaylorade(players, appUrl) {
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
    func: (players) => {
      localStorage.setItem("naylorade_roster", JSON.stringify(players));
      window.location.reload();
    },
    args: [players],
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
  await chrome.storage.local.set({
    apiUrl: apiUrlInput.value.trim(),
    appUrl: appUrlInput.value.trim(),
  });
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
