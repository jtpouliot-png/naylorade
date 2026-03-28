// Runs inside ESPN Fantasy pages — handles roster fetch requests from the popup

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "FETCH_ROSTER") return;

  const { leagueId, year } = message;

  (async () => {
    for (const y of [year, year - 1]) {
      const url = `https://fantasy.espn.com/apis/v3/games/flb/seasons/${y}/segments/0/leagues/${leagueId}?view=mRoster`;
      try {
        const resp = await fetch(url);
        if (resp.status === 500 && y === year) continue;
        if (resp.status === 401) return sendResponse({ error: "ESPN session expired — log out and back in." });
        if (resp.status === 404) return sendResponse({ error: "League not found — check your league ID." });
        if (!resp.ok)           return sendResponse({ error: `ESPN returned ${resp.status}` });

        const ct = resp.headers.get("content-type") || "";
        if (!ct.includes("application/json")) return sendResponse({ error: "ESPN returned an unexpected page." });

        return sendResponse({ data: await resp.json() });
      } catch (e) {
        if (y === year) continue;
        return sendResponse({ error: e.message });
      }
    }
    sendResponse({ error: "Could not load roster from ESPN for this year or last." });
  })();

  return true; // keep message channel open for async response
});
