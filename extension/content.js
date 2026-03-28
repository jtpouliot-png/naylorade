// Isolated world — bridges interceptor (MAIN) → extension runtime
if (window.__nayloradeLoaded) throw new Error("already loaded");
window.__nayloradeLoaded = true;

// Inject interceptor.js into the page's MAIN world via script tag
const s = document.createElement("script");
s.src = chrome.runtime.getURL("interceptor.js");
s.onload = () => s.remove();
(document.head || document.documentElement).appendChild(s);

// Receive messages posted by interceptor.js
window.addEventListener("message", (e) => {
  if (e.source !== window || !e.data?.__naylorade) return;
  if (e.data.__naylorade === "roster") {
    chrome.storage.local.set({ cachedRoster: e.data.data });
  }
  if (e.data.__naylorade === "debug_url") {
    chrome.storage.local.get("debugUrls").then(s => {
      const urls = s.debugUrls || [];
      urls.unshift(e.data.url);
      chrome.storage.local.set({ debugUrls: urls.slice(0, 20) });
    });
  }
});

// Respond to popup asking for cached roster
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== "GET_ROSTER") return;
  chrome.storage.local.get(["cachedRoster", "debugUrls"]).then(saved => {
    if (saved.cachedRoster) {
      sendResponse({ data: saved.cachedRoster });
    } else {
      const urls = saved.debugUrls || [];
      const detail = urls.length
        ? `\n\nURLs seen (${urls.length}):\n` + urls.slice(0, 5).join("\n")
        : "\n\n(No ESPN fetches intercepted — interceptor.js may not be running)";
      sendResponse({ error: "No roster cached yet — reload your ESPN Fantasy page, then try Sync." + detail });
    }
  });
  return true;
});
