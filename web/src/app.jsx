// QR Teku App — v3 · Layout estilo Variant C, sin datos demo,
// preview del Word a la derecha (idéntico al print real).

const { useState, useMemo, useRef, useEffect, useCallback } = React;

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
  const [view, setView] = useState("cargas");  // 'cargas' | 'cola'
  const [queueCounts, setQueueCounts] = useState({ queued: 0, assigned: 0, done: 0 });

  // ── Toasts ─────────────────────────────────────────────────────
  const pushToast = useCallback((text, type = "info") => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, text, type }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);

  // ── PyWebView detection ────────────────────────────────────────
  useEffect(() => {
    const check = () => setConnected(!!(window.pywebview && window.pywebview.api));
    check();
    window.addEventListener("pywebviewready", check);
    return () => window.removeEventListener("pywebviewready", check);
  }, []);

  // ── Auto-refresh para detectar cambios en el Excel (HORA ACULE) ─────────
  useEffect(() => {
    if (!connected || !tw.autoRefresh || !fileInfo) return;
    const interval = setInterval(async () => {
      try {
        const res = await window.pywebview.api.reload_excel();
        if (res && res.ok) {
          setRows((prevRows) => {
            // Mantener "done" local pero actualizar aculado y datos desde Excel
            const doneSet = new Set(prevRows.filter((r) => r.estado === "done").map((r) => r.n));
            return res.rows.map((r) => doneSet.has(r.n) ? { ...r, estado: "done" } : r);
          });
          if (res.auto_enqueued > 0) pushToast(`${res.auto_enqueued} carga(s) añadidas a la cola Bleecker`, "success");
        }
      } catch (e) { /* silencio */ }
    }, 20000);
    return () => clearInterval(interval);
  }, [connected, tw.autoRefresh, fileInfo]);

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
    const t = setInterval(tick, 8000);
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
    if (!connected) return;
    const matricula = (row.matriculas || "").split("/")[0]?.trim();
    if (!matricula) return;
    setLoadingOdbc(true);
    try {
      const res = await window.pywebview.api.lookup_chf(matricula);
      setLoadingOdbc(false);
      if (res.ok && res.found) {
        setEditing((e) => ({ ...e, [idx]: { ...e[idx], C: res.cif, E: res.agencia, odbcDone: true, odbcFound: true } }));
        pushToast(`CIF + Agencia: ${res.cif} · ${res.agencia}`, "success");
      } else {
        setEditing((e) => ({ ...e, [idx]: { ...e[idx], odbcDone: true, odbcFound: false } }));
        pushToast(`No se encontró ${matricula} en GEZCAM`, "error");
        // marcar la fila como missing-cif
        setRows((rs) => rs.map((r, i) => (i === idx ? { ...r, estado: "missing-cif" } : r)));
      }
    } catch (err) {
      setLoadingOdbc(false);
      pushToast(`ODBC error: ${err.message || err}`, "error");
    }
  }, [connected, pushToast]);

  const selectRow = useCallback((idx) => {
    if (idx === selectedIdx) { setSelectedIdx(null); return; }
    setSelectedIdx(idx);
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
    P: state.obs.map((o) => ({ H: o.H, D: o.D })),
  });
  // Meta para el Word (no va en el QR)
  const buildMeta = (state) => ({ playa: state.PL || "", muelle: state.MU || "" });

  const handleImport = async () => {
    if (!connected) {
      pushToast("Función disponible solo dentro de QRTeku.exe", "info");
      return;
    }
    try {
      const path = await window.pywebview.api.pick_excel();
      if (!path) return;
      const res = await window.pywebview.api.load_excel(path);
      if (!res.ok) { pushToast(`Error: ${res.error}`, "error"); return; }
      setRows(res.rows);
      setFileInfo({ name: res.filename, count: res.count, fecha: res.fecha_b2, path });
      setSelectedIdx(null);
      setEditing({});
      pushToast(`${res.count} filas cargadas desde ${res.filename}`, "success");
    } catch (e) {
      pushToast(`Error: ${e.message || e}`, "error");
    }
  };

  const handleReload = async () => {
    if (!connected) return;
    const res = await window.pywebview.api.reload_excel();
    if (res.ok) {
      setRows(res.rows);
      setFileInfo({ name: res.filename, count: res.count, fecha: res.fecha_b2 });
      setEditing({});
      setSelectedIdx(null);
      pushToast("Excel recargado", "success");
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

    if (connected) {
      try {
        const res = await window.pywebview.api.generate_word_and_print(payload, r.destino, precintos, true, meta);
        if (!res.ok) { pushToast(`Error: ${res.error}`, "error"); return; }
        pushToast(`Word generado · ${res.path.split(/[\\/]/).pop()}`, "success");
      } catch (e) {
        pushToast(`Error: ${e.message || e}`, "error");
        return;
      }
    } else {
      pushToast("Modo demo · no se imprime", "info");
    }
    setRows((rs) => rs.map((row, i) => row === r ? { ...row, estado: "done" } : row));
    setSelectedIdx(null);
  };

  const copyJSON = (idx) => {
    const compact = JSON.stringify(buildPayload(editing[idx]));
    if (navigator.clipboard) navigator.clipboard.writeText(compact);
    else if (connected) window.pywebview.api.copy_to_clipboard(compact);
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
          <div style={S.logoMark}>
            <span style={S.logoG}>G</span>
            <span style={S.logoBar} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.15 }}>
            <span style={{ fontSize: 14, fontWeight: 700, color: "#fafaf9", letterSpacing: -0.3 }}>QR Teku</span>
            <span style={{ fontSize: 11, color: "rgba(255,255,255,0.5)", letterSpacing: 0.3 }}>Garvasa · v3.2</span>
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
          {/* CTA Importar muy visible */}
          <button onClick={handleImport} style={S.importBtnTop}>
            <IconUpload size={14} />
            {hasFile ? "Cambiar Excel" : "Importar Excel"}
          </button>
          {hasFile && (
            <button onClick={handleReload} title="Recargar el mismo archivo" style={S.topIconBtn}>
              <IconRefresh size={14} />
            </button>
          )}
          <span style={S.topDivider} />
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
          <div style={S.split}>
            {/* Left: table */}
            <section style={S.leftPane}>
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
                  <span><kbd style={S.kbdLight}>↑↓</kbd> navegar</span>
                  <span><kbd style={S.kbdLight}>⏎</kbd> abrir</span>
                  <span><kbd style={S.kbdLight}>⌘⏎</kbd> imprimir</span>
                  <span><kbd style={S.kbdLight}>Esc</kbd> cerrar</span>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                  <span style={{ fontSize: 11.5, color: "#a8a29e" }}>{filtered.length} de {stats.all}</span>
                  <span style={{ fontSize: 11.5, color: "#d6d3d1" }}>·</span>
                  <span style={{ fontSize: 11, color: "#c4c0bc", fontStyle: "italic" }}>Javier Simón-Altuna San Martín</span>
                </div>
              </div>
            </section>

            {/* Right: WORD-PAGE PREVIEW */}
            <section style={S.rightPane}>
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
                  onClose={() => setSelectedIdx(null)}
                  onConfirm={() => handleConfirm(selectedIdx)}
                  onCopy={() => copyJSON(selectedIdx)}
                  onSendToQueue={() => handleEnqueueRow(selectedIdx)}
                  showJson={tw.showJsonPanel}
                />
              ) : (
                <SelectHint />
              )}
            </section>
          </div>
        </>
      )}

      {/* Toasts */}
      <div style={S.toastWrap}>
        {toasts.map((t) => (
          <Toast key={t.id} {...t} onClose={() => setToasts((ts) => ts.filter((x) => x.id !== t.id))} />
        ))}
      </div>

      {/* Tweaks */}
      <TweaksPanel title="Tweaks · QR Teku">
        <TweakSection label="Vista">
          <TweakToggle label="Tabla compacta"   value={tw.denseTable}     onChange={(v) => setTweak("denseTable", v)} />
          <TweakToggle label="Mostrar JSON"     value={tw.showJsonPanel}  onChange={(v) => setTweak("showJsonPanel", v)} />
          <TweakToggle label="Auto-recargar Excel (20s)" value={tw.autoRefresh}    onChange={(v) => setTweak("autoRefresh", v)} />
        </TweakSection>
      </TweaksPanel>
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
        QR Teku detecta automáticamente el destino, matrículas, expediciones y precintos,
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
