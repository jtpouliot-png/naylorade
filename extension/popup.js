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

    const players = await fetchESPNRoster();
    if (!players.length) throw new Error("No players found — make sure you are on your ESPN Fantasy team page.");

    const espnData = await fetchESPNLeagueData(leagueId);

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

// ── Fetch ESPN league data via tab navigation (bypasses fetch/CORS issues) ────
async function fetchESPNLeagueData(leagueId) {
  const allTabs = await chrome.tabs.query({});
  const espnTabs = allTabs.filter(t => t.url?.includes("fantasy.espn.com"));
  if (!espnTabs.length) {
    throw new Error("No fantasy.espn.com tab found — open fantasy.espn.com first, then try again.");
  }

  const tabId = espnTabs[0].id;
  const originalUrl = espnTabs[0].url;
  const base = "https://fantasy.espn.com/apis/v3/games/flb/seasons";
  const year = new Date().getFullYear();

  async function navFetch(url) {
    await chrome.tabs.update(tabId, { url });
    await waitForTabLoad(tabId);
    const res = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        const t = document.body?.innerText || "";
        return t.trim().startsWith("{") ? t : null;
      },
    });
    const raw = res?.[0]?.result;
    return raw ? JSON.parse(raw) : null;
  }

  try {
    let rosterData = await navFetch(`${base}/${year}/segments/0/leagues/${leagueId}?view=mRoster`);
    if (!rosterData) {
      rosterData = await navFetch(`${base}/${year - 1}/segments/0/leagues/${leagueId}?view=mRoster`);
    }
    if (!rosterData) {
      throw new Error("Could not load ESPN roster data — make sure you are logged into ESPN Fantasy.");
    }

    const dataYear = rosterData.seasonId || year;
    let matchupData = await navFetch(`${base}/${dataYear}/segments/0/leagues/${leagueId}?view=mMatchupScore`);
    if (!matchupData) {
      matchupData = await navFetch(`${base}/${dataYear - 1}/segments/0/leagues/${leagueId}?view=mMatchupScore`);
    }

    return { rosterData, matchupData: matchupData || null };
  } finally {
    // Restore the ESPN tab to where it was
    chrome.tabs.update(tabId, { url: originalUrl }).catch(() => {});
  }
}

// ── Read roster from ESPN page DOM ────────────────────────────────────────────
async function fetchESPNRoster() {
  const allTabs2 = await chrome.tabs.query({});
  const espnTabs = allTabs2.filter(t => t.url?.includes("fantasy.espn.com") || t.url?.includes("espn.com/fantasy"));
  if (!espnTabs.length) {
    throw new Error("No ESPN Fantasy tab found — open your team page at fantasy.espn.com first.");
  }

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

  const players = results?.[0]?.result;
  if (!players) throw new Error("Could not read the ESPN page — make sure it is fully loaded.");
  return players;
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
