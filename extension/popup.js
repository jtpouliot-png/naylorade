const DEFAULT_API_URL = "https://naylorade-backend-production.up.railway.app";
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
const apiUrlInput    = document.getElementById("api-url");
const appUrlInput    = document.getElementById("app-url");
const saveSettingsBtn= document.getElementById("save-settings-btn");

let espnS2 = null;
let swid   = null;

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  // Load saved settings
  const saved = await chrome.storage.local.get(["apiUrl", "appUrl", "leagueId", "lastRoster"]);
  apiUrlInput.value = saved.apiUrl || DEFAULT_API_URL;
  appUrlInput.value = saved.appUrl || DEFAULT_APP_URL;
  if (saved.leagueId) leagueIdInput.value = saved.leagueId;

  // Show previous roster if any
  if (saved.lastRoster?.length) {
    showPlayers(saved.lastRoster, false);
    openBtn.style.display = "block";
  }

  // Read ESPN cookies
  await checkESPNCookies();

  // Try to detect league ID from active tab
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

    espnS2 = s2Cookie?.value || null;
    swid   = swidCookie?.value || null;

    if (espnS2 && swid) {
      espnStatus.innerHTML = `<div class="dot green"></div><span>Logged in — cookies found</span>`;
    } else {
      espnStatus.innerHTML = `<div class="dot red"></div><span>Not logged in — <a href="https://fantasy.espn.com/baseball" target="_blank" style="color:#1a1917">open ESPN Fantasy</a> first</span>`;
    }
  } catch (e) {
    espnStatus.innerHTML = `<div class="dot red"></div><span>Could not read cookies</span>`;
  }
}

// ── League ID detection ───────────────────────────────────────────────────────
async function detectLeagueId() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || "";
    const match = url.match(/leagueId=(\d+)/);
    if (match && !leagueIdInput.value) {
      leagueIdInput.value = match[1];
    }
  } catch { }
}

// ── Sync button state ─────────────────────────────────────────────────────────
function updateSyncBtn() {
  const ready = espnS2 && swid && leagueIdInput.value.trim();
  syncBtn.disabled = !ready;
}

leagueIdInput.addEventListener("input", updateSyncBtn);

// ── Sync roster ───────────────────────────────────────────────────────────────
syncBtn.addEventListener("click", async () => {
  clearError();
  const leagueId = leagueIdInput.value.trim();
  const apiUrl   = normalizeUrl(apiUrlInput.value.trim() || DEFAULT_API_URL);
  const appUrl   = normalizeUrl(appUrlInput.value.trim() || DEFAULT_APP_URL);

  if (!leagueId) return showError("Enter your ESPN league ID.");
  if (!espnS2 || !swid) return showError("ESPN cookies not found. Log into ESPN Fantasy first.");

  // Save league ID
  await chrome.storage.local.set({ leagueId, apiUrl, appUrl });

  setSyncing(true);

  // First verify the backend is reachable
  try {
    const health = await fetch(`${apiUrl}/api/health`);
    if (!health.ok) throw new Error(`HTTP ${health.status}`);
  } catch (e) {
    setSyncing(false);
    return showError(`Cannot reach backend.\nURL tried: ${apiUrl}/api/health\nError: ${e.message}\n\nOpen that URL in your browser to verify it works, then check Settings.`);
  }

  try {
    const res = await fetch(`${apiUrl}/api/roster`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leagueId, espnS2, swid }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

    const players = data.players || [];
    if (!players.length) throw new Error("No players found. Check your league ID.");

    // Save roster for next time
    await chrome.storage.local.set({ lastRoster: players });

    // Push to Naylorade
    await pushToNaylorade(players, appUrl);

    showPlayers(players, true);
    openBtn.style.display = "block";

  } catch (e) {
    showError(e.message);
  } finally {
    setSyncing(false);
  }
});

// ── Push roster into Naylorade via scripting injection ────────────────────────
async function pushToNaylorade(players, appUrl) {
  // Find an existing Naylorade tab
  const allTabs = await chrome.tabs.query({});
  const nayloradeTab = allTabs.find(t => t.url?.startsWith(appUrl));

  let tab;
  if (nayloradeTab) {
    tab = nayloradeTab;
    await chrome.tabs.update(tab.id, { active: true });
  } else {
    // Open Naylorade in a new tab and wait for it to load
    tab = await chrome.tabs.create({ url: appUrl });
    await waitForTabLoad(tab.id);
  }

  // Inject script to write localStorage and reload
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
  return new Promise((resolve) => {
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
  const appUrl = (appUrlInput.value.trim() || DEFAULT_APP_URL).replace(/\/$/, "");
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
  const apiUrl = apiUrlInput.value.trim();
  const appUrl = appUrlInput.value.trim();
  await chrome.storage.local.set({ apiUrl, appUrl });
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
  syncBtn.innerHTML = on
    ? '<span class="spinner"></span>Syncing...'
    : "Sync Roster";
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function normalizeUrl(url) {
  url = url.trim().replace(/\/$/, "");
  if (url && !/^https?:\/\//i.test(url)) url = "https://" + url;
  return url;
}

// ── Start ─────────────────────────────────────────────────────────────────────
init();
