// MAIN world — injected at document_start to intercept ESPN's own roster API call
(function () {
  const ROSTER_RE = /\/apis\/v3\/games\/flb\/.*view=mRoster/;

  // Patch fetch
  const _fetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = (typeof input === "string" ? input : input?.url) || "";
    const response = await _fetch.apply(this, arguments);
    if (ROSTER_RE.test(url)) {
      response.clone().json()
        .then(data => window.postMessage({ __naylorade: "roster", data }, "*"))
        .catch(() => {});
    }
    return response;
  };

  // Patch XMLHttpRequest in case ESPN uses XHR
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__nUrl = url;
    return _open.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    if (ROSTER_RE.test(this.__nUrl || "")) {
      this.addEventListener("load", function () {
        try {
          const data = JSON.parse(this.responseText);
          window.postMessage({ __naylorade: "roster", data }, "*");
        } catch {}
      });
    }
    return _send.apply(this, arguments);
  };
})();
