// API shim — unifica llamadas a Python:
//   - Si window.pywebview.api existe (dentro de la ventana desktop) → bridge nativo
//   - Si no (móvil en LAN) → fetch POST /api/<método>
// Uso:  await api.call('loader_login', '1234')
(function () {
  const params = new URLSearchParams(location.search);
  const mode = params.get("mode") || "supervisor";

  function bridgeAvailable(method) {
    return (
      window.pywebview &&
      window.pywebview.api &&
      typeof window.pywebview.api[method] === "function"
    );
  }

  async function viaHttp(method, args) {
    const resp = await fetch(`/api/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ args: args || [], kwargs: {} }),
    });
    if (!resp.ok) {
      let detail = "";
      try { detail = (await resp.json()).error || ""; } catch (_) {}
      throw new Error(`HTTP ${resp.status} ${detail}`);
    }
    return resp.json();
  }

  async function call(method, ...args) {
    if (bridgeAvailable(method)) {
      const r = await window.pywebview.api[method](...args);
      return r;
    }
    return viaHttp(method, args);
  }

  window.api = { call, mode };
})();
