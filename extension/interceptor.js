// MAIN world — injected at document_start to intercept ESPN's league API responses
(function () {
  const ESPN_API_RE = /\/apis\/v3\/games\/flb\//;

  function tryCache(url, data) {
    if (!ESPN_API_RE.test(url)) return;
    // Only cache if the response contains team roster data
    try {
      const teams = data?.teams || [];
      const hasRoster = teams.some(t => t?.roster?.entries?.length > 0);
      if (hasRoster) {
        window.postMessage({ __naylorade: "roster", data }, "*");
      }
    } catch {}
  }

  // Patch fetch
  const _fetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = (typeof input === "string" ? input : input?.url) || "";
    const response = await _fetch.apply(this, arguments);
    if (ESPN_API_RE.test(url)) {
      response.clone().json().then(data => tryCache(url, data)).catch(() => {});
    }
    return response;
  };

  // Patch XMLHttpRequest
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__nUrl = url || "";
    return _open.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    if (ESPN_API_RE.test(this.__nUrl)) {
      this.addEventListener("load", function () {
        try { tryCache(this.__nUrl, JSON.parse(this.responseText)); } catch {}
      });
    }
    return _send.apply(this, arguments);
  };
})();
