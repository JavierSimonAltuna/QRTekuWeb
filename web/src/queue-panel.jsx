// Panel Cola Bleecker — vista supervisor
// Muestra: cargas en cola, asignaciones activas, cargadores, histórico.
// Permite reasignar, marcar urgente, eliminar de cola.

const { useState, useEffect, useCallback } = React;

const QueuePanel = ({ pushToast }) => {
  const [snap, setSnap] = useState({ queued: [], assigned: [], done: [], loaders: [], counts: { queued: 0, assigned: 0, done: 0 } });
  const [reassignFor, setReassignFor] = useState(null); // item id

  const refresh = useCallback(async () => {
    try {
      const r = await window.api.call("queue_snapshot");
      if (r.ok) setSnap(r);
    } catch (e) { /* silencio */ }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 6000);
    return () => clearInterval(t);
  }, [refresh]);

  const handleRemove = async (id) => {
    if (!confirm("¿Quitar de la cola?")) return;
    const r = await window.api.call("queue_remove", id);
    if (r.ok) { pushToast("Eliminada de la cola", "success"); refresh(); }
    else pushToast(r.error || "Error", "error");
  };

  const handleUrgent = async (id, urgente) => {
    const r = await window.api.call("queue_set_urgent", id, !urgente);
    if (r.ok) { pushToast(urgente ? "Urgencia desactivada" : "Marcada como urgente", "success"); refresh(); }
  };

  const handleReassign = async (id, loaderId) => {
    const r = await window.api.call("queue_reassign", id, loaderId);
    if (r.ok) { pushToast("Reasignada", "success"); refresh(); setReassignFor(null); }
    else pushToast(r.error || "Error", "error");
  };

  const handleResetDone = async () => {
    if (!confirm("¿Limpiar el histórico de completadas?")) return;
    const r = await window.api.call("queue_reset_done");
    if (r.ok) { pushToast("Histórico limpiado", "success"); refresh(); }
  };

  const loaderById = (id) => snap.loaders.find((l) => l.id === id);

  return (
    <div style={QS.root}>
      {/* ─── Header stats ─── */}
      <div style={QS.stats}>
        <StatBig label="En cola"     value={snap.counts.queued}   color="#1c1917" />
        <StatBig label="Asignadas"   value={snap.counts.assigned} color="#0ea5e9" />
        <StatBig label="Completadas" value={snap.counts.done}     color="#15803d" />
        <div style={{ flex: 1 }} />
        <button onClick={refresh} style={QS.refreshBtn} title="Refrescar">
          <IconRefresh size={14} />
          Refrescar
        </button>
        {snap.counts.done > 0 && (
          <button onClick={handleResetDone} style={QS.clearBtn} title="Limpiar histórico">
            <IconTrash size={13} />
            Limpiar histórico
          </button>
        )}
      </div>

      {/* ─── Grid 3 columnas ─── */}
      <div style={QS.grid}>
        {/* ── Cola ── */}
        <section style={QS.col}>
          <div style={QS.colHead}>
            <span style={QS.colTitle}>Cola</span>
            <span style={QS.colCount}>{snap.queued.length}</span>
          </div>
          <div style={QS.list}>
            {snap.queued.length === 0 ? (
              <EmptyMini label="Sin cargas en cola" hint="Se añaden automáticamente cuando se detecta la hora de acule" />
            ) : snap.queued.map((it, i) => (
              <QueueCard
                key={it.id}
                item={it}
                position={i + 1}
                loaders={snap.loaders}
                onToggleUrgent={() => handleUrgent(it.id, it.urgente)}
                onRemove={() => handleRemove(it.id)}
                onReassign={(loaderId) => handleReassign(it.id, loaderId)}
                showReassignMenu={reassignFor === it.id}
                onOpenReassign={() => setReassignFor(reassignFor === it.id ? null : it.id)}
              />
            ))}
          </div>
        </section>

        {/* ── Asignadas ── */}
        <section style={QS.col}>
          <div style={QS.colHead}>
            <span style={QS.colTitle}>En curso</span>
            <span style={QS.colCount}>{snap.assigned.length}</span>
          </div>
          <div style={QS.list}>
            {snap.assigned.length === 0 ? (
              <EmptyMini label="Ninguna carga en curso" hint="Cuando un cargador pida una carga aparecerá aquí" />
            ) : snap.assigned.map((it) => (
              <AssignedCard
                key={it.id}
                item={it}
                loader={loaderById(it.assigned_to)}
                loaders={snap.loaders}
                onReassign={(loaderId) => handleReassign(it.id, loaderId)}
                onRemove={() => handleRemove(it.id)}
                showReassignMenu={reassignFor === it.id}
                onOpenReassign={() => setReassignFor(reassignFor === it.id ? null : it.id)}
              />
            ))}
          </div>
        </section>

        {/* ── Cargadores ── */}
        <section style={QS.col}>
          <div style={QS.colHead}>
            <span style={QS.colTitle}>Cargadores</span>
            <span style={QS.colCount}>{snap.loaders.filter((l) => l.active).length}</span>
          </div>
          <div style={QS.list}>
            {snap.loaders.map((l) => {
              const current = snap.assigned.find((a) => a.assigned_to === l.id);
              return (
                <LoaderCard key={l.id} loader={l} current={current} />
              );
            })}
          </div>

          {/* ── Histórico breve ── */}
          {snap.done.length > 0 && (
            <>
              <div style={{ ...QS.colHead, marginTop: 18 }}>
                <span style={QS.colTitle}>Últimas completadas</span>
                <span style={QS.colCount}>{snap.done.length}</span>
              </div>
              <div style={QS.list}>
                {[...snap.done].reverse().slice(0, 10).map((it) => (
                  <DoneCard key={it.id} item={it} loader={loaderById(it.assigned_to)} />
                ))}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
};

// ───────────────────────────────────────────────────────────────
// Tarjetas
// ───────────────────────────────────────────────────────────────
const QueueCard = ({ item, position, loaders, onToggleUrgent, onRemove, onReassign, showReassignMenu, onOpenReassign }) => (
  <div style={{
    ...QS.card,
    borderLeft: item.urgente ? "3px solid #dc2626" : "3px solid transparent",
  }}>
    <div style={QS.cardHead}>
      <div style={QS.cardLeft}>
        <span style={QS.cardPos}>{String(position).padStart(2, "0")}</span>
        <span style={QS.cardTicket}>{item.id}</span>
      </div>
      <div style={QS.cardRight}>
        <button onClick={onToggleUrgent} title={item.urgente ? "Quitar urgencia" : "Marcar urgente"}
          style={{ ...QS.iconBtn, color: item.urgente ? "#dc2626" : "#a8a29e" }}>
          <IconBolt size={12} />
        </button>
        <button onClick={onOpenReassign} title="Asignar manualmente"
          style={{ ...QS.iconBtn, color: showReassignMenu ? "#1c1917" : "#a8a29e" }}>
          <IconTruck size={12} />
        </button>
        <button onClick={onRemove} title="Quitar de cola"
          style={{ ...QS.iconBtn, color: "#a8a29e" }}>
          <IconX size={13} />
        </button>
      </div>
    </div>

    <div style={QS.cardBody}>
      <div style={QS.cardTitleRow}>
        <span style={QS.cardDestino}>{item.destino}</span>
        <span style={{
          ...QS.tipoBadge,
          background: item.tipo_carga === "REFRIGERADO" ? "#dbeafe" : "#ffedd5",
          color: item.tipo_carga === "REFRIGERADO" ? "#0c4a6e" : "#9a3412",
        }}>
          {item.tipo_carga === "REFRIGERADO" ? "❄" : "☼"}
        </span>
      </div>
      <div style={QS.cardMeta}>
        <Meta label="Muelle" value={(item.muelle || "—").padStart(2, "0")} />
        <Meta label="Playa" value={item.playa || "—"} />
        <Meta label="Salida" value={item.hora_salida || "—"} />
      </div>
      <div style={QS.cardTractora}>{item.tractora}</div>
    </div>

    {showReassignMenu && (
      <div style={QS.reassignMenu}>
        <div style={QS.reassignHint}>Asignar a:</div>
        {loaders.filter((l) => l.active).map((l) => (
          <button key={l.id} onClick={() => onReassign(l.id)} style={QS.reassignOpt}>
            <span style={QS.reassignDot} />
            <span style={{ fontWeight: 600 }}>{l.id}</span>
            <span style={{ color: "#a8a29e", marginLeft: 4 }}>· {l.name}</span>
            <span style={{ flex: 1 }} />
            <span style={QS.reassignMuelle}>M{(l.muelle_actual || "—").padStart(2, "0")}</span>
          </button>
        ))}
      </div>
    )}
  </div>
);

const AssignedCard = ({ item, loader, loaders, onReassign, onRemove, showReassignMenu, onOpenReassign }) => (
  <div style={{ ...QS.card, background: "#eff6ff", borderLeft: "3px solid #0ea5e9" }}>
    <div style={QS.cardHead}>
      <div style={QS.cardLeft}>
        <span style={QS.cardTicket}>{item.id}</span>
        <span style={QS.assignedBy}>
          <IconTruck size={11} />
          {loader?.id || item.assigned_to} · {loader?.name || "?"}
        </span>
      </div>
      <div style={QS.cardRight}>
        <button onClick={onOpenReassign} title="Reasignar a otro cargador" style={QS.iconBtn}>
          <IconRefresh size={12} />
        </button>
        <button onClick={onRemove} title="Cancelar" style={QS.iconBtn}>
          <IconX size={13} />
        </button>
      </div>
    </div>
    <div style={QS.cardBody}>
      <div style={QS.cardDestino}>{item.destino}</div>
      <div style={QS.cardMeta}>
        <Meta label="Muelle" value={(item.muelle || "—").padStart(2, "0")} />
        <Meta label="Asignada" value={fmtT(item.assigned_at)} />
      </div>
    </div>
    {showReassignMenu && (
      <div style={QS.reassignMenu}>
        <div style={QS.reassignHint}>Reasignar a:</div>
        {loaders.filter((l) => l.active && l.id !== item.assigned_to).map((l) => (
          <button key={l.id} onClick={() => onReassign(l.id)} style={QS.reassignOpt}>
            <span style={QS.reassignDot} />
            <span style={{ fontWeight: 600 }}>{l.id}</span>
            <span style={{ color: "#a8a29e", marginLeft: 4 }}>· {l.name}</span>
            <span style={{ flex: 1 }} />
            <span style={QS.reassignMuelle}>M{(l.muelle_actual || "—").padStart(2, "0")}</span>
          </button>
        ))}
      </div>
    )}
  </div>
);

const LoaderCard = ({ loader, current }) => (
  <div style={QS.loaderCard}>
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{
        width: 10, height: 10, borderRadius: "50%",
        background: current ? "#0ea5e9" : (loader.active ? "#22c55e" : "#a8a29e"),
        boxShadow: current ? "0 0 0 4px rgba(14,165,233,0.18)" : "0 0 0 4px rgba(34,197,94,0.12)",
      }} />
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#1c1917" }}>
          {loader.id} <span style={{ color: "#a8a29e", fontWeight: 500 }}>· {loader.name}</span>
        </div>
        <div style={{ fontSize: 10.5, color: "#78716c", marginTop: 2 }}>
          PIN: <code style={{ fontFamily: "ui-monospace, monospace", color: "#1c1917" }}>{loader.pin}</code>
          {" · Muelle "}<b>{(loader.muelle_actual || "—").padStart(2, "0")}</b>
        </div>
      </div>
    </div>
    {current ? (
      <div style={QS.loaderCurrent}>
        Cargando #{current.id} · {current.destino}
      </div>
    ) : (
      <div style={{ fontSize: 10.5, color: "#a8a29e", marginTop: 8, fontStyle: "italic" }}>En espera</div>
    )}
  </div>
);

const DoneCard = ({ item, loader }) => (
  <div style={QS.doneCard}>
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <span style={{ fontSize: 13, fontWeight: 600, color: "#1c1917", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.destino}</span>
        <span style={{ fontSize: 10, color: "#a8a29e", fontFamily: "ui-monospace, monospace" }}>
          {item.id} · {loader?.id || "?"} · M{(item.muelle || "—").padStart(2, "0")}
        </span>
      </div>
      <span style={{ fontSize: 10, color: "#15803d", fontWeight: 700, letterSpacing: 0.5, textTransform: "uppercase", whiteSpace: "nowrap" }}>
        ✓ {item.completed_at || fmtT(item.finished_at)}
      </span>
    </div>
  </div>
);

const Meta = ({ label, value }) => (
  <div style={QS.meta}>
    <span style={QS.metaLbl}>{label}</span>
    <span style={QS.metaVal}>{value}</span>
  </div>
);

const StatBig = ({ label, value, color }) => (
  <div style={{ display: "flex", flexDirection: "column", paddingRight: 24, marginRight: 24, borderRight: "1px solid #e7e5e4" }}>
    <span style={{ fontSize: 10.5, fontWeight: 600, letterSpacing: 0.8, color: "#a8a29e", textTransform: "uppercase" }}>{label}</span>
    <span style={{ fontSize: 24, fontWeight: 700, letterSpacing: -0.5, color, marginTop: 2 }}>{value}</span>
  </div>
);

const EmptyMini = ({ label, hint }) => (
  <div style={{ padding: "40px 18px", textAlign: "center", border: "1px dashed #e7e5e4", borderRadius: 8, background: "#fff" }}>
    <div style={{ fontSize: 12.5, fontWeight: 600, color: "#57534e" }}>{label}</div>
    {hint && <div style={{ fontSize: 11.5, color: "#a8a29e", marginTop: 6, lineHeight: 1.5 }}>{hint}</div>}
  </div>
);

const fmtT = (iso) => {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  } catch (_) { return "—"; }
};

// ───────────────────────────────────────────────────────────────
// Estilos
// ───────────────────────────────────────────────────────────────
const QS = {
  root: { flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minHeight: 0, background: "#fafaf9" },
  stats: { display: "flex", alignItems: "center", padding: "14px 24px", background: "#fff", borderBottom: "1px solid #e7e5e4", flexShrink: 0 },
  refreshBtn: { display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", background: "#fafaf9", border: "1px solid #e7e5e4", borderRadius: 8, fontSize: 12, color: "#57534e", cursor: "pointer", fontFamily: "inherit", marginRight: 6 },
  clearBtn: { display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", background: "#fff", border: "1px solid #fecaca", borderRadius: 8, fontSize: 12, color: "#dc2626", cursor: "pointer", fontFamily: "inherit" },

  grid: { flex: 1, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 0, overflow: "hidden", minHeight: 0 },
  col: { display: "flex", flexDirection: "column", borderRight: "1px solid #e7e5e4", overflow: "hidden", minHeight: 0, background: "#fafaf9" },
  colHead: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 18px", background: "#fafaf9", borderBottom: "1px solid #e7e5e4", flexShrink: 0 },
  colTitle: { fontSize: 11, fontWeight: 700, letterSpacing: 1.2, color: "#1c1917", textTransform: "uppercase" },
  colCount: { fontSize: 11, fontWeight: 600, color: "#a8a29e", padding: "2px 9px", background: "#fff", borderRadius: 999, border: "1px solid #e7e5e4" },
  list: { flex: 1, overflowY: "auto", padding: "12px 12px 24px", display: "flex", flexDirection: "column", gap: 8 },

  card: { background: "#fff", border: "1px solid #e7e5e4", borderRadius: 8, padding: 12, position: "relative", transition: "all 160ms" },
  cardHead: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  cardLeft: { display: "flex", alignItems: "center", gap: 8, minWidth: 0 },
  cardPos: { fontSize: 11, fontWeight: 700, color: "#a8a29e", fontFamily: "ui-monospace, monospace" },
  cardTicket: { fontSize: 11, fontWeight: 600, color: "#1c1917", fontFamily: "ui-monospace, monospace", letterSpacing: 0.5 },
  cardRight: { display: "flex", gap: 4 },
  iconBtn: { background: "transparent", border: "none", padding: 4, color: "#a8a29e", cursor: "pointer", display: "flex", alignItems: "center", borderRadius: 4 },
  cardBody: { display: "flex", flexDirection: "column", gap: 6 },
  cardTitleRow: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  cardDestino: { fontSize: 14, fontWeight: 700, letterSpacing: -0.3, color: "#1c1917", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  tipoBadge: { fontSize: 11, padding: "2px 7px", borderRadius: 999, fontWeight: 700 },
  cardMeta: { display: "flex", gap: 12, alignItems: "center" },
  cardTractora: { fontSize: 11, fontFamily: "ui-monospace, monospace", color: "#78716c", fontWeight: 600 },
  meta: { display: "flex", flexDirection: "column", lineHeight: 1.1 },
  metaLbl: { fontSize: 9, fontWeight: 700, letterSpacing: 1, color: "#a8a29e", textTransform: "uppercase" },
  metaVal: { fontSize: 12, fontWeight: 700, color: "#1c1917", fontFamily: "ui-monospace, monospace", marginTop: 2 },

  assignedBy: { display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#0c4a6e", background: "#dbeafe", padding: "2px 8px", borderRadius: 999, fontWeight: 600 },

  reassignMenu: { marginTop: 10, paddingTop: 10, borderTop: "1px solid #f4f4f3", display: "flex", flexDirection: "column", gap: 4 },
  reassignHint: { fontSize: 10, fontWeight: 700, letterSpacing: 0.8, color: "#a8a29e", textTransform: "uppercase", marginBottom: 4 },
  reassignOpt: { display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", background: "#fafaf9", border: "1px solid #e7e5e4", borderRadius: 6, fontSize: 12, color: "#1c1917", cursor: "pointer", fontFamily: "inherit", textAlign: "left" },
  reassignDot: { width: 7, height: 7, borderRadius: "50%", background: "#22c55e" },
  reassignMuelle: { fontSize: 10, color: "#a8a29e", fontFamily: "ui-monospace, monospace" },

  loaderCard: { background: "#fff", border: "1px solid #e7e5e4", borderRadius: 8, padding: 12 },
  loaderCurrent: { fontSize: 11, color: "#0c4a6e", background: "#dbeafe", padding: "5px 8px", borderRadius: 4, marginTop: 8, fontWeight: 600, fontFamily: "ui-monospace, monospace", letterSpacing: 0.2 },

  doneCard: { background: "#fff", border: "1px solid #e7e5e4", borderRadius: 6, padding: "8px 12px" },
};

window.QueuePanel = QueuePanel;
