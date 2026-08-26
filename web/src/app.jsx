// PULSO 6.0 · Supervisor de cargas Garvasa
// preview del Word a la derecha (idéntico al print real).

const { useState, useMemo, useRef, useEffect, useCallback } = React;

const useWindowWidth = () => {
  const [w, setW] = useState(window.innerWidth);
  useEffect(() => {
    const h = () => setW(window.innerWidth);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return w;
};

// ───────────────────────────────────────────────────────────────────
// Tweaks
// ───────────────────────────────────────────────────────────────────
const DEFAULT_TWEAKS = /*EDITMODE-BEGIN*/{
  "denseTable": false,
  "showJsonPanel": false,
  "autoRefresh": true
}/*EDITMODE-END*/;

const safeUpper = (s) => (s || "").toString().trim().toUpperCase();
const slug = (s) => (s || "").toString().trim().replace(/[\\\/:*?"<>|]+/g, "_").replace(/\s+/g, "_").slice(0, 60);
const todayYMD = () => {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
};

// ───────────────────────────────────────────────────────────────────
// App
// ───────────────────────────────────────────────────────────────────
const QRTekuApp = () => {
  const [tw, setTweak] = useTweaks(DEFAULT_TWEAKS);

  const [rows, setRows] = useState([]); // ← VACÍO por defecto. Sin demo.
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [showDone, setShowDone] = useState(false); // ocultar generados por defecto
  const [selectedIdx, setSelectedIdx] = useState(null);
  const [editing, setEditing] = useState({});
  const [toasts, setToasts] = useState([]);
  const [connected, setConnected] = useState(false);
  const [fileInfo, setFileInfo] = useState(null);
  const [loadingOdbc, setLoadingOdbc] = useState(false);
  const [showGraphModal, setShowGraphModal] = useState(false);
  const [showGraphPicker, setShowGraphPicker] = useState(false);
  const [graphConfigured, setGraphConfigured] = useState(false);
  const [view, setView] = useState("cargas");  // 'cargas' | 'cola'
  const [queueCounts, setQueueCounts] = useState({ queued: 0, assigned: 0, done: 0 });
  const [excelSessions, setExcelSessions] = useState([]);
  const [showExcelPicker, setShowExcelPicker] = useState(false);
  const [serverInfo, setServerInfo] = useState(null);
  const prevAculadoCountRef = useRef(null); // para detectar nuevos acules en el polling HTTP
  const audioCtxRef = useRef(null);         // AudioContext persistente (se desbloquea con el primer clic)
  const winW = useWindowWidth();
  const isTablet = winW < 1100;
  // En tablet, controla si mostrar la lista o el detalle
  const [tabletPane, setTabletPane] = useState("list"); // 'list' | 'detail'

  // ── Toasts ─────────────────────────────────────────────────────
  const pushToast = useCallback((text, type = "info") => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, text, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);

  // ── Audio: desbloquear AudioContext en el primer gesto del usuario ──
  // Los navegadores suspenden el contexto hasta que hay interacción humana.
  useEffect(() => {
    const unlock = () => {
      try {
        if (!audioCtxRef.current) {
          audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
        } else if (audioCtxRef.current.state === "suspended") {
          audioCtxRef.current.resume();
        }
      } catch (_) {}
    };
    document.addEventListener("click", unlock, { once: true });
    document.addEventListener("keydown", unlock, { once: true });
    return () => {
      document.removeEventListener("click", unlock);
      document.removeEventListener("keydown", unlock);
    };
  }, []);

  const _playBeeps = useCallback((ctx) => {
    [0, 0.22, 0.44, 0.66, 0.88].forEach((delay, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.value = 660 + i * 110;
      gain.gain.setValueAtTime(0.85, ctx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.2);
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + 0.2);
    });
  }, []);

  const beepAcule = useCallback(() => {
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === "suspended") {
        ctx.resume().then(() => _playBeeps(ctx)).catch(() => {});
      } else {
        _playBeeps(ctx);
      }
    } catch (_) {}
  }, [_playBeeps]);

  const notifyAcule = useCallback((count) => {
    beepAcule();
    pushToast(`🚛 ${count} camión${count > 1 ? "es" : ""} aculado${count > 1 ? "s" : ""}`, "success");
    try {
      if ("Notification" in window && Notification.permission === "granted") {
        new Notification("PULSO · Acule detectado", {
          body: `${count} camión${count > 1 ? "es" : ""} aculado${count > 1 ? "s" : ""} — revisar plan de carga`,
          icon: "/assets/pulso-icon.svg",
          tag: "acule",
        });
      }
    } catch (_) {}
  }, [beepAcule, pushToast]);

  // ── Solicitar permiso de notificaciones del sistema ───────────
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);

  // ── PyWebView detection ────────────────────────────────────────
  // Polling fallback: pywebviewready puede disparar antes de que React monte,
  // o la inyección del bridge tarda un instante. Reintentamos cada 400ms hasta 8s.
  useEffect(() => {
    const tryConnect = () => {
      if (window.pywebview && window.pywebview.api) {
        setConnected(true);
        return true;
      }
      return false;
    };
    if (tryConnect()) return;
    const onReady = () => tryConnect();
    window.addEventListener("pywebviewready", onReady);
    let attempts = 0;
    const poll = setInterval(() => {
      if (tryConnect() || ++attempts >= 20) clearInterval(poll);
    }, 400);
    return () => {
      window.removeEventListener("pywebviewready", onReady);
      clearInterval(poll);
    };
  }, []);

  // ── Auto-refresh para detectar cambios en el Excel (HORA ACULE) ─────────
  // Solo cuando hay un archivo local accesible (pywebview). Desde tablet no aplica.
  useEffect(() => {
    if (!connected || !tw.autoRefresh || !fileInfo) return;
    let alive = true;
    let tid = null;
    const tick = async () => {
      try {
        const res = await window.api.call("reload_excel");
        if (alive && res && res.ok) {
          setRows((prevRows) => {
            const doneSet = new Set(prevRows.filter((r) => r.estado === "done").map((r) => r.n));
            return res.rows.map((r) => doneSet.has(r.n) ? { ...r, estado: "done" } : r);
          });
          if (res.auto_enqueued > 0) {
            pushToast(`${res.auto_enqueued} carga(s) añadidas a la cola Bleecker`, "success");
          }
          // Detectar nuevos aculados (mismo mecanismo que tablet)
          const newAculCount = (res.rows || []).filter(r => r.aculado && !r.ya_cargado).length;
          if (prevAculadoCountRef.current !== null && newAculCount > prevAculadoCountRef.current) {
            notifyAcule(newAculCount - prevAculadoCountRef.current);
          }
          prevAculadoCountRef.current = newAculCount;
        }
      } catch (e) { /* silencio */ }
      if (alive) tid = setTimeout(tick, 5000);
    };
    tid = setTimeout(tick, 5000);
    return () => { alive = false; clearTimeout(tid); };
  }, [connected, tw.autoRefresh, fileInfo]);

  // ── Sincronización de cargas desde navegador/tablet ───────────────────
  // Polling cada 5s. Usa get_cargas_state (ligero, sin ODBC) con fallback
  // a reload_excel para compatibilidad con servidores antiguos.
  // En desktop (pywebview) continúa el loop pero no actualiza filas:
  // el auto-refresh de arriba ya las gestiona con mayor granularidad.
  useEffect(() => {
    let alive = true;
    let tid = null;
    const tick = async () => {
      if (!alive) return;
      const isDesktop = !!(window.pywebview && window.pywebview.api);
      if (!isDesktop) {
        try {
          let res = null;
          try { res = await window.api.call("get_cargas_state"); } catch (_) {}
          if (!res || !res.ok) {
            try { res = await window.api.call("reload_excel"); } catch (_) {}
          }
          if (alive && res && res.ok) {
            const newAculCount = (res.rows || []).filter(r => r.aculado && !r.ya_cargado).length;
            if (prevAculadoCountRef.current !== null && newAculCount > prevAculadoCountRef.current) {
              notifyAcule(newAculCount - prevAculadoCountRef.current);
            }
            prevAculadoCountRef.current = newAculCount;
            setRows(res.rows);
            setFileInfo((prev) => prev || {
              name: res.filename, count: res.count, fecha: res.fecha_b2, path: res.filename,
            });
          }
        } catch (_) {}
      }
      if (alive) tid = setTimeout(tick, 5000);
    };
    tid = setTimeout(tick, 500); // primer tick a 500ms
    return () => { alive = false; clearTimeout(tid); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Info del servidor (IP LAN, URLs) ──────────────────────────────────
  useEffect(() => {
    window.api.call("app_info").then(r => { if (r) setServerInfo(r); }).catch(() => {});
  }, []);

  // ── Estado Graph / SharePoint ─────────────────────────────────────────
  useEffect(() => {
    window.api.call("graph_get_config").then(r => {
      if (r && r.ok) setGraphConfigured(r.configured);
    }).catch(() => {});
  }, []);

  // ── Polling contadores de cola (badge en la pestaña) ───────────────────
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const r = await window.api.call("queue_snapshot");
        if (alive && r && r.ok) setQueueCounts(r.counts || { queued: 0, assigned: 0, done: 0 });
      } catch (_) { /* silencio */ }
    };
    tick();
    const t = setInterval(tick, 5000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const initRowEdit = useCallback((row) => {
    const [trac, rem] = (row.matriculas || "").split("/").map((s) => safeUpper(s));
    return {
      T: trac || "",
      R: rem || trac || "",
      N: (row.n || "").padStart(3, "0"),
      D: fileInfo?.fecha || todayYMD(),
      C: "", // se rellena por ODBC
      E: "",
      PL: row.playa || "",
      MU: row.muelle || "",
      obs: [],
      precintos: (Array.isArray(row.precintos_data) && row.precintos_data.length > 0)
        ? row.precintos_data.map((p, i) => ({
            id: `p${i}-${Math.random().toString(36).slice(2,6)}`,
            code: p.precinto,
            centro: p.centro || row.destino || "",
          }))
        : (row.precinto || "").split(",").map((p) => p.trim()).filter(Boolean)
            .map((p, i) => ({ id: `p${i}-${Math.random().toString(36).slice(2,6)}`, code: p, centro: row.destino })),
      odbcDone: false,
      odbcFound: false,
    };
  }, [fileInfo]);

  // ── Filtered rows + stats ──────────────────────────────────────
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      // Ocultar 'done' por defecto, salvo si está el chip "Hechas" o el toggle
      if (r.estado === "done" && statusFilter !== "done" && !showDone) return false;
      if (statusFilter === "aculado") {
        if (!r.aculado) return false;
      } else if (statusFilter !== "all" && r.estado !== statusFilter) return false;
      if (!q) return true;
      return Object.values(r).some((v) => String(v).toLowerCase().includes(q));
    });
  }, [rows, query, statusFilter, showDone]);

  const stats = useMemo(() => {
    const counts = { all: rows.length, ready: 0, "missing-cif": 0, done: 0, aculado: 0 };
    rows.forEach((r) => {
      counts[r.estado] = (counts[r.estado] || 0) + 1;
      if (r.aculado) counts.aculado += 1;
    });
    return counts;
  }, [rows]);

  // ── Selection + ODBC lookup ────────────────────────────────────
  const lookupCifAgencia = useCallback(async (idx, row) => {
    const matricula = (row.matriculas || "").split("/")[0]?.trim();
    if (!matricula) return;
    setLoadingOdbc(true);
    try {
      const res = await window.api.call("lookup_chf", matricula);
      setLoadingOdbc(false);
      if (res.ok && res.found) {
        setEditing((e) => ({ ...e, [idx]: { ...e[idx], C: res.cif, E: res.agencia, odbcDone: true, odbcFound: true } }));
        pushToast(`CIF + Agencia: ${res.cif} · ${res.agencia}`, "success");
        // Sincronizar al servidor para que el otro dispositivo vea el CIF
        window.api.call("update_row", row.n, { cif: res.cif, agencia: res.agencia }).catch(() => {});
      } else {
        setEditing((e) => ({ ...e, [idx]: { ...e[idx], odbcDone: true, odbcFound: false } }));
        pushToast(`No se encontró ${matricula} en GEZCAM`, "error");
        // marcar la fila como missing-cif
        setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, estado: "missing-cif" } : r)));
        window.api.call("update_row", row.n, { estado: "missing-cif" }).catch(() => {});
      }
    } catch (err) {
      setLoadingOdbc(false);
      pushToast(`ODBC error: ${err.message || err}`, "error");
    }
  }, [pushToast]);

  const selectRow = useCallback((idx) => {
    if (idx === selectedIdx) { setSelectedIdx(null); setTabletPane("list"); return; }
    setSelectedIdx(idx);
    setTabletPane("detail");
    if (!editing[idx]) {
      const row = filtered[idx];
      const state = initRowEdit(row);
      setEditing((e) => ({ ...e, [idx]: state }));
      // Disparar ODBC lookup
      lookupCifAgencia(idx, row);
    }
  }, [selectedIdx, editing, filtered, initRowEdit, lookupCifAgencia]);

  // ── Field updates ──────────────────────────────────────────────
  const updateField = (idx, key, value) => setEditing((e) => ({ ...e, [idx]: { ...e[idx], [key]: value } }));

  const addObs = (idx, H, D) => {
    if (!H || !D) return;
    setEditing((e) => ({
      ...e,
      [idx]: { ...e[idx], obs: [...e[idx].obs, { id: Math.random().toString(36).slice(2), H, D }] },
    }));
    pushToast("Observación añadida", "success");
  };
  const delObs = (idx, oid) => setEditing((e) => ({ ...e, [idx]: { ...e[idx], obs: e[idx].obs.filter((o) => o.id !== oid) } }));

  const addPrecinto = (idx, code, centro) => {
    if (!code) return;
    setEditing((e) => ({
      ...e,
      [idx]: { ...e[idx], precintos: [...e[idx].precintos, { id: Math.random().toString(36).slice(2), code: code.toUpperCase(), centro: centro || "" }] },
    }));
    pushToast("Precinto añadido", "success");
  };
  const delPrecinto = (idx, pid) => setEditing((e) => ({ ...e, [idx]: { ...e[idx], precintos: e[idx].precintos.filter((p) => p.id !== pid) } }));
  const updatePrecintoCentro = (idx, pid, centro) => {
    setEditing((e) => ({ ...e, [idx]: { ...e[idx], precintos: e[idx].precintos.map((p) => p.id === pid ? { ...p, centro } : p) } }));
  };

  // ── Actions ────────────────────────────────────────────────────
  // PAYLOAD QR — SOLO T,R,N,D,C,E,P (sin PL/MU)
  const buildPayload = (state) => ({
    T: state.T, R: state.R, N: state.N, D: state.D, C: state.C, E: state.E,
    P: [],
  });
  // Meta para el Word (no va en el QR)
  const buildMeta = (state) => ({ playa: state.PL || "", muelle: state.MU || "" });

  // Comprueba el bridge directamente en el momento de la llamada (no React state)
  const apiReady = () => !!(window.pywebview && window.pywebview.api);

  const refreshExcelSessions = useCallback(async () => {
    try {
      const r = await window.api.call("get_excel_sessions");
      if (r.ok) setExcelSessions(r.sessions || []);
    } catch (_) {}
  }, []);

  const applyExcelResult = useCallback((res, path) => {
    setRows(res.rows);
    setFileInfo({ name: res.filename, count: res.count, fecha: res.fecha_b2, path: path || res.filename });
    setSelectedIdx(null);
    setEditing({});
  }, []);

  const handleImport = async () => {
    if (apiReady()) {
      // Ventana PyWebView: diálogo nativo de archivo
      try {
        const path = await window.pywebview.api.pick_excel();
        if (!path) return;
        const res = await window.pywebview.api.load_excel(path);
        if (!res.ok) { pushToast(`Error: ${res.error}`, "error"); return; }
        applyExcelResult(res, path);
        pushToast(`${res.count} filas cargadas desde ${res.filename}`, "success");
        refreshExcelSessions();
      } catch (e) {
        pushToast(`Error: ${e.message || e}`, "error");
      }
    } else {
      // Navegador: input file HTML → envía base64 al servidor HTTP
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".xlsx,.xls,.csv";
      input.onchange = async () => {
        const file = input.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (ev) => {
          try {
            const b64 = ev.target.result.split(",")[1];
            const res = await window.api.call("load_excel_base64", file.name, b64);
            if (!res.ok) { pushToast(`Error: ${res.error}`, "error"); return; }
            applyExcelResult(res, file.name);
            pushToast(`${res.count} filas cargadas desde ${res.filename}`, "success");
            refreshExcelSessions();
          } catch (e) {
            pushToast(`Error: ${e.message || e}`, "error");
          }
        };
        reader.readAsDataURL(file);
      };
      input.click();
    }
  };

  const handleReload = async () => {
    const res = await window.api.call("reload_excel");
    if (res.ok) {
      applyExcelResult(res);
      pushToast("Excel recargado", "success");
      refreshExcelSessions();
    } else {
      pushToast(res.error, "error");
    }
  };

  const handleConfirm = async (idx) => {
    const state = editing[idx];
    const errs = ["T", "R", "N", "D", "C", "E"].filter((k) => !state[k]);
    if (errs.length) {
      pushToast(`Faltan campos: ${errs.join(", ")}`, "error");
      return;
    }
    const r = filtered[idx];
    const payload = buildPayload(state);
    const meta = buildMeta(state);
    const precintos = state.precintos.map((p) => ({ centro: p.centro, precinto: p.code }));

    try {
      const res = await window.api.call("generate_word_and_print", payload, r.destino, precintos, true, meta);
      if (!res.ok) { pushToast(`Error: ${res.error}`, "error"); return; }
      pushToast(`Word generado · ${(res.path || "").split(/[\\/]/).pop()}`, "success");
    } catch (e) {
      pushToast(`Error: ${e.message || e}`, "error");
      return;
    }
    setRows((rs) => rs.map((row, i) => row === r ? { ...row, estado: "done" } : row));
    // Sincronizar estado "done" al servidor para que el otro dispositivo lo vea
    window.api.call("update_row", r.n, {
      estado: "done",
      cif: state.C || "",
      agencia: state.E || "",
      precintos_data: precintos,
    }).catch(() => {});
    setSelectedIdx(null);
  };

  const copyJSON = (idx) => {
    const compact = JSON.stringify(buildPayload(editing[idx]));
    if (navigator.clipboard) navigator.clipboard.writeText(compact);
    else if (apiReady()) window.pywebview.api.copy_to_clipboard(compact);
    pushToast("JSON copiado al portapapeles", "success");
  };

  // ── Enviar fila a la cola Bleecker (manual) ──────────────────
  const handleEnqueueRow = async (idx) => {
    const r = filtered[idx];
    const st = editing[idx];
    if (!r) return;
    // Enriquecer la fila con CIF/agencia editados antes de encolar
    const payload = {
      ...r,
      source: "excel",
      cif: st?.C || r.cif || "",
      agencia: st?.E || r.agencia || "",
      fecha: st?.D || fileInfo?.fecha || "",
      // Preservar precintos editados
      precintos_data: st?.precintos?.length
        ? st.precintos.map((p) => ({ centro: p.centro, precinto: p.code }))
        : r.precintos_data,
    };
    try {
      const res = await window.api.call("queue_enqueue_manual", payload, false);
      if (res.ok) pushToast(`Encolada ${res.item.id} · ${r.destino}`, "success");
      else pushToast(`Error: ${res.error}`, "error");
    } catch (e) {
      pushToast(`Error: ${e.message || e}`, "error");
    }
  };

  // ── Keyboard shortcuts ─────────────────────────────────────────
  useEffect(() => {
    const h = (e) => {
      if (e.key === "Escape" && selectedIdx !== null) setSelectedIdx(null);
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter" && selectedIdx !== null) {
        e.preventDefault();
        handleConfirm(selectedIdx);
      }
      // arrow nav when no row selected
      if (selectedIdx === null && rows.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        e.preventDefault();
        selectRow(0);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [selectedIdx, editing, rows, selectRow]);

  // ── Render ─────────────────────────────────────────────────────
  const hasFile = rows.length > 0;
  const sel = selectedIdx !== null ? filtered[selectedIdx] : null;
  const selState = selectedIdx !== null ? editing[selectedIdx] : null;

  return (
    <div style={S.root}>
      {/* ─── Dark top bar (estilo Variant C) ───────────────────── */}
      <header style={S.top}>
        <div style={S.brandRow}>
          <img
            src="assets/icon-rojo.png"
            alt="PULSO"
            style={{ width: 34, height: 34, borderRadius: 8, flexShrink: 0 }}
            onError={(e) => {
              e.target.src = "assets/pulso-icon.svg";
              e.target.onerror = () => {
                e.target.style.display = "none";
                e.target.nextElementSibling.style.display = "flex";
              };
            }}
          />
          <div style={{ ...S.logoMark, display: "none" }}>
            <span style={S.logoG}>P</span>
            <span style={S.logoBar} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.15 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#fafaf9", letterSpacing: -0.3 }}>PULSO 6.0</span>
            <span style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", letterSpacing: 0.3 }}>Garvasa</span>
          </div>
          {hasFile && (
            <>
              <span style={S.topDivider} />
              <div style={{ display: "flex", alignItems: "center", gap: 8, color: "rgba(255,255,255,0.78)", fontSize: 12.5 }}>
                <IconFile size={13} />
                <span style={{ fontWeight: 500, color: "#fafaf9" }}>{fileInfo?.name}</span>
                <span style={{ color: "rgba(255,255,255,0.35)" }}>·</span>
                <span>{fileInfo?.count} filas</span>
                <span style={{ color: "rgba(255,255,255,0.35)" }}>·</span>
                <span>B2 {fileInfo?.fecha}</span>
              </div>
            </>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {excelSessions.length > 1 && (
            <button
              onClick={() => setShowExcelPicker(true)}
              title="Cambiar plan de carga activo"
              style={{ ...S.topIconBtn, padding: "0 10px", fontSize: 11, fontWeight: 600, color: "#fbbf24", borderColor: "rgba(251,191,36,0.3)", gap: 5, display: "flex", alignItems: "center", width: "auto" }}
            >
              Plan ({excelSessions.findIndex(s => s.active) + 1}/{excelSessions.length})
            </button>
          )}
          <span style={S.topDivider} />
          {/* Botón SharePoint — siempre visible; abre picker si configurado, config si no */}
          <button
            onClick={() => graphConfigured ? setShowGraphPicker(true) : setShowGraphModal(true)}
            style={{ display: "flex", alignItems: "center", gap: 5, padding: "3px 10px", background: graphConfigured ? "rgba(14,165,233,0.15)" : "rgba(255,255,255,0.07)", border: `1px solid ${graphConfigured ? "rgba(14,165,233,0.3)" : "rgba(255,255,255,0.15)"}`, borderRadius: 6, cursor: "pointer", fontFamily: "inherit" }}
            title={graphConfigured ? "Importar plan de carga desde SharePoint" : "Configurar SharePoint / Microsoft 365"}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: graphConfigured ? "#38bdf8" : "#57534e" }} />
            <span style={{ fontSize: 11, color: graphConfigured ? "#7dd3fc" : "rgba(255,255,255,0.45)", fontWeight: 600 }}>M365</span>
          </button>
          {/* Botón tweaks */}
          <button
            onClick={() => window.postMessage({ type: "__activate_edit_mode" }, "*")}
            title="Ajustes (Tweaks)"
            style={{ ...S.topIconBtn, fontSize: 14 }}
          >⚙</button>
          <div style={S.connStatus}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: connected ? "#22c55e" : "#a8a29e", boxShadow: connected ? "0 0 0 3px rgba(34,197,94,0.18)" : "none" }} />
            <span style={{ fontSize: 11.5, color: "rgba(255,255,255,0.78)", fontWeight: 500 }}>
              {connected ? "ODBC INFOLOG" : "Modo demo"}
            </span>
          </div>
        </div>
      </header>

      {/* ─── Tabs ─── */}
      <div style={S.tabBar}>
        <button onClick={() => setView("cargas")} style={{
          ...S.tab,
          ...(view === "cargas" ? S.tabActive : {}),
        }}>
          <IconLayers size={13} />
          Cargas
          {hasFile && <span style={S.tabCount}>{rows.length}</span>}
        </button>
        <button onClick={() => setView("cola")} style={{
          ...S.tab,
          ...(view === "cola" ? S.tabActive : {}),
        }}>
          <IconTruck size={13} />
          Cola Bleecker
          {(queueCounts.queued + queueCounts.assigned) > 0 && (
            <span style={{
              ...S.tabCount,
              background: view === "cola" ? "#dc2626" : "#fee2e2",
              color: view === "cola" ? "#fff" : "#dc2626",
              borderColor: view === "cola" ? "#dc2626" : "#fecaca",
            }}>
              {queueCounts.queued + queueCounts.assigned}
            </span>
          )}
        </button>
        <div style={{ flex: 1 }} />
        {serverInfo?.supervisor_url && serverInfo.ip_lan !== "127.0.0.1" && (
          <div style={{ display: "flex", alignItems: "center", gap: 4, padding: "4px 10px", background: "rgba(251,191,36,0.12)", border: "1px solid rgba(251,191,36,0.25)", borderRadius: 6, fontSize: 11, color: "#fbbf24", fontFamily: "ui-monospace, monospace", marginRight: 4 }}
            title="URL para acceder al supervisor desde tablet u otro dispositivo en la misma red">
            <IconExternal size={10} />
            {serverInfo.supervisor_url}
          </div>
        )}
        <a
          href="?mode=loader"
          target="_blank"
          rel="noopener noreferrer"
          style={S.loaderLink}
          title="Abrir vista cargador en nueva ventana"
        >
          <IconExternal size={11} />
          Vista cargador
        </a>
      </div>

      {/* ─── Empty state (solo en cargas, sin archivo) ───────── */}
      {view === "cargas" && !hasFile ? (
        <EmptyState onImport={handleImport} connected={connected} />
      ) : view === "cola" ? (
        <QueuePanel pushToast={pushToast} />
      ) : (
        <>
          {/* Stats strip */}
          <div style={S.statStrip}>
            <StatItem label="Pendientes"  value={stats.ready || 0}  />
            <StatItem label="Aculadas"    value={stats.aculado || 0}  success />
            <StatItem label="Sin CIF"     value={stats["missing-cif"] || 0} warn />
            <StatItem label="Generadas"   value={stats.done || 0}   success />
            <div style={{ flex: 1 }} />
            <div style={S.searchWrap}>
              <IconSearch size={14} style={{ color: "#a8a29e" }} />
              <input
                style={S.searchInput}
                placeholder="Buscar destino, matrícula, agencia, expedición…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {query && (
                <button onClick={() => setQuery("")} style={{ background: "transparent", border: "none", cursor: "pointer", color: "#a8a29e", padding: 0, display: "flex" }}>
                  <IconX size={13} />
                </button>
              )}
              <kbd style={S.kbd}>/</kbd>
            </div>
            <div style={S.chipsBar}>
              <Chip label="Todos"    active={statusFilter === "all"}         count={(stats.all || 0) - (showDone ? 0 : (stats.done || 0))} onClick={() => setStatusFilter("all")} />
              <Chip label="Aculadas" active={statusFilter === "aculado"}     count={stats.aculado || 0}        onClick={() => setStatusFilter("aculado")} />
              <Chip label="Pendientes" active={statusFilter === "ready"}     count={stats.ready || 0}          onClick={() => setStatusFilter("ready")} />
              <Chip label="Sin CIF"  active={statusFilter === "missing-cif"} count={stats["missing-cif"] || 0} onClick={() => setStatusFilter("missing-cif")} />
              {(stats.done > 0) && (
                <button
                  onClick={() => setShowDone((v) => !v)}
                  style={{
                    ...S.toggleDoneBtn,
                    background: showDone ? "#1c1917" : "#fff",
                    color: showDone ? "#fff" : "#15803d",
                    borderColor: showDone ? "#1c1917" : "#d1fae5",
                  }}
                  title={showDone ? "Ocultar generadas" : "Mostrar generadas"}
                >
                  {showDone ? <IconCheck size={11} stroke={2.5} /> : <IconCircle size={10} />}
                  {showDone ? "Ocultar generadas" : `Mostrar generadas`}
                  <span style={{ fontSize: 11, opacity: 0.7 }}>{stats.done || 0}</span>
                </button>
              )}
            </div>
          </div>

          {/* Split content */}
          <div style={isTablet
            ? { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0 }
            : S.split
          }>
            {/* Left: table — hidden on tablet when showing detail */}
            {(!isTablet || tabletPane === "list") && (
            <section style={isTablet ? { ...S.leftPane, flex: 1 } : S.leftPane}>
              {isTablet && tabletPane === "list" && selectedIdx !== null && (
                <div style={{ padding: "8px 12px", background: "#fff7ed", borderBottom: "1px solid #fed7aa", display: "flex", alignItems: "center", gap: 8 }}>
                  <button onClick={() => setTabletPane("detail")} style={{ fontSize: 12, fontWeight: 600, color: "#c2410c", background: "transparent", border: "none", cursor: "pointer", fontFamily: "inherit" }}>
                    → Ver detalle seleccionado
                  </button>
                </div>
              )}
              <div style={S.tableHead}>
                <span style={{ width: 56, textAlign: "center" }}>VIAJE</span>
                <span style={{ flex: 1, minWidth: 0 }}>DESTINO · MATRÍCULA · AGENCIA</span>
                <span style={{ width: 80, textAlign: "right" }}>ESTADO</span>
              </div>
              <div style={S.tableList}>
                {filtered.length === 0 ? (
                  <div style={{ padding: 60, textAlign: "center", color: "#a8a29e", fontSize: 13.5 }}>
                    <IconSearch size={28} style={{ color: "#d6d3d1", marginBottom: 10 }} />
                    <div style={{ fontWeight: 500, color: "#57534e" }}>Sin resultados</div>
                  </div>
                ) : filtered.map((r, i) => (
                  <RowC key={i} row={r} selected={i === selectedIdx} dense={tw.denseTable} onClick={() => selectRow(i)} />
                ))}
              </div>
              <div style={S.tableFooter}>
                <div style={{ display: "flex", gap: 14, fontSize: 11, color: "#78716c" }}>
                  {!isTablet && <>
                    <span><kbd style={S.kbdLight}>↑↓</kbd> navegar</span>
                    <span><kbd style={S.kbdLight}>⏎</kbd> abrir</span>
                    <span><kbd style={S.kbdLight}>⌘⏎</kbd> imprimir</span>
                    <span><kbd style={S.kbdLight}>Esc</kbd> cerrar</span>
                  </>}
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <span style={{ fontSize: 11.5, color: "#a8a29e" }}>{filtered.length} de {stats.all}</span>
                  <span style={{ fontSize: 11.5, color: "#d6d3d1" }}>·</span>
                  {!isTablet && <span style={{ fontSize: 11, color: "#c4c0bc", fontStyle: "italic" }}>Javier Simón-Altuna San Martín</span>}
                </div>
              </div>
            </section>
            )}

            {/* Right: WORD-PAGE PREVIEW — on tablet, full screen with back button */}
            {(!isTablet || tabletPane === "detail") && (
            <section style={isTablet ? { ...S.rightPane, flex: 1 } : S.rightPane}>
              {isTablet && (
                <div style={{ padding: "8px 12px", background: "#1c1917", display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                  <button onClick={() => setTabletPane("list")} style={{ fontSize: 12, fontWeight: 600, color: "#fafaf9", background: "transparent", border: "none", cursor: "pointer", fontFamily: "inherit" }}>
                    ← Volver a lista
                  </button>
                </div>
              )}
              {sel && selState ? (
                <WordPreview
                  row={sel}
                  state={selState}
                  loadingOdbc={loadingOdbc}
                  onField={(k, v) => updateField(selectedIdx, k, v)}
                  onAddObs={(H, D) => addObs(selectedIdx, H, D)}
                  onDelObs={(oid) => delObs(selectedIdx, oid)}
                  onAddPrec={(code, centro) => addPrecinto(selectedIdx, code, centro)}
                  onDelPrec={(pid) => delPrecinto(selectedIdx, pid)}
                  onPrecCentro={(pid, centro) => updatePrecintoCentro(selectedIdx, pid, centro)}
                  onClose={() => { setSelectedIdx(null); setTabletPane("list"); }}
                  onConfirm={() => handleConfirm(selectedIdx)}
                  onCopy={() => copyJSON(selectedIdx)}
                  onSendToQueue={() => handleEnqueueRow(selectedIdx)}
                  showJson={tw.showJsonPanel}
                />
              ) : (
                <SelectHint />
              )}
            </section>
            )}
          </div>
        </>
      )}

      {/* ─── Modal selector de plan de carga ─── */}
      {showExcelPicker && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 9000, display: "flex", alignItems: "center", justifyContent: "center" }}
          onClick={(e) => { if (e.target === e.currentTarget) setShowExcelPicker(false); }}>
          <div style={{ background: "#fff", borderRadius: 12, width: "min(480px, 92vw)", boxShadow: "0 20px 60px rgba(0,0,0,0.25)", overflow: "hidden" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: "1px solid #e7e5e4" }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: "#1c1917" }}>Cambiar plan de carga</span>
              <button onClick={() => setShowExcelPicker(false)} style={{ background: "transparent", border: "none", fontSize: 18, color: "#a8a29e", cursor: "pointer" }}>✕</button>
            </div>
            <div style={{ padding: "14px 20px 20px", display: "flex", flexDirection: "column", gap: 10 }}>
              <p style={{ margin: 0, fontSize: 12, color: "#78716c" }}>
                Solo cambia las filas mostradas. La cola Bleecker no se modifica automáticamente.
              </p>
              {excelSessions.map((s, idx) => (
                <button
                  key={s.path}
                  onClick={async () => {
                    const r = await window.api.call("switch_excel_session", idx);
                    if (r.ok) {
                      applyExcelResult(r);
                      pushToast(`Plan activo: ${r.filename}`, "success");
                      refreshExcelSessions();
                    } else {
                      pushToast(r.error || "Error", "error");
                    }
                    setShowExcelPicker(false);
                  }}
                  style={{
                    display: "flex", flexDirection: "column", gap: 4, padding: "12px 14px",
                    borderRadius: 8, border: `2px solid ${s.active ? "#dc2626" : "#e7e5e4"}`,
                    background: s.active ? "#fff5f5" : "#fafaf9",
                    cursor: "pointer", fontFamily: "inherit", textAlign: "left",
                  }}
                >
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {s.active && <span style={{ fontSize: 10, fontWeight: 700, color: "#dc2626", background: "#fee2e2", padding: "1px 7px", borderRadius: 999 }}>ACTIVO</span>}
                    <span style={{ fontSize: 13, fontWeight: 600, color: "#1c1917" }}>{s.filename}</span>
                  </div>
                  <div style={{ fontSize: 11, color: "#78716c" }}>{s.count} filas · fecha B2: {s.fecha}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Toasts */}
      <div style={S.toastWrap}>
        {toasts.map((t) => (
          <Toast key={t.id} {...t} onClose={() => setToasts((ts) => ts.filter((x) => x.id !== t.id))} />
        ))}
      </div>

      {/* Tweaks */}
      <TweaksPanel title="Tweaks · PULSO 6.0">
        <TweakSection label="Vista">
          <TweakToggle label="Tabla compacta"   value={tw.denseTable}     onChange={(v) => setTweak("denseTable", v)} />
          <TweakToggle label="Mostrar JSON"     value={tw.showJsonPanel}  onChange={(v) => setTweak("showJsonPanel", v)} />
          <TweakToggle label="Auto-recargar Excel (5s)"  value={tw.autoRefresh}    onChange={(v) => setTweak("autoRefresh", v)} />
        </TweakSection>
        <TweakSection label="Microsoft 365">
          <div style={{ padding: "6px 0" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: graphConfigured ? "#22c55e" : "#d6d3d1", flexShrink: 0 }} />
              <span style={{ fontSize: 12, color: graphConfigured ? "#15803d" : "#a8a29e" }}>
                {graphConfigured ? "SharePoint activo" : "No configurado"}
              </span>
            </div>
            <button
              onClick={() => setShowGraphModal(true)}
              style={{ fontSize: 12, fontWeight: 600, padding: "5px 12px", borderRadius: 6, border: "1px solid #d6d3d1", background: "#fff", cursor: "pointer", color: "#1c1917", fontFamily: "inherit" }}
            >
              Configurar SharePoint…
            </button>
          </div>
        </TweakSection>
      </TweaksPanel>

      {/* Modal Graph / SharePoint config */}
      {showGraphModal && (
        <GraphConfigModal
          onClose={() => setShowGraphModal(false)}
          onSaved={(configured) => { setGraphConfigured(configured); }}
          pushToast={pushToast}
        />
      )}

      {/* Modal picker de archivos SharePoint */}
      {showGraphPicker && (
        <GraphFilePicker
          onClose={() => setShowGraphPicker(false)}
          onLoaded={(res) => {
            applyExcelResult(res);
            pushToast(`${res.count} filas cargadas · ${res.filename}`, "success");
            refreshExcelSessions();
            setShowGraphPicker(false);
          }}
          pushToast={pushToast}
        />
      )}
    </div>
  );
};

