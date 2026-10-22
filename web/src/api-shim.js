// API shim — unifica llamadas a Python:
//   - Si window.pywebview.api existe (dentro de la ventana desktop) → bridge nativo
//   - Si no (móvil en LAN o Firebase Hosting) → fetch POST <base>/api/<método>
//
// Base URL del backend (Python HTTP server):
//   - Por defecto: URL relativa → mismo origen (cuando Python sirve los ficheros)
//   - Firebase Hosting u otro CDN: configura window.PULSO_BACKEND o query-param ?backend=http://192.168.x.x:8765
//   - El parámetro ?backend=... se guarda en localStorage para no tener que introducirlo cada vez
// Uso: await api.call('loader_login', '1234')
(function () {
  const params = new URLSearchParams(location.search);
  const mode = params.get("mode") || "supervisor";

  // Detectar y persistir URL del backend
  const STORAGE_KEY = "pulso_backend_url";
  let backendBase = "";
  const fromQuery = params.get("backend");
  if (fromQuery) {
    const normalized = fromQuery.replace(/\/$/, "");
    try { localStorage.setItem(STORAGE_KEY, normalized); } catch (_) {}
    backendBase = normalized;
  } else if (window.PULSO_BACKEND) {
    backendBase = window.PULSO_BACKEND.replace(/\/$/, "");
  } else {
    try { backendBase = localStorage.getItem(STORAGE_KEY) || ""; } catch (_) {}
  }

  function bridgeAvailable(method) {
    return (
      window.pywebview &&
      window.pywebview.api &&
      typeof window.pywebview.api[method] === "function"
    );
  }

  async function viaHttp(method, args) {
    const url = backendBase ? `${backendBase}/api/${method}` : `/api/${method}`;
    const resp = await fetch(url, {
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

  window.api = { call, mode, backendBase };
})();
