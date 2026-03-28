// Isolated world — bridges interceptor (MAIN) → extension runtime
if (window.__nayloradeLoaded) throw new Error("already loaded");
window.__nayloradeLoaded = true;

// Receive roster data posted by interceptor.js
window.addEventListener("message", (e) => {
  if (e.source !== window || e.data?.__naylorade !== "roster") return;
  chrome.storage.local.set({ cachedRoster: e.data.data });
});

// Respond to popup asking for cached roster
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "GET_ROSTER") return;
  chrome.storage.local.get("cachedRoster").then(saved => {
    if (saved.cachedRoster) {
      sendResponse({ data: saved.cachedRoster });
    } else {
      sendResponse({ error: "No roster cached yet — reload your ESPN Fantasy page, then try Sync." });
    }
  });
  return true;
});
