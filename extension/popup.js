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

let swid = null;

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
    const [s2Cookie, swidCookie] = await Promise.all([
      chrome.cookies.get({ url: "https://fantasy.espn.com", name: "espn_s2" }),
      chrome.cookies.get({ url: "https://fantasy.espn.com", name: "SWID" }),
    ]);

    swid = swidCookie?.value || null;

    if (s2Cookie && swidCookie) {
      espnStatus.innerHTML = `<div class="dot green"></div><span>Logged in — cookies found</span>`;
    } else {
      espnStatus.innerHTML = `<div class="dot red"></div><span>Not logged in — <a href="https://fantasy.espn.com/baseball" target="_blank" style="color:#1a1917">open ESPN Fantasy</a> first</span>`;
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

// ── Fetch roster by executing inside an ESPN tab (bypasses SameSite cookie restrictions) ──
async function fetchESPNRoster(leagueId) {
  const espnTabs = await chrome.tabs.query({ url: "*://*.espn.com/*" });
  if (!espnTabs.length) {
    throw new Error("No ESPN tab found. Open ESPN Fantasy Baseball in a tab first, then try again.");
  }

  const year = new Date().getFullYear();

  const results = await chrome.scripting.executeScript({
    target: { tabId: espnTabs[0].id },
    func: async (leagueId, year) => {
      for (const y of [year, year - 1]) {
        const url = `https://fantasy.espn.com/apis/v3/games/flb/seasons/${y}/segments/0/leagues/${leagueId}?view=mRoster`;
        try {
          const resp = await fetch(url, { credentials: "include" });
          if (resp.status === 500 && y === year) continue;
          if (resp.status === 401) return { error: "ESPN credentials expired — log out and back in." };
          if (resp.status === 404) return { error: "League not found — check your league ID." };
          if (!resp.ok) return { error: `ESPN returned ${resp.status}` };
          const ct = resp.headers.get("content-type") || "";
          if (!ct.includes("application/json")) return { error: "ESPN returned an unexpected page — are you logged in?" };
          return { data: await resp.json() };
        } catch (e) {
          if (y === year) continue;
          return { error: e.message };
        }
      }
      return { error: "Could not load roster from ESPN for this year or last." };
    },
    args: [leagueId, year],
  });

  const result = results?.[0]?.result;
  if (!result) throw new Error("Script injection failed — make sure the ESPN tab is fully loaded.");
  if (result.error) throw new Error(result.error);
  return parseRoster(result.data);
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
