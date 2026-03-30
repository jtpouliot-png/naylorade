// Runs at document_start in MAIN world, before ESPN's JS loads.
// 1) Saves native fetch reference
// 2) Intercepts ESPN API responses and caches them in localStorage
(function () {
  const _f = window.fetch.bind(window);
  window.__nativeFetch = _f;

  window.fetch = async function () {
    const resp = await _f.apply(this, arguments);
    try {
      const input = arguments[0];
      const url = typeof input === "string" ? input : input?.url ?? "";
      if (url.includes("/apis/v3/games/flb/") && url.includes("/leagues/")) {
        const view = new URL(url, location.href).searchParams.get("view");
        if (view) {
          resp.clone().text().then((t) => {
            if (t.trim().startsWith("{")) {
              localStorage.setItem("_espn_" + view, t);
              localStorage.setItem("_espn_ts", Date.now().toString());
            }
          });
        }
      }
    } catch {}
    return resp;
  };
})();