// ───────────────────────────────────────────────────────────────────
// Graph / SharePoint config modal
// ───────────────────────────────────────────────────────────────────
const GraphConfigModal = ({ onClose, onSaved, pushToast }) => {
  const [cfg, setCfg] = useState({
    enabled: false, mode: "sharepoint", source: "folder",
    tenant_id: "", client_id: "", client_secret: "",
    sharepoint_url: "", site_path: "", folder_path: "", file_path: "",
    user_email: "", drive_id: "", item_id: "",
  });
  const [loading, setLoading] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testFiles, setTestFiles] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    window.api.call("graph_get_config").then(r => {
      if (r && r.ok && r.config && Object.keys(r.config).length)
        setCfg(prev => ({ ...prev, ...r.config }));
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const set = (k, v) => setCfg(prev => ({ ...prev, [k]: v }));

  const handleSave = async () => {
    setSaving(true);
    try {
      const r = await window.api.call("graph_save_config", cfg);
      if (r.ok) { pushToast("Configuración guardada", "success"); onSaved(r.configured); onClose(); }
      else pushToast(r.error || "Error guardando", "error");
    } catch (e) { pushToast(String(e), "error"); }
    finally { setSaving(false); }
  };

  const handleTest = async () => {
    setTesting(true); setTestFiles(null);
    try {
      // Save current form values first so the backend has them before testing
      const saveR = await window.api.call("graph_save_config", cfg);
      if (!saveR.ok) { pushToast(`Error guardando: ${saveR.error}`, "error"); return; }
      const r = await window.api.call("graph_test");
      if (r.ok) {
        setTestFiles(r.files || []);
        pushToast(`Conexión OK · ${r.count} archivo(s) encontrado(s)`, "success");
      } else {
        pushToast(`Error: ${r.error}`, "error");
      }
    } catch (e) { pushToast(String(e), "error"); }
    finally { setTesting(false); }
  };

  const IS = {
    overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 9000, display: "flex", alignItems: "center", justifyContent: "center" },
    box: { background: "#fff", borderRadius: 12, width: 520, maxWidth: "95vw", maxHeight: "90vh", overflow: "auto", boxShadow: "0 8px 40px rgba(0,0,0,0.18)", fontFamily: "inherit" },
    head: { padding: "18px 22px 14px", borderBottom: "1px solid #e7e5e4", display: "flex", alignItems: "center", justifyContent: "space-between" },
    title: { fontSize: 15, fontWeight: 700, color: "#1c1917" },
    body: { padding: "18px 22px" },
    row: { marginBottom: 14 },
    label: { display: "block", fontSize: 11.5, fontWeight: 600, color: "#57534e", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" },
    input: { width: "100%", padding: "7px 10px", border: "1px solid #d6d3d1", borderRadius: 6, fontSize: 13, fontFamily: "ui-monospace, monospace", boxSizing: "border-box", color: "#1c1917", outline: "none" },
    hint: { fontSize: 11, color: "#a8a29e", marginTop: 3 },
    footer: { padding: "12px 22px", borderTop: "1px solid #e7e5e4", display: "flex", gap: 8, justifyContent: "flex-end" },
    btn: (color) => ({ padding: "7px 16px", borderRadius: 7, border: "none", fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit", background: color, color: "#fff" }),
    btnGhost: { padding: "7px 16px", borderRadius: 7, border: "1px solid #d6d3d1", background: "#fff", fontWeight: 600, fontSize: 13, cursor: "pointer", fontFamily: "inherit", color: "#44403c" },
    toggleRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 14 },
    segRow: { display: "flex", gap: 0, marginBottom: 14, border: "1px solid #d6d3d1", borderRadius: 7, overflow: "hidden" },
    segBtn: (active) => ({ flex: 1, padding: "7px 0", border: "none", borderRight: "1px solid #d6d3d1", background: active ? "#0ea5e9" : "#fff", color: active ? "#fff" : "#57534e", fontWeight: 600, fontSize: 12.5, cursor: "pointer", fontFamily: "inherit" }),
    section: { fontSize: 11, fontWeight: 700, color: "#a8a29e", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10, paddingTop: 4 },
    fileRow: { padding: "7px 10px", borderBottom: "1px solid #f5f5f4", fontSize: 12.5, color: "#1c1917", display: "flex", justifyContent: "space-between", alignItems: "center" },
  };

  if (loading) return (
    <div style={IS.overlay}>
      <div style={{ ...IS.box, padding: 32, textAlign: "center", color: "#a8a29e" }}>Cargando…</div>
    </div>
  );

  const fmtDate = (s) => {
    if (!s) return "";
    try { return new Date(s).toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }); }
    catch { return s; }
  };

  return (
    <div style={IS.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={IS.box}>
        <div style={IS.head}>
          <span style={IS.title}>Microsoft 365 · SharePoint</span>
          <button onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 18, color: "#78716c", lineHeight: 1 }}>×</button>
        </div>
        <div style={IS.body}>
          {/* Activar */}
          <div style={IS.toggleRow}>
            <input type="checkbox" id="g-enabled" checked={!!cfg.enabled} onChange={e => set("enabled", e.target.checked)} style={{ width: 16, height: 16, cursor: "pointer" }} />
            <label htmlFor="g-enabled" style={{ fontSize: 13.5, fontWeight: 600, color: "#1c1917", cursor: "pointer" }}>
              Activar lectura desde SharePoint
            </label>
          </div>

          {/* Credenciales Azure */}
          <div style={IS.section}>Credenciales Azure</div>
          <div style={IS.row}>
            <label style={IS.label}>Tenant ID (ID de directorio)</label>
            <input style={IS.input} value={cfg.tenant_id} onChange={e => set("tenant_id", e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
            <div style={IS.hint}>Azure Portal → Entra ID → Overview → ID de directorio</div>
          </div>
          <div style={IS.row}>
            <label style={IS.label}>Client ID (ID de aplicación)</label>
            <input style={IS.input} value={cfg.client_id} onChange={e => set("client_id", e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" />
          </div>
          <div style={IS.row}>
            <label style={IS.label}>Client Secret</label>
            <input style={IS.input} type="password" value={cfg.client_secret} onChange={e => set("client_secret", e.target.value)} placeholder="Secreto de cliente" />
            <div style={IS.hint}>Certificados y secretos → Nuevo secreto → copiar valor</div>
          </div>

          {/* Ubicación SharePoint */}
          <div style={IS.section}>Ubicación en SharePoint</div>
          <div style={IS.row}>
            <label style={IS.label}>URL de SharePoint</label>
            <input style={IS.input} value={cfg.sharepoint_url} onChange={e => set("sharepoint_url", e.target.value)} placeholder="https://garvasalogistica.sharepoint.com" />
          </div>
          <div style={IS.row}>
            <label style={IS.label}>Ruta del sitio</label>
            <input style={IS.input} value={cfg.site_path} onChange={e => set("site_path", e.target.value)} placeholder="/sites/DatosGarvasa" />
            <div style={IS.hint}>Vacío = sitio raíz</div>
          </div>
          <div style={IS.row}>
            <label style={IS.label}>Carpeta de planes de carga</label>
            <input style={IS.input} value={cfg.folder_path} onChange={e => set("folder_path", e.target.value)} placeholder="/Documentos compartidos/Expediciones/PLAN DE CARGA" />
            <div style={IS.hint}>Ruta relativa al sitio — el archivo concreto se elige al importar</div>
          </div>

          {/* Resultado del test */}
          {testFiles !== null && (
            <div style={{ marginTop: 8, border: "1px solid #e7e5e4", borderRadius: 8, overflow: "hidden" }}>
              <div style={{ padding: "7px 10px", background: "#f5f5f4", fontSize: 11.5, fontWeight: 700, color: "#57534e" }}>
                Archivos encontrados en la carpeta
              </div>
              {testFiles.length === 0 && (
                <div style={{ ...IS.fileRow, color: "#a8a29e" }}>Sin archivos .xlsx</div>
              )}
              {testFiles.slice(0, 8).map((f, i) => (
                <div key={i} style={IS.fileRow}>
                  <span>{f.name}</span>
                  <span style={{ fontSize: 11, color: "#a8a29e" }}>{fmtDate(f.modified)} · {f.size_kb} KB</span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={IS.footer}>
          <button onClick={handleTest} disabled={testing} style={{ ...IS.btnGhost, opacity: testing ? 0.6 : 1 }}>
            {testing ? "Probando…" : "Probar conexión"}
          </button>
          <button onClick={onClose} style={IS.btnGhost}>Cancelar</button>
          <button onClick={handleSave} disabled={saving} style={{ ...IS.btn("#0ea5e9"), opacity: saving ? 0.6 : 1 }}>
            {saving ? "Guardando…" : "Guardar"}
          </button>
        </div>
      </div>
    </div>
  );
};

// ───────────────────────────────────────────────────────────────────
// SharePoint file picker
// ───────────────────────────────────────────────────────────────────
const GraphFilePicker = ({ onClose, onLoaded, pushToast }) => {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingFile, setLoadingFile] = useState("");

  useEffect(() => {
    window.api.call("graph_list_files").then(r => {
      if (r.ok) setFiles(r.files || []);
      else pushToast(r.error || "Error listando archivos", "error");
    }).catch(e => pushToast(String(e), "error"))
      .finally(() => setLoading(false));
  }, []);

  const handlePick = async (f) => {
    setLoadingFile(f.server_url);
    try {
      const r = await window.api.call("graph_load_file", f.server_url);
      if (r.ok) onLoaded(r);
      else pushToast(r.error || "Error cargando", "error");
    } catch (e) { pushToast(String(e), "error"); }
    finally { setLoadingFile(""); }
  };

  const fmtDate = (s) => {
    if (!s) return "";
    try { return new Date(s).toLocaleDateString("es-ES", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" }); }
    catch { return s; }
  };

  const PS = {
    overlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 9100, display: "flex", alignItems: "center", justifyContent: "center" },
    box: { background: "#fff", borderRadius: 12, width: 540, maxWidth: "95vw", maxHeight: "80vh", display: "flex", flexDirection: "column", boxShadow: "0 8px 40px rgba(0,0,0,0.18)", fontFamily: "inherit" },
    head: { padding: "16px 20px 12px", borderBottom: "1px solid #e7e5e4", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 },
    list: { flex: 1, overflow: "auto" },
    row: (active) => ({ padding: "10px 18px", borderBottom: "1px solid #f5f5f4", display: "flex", alignItems: "center", justifyContent: "space-between", cursor: "pointer", background: active ? "#f0f9ff" : "#fff", transition: "background 0.1s" }),
    name: { fontSize: 13.5, fontWeight: 600, color: "#1c1917" },
    meta: { fontSize: 11, color: "#a8a29e", marginTop: 2 },
    loadBtn: { padding: "5px 14px", borderRadius: 6, border: "none", background: "#0ea5e9", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", flexShrink: 0 },
  };

  return (
    <div style={PS.overlay} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div style={PS.box}>
        <div style={PS.head}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700, color: "#1c1917" }}>Importar plan de carga</div>
            <div style={{ fontSize: 11.5, color: "#a8a29e", marginTop: 2 }}>Selecciona el archivo de SharePoint</div>
          </div>
          <button onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", fontSize: 18, color: "#78716c", lineHeight: 1 }}>×</button>
        </div>
        <div style={PS.list}>
          {loading && <div style={{ padding: 32, textAlign: "center", color: "#a8a29e" }}>Cargando lista…</div>}
          {!loading && files.length === 0 && <div style={{ padding: 32, textAlign: "center", color: "#a8a29e" }}>Sin archivos .xlsx en la carpeta</div>}
          {files.map((f, i) => {
            const busy = loadingFile === f.server_url;
            return (
              <div key={i} style={PS.row(busy)} onClick={() => !loadingFile && handlePick(f)}>
                <div>
                  <div style={PS.name}>{f.name}</div>
                  <div style={PS.meta}>{fmtDate(f.modified)} · {f.size_kb} KB</div>
                </div>
                <button style={{ ...PS.loadBtn, opacity: loadingFile && !busy ? 0.4 : 1 }} disabled={!!loadingFile} onClick={e => { e.stopPropagation(); handlePick(f); }}>
                  {busy ? "Cargando…" : "Abrir"}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

// ───────────────────────────────────────────────────────────────────
// Empty state
// ───────────────────────────────────────────────────────────────────
const EmptyState = ({ onImport, connected }) => (
  <div style={S.emptyRoot}>
    <div style={S.emptyCard}>
      <div style={S.emptyIcon}>
        <IconFile size={36} stroke={1.5} />
      </div>
      <h2 style={S.emptyH}>Importa un Excel para empezar</h2>
      <p style={S.emptyP}>
        Carga el archivo de cargas del día (.xlsx, .xls o .csv).<br/>
        PULSO detecta automáticamente el destino, matrículas, expediciones y precintos,
        y consulta el CIF + Agencia en {connected ? <b>FGE50STO.GEZCAM</b> : <span style={{ color: "#a8a29e" }}>(modo demo)</span>}.
      </p>
      <button onClick={onImport} style={S.emptyBtn}>
        <IconUpload size={16} stroke={2} />
        Importar Excel
        <kbd style={{ ...S.kbdLight, marginLeft: 8 }}>⌘O</kbd>
      </button>
      <div style={S.emptyHints}>
        <div style={S.emptyHint}>
          <IconCalendar size={13} style={{ color: "#a8a29e" }} />
          <span>La fecha se lee de la celda <b style={{ fontFamily: "ui-monospace, monospace" }}>B2</b></span>
        </div>
        <div style={S.emptyHint}>
          <IconLayers size={13} style={{ color: "#a8a29e" }} />
          <span>Encabezados detectados por columna <b>DESTINO</b></span>
        </div>
        <div style={S.emptyHint}>
          <IconCheck size={13} style={{ color: "#a8a29e" }} />
          <span>Precintos leídos de columna con <b>PRECINTO</b> (o AE)</span>
        </div>
      </div>
      <div style={{ marginTop: 32, paddingTop: 18, borderTop: "1px solid #f4f4f3", fontSize: 11, color: "#c4c0bc", letterSpacing: 0.2 }}>
        Desarrollado por <span style={{ color: "#a8a29e", fontWeight: 500 }}>Javier Simón-Altuna San Martín</span> · Garvasa Logística 2026
      </div>
    </div>
  </div>
);

const SelectHint = () => (
  <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: "100%", flexDirection: "column", gap: 8, color: "#a8a29e" }}>
    <IconChevronR size={20} style={{ color: "#d6d3d1" }} />
    <div style={{ fontSize: 13.5, fontWeight: 500, color: "#57534e" }}>Selecciona una fila</div>
    <div style={{ fontSize: 12 }}>El preview del Word aparecerá aquí · ODBC se consulta automáticamente</div>
  </div>
);

// ───────────────────────────────────────────────────────────────────
// Subcomponents
// ───────────────────────────────────────────────────────────────────
const StatItem = ({ label, value, warn, success }) => (
  <div style={{ display: "flex", flexDirection: "column", padding: "0 22px 0 0", marginRight: 22, borderRight: "1px solid #e7e5e4" }}>
    <div style={{ fontSize: 10.5, color: "#a8a29e", letterSpacing: 0.8, textTransform: "uppercase", fontWeight: 600 }}>{label}</div>
    <div style={{ fontSize: 17, fontWeight: 600, letterSpacing: -0.3, marginTop: 3, color: warn ? "#dc2626" : success ? "#15803d" : "#1c1917" }}>
      {value}
    </div>
  </div>
);

const Chip = ({ label, count, active, onClick }) => (
  <button onClick={onClick} style={{
    display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px",
    borderRadius: 999,
    background: active ? "#1c1917" : "#fff",
    color: active ? "#fff" : "#57534e",
    border: active ? "1px solid #1c1917" : "1px solid #e7e5e4",
    fontSize: 12, fontWeight: 500, cursor: "pointer", fontFamily: "inherit",
  }}>
    {label}
    <span style={{ fontSize: 11, color: active ? "rgba(255,255,255,0.7)" : "#a8a29e" }}>{count}</span>
  </button>
);

const RowC = ({ row, selected, dense, onClick }) => {
  const isMissing = row.estado === "missing-cif";
  const isDone = row.estado === "done";
  const isAculado = !!row.aculado;
  return (
    <div onClick={onClick} style={{
      display: "flex", alignItems: "center",
      padding: dense ? "9px 20px 9px 12px" : "13px 20px 13px 12px",
      background: selected ? "#1c1917" : (isAculado ? "#ecfdf5" : "transparent"),
      borderBottom: "1px solid " + (isAculado && !selected ? "#d1fae5" : "#e7e5e4"),
      cursor: "pointer", position: "relative",
      color: selected ? "#fafaf9" : "#1c1917",
      gap: 12,
    }}>
      {selected && <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: "#dc2626" }} />}
      {isAculado && !selected && <span style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: "#15803d" }} />}

      {/* Nº viaje destacado a la izquierda */}
      <div style={{
        flex: "0 0 56px", display: "flex", flexDirection: "column", alignItems: "center",
        padding: "4px 0", borderRight: "1px solid " + (selected ? "rgba(255,255,255,0.12)" : "#f4f4f3"),
      }}>
        <span style={{
          fontSize: 9, color: selected ? "rgba(255,255,255,0.45)" : "#a8a29e",
          textTransform: "uppercase", letterSpacing: 1, fontWeight: 600, marginBottom: 1,
        }}>VIAJE</span>
        <span style={{
          fontSize: 17, fontFamily: "ui-monospace, 'JetBrains Mono', monospace",
          fontWeight: 700, letterSpacing: -0.3,
          color: selected ? "#fafaf9" : (isMissing ? "#dc2626" : "#1c1917"),
          lineHeight: 1,
        }}>{row.n || "—"}</span>
      </div>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{
            display: "inline-block", width: 6, height: 6, borderRadius: "50%", flexShrink: 0,
            background: isMissing ? "#dc2626" : isDone ? "#15803d" : "#d6d3d1",
          }} />
          <span style={{
            fontSize: 15, fontWeight: 600, letterSpacing: -0.2,
            color: selected ? "#fafaf9" : "#1c1917",
            overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          }}>{row.destino || "—"}</span>
        </div>
        <div style={{
          fontSize: 11.5, marginTop: 4, marginLeft: 14, display: "flex", gap: 8, alignItems: "center",
          fontFamily: "ui-monospace, monospace",
          color: selected ? "rgba(255,255,255,0.65)" : "#57534e",
          overflow: "hidden", whiteSpace: "nowrap",
        }}>
          <span style={{ fontWeight: 600 }}>{(row.matriculas || "—").split(" / ")[0]}</span>
          {row.agencia && <>
            <span style={{ color: selected ? "rgba(255,255,255,0.3)" : "#d6d3d1" }}>·</span>
            <span style={{ fontFamily: "'Inter Tight', Inter, sans-serif" }}>{row.agencia}</span>
          </>}
          {row.expedicion && <>
            <span style={{ color: selected ? "rgba(255,255,255,0.3)" : "#d6d3d1" }}>·</span>
            <span style={{ color: selected ? "rgba(255,255,255,0.5)" : "#a8a29e" }}>{row.expedicion}</span>
          </>}
        </div>
        {(row.ruta_carga != null || row.combined_count != null || row.numsup_count != null) && (
          <div style={{
            fontSize: 10.5, marginTop: 3, marginLeft: 14, display: "flex", gap: 8, alignItems: "center",
            color: selected ? "rgba(255,255,255,0.45)" : "#a8a29e",
            fontFamily: "'Inter Tight', Inter, sans-serif",
          }}>
            {row.ruta_carga != null && (
              <span>Ruta <b style={{ color: selected ? "rgba(255,255,255,0.65)" : "#78716c" }}>{row.ruta_carga}</b></span>
            )}
            {(row.combined_count != null || row.numsup_count != null) && row.ruta_carga != null && (
              <span style={{ color: selected ? "rgba(255,255,255,0.2)" : "#d6d3d1" }}>·</span>
            )}
            {(row.combined_count != null || row.numsup_count != null) && (
              <span><b style={{ color: selected ? "rgba(255,255,255,0.65)" : "#78716c" }}>{row.combined_count ?? row.numsup_count}</b> pales</span>
            )}
          </div>
        )}
      </div>
      <div style={{ width: 80, textAlign: "right" }}>
        {isAculado ? <span style={{ fontSize: 11, color: selected ? "#86efac" : "#15803d", fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, display: "inline-flex", alignItems: "center", gap: 4 }}>● {row.hora_acule || "OK"}</span>
         : isMissing ? <span style={{ fontSize: 11, color: "#dc2626", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>Sin CIF</span>
         : isDone ? <span style={{ fontSize: 11, color: selected ? "#86efac" : "#15803d", fontWeight: 600, textTransform: "uppercase", letterSpacing: 0.5 }}>Hecha</span>
         : <span style={{ fontSize: 11, color: selected ? "rgba(255,255,255,0.5)" : "#a8a29e", textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 500 }}>Pdte</span>}
      </div>
    </div>
  );
};

const Toast = ({ text, type, onClose }) => {
  const map = {
    success: { iconBg: "rgba(34,197,94,0.16)", iconColor: "#22c55e", icon: <IconCheck size={14} stroke={2.5} /> },
    info:    { iconBg: "rgba(255,255,255,0.1)", iconColor: "#fafaf9", icon: <IconCircle size={14} /> },
    error:   { iconBg: "rgba(239,68,68,0.18)", iconColor: "#f87171", icon: <IconAlert size={14} /> },
  };
  const c = map[type] || map.info;
  return (
    <div style={S.toast}>
      <div style={{ width: 28, height: 28, borderRadius: 8, background: c.iconBg, color: c.iconColor, display: "grid", placeItems: "center" }}>{c.icon}</div>
      <div style={{ flex: 1, fontSize: 12.5, color: "#fafaf9", fontWeight: 500 }}>{text}</div>
      <button onClick={onClose} style={{ background: "transparent", border: "none", cursor: "pointer", color: "rgba(255,255,255,0.55)", padding: 0, display: "flex" }}><IconX size={13} /></button>
    </div>
  );
};

// ───────────────────────────────────────────────────────────────────
// Styles
// ───────────────────────────────────────────────────────────────────
const S = {
  root: { height: "100vh", background: "#fafaf9", color: "#1c1917", display: "flex", flexDirection: "column", fontFamily: "'Inter Tight', Inter, system-ui, sans-serif", overflow: "hidden" },

  // Top bar
  top: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 24px", background: "#1c1917", borderBottom: "1px solid #292524", flexShrink: 0 },
  brandRow: { display: "flex", alignItems: "center", gap: 14 },
  logoMark: { width: 32, height: 32, borderRadius: 7, background: "#dc2626", display: "grid", placeItems: "center", position: "relative", overflow: "hidden" },
  logoG: { color: "#fff", fontWeight: 800, fontSize: 15, letterSpacing: -0.5, zIndex: 2 },
  logoBar: { position: "absolute", left: 0, right: 0, bottom: 0, height: 4, background: "rgba(255,255,255,0.18)" },
  topDivider: { width: 1, height: 24, background: "rgba(255,255,255,0.12)" },
  importBtnTop: { display: "flex", alignItems: "center", gap: 8, padding: "8px 14px 8px 12px", background: "#dc2626", color: "#fff", border: "none", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", boxShadow: "0 1px 0 rgba(255,255,255,0.08) inset, 0 0 0 1px rgba(220,38,38,0.4)", whiteSpace: "nowrap" },
  topIconBtn: { width: 32, height: 32, display: "grid", placeItems: "center", background: "rgba(255,255,255,0.05)", border: "1px solid rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.78)", borderRadius: 8, cursor: "pointer" },
  connStatus: { display: "flex", alignItems: "center", gap: 8, padding: "0 4px", whiteSpace: "nowrap" },

  // Tabs
  tabBar: { display: "flex", alignItems: "center", padding: "0 24px", background: "#fff", borderBottom: "1px solid #e7e5e4", gap: 4, flexShrink: 0 },
  tab: { display: "flex", alignItems: "center", gap: 7, padding: "11px 14px 11px 12px", background: "transparent", border: "none", borderBottom: "2px solid transparent", color: "#78716c", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", marginBottom: -1 },
  tabActive: { color: "#1c1917", borderBottomColor: "#dc2626" },
  tabCount: { fontSize: 10.5, fontWeight: 600, padding: "1px 7px", background: "#fafaf9", color: "#57534e", border: "1px solid #e7e5e4", borderRadius: 999 },
  loaderLink: { display: "inline-flex", alignItems: "center", gap: 5, padding: "6px 10px", background: "#fafaf9", border: "1px solid #e7e5e4", borderRadius: 6, fontSize: 11.5, color: "#57534e", textDecoration: "none", fontWeight: 500 },

  // Stats strip
  statStrip: { display: "flex", alignItems: "center", padding: "12px 24px", background: "#fff", borderBottom: "1px solid #e7e5e4", flexShrink: 0, gap: 0 },
  searchWrap: { display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", background: "#fafaf9", border: "1px solid #e7e5e4", borderRadius: 8, width: 360 },
  searchInput: { flex: 1, border: "none", outline: "none", fontSize: 12.5, color: "#1c1917", background: "transparent", fontFamily: "inherit" },
  kbd: { fontSize: 10, color: "#78716c", background: "#fff", border: "1px solid #e7e5e4", padding: "1px 5px", borderRadius: 3, fontFamily: "ui-monospace, monospace" },
  kbdLight: { fontSize: 10, color: "#57534e", background: "#fff", border: "1px solid #e7e5e4", padding: "1px 5px", borderRadius: 3, fontFamily: "ui-monospace, monospace", marginRight: 3 },
  chipsBar: { display: "flex", gap: 6, marginLeft: 16, alignItems: "center" },
  toggleDoneBtn: { display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 10px", borderRadius: 999, border: "1px solid #d1fae5", fontSize: 12, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", marginLeft: 6 },

  // Split
  split: { flex: 1, display: "grid", gridTemplateColumns: "minmax(520px, 1fr) minmax(640px, 740px)", overflow: "hidden", minHeight: 0 },
  leftPane: { display: "flex", flexDirection: "column", borderRight: "1px solid #e7e5e4", background: "#fff", overflow: "hidden", minWidth: 0, minHeight: 0 },
  tableHead: { display: "flex", padding: "12px 20px 12px 12px", background: "#fafaf9", borderBottom: "1px solid #d6d3d1", fontSize: 10.5, color: "#a8a29e", textTransform: "uppercase", letterSpacing: 1, fontWeight: 700, gap: 12 },
  tableList: { flex: 1, overflow: "auto" },
  tableFooter: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 20px", borderTop: "1px solid #e7e5e4", background: "#fafaf9", flexShrink: 0 },

  rightPane: { display: "flex", flexDirection: "column", background: "#f4f4f3", overflow: "auto", minWidth: 0, minHeight: 0 },

  // Empty state
  emptyRoot: { flex: 1, display: "grid", placeItems: "center", padding: 40, background: "linear-gradient(180deg, #fafaf9 0%, #f4f4f3 100%)" },
  emptyCard: { background: "#fff", border: "1px solid #e7e5e4", borderRadius: 16, padding: "48px 56px", maxWidth: 600, textAlign: "center", boxShadow: "0 1px 2px rgba(0,0,0,0.04), 0 4px 16px rgba(0,0,0,0.04)" },
  emptyIcon: { width: 72, height: 72, borderRadius: 16, background: "#fafaf9", border: "1px solid #e7e5e4", display: "grid", placeItems: "center", margin: "0 auto 22px", color: "#78716c" },
  emptyH: { fontSize: 26, fontWeight: 600, letterSpacing: -0.6, margin: "0 0 10px", color: "#1c1917" },
  emptyP: { fontSize: 14, color: "#78716c", lineHeight: 1.6, margin: "0 0 28px" },
  emptyBtn: { display: "inline-flex", alignItems: "center", gap: 10, padding: "13px 24px 13px 20px", background: "#dc2626", color: "#fff", border: "none", borderRadius: 10, fontSize: 15, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", boxShadow: "0 4px 12px rgba(220,38,38,0.25), 0 1px 0 rgba(255,255,255,0.15) inset", whiteSpace: "nowrap" },
  emptyHints: { display: "flex", flexDirection: "column", gap: 10, marginTop: 32, paddingTop: 24, borderTop: "1px solid #f4f4f3", alignItems: "flex-start", textAlign: "left", maxWidth: 360, margin: "32px auto 0" },
  emptyHint: { display: "flex", alignItems: "center", gap: 10, fontSize: 12.5, color: "#78716c" },

  // Toasts
  toastWrap: { position: "fixed", bottom: 24, right: 24, display: "flex", flexDirection: "column", gap: 8, zIndex: 60 },
  toast: { display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", background: "#1c1917", border: "1px solid #292524", borderRadius: 10, boxShadow: "0 10px 30px rgba(0,0,0,0.18)", minWidth: 280, animation: "toastIn 200ms" },
};

window.QRTekuApp = QRTekuApp;
