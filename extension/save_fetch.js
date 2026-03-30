// Runs at document_start in MAIN world, before ESPN's JS loads.
// Intercepts both fetch() and XMLHttpRequest to capture ESPN API responses.
(function () {
  function capture(url, text) {
    try {
      if (!url || !text.trim().startsWith("{")) return;
      if (!url.includes("/apis/v3/games/flb/") || !url.includes("/leagues/")) return;
      const view = new URL(url, location.href).searchParams.get("view");
      if (view) {
        localStorage.setItem("_espn_" + view, text);
        localStorage.setItem("_espn_ts", Date.now().toString());
      }
    } catch {}
  }

  // ── Intercept fetch ──────────────────────────────────────────────────────────
  const _f = window.fetch.bind(window);
  window.__nativeFetch = _f;
  window.fetch = async function (input, init) {
    const resp = await _f.apply(this, arguments);
    const url = typeof input === "string" ? input : input?.url ?? "";
    resp.clone().text().then((t) => capture(url, t)).catch(() => {});
    return resp;
  };

  // ── Intercept XHR ────────────────────────────────────────────────────────────
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._espnUrl = typeof url === "string" ? url : "";
    return _open.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    this.addEventListener("load", function () {
      capture(this._espnUrl, this.responseText || "");
    });
    return _send.apply(this, arguments);
  };
})();
