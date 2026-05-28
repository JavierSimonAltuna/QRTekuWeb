// Panel Cola Bleecker — vista supervisor
// Muestra: cargas en cola, asignaciones activas, cargadores, histórico.
// Permite reasignar, marcar urgente, eliminar de cola.

const { useState, useEffect, useCallback } = React;

const QueuePanel = ({ pushToast }) => {
  const [snap, setSnap] = useState({
    queued: [], queued_refr: [],
    assigned: [], assigned_refr: [],
    done: [],
    pending_merch: [], pending_merch_refr: [],
    loaders: [],
    counts: { queued: 0, queued_refr: 0, assigned: 0, assigned_refr: 0, done: 0, pending_merch: 0, pending_merch_refr: 0, blocked: 0 }
  });
  const [activeTab, setActiveTab] = useState("cola");
  const [reassignFor, setReassignFor] = useState(null);
  const [helperMenuFor, setHelperMenuFor] = useState(null);
  const [search, setSearch] = useState("");
  const [showOdbc, setShowOdbc] = useState(false);
  const [odbcLog, setOdbcLog] = useState([]);
  const [loaderForm, setLoaderForm] = useState(null); // null | {id,name,pin,queue_type,isNew}

  const refresh = useCallback(async () => {
    try {
      const r = await window.api.call("queue_snapshot");
      if (r.ok) setSnap(r);
    } catch (e) { /* silencio */ }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
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

  const handleForceQueued = async (id) => {
    const r = await window.api.call("queue_force_queued", id);
    if (r.ok) { pushToast("Priorizada a la cola", "success"); refresh(); setActiveTab("cola"); }
    else pushToast(r.error || "Error", "error");
  };

  const handleToggleBlock = async (id, blocked) => {
    const method = blocked ? "queue_unblock" : "queue_block";
    const r = await window.api.call(method, id);
    if (r.ok) { pushToast(blocked ? "Carga desbloqueada" : "Carga bloqueada", "info"); refresh(); }
    else pushToast(r.error || "Error", "error");
  };

  const handleAssignHelper = async (id, loaderId) => {
    const r = await window.api.call("queue_assign_helper", id, loaderId);
    if (r.ok) { pushToast("Ayudante asignado", "success"); refresh(); setHelperMenuFor(null); }
    else pushToast(r.error || "Error", "error");
  };

  const handleRemoveHelper = async (id) => {
    const r = await window.api.call("queue_remove_helper", id);
    if (r.ok) { pushToast("Ayudante eliminado", "info"); refresh(); }
    else pushToast(r.error || "Error", "error");
  };

  const handleSetComment = async (id, text) => {
    const r = await window.api.call("queue_set_comment", id, text);
    if (r.ok) refresh();
    else pushToast(r.error || "Error al guardar comentario", "error");
  };

  const handleSendToPendingMerch = async (id) => {
    const r = await window.api.call("queue_send_to_pending_merch", id);
    if (r.ok) { pushToast("Movido a Sin mercancía", "info"); refresh(); setActiveTab("sinmerch"); }
    else pushToast(r.error || "Error", "error");
  };

  const handleOpenOdbc = async () => {
    const r = await window.api.call("get_odbc_diagnostics");
    if (r.ok) setOdbcLog(r.log || []);
    setShowOdbc(true);
  };

  const openNewLoader = (defaultType = "ambiente") =>
    setLoaderForm({ id: "", name: "", pin: "", queue_type: defaultType, isNew: true });

  const openEditLoader = (l) =>
    setLoaderForm({ id: l.id, name: l.name, pin: l.pin, queue_type: l.queue_type || "ambiente", isNew: false });

  const handleSaveLoader = async () => {
    if (!loaderForm) return;
    const r = await window.api.call("loader_upsert", loaderForm.id, loaderForm.name, loaderForm.pin, loaderForm.queue_type);
    if (r.ok) {
      pushToast(loaderForm.isNew ? "Cargador añadido" : "Cargador actualizado", "success");
      setLoaderForm(null); refresh();
    } else pushToast(r.error || "Error", "error");
  };

  const handleRemoveLoader = async (loaderId) => {
    if (!confirm(`¿Eliminar cargador ${loaderId}?`)) return;
    const r = await window.api.call("loader_remove", loaderId);
    if (r.ok) { pushToast("Cargador eliminado", "info"); refresh(); }
    else pushToast(r.error || "Error", "error");
  };

  const handleRefreshNumsup = async (item_id, ruta_carga) => {
    const r = await window.api.call("queue_update_ruta", item_id, String(ruta_carga));
    if (r.ok) {
      pushToast(`Ruta ${ruta_carga}: ${r.numsup_count} pales supervisados`, r.numsup_count > 25 ? "success" : "info");
      refresh();
    } else pushToast(r.error || "Error al consultar ruta", "error");
  };

  const handleResetDone = async () => {
    if (!confirm("¿Limpiar el histórico de completadas?")) return;
    const r = await window.api.call("queue_reset_done");
    if (r.ok) { pushToast("Histórico limpiado", "success"); refresh(); }
  };

  const handleResetQueued = async () => {
    if (!confirm("¿Vaciar la cola de pendientes?\nRecarga el Excel para volver a encolarlos.")) return;
    const r = await window.api.call("queue_reset_queued");
    if (r.ok) { pushToast(`Cola vaciada (${r.removed} eliminadas)`, "success"); refresh(); }
    else pushToast(r.error || "Error", "error");
  };

  const matchesSearch = (item) => {
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      (item.destino || "").toLowerCase().includes(q) ||
      (item.tractora || "").toLowerCase().includes(q) ||
      (item.remolque || "").toLowerCase().includes(q) ||
      (item.muelle || "").toLowerCase().includes(q) ||
      (item.cod_centro || "").toLowerCase().includes(q) ||
      (item.agencia || "").toLowerCase().includes(q) ||
      (item.id || "").toLowerCase().includes(q)
    );
  };

  const loaderById = (id) => snap.loaders.find((l) => l.id === id);
  const pendingMerch      = snap.pending_merch      || [];
  const pendingMerchRefri = snap.pending_merch_refr || [];
  const ambLoaders   = snap.loaders.filter(l => (l.queue_type || "ambiente") === "ambiente");
  const refriLoaders = snap.loaders.filter(l => (l.queue_type || "ambiente") === "refrigerado");
  const isRefriTab = activeTab === "cola_refri" || activeTab === "sinmerch_refri";

  const makePendingGroups = (items) => {
    const map = {};
    for (const it of items) {
      const k = it.viaje_n || it.id;
      if (!map[k]) map[k] = [];
      map[k].push(it);
    }
    return Object.values(map);
  };
  const pendingGroups      = makePendingGroups(pendingMerch);
  const pendingGroupsRefri = makePendingGroups(pendingMerchRefri);

  return (
    <div style={QS.root}>
      {/* ─── Header stats + tabs ─── */}
      <div style={QS.stats}>
        <StatBig label="En cola"     value={isRefriTab ? (snap.counts.queued_refr||0)       : snap.counts.queued}   color="#1c1917" />
        <StatBig label="Asignadas"   value={isRefriTab ? (snap.counts.assigned_refr||0)     : snap.counts.assigned} color="#0ea5e9" />
        <StatBig label="Completadas" value={snap.counts.done} color="#15803d" />
        {(isRefriTab ? (snap.counts.pending_merch_refr||0) : (snap.counts.pending_merch||0)) > 0 && (
          <StatBig label="Sin mercancía" value={isRefriTab ? (snap.counts.pending_merch_refr||0) : snap.counts.pending_merch} color="#d97706" />
        )}
        <div style={{ flex: 1 }} />
        <button onClick={refresh} style={QS.refreshBtn} title="Refrescar">
          <IconRefresh size={14} />
          Refrescar
        </button>
        <button onClick={handleOpenOdbc} style={QS.odbcBtn} title="Diagnóstico ODBC">
          ODBC
        </button>
        {(snap.counts.queued + (snap.counts.pending_merch || 0)) > 0 && (
          <button onClick={handleResetQueued} style={QS.clearBtn} title="Vaciar cola de pendientes">
            <IconTrash size={13} />
            Vaciar cola
          </button>
        )}
        {snap.counts.done > 0 && (
          <button onClick={handleResetDone} style={{ ...QS.clearBtn, marginLeft: 4 }} title="Limpiar histórico">
            <IconTrash size={13} />
            Limpiar histórico
          </button>
        )}
      </div>

      {/* ─── Tabs ─── */}
      <div style={QS.tabBar}>
        <button
          onClick={() => setActiveTab("cola")}
          style={{ ...QS.tab, ...(activeTab === "cola" ? QS.tabActive : {}) }}
        >
          ☼ Cola ambiente
          {snap.counts.queued > 0 && (
            <span style={QS.tabBadge}>{snap.counts.queued}</span>
          )}
        </button>
        <button
          onClick={() => setActiveTab("sinmerch")}
          style={{ ...QS.tab, ...(activeTab === "sinmerch" ? QS.tabActive : {}), ...(pendingGroups.length > 0 ? { color: "#d97706" } : {}) }}
        >
          ⚠ Sin merch AMB
          {pendingGroups.length > 0 && (
            <span style={{ ...QS.tabBadge, background: "#fef3c7", color: "#d97706" }}>
              {pendingMerch.length}
            </span>
          )}
        </button>
        <button
          onClick={() => setActiveTab("cola_refri")}
          style={{ ...QS.tab, ...(activeTab === "cola_refri" ? { ...QS.tabActive, borderBottomColor: "#0ea5e9", color: "#0c4a6e" } : {}) }}
        >
          ❄ Cola refri
          {(snap.counts.queued_refr || 0) > 0 && (
            <span style={{ ...QS.tabBadge, background: "#dbeafe", color: "#0c4a6e" }}>{snap.counts.queued_refr}</span>
          )}
        </button>
        <button
          onClick={() => setActiveTab("sinmerch_refri")}
          style={{ ...QS.tab, ...(activeTab === "sinmerch_refri" ? { ...QS.tabActive, borderBottomColor: "#0ea5e9", color: "#0c4a6e" } : {}), ...(pendingGroupsRefri.length > 0 ? { color: "#d97706" } : {}) }}
        >
          ❄ Sin merch REFRI
          {pendingGroupsRefri.length > 0 && (
            <span style={{ ...QS.tabBadge, background: "#fef3c7", color: "#d97706" }}>{pendingMerchRefri.length}</span>
          )}
        </button>
      </div>

      {/* ─── Buscador (en tabs de cola) ─── */}
      {(activeTab === "cola" || activeTab === "cola_refri") && (
        <div style={QS.searchBar}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#a8a29e" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
          </svg>
          <input
            type="text"
            placeholder="Buscar por destino, matrícula, muelle, cliente…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={QS.searchInput}
          />
          {search && (
            <button onClick={() => setSearch("")} style={QS.searchClear}>✕</button>
          )}
        </div>
      )}

      {/* ─── Tab: Cola de cargas ─── */}
      {activeTab === "cola" && (
        <div style={QS.grid}>
          {/* ── Cola ── */}
          <section style={QS.col}>
            <div style={QS.colHead}>
              <span style={QS.colTitle}>Cola</span>
              <span style={QS.colCount}>{(snap.queued||[]).length}</span>
            </div>
            <div style={QS.list}>
              {(snap.queued||[]).filter(matchesSearch).length === 0 ? (
                <EmptyMini
                  label={search ? "Sin resultados" : "Sin cargas en cola"}
                  hint={search ? `No coincide ningún elemento con "${search}"` : "Se añaden automáticamente cuando se detecta la hora de acule"}
                />
              ) : (snap.queued||[]).filter(matchesSearch).map((it, i) => (
                <QueueCard
                  key={it.id}
                  item={it}
                  position={i + 1}
                  loaders={snap.loaders}
                  onToggleUrgent={() => handleUrgent(it.id, it.urgente)}
                  onToggleBlock={() => handleToggleBlock(it.id, it.blocked)}
                  onRemove={() => handleRemove(it.id)}
                  onReassign={(loaderId) => handleReassign(it.id, loaderId)}
                  showReassignMenu={reassignFor === it.id}
                  onOpenReassign={() => setReassignFor(reassignFor === it.id ? null : it.id)}
                  onSendToPendingMerch={() => handleSendToPendingMerch(it.id)}
                  onSetComment={(text) => handleSetComment(it.id, text)}
                />
              ))}
            </div>
          </section>

          {/* ── Asignadas ── */}
          <section style={QS.col}>
            <div style={QS.colHead}>
              <span style={QS.colTitle}>En curso</span>
              <span style={QS.colCount}>{(snap.assigned||[]).length}</span>
            </div>
            <div style={QS.list}>
              {(snap.assigned||[]).filter(matchesSearch).length === 0 ? (
                <EmptyMini
                  label={search ? "Sin resultados" : "Ninguna carga en curso"}
                  hint={search ? `No coincide ningún elemento con "${search}"` : "Cuando un cargador pida una carga aparecerá aquí"}
                />
              ) : (snap.assigned||[]).filter(matchesSearch).map((it) => (
                <AssignedCard
                  key={it.id}
                  item={it}
                  loader={loaderById(it.assigned_to)}
                  helper={it.helper_id ? loaderById(it.helper_id) : null}
                  loaders={snap.loaders}
                  onReassign={(loaderId) => handleReassign(it.id, loaderId)}
                  onRemove={() => handleRemove(it.id)}
                  showReassignMenu={reassignFor === it.id}
                  onOpenReassign={() => setReassignFor(reassignFor === it.id ? null : it.id)}
                  onAssignHelper={(loaderId) => handleAssignHelper(it.id, loaderId)}
                  onRemoveHelper={() => handleRemoveHelper(it.id)}
                  showHelperMenu={helperMenuFor === it.id}
                  onOpenHelperMenu={() => setHelperMenuFor(helperMenuFor === it.id ? null : it.id)}
                />
              ))}
            </div>
          </section>

          {/* ── Cargadores ── */}
          <section style={QS.col}>
            <div style={QS.colHead}>
              <span style={QS.colTitle}>Cargadores</span>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={QS.colCount}>{ambLoaders.filter((l) => l.active).length}</span>
                <button onClick={() => openNewLoader("ambiente")} style={QS.addLoaderBtn} title="Añadir cargador ambiente">+ Cargador</button>
              </div>
            </div>
            <div style={QS.list}>
              {ambLoaders.map((l) => {
                const current = (snap.assigned||[]).find((a) => a.assigned_to === l.id || a.helper_id === l.id);
                return (
                  <LoaderCard key={l.id} loader={l} current={current}
                    onEdit={() => openEditLoader(l)}
                    onRemove={() => handleRemoveLoader(l.id)}
                  />
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
      )}

      {/* ─── Tab: Sin mercancía suficiente ─── */}
      {activeTab === "sinmerch" && (
        <div style={QS.sinMerchRoot}>
          {pendingGroups.length === 0 ? (
            <EmptyMini
              label="Sin camiones en espera de mercancía"
              hint="Todos los camiones aculados tienen suficiente mercancía supervisada (>25 pales)"
            />
          ) : pendingGroups.map((group) => {
            const isCombo = group.length > 1 || group[0].is_combined;
            const combinedCount = group[0].combined_count ?? group.reduce((s, it) => s + (it.numsup_count || 0), 0);
            const nearDep = group.some((it) => {
              const hs = it.hora_salida || "";
              if (!hs.includes(":")) return false;
              const [h, m] = hs.split(":").map(Number);
              const now = new Date();
              const dep = new Date(now);
              dep.setHours(h, m, 0, 0);
              // Si la hora ya pasó más de 5 min → es del día siguiente
              if ((dep - now) < -5 * 60000) dep.setDate(dep.getDate() + 1);
              const diffMin = (dep - now) / 60000;
              return diffMin >= 0 && diffMin <= 45;
            });
            return (
              <div key={group[0].viaje_n || group[0].id} style={{
                ...QS.pendGroup,
                borderLeft: nearDep ? "3px solid #d97706" : "3px solid #e7e5e4",
              }}>
                {/* Cabecera del grupo */}
                <div style={QS.pendGroupHead}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    {isCombo && (
                      <span style={QS.comboBadge}>COMBINADO</span>
                    )}
                    <span style={{ fontSize: 11, fontFamily: "ui-monospace, monospace", color: "#57534e" }}>
                      Nº {group[0].viaje_n}
                    </span>
                    {group[0].tipo_carga && (
                      <span style={{
                        fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 999,
                        background: group[0].tipo_carga === "REFRIGERADO" ? "#dbeafe" : "#ffedd5",
                        color: group[0].tipo_carga === "REFRIGERADO" ? "#0c4a6e" : "#9a3412",
                      }}>
                        {group[0].tipo_carga === "REFRIGERADO" ? "❄" : "☼"} {group[0].tipo_carga}
                      </span>
                    )}
                    {nearDep && (
                      <span style={QS.urgentBadge}>⚡ &lt;45 min</span>
                    )}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={QS.pendCount}>
                      {combinedCount} / {group[0].merch_threshold ?? 25} pales
                    </span>
                    <button
                      onClick={() => { if (confirm("¿Priorizar este viaje a la cola aunque falte mercancía?")) handleForceQueued(group[0].id); }}
                      style={QS.prioritizeBtn}
                      title="Forzar entrada a cola como urgente"
                    >
                      ↑ Priorizar
                    </button>
                  </div>
                </div>

                {/* Tarjetas de cada centro */}
                {group.map((it) => (
                  <PendingMerchCard
                    key={it.id}
                    item={it}
                    onRemove={() => handleRemove(it.id)}
                    onRefreshNumsup={(ruta) => handleRefreshNumsup(it.id, ruta)}
                  />
                ))}
              </div>
            );
          })}
        </div>
      )}

      {/* ─── Tab: Cola refrigerado ─── */}
      {activeTab === "cola_refri" && (
        <div style={QS.grid}>
          {/* ── Cola refri ── */}
          <section style={QS.col}>
            <div style={QS.colHead}>
              <span style={QS.colTitle}>❄ Cola</span>
              <span style={QS.colCount}>{(snap.queued_refr||[]).length}</span>
            </div>
            <div style={QS.list}>
              {(snap.queued_refr||[]).filter(matchesSearch).length === 0 ? (
                <EmptyMini
                  label={search ? "Sin resultados" : "Sin cargas refrigeradas en cola"}
                  hint={search ? `No coincide con "${search}"` : "Se añaden al acularse un camión refrigerado sin marca A"}
                />
              ) : (snap.queued_refr||[]).filter(matchesSearch).map((it, i) => (
                <QueueCard
                  key={it.id}
                  item={it}
                  position={i + 1}
                  loaders={snap.loaders}
                  onToggleUrgent={() => handleUrgent(it.id, it.urgente)}
                  onToggleBlock={() => handleToggleBlock(it.id, it.blocked)}
                  onRemove={() => handleRemove(it.id)}
                  onReassign={(loaderId) => handleReassign(it.id, loaderId)}
                  showReassignMenu={reassignFor === it.id}
                  onOpenReassign={() => setReassignFor(reassignFor === it.id ? null : it.id)}
                  onSendToPendingMerch={() => handleSendToPendingMerch(it.id)}
                  onSetComment={(text) => handleSetComment(it.id, text)}
                />
              ))}
            </div>
          </section>

          {/* ── En curso refri ── */}
          <section style={QS.col}>
            <div style={QS.colHead}>
              <span style={QS.colTitle}>❄ En curso</span>
              <span style={QS.colCount}>{(snap.assigned_refr||[]).length}</span>
            </div>
            <div style={QS.list}>
              {(snap.assigned_refr||[]).filter(matchesSearch).length === 0 ? (
                <EmptyMini
                  label={search ? "Sin resultados" : "Ninguna carga refrigerada en curso"}
                  hint={search ? `No coincide con "${search}"` : "Cuando un cargador refri pida una carga aparecerá aquí"}
                />
              ) : (snap.assigned_refr||[]).filter(matchesSearch).map((it) => (
                <AssignedCard
                  key={it.id}
                  item={it}
                  loader={loaderById(it.assigned_to)}
                  helper={it.helper_id ? loaderById(it.helper_id) : null}
                  loaders={snap.loaders}
                  onReassign={(loaderId) => handleReassign(it.id, loaderId)}
                  onRemove={() => handleRemove(it.id)}
                  showReassignMenu={reassignFor === it.id}
                  onOpenReassign={() => setReassignFor(reassignFor === it.id ? null : it.id)}
                  onAssignHelper={(loaderId) => handleAssignHelper(it.id, loaderId)}
                  onRemoveHelper={() => handleRemoveHelper(it.id)}
                  showHelperMenu={helperMenuFor === it.id}
                  onOpenHelperMenu={() => setHelperMenuFor(helperMenuFor === it.id ? null : it.id)}
                />
              ))}
            </div>
          </section>

          {/* ── Cargadores refri ── */}
          <section style={QS.col}>
            <div style={QS.colHead}>
              <span style={QS.colTitle}>❄ Cargadores refri</span>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={QS.colCount}>{refriLoaders.filter(l => l.active).length}</span>
                <button onClick={() => openNewLoader("refrigerado")} style={{ ...QS.addLoaderBtn, background: "#dbeafe", color: "#0c4a6e", borderColor: "#bfdbfe" }} title="Añadir cargador refrigerado">+ Cargador</button>
              </div>
            </div>
            <div style={QS.list}>
              {refriLoaders.length === 0 ? (
                <EmptyMini label="Sin cargadores refri" hint='Pulsa "+ Cargador" para añadir un cargador de refrigerado' />
              ) : refriLoaders.map((l) => {
                const current = (snap.assigned_refr||[]).find(a => a.assigned_to === l.id || a.helper_id === l.id);
                return <LoaderCard key={l.id} loader={l} current={current}
                  onEdit={() => openEditLoader(l)}
                  onRemove={() => handleRemoveLoader(l.id)}
                />;
              })}
            </div>
            {snap.done.filter(it => it.queue_type === "refrigerado").length > 0 && (
              <>
                <div style={{ ...QS.colHead, marginTop: 18 }}>
                  <span style={QS.colTitle}>Últimas completadas</span>
                </div>
                <div style={QS.list}>
                  {[...snap.done].reverse().filter(it => it.queue_type === "refrigerado").slice(0, 10).map(it => (
                    <DoneCard key={it.id} item={it} loader={loaderById(it.assigned_to)} />
                  ))}
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {/* ─── Tab: Sin mercancía refrigerado ─── */}
      {activeTab === "sinmerch_refri" && (
        <div style={QS.sinMerchRoot}>
          {pendingGroupsRefri.length === 0 ? (
            <EmptyMini
              label="Sin camiones refrigerados en espera de mercancía"
              hint="Todos los camiones refrigerados aculados tienen suficiente mercancía supervisada"
            />
          ) : pendingGroupsRefri.map((group) => {
            const isCombo = group.length > 1 || group[0].is_combined;
            const combinedCount = group[0].combined_count ?? group.reduce((s, it) => s + (it.numsup_count || 0), 0);
            const nearDep = group.some((it) => {
              const hs = it.hora_salida || "";
              if (!hs.includes(":")) return false;
              const [h, m] = hs.split(":").map(Number);
              const now = new Date(); const dep = new Date(now);
              dep.setHours(h, m, 0, 0);
              if ((dep - now) < -5 * 60000) dep.setDate(dep.getDate() + 1);
              return (dep - now) / 60000 >= 0 && (dep - now) / 60000 <= 45;
            });
            return (
              <div key={group[0].viaje_n || group[0].id} style={{ ...QS.pendGroup, borderLeft: nearDep ? "3px solid #d97706" : "3px solid #dbeafe" }}>
                <div style={QS.pendGroupHead}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    {isCombo && <span style={QS.comboBadge}>COMBINADO</span>}
                    <span style={{ fontSize: 11, fontFamily: "ui-monospace, monospace", color: "#57534e" }}>Nº {group[0].viaje_n}</span>
                    <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 6px", borderRadius: 999, background: "#dbeafe", color: "#0c4a6e" }}>❄ REFRIGERADO</span>
                    {nearDep && <span style={QS.urgentBadge}>⚡ &lt;45 min</span>}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={QS.pendCount}>{combinedCount} / {group[0].merch_threshold ?? 25} pales</span>
                    <button onClick={() => { if (confirm("¿Priorizar este viaje a la cola aunque falte mercancía?")) handleForceQueued(group[0].id); }} style={QS.prioritizeBtn}>↑ Priorizar</button>
                  </div>
                </div>
                {group.map((it) => (
                  <PendingMerchCard key={it.id} item={it} onRemove={() => handleRemove(it.id)} onRefreshNumsup={(ruta) => handleRefreshNumsup(it.id, ruta)} />
                ))}
              </div>
            );
          })}
        </div>
      )}

      {/* ─── Modal diagnóstico ODBC ─── */}
      {showOdbc && (
        <OdbcModal log={odbcLog} onClose={() => setShowOdbc(false)} />
      )}

      {/* ─── Modal gestión de cargadores ─── */}
      {loaderForm && (
        <LoaderFormModal
          form={loaderForm}
          onChange={(f) => setLoaderForm(f)}
          onSave={handleSaveLoader}
          onClose={() => setLoaderForm(null)}
        />
      )}
    </div>
  );
};

// ───────────────────────────────────────────────────────────────
// Modal ODBC
// ───────────────────────────────────────────────────────────────
const STATUS_COLOR = {
  OK:        { bg: "#dcfce7", text: "#15803d" },
  CACHE:     { bg: "#f4f4f3", text: "#78716c" },
  NOT_FOUND: { bg: "#fef3c7", text: "#b45309" },
  ERROR:     { bg: "#fee2e2", text: "#b91c1c" },
};

const OdbcModal = ({ log, onClose }) => (
  <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 9000, display: "flex", alignItems: "center", justifyContent: "center" }}
    onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div style={{ background: "#fff", borderRadius: 12, width: 760, maxHeight: "80vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.25)", overflow: "hidden" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: "1px solid #e7e5e4" }}>
        <div>
          <span style={{ fontSize: 14, fontWeight: 700, color: "#1c1917" }}>Diagnóstico ODBC</span>
          <span style={{ fontSize: 11, color: "#a8a29e", marginLeft: 10 }}>{log.length} operaciones recientes</span>
        </div>
        <button onClick={onClose} style={{ background: "transparent", border: "none", fontSize: 18, color: "#a8a29e", cursor: "pointer", lineHeight: 1 }}>✕</button>
      </div>
      {/* Leyenda */}
      <div style={{ display: "flex", gap: 12, padding: "8px 20px", borderBottom: "1px solid #f4f4f3", flexShrink: 0 }}>
        {Object.entries(STATUS_COLOR).map(([k, v]) => (
          <span key={k} style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: v.bg, color: v.text }}>{k}</span>
        ))}
      </div>
      {/* Log */}
      <div style={{ overflowY: "auto", flex: 1 }}>
        {log.length === 0 ? (
          <div style={{ padding: "40px 20px", textAlign: "center", color: "#a8a29e", fontSize: 12 }}>
            Sin operaciones registradas aún. Carga el Excel para iniciar consultas ODBC.
          </div>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
            <thead>
              <tr style={{ position: "sticky", top: 0, background: "#fafaf9" }}>
                {["Hora", "Operación", "Clave", "Estado", "Valor", "Error"].map((h) => (
                  <th key={h} style={{ padding: "6px 12px", textAlign: "left", fontWeight: 700, fontSize: 10, letterSpacing: 0.8, color: "#a8a29e", textTransform: "uppercase", borderBottom: "1px solid #e7e5e4", whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {log.map((entry, i) => {
                const sc = STATUS_COLOR[entry.status] || STATUS_COLOR.CACHE;
                return (
                  <tr key={i} style={{ borderBottom: "1px solid #f4f4f3" }}>
                    <td style={{ padding: "5px 12px", fontFamily: "ui-monospace, monospace", color: "#78716c", whiteSpace: "nowrap" }}>{entry.ts}</td>
                    <td style={{ padding: "5px 12px", fontWeight: 600, color: "#1c1917" }}>{entry.op}</td>
                    <td style={{ padding: "5px 12px", fontFamily: "ui-monospace, monospace", color: "#57534e" }}>{entry.key}</td>
                    <td style={{ padding: "5px 12px" }}>
                      <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 7px", borderRadius: 999, background: sc.bg, color: sc.text }}>{entry.status}</span>
                    </td>
                    <td style={{ padding: "5px 12px", fontFamily: "ui-monospace, monospace", color: "#1c1917", fontWeight: 600 }}>{entry.value}</td>
                    <td style={{ padding: "5px 12px", color: "#b91c1c", fontFamily: "ui-monospace, monospace", fontSize: 10.5, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={entry.error}>{entry.error}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  </div>
);

// ───────────────────────────────────────────────────────────────
// Modal gestión de cargadores
// ───────────────────────────────────────────────────────────────
const LoaderFormModal = ({ form, onChange, onSave, onClose }) => {
  const set = (k, v) => onChange({ ...form, [k]: v });
  const isRefri = form.queue_type === "refrigerado";
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.45)", zIndex: 9000, display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background: "#fff", borderRadius: 12, width: 400, boxShadow: "0 20px 60px rgba(0,0,0,0.25)", overflow: "hidden" }}>
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 20px", borderBottom: "1px solid #e7e5e4" }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: "#1c1917" }}>
            {form.isNew ? "Nuevo cargador" : `Editar ${form.id}`}
          </span>
          <button onClick={onClose} style={{ background: "transparent", border: "none", fontSize: 18, color: "#a8a29e", cursor: "pointer" }}>✕</button>
        </div>
        {/* Formulario */}
        <div style={{ padding: "20px", display: "flex", flexDirection: "column", gap: 14 }}>
          {/* Tipo ☼/❄ */}
          <div>
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, color: "#a8a29e", textTransform: "uppercase", marginBottom: 8 }}>Tipo de cola</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                onClick={() => set("queue_type", "ambiente")}
                style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: `2px solid ${!isRefri ? "#f97316" : "#e7e5e4"}`, background: !isRefri ? "#fff7ed" : "#fafaf9", color: !isRefri ? "#9a3412" : "#78716c", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}
              >☼ AMBIENTE</button>
              <button
                onClick={() => set("queue_type", "refrigerado")}
                style={{ flex: 1, padding: "10px 0", borderRadius: 8, border: `2px solid ${isRefri ? "#0ea5e9" : "#e7e5e4"}`, background: isRefri ? "#dbeafe" : "#fafaf9", color: isRefri ? "#0c4a6e" : "#78716c", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}
              >❄ REFRIGERADO</button>
            </div>
          </div>
          {/* ID */}
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, color: "#a8a29e", textTransform: "uppercase" }}>ID</label>
            <input
              type="text"
              value={form.id}
              onChange={(e) => set("id", e.target.value.toUpperCase())}
              placeholder="L01, R01…"
              disabled={!form.isNew}
              style={{ display: "block", width: "100%", marginTop: 5, padding: "8px 10px", border: "1px solid #e7e5e4", borderRadius: 6, fontSize: 13, fontFamily: "inherit", color: "#1c1917", background: form.isNew ? "#fff" : "#fafaf9", boxSizing: "border-box" }}
            />
          </div>
          {/* Nombre */}
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, color: "#a8a29e", textTransform: "uppercase" }}>Nombre</label>
            <input
              type="text"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              placeholder="Juan García"
              style={{ display: "block", width: "100%", marginTop: 5, padding: "8px 10px", border: "1px solid #e7e5e4", borderRadius: 6, fontSize: 13, fontFamily: "inherit", color: "#1c1917", background: "#fff", boxSizing: "border-box" }}
            />
          </div>
          {/* PIN */}
          <div>
            <label style={{ fontSize: 11, fontWeight: 700, letterSpacing: 0.8, color: "#a8a29e", textTransform: "uppercase" }}>PIN</label>
            <input
              type="text"
              value={form.pin}
              onChange={(e) => set("pin", e.target.value)}
              placeholder="1234"
              maxLength={8}
              style={{ display: "block", width: "100%", marginTop: 5, padding: "8px 10px", border: "1px solid #e7e5e4", borderRadius: 6, fontSize: 13, fontFamily: "ui-monospace, monospace", color: "#1c1917", background: "#fff", boxSizing: "border-box" }}
            />
          </div>
          {/* Guardar */}
          <button
            onClick={onSave}
            disabled={!form.id || !form.name || !form.pin}
            style={{ padding: "10px 0", borderRadius: 8, background: !form.id || !form.name || !form.pin ? "#e7e5e4" : (isRefri ? "#0ea5e9" : "#f97316"), color: !form.id || !form.name || !form.pin ? "#a8a29e" : "#fff", border: "none", fontSize: 13, fontWeight: 700, cursor: !form.id || !form.name || !form.pin ? "not-allowed" : "pointer", fontFamily: "inherit" }}
          >
            {form.isNew ? "Añadir cargador" : "Guardar cambios"}
          </button>
        </div>
      </div>
    </div>
  );
};

// ───────────────────────────────────────────────────────────────
// Tarjetas
// ───────────────────────────────────────────────────────────────

// Badge de viaje combinado para la vista de cola y cargador
const ComboBadge = () => (
  <span style={{
    fontSize: 9, fontWeight: 700, letterSpacing: 0.8,
    background: "#ede9fe", color: "#6d28d9",
    padding: "2px 6px", borderRadius: 999, textTransform: "uppercase",
    whiteSpace: "nowrap",
  }}>
    COMBINADO
  </span>
);

const QueueCard = ({ item, position, loaders, onToggleUrgent, onToggleBlock, onRemove, onReassign, showReassignMenu, onOpenReassign, onSendToPendingMerch, onSetComment }) => {
  const [showCommentInput, setShowCommentInput] = React.useState(false);
  const [commentDraft, setCommentDraft] = React.useState(item.comment || "");
  const saveComment = () => { onSetComment(commentDraft.trim()); setShowCommentInput(false); };
  return (
  <div style={{
    ...QS.card,
    borderLeft: item.urgente ? "3px solid #dc2626" : item.blocked ? "3px solid #f59e0b" : "3px solid transparent",
    opacity: item.blocked ? 0.75 : 1,
  }}>
    <div style={QS.cardHead}>
      <div style={QS.cardLeft}>
        <span style={QS.cardPos}>{String(position).padStart(2, "0")}</span>
        <span style={QS.cardTicket}>{item.id}</span>
        {item.is_combined && <ComboBadge />}
        {item.blocked && (
          <span style={{ fontSize: 9, fontWeight: 700, background: "#fef3c7", color: "#d97706", padding: "2px 6px", borderRadius: 999, letterSpacing: 0.5 }}>
            🔒 BLOQUEADA
          </span>
        )}
      </div>
      <div style={QS.cardRight}>
        <button onClick={onToggleUrgent} title={item.urgente ? "Quitar urgencia" : "Marcar urgente"}
          style={{ ...QS.iconBtn, color: item.urgente ? "#dc2626" : "#a8a29e" }}>
          <IconBolt size={12} />
        </button>
        <button onClick={onToggleBlock} title={item.blocked ? "Desbloquear carga" : "Bloquear carga (no asignar automáticamente)"}
          style={{ ...QS.iconBtn, color: item.blocked ? "#d97706" : "#a8a29e", fontSize: 12 }}>
          {item.blocked ? "🔓" : "🔒"}
        </button>
        <button onClick={onOpenReassign} title="Asignar manualmente"
          style={{ ...QS.iconBtn, color: showReassignMenu ? "#1c1917" : "#a8a29e" }}>
          <IconTruck size={12} />
        </button>
        <button onClick={onSendToPendingMerch} title="Mover a Sin mercancía"
          style={{ ...QS.iconBtn, color: "#d97706", fontSize: 11, fontWeight: 700 }}>
          →⚠
        </button>
        <button onClick={() => setShowCommentInput((v) => !v)} title="Añadir nota para el cargador"
          style={{ ...QS.iconBtn, color: item.comment ? "#0ea5e9" : "#a8a29e" }}>
          💬
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
      {/* Centros del viaje combinado */}
      {item.is_combined && item.trip_destinos && item.trip_destinos.length > 1 && (
        <div style={{ fontSize: 10, color: "#6d28d9", background: "#f5f3ff", borderRadius: 4, padding: "3px 7px", fontWeight: 600 }}>
          {item.trip_destinos.join(" → ")}
        </div>
      )}
      <div style={QS.cardMeta}>
        <Meta label="Muelle" value={(item.muelle || "—").padStart(2, "0")} />
        <Meta label="Playa" value={item.playa || "—"} />
        <Meta label="Salida" value={item.hora_salida || "—"} />
        {item.cod_centro && <Meta label="Cliente" value={item.cod_centro} />}
        {(item.combined_count != null || item.numsup_count != null) && (
          <Meta
            label="Pales"
            value={`${item.combined_count ?? item.numsup_count} / 25`}
          />
        )}
      </div>
      <div style={QS.cardTractora}>{item.tractora}</div>
    </div>

    {/* Nota existente (siempre visible si hay texto) */}
    {item.comment && !showCommentInput && (
      <div style={QS.commentDisplay}>
        <span style={{ fontSize: 11, color: "#92400e" }}>📌</span>
        <span style={{ flex: 1, fontSize: 11.5, color: "#1c1917" }}>{item.comment}</span>
        <button onClick={() => setShowCommentInput(true)} style={{ fontSize: 10, color: "#0ea5e9", background: "none", border: "none", cursor: "pointer", padding: 0 }}>editar</button>
      </div>
    )}

    {/* Input de comentario */}
    {showCommentInput && (
      <div style={QS.commentInputWrap}>
        <textarea
          value={commentDraft}
          onChange={(e) => setCommentDraft(e.target.value)}
          placeholder="Nota para el cargador (informativa)…"
          rows={2}
          autoFocus
          style={QS.commentTextarea}
        />
        <div style={{ display: "flex", gap: 6, marginTop: 5 }}>
          <button onClick={saveComment} style={QS.commentSaveBtn}>Guardar</button>
          <button onClick={() => { setCommentDraft(item.comment || ""); setShowCommentInput(false); }} style={QS.commentCancelBtn}>Cancelar</button>
          {item.comment && <button onClick={() => { setCommentDraft(""); onSetComment(""); setShowCommentInput(false); }} style={{ ...QS.commentCancelBtn, color: "#dc2626" }}>Borrar</button>}
        </div>
      </div>
    )}

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
};

const AssignedCard = ({ item, loader, helper, loaders, onReassign, onRemove, showReassignMenu, onOpenReassign, onAssignHelper, onRemoveHelper, showHelperMenu, onOpenHelperMenu }) => (
  <div style={{ ...QS.card, background: "#eff6ff", borderLeft: "3px solid #0ea5e9" }}>
    <div style={QS.cardHead}>
      <div style={QS.cardLeft}>
        <span style={QS.cardTicket}>{item.id}</span>
        {item.is_combined && <ComboBadge />}
        <span style={QS.assignedBy}>
          <IconTruck size={11} />
          {loader?.id || item.assigned_to} · {loader?.name || "?"}
        </span>
        {helper && (
          <span style={{ ...QS.assignedBy, background: "#dcfce7", color: "#166534" }}>
            +{helper.id} · {helper.name}
          </span>
        )}
      </div>
      <div style={QS.cardRight}>
        <button
          onClick={onOpenHelperMenu}
          title={item.helper_id ? "Gestionar ayudante" : "Asignar segundo cargador"}
          style={{ ...QS.iconBtn, color: item.helper_id ? "#166534" : "#a8a29e", fontSize: 13 }}
        >
          👤+
        </button>
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
      {item.is_combined && item.trip_destinos && item.trip_destinos.length > 1 && (
        <div style={{ fontSize: 10, color: "#6d28d9", background: "#f5f3ff", borderRadius: 4, padding: "3px 7px", fontWeight: 600 }}>
          {item.trip_destinos.join(" → ")}
        </div>
      )}
      <div style={QS.cardMeta}>
        <Meta label="Muelle" value={(item.muelle || "—").padStart(2, "0")} />
        <Meta label="Asignada" value={fmtT(item.assigned_at)} />
      </div>
    </div>
    {showHelperMenu && (
      <div style={QS.reassignMenu}>
        <div style={QS.reassignHint}>
          {item.helper_id ? "Ayudante asignado:" : "Asignar ayudante:"}
        </div>
        {item.helper_id ? (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 6 }}>
            <span style={{ fontSize: 12, fontWeight: 700, color: "#166534" }}>
              {helper?.id || item.helper_id} · {helper?.name || "?"}
            </span>
            <span style={{ flex: 1 }} />
            <button
              onClick={onRemoveHelper}
              style={{ fontSize: 11, padding: "3px 8px", background: "#fff", border: "1px solid #fecaca", borderRadius: 4, color: "#dc2626", cursor: "pointer", fontFamily: "inherit" }}
            >
              Quitar
            </button>
          </div>
        ) : (
          loaders.filter((l) => l.active && l.id !== item.assigned_to).map((l) => (
            <button key={l.id} onClick={() => onAssignHelper(l.id)} style={QS.reassignOpt}>
              <span style={{ ...QS.reassignDot, background: "#22c55e" }} />
              <span style={{ fontWeight: 600 }}>{l.id}</span>
              <span style={{ color: "#a8a29e", marginLeft: 4 }}>· {l.name}</span>
              <span style={{ flex: 1 }} />
              <span style={QS.reassignMuelle}>M{(l.muelle_actual || "—").padStart(2, "0")}</span>
            </button>
          ))
        )}
      </div>
    )}
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

const PendingMerchCard = ({ item, onRemove, onRefreshNumsup }) => {
  const [editRuta, setEditRuta] = useState(false);
  const [rutaVal, setRutaVal] = useState(String(item.ruta_carga ?? ""));
  const pales = item.numsup_count ?? "?";
  const paleColor = (n) => typeof n === "number" ? (n >= 25 ? "#15803d" : n >= 10 ? "#d97706" : "#dc2626") : "#a8a29e";
  const isRefr = item.tipo_carga === "REFRIGERADO";
  const centers = (item.trip_centers && item.trip_centers.length > 1) ? item.trip_centers : null;

  return (
    <div style={QS.pendCard}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Info común: matrícula · muelle · salida · tipo */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 11, color: "#78716c" }}>
            {item.tractora && (
              <span style={{ fontFamily: "ui-monospace, monospace", fontWeight: 700, color: "#1c1917" }}>{item.tractora}</span>
            )}
            <span>Muelle {(item.muelle || "—").padStart(2, "0")}</span>
            {item.hora_salida && <span>· Salida {item.hora_salida}</span>}
            <span style={{
              fontSize: 10, fontWeight: 700, padding: "1px 6px", borderRadius: 999,
              background: isRefr ? "#dbeafe" : "#ffedd5",
              color: isRefr ? "#0c4a6e" : "#9a3412",
            }}>
              {isRefr ? "❄ REFR" : "☼ AMB"}
            </span>
          </div>

          {centers ? (
            /* Desglose por centro para viajes combinados */
            <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 0 }}>
              {centers.map((c, i) => (
                <div key={i} style={{
                  display: "flex", alignItems: "center", gap: 8,
                  padding: "5px 0",
                  borderBottom: i < centers.length - 1 ? "1px solid #f4f4f3" : "none",
                }}>
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#1c1917", flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {c.destino}
                  </span>
                  {c.ruta_carga != null && (
                    <span style={{ fontSize: 10, color: "#78716c", whiteSpace: "nowrap" }}>RUTA <b>{c.ruta_carga}</b></span>
                  )}
                  <span style={{ fontSize: 12, fontWeight: 700, color: paleColor(c.numsup_count), whiteSpace: "nowrap" }}>
                    {c.numsup_count ?? "?"} pales
                  </span>
                </div>
              ))}
            </div>
          ) : (
            /* Centro único */
            <>
              <div style={{ fontSize: 13, fontWeight: 700, color: "#1c1917", marginTop: 4 }}>{item.destino}</div>
              {!editRuta ? (
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 5 }}>
                  {item.ruta_carga != null
                    ? <span style={{ fontSize: 10.5, color: "#78716c" }}>RUTA <b>{item.ruta_carga}</b></span>
                    : <span style={{ fontSize: 10.5, color: "#dc2626" }}>Sin ruta detectada</span>
                  }
                  <span style={{ fontSize: 12, fontWeight: 700, color: paleColor(pales) }}>
                    {pales} pales
                  </span>
                  <button
                    onClick={() => setEditRuta(true)}
                    style={{ fontSize: 10, color: "#0ea5e9", background: "none", border: "none", cursor: "pointer", padding: 0 }}
                    title="Editar ruta manualmente"
                  >
                    ✎ editar
                  </button>
                </div>
              ) : (
                <div style={{ display: "flex", gap: 5, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 10.5, color: "#78716c" }}>RUTA:</span>
                  <input
                    type="number"
                    value={rutaVal}
                    onChange={(e) => setRutaVal(e.target.value)}
                    style={{ fontSize: 12, padding: "2px 6px", border: "1px solid #d6d3d1", borderRadius: 4, width: 70 }}
                    placeholder="Nº ruta"
                    autoFocus
                  />
                  <button
                    onClick={() => { if (rutaVal) onRefreshNumsup(rutaVal); setEditRuta(false); }}
                    style={{ fontSize: 11, padding: "3px 9px", background: "#0ea5e9", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer" }}
                  >
                    Buscar
                  </button>
                  <button
                    onClick={() => setEditRuta(false)}
                    style={{ fontSize: 11, padding: "3px 7px", background: "transparent", border: "1px solid #d6d3d1", borderRadius: 4, cursor: "pointer", color: "#78716c" }}
                  >
                    ✕
                  </button>
                </div>
              )}
            </>
          )}
        </div>
        <button onClick={onRemove} style={{ ...QS.iconBtn, color: "#a8a29e", marginTop: -2, flexShrink: 0 }}>
          <IconX size={13} />
        </button>
      </div>
    </div>
  );
};

const LoaderCard = ({ loader, current, onEdit, onRemove }) => (
  <div style={QS.loaderCard}>
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span style={{
        width: 10, height: 10, borderRadius: "50%",
        background: current ? "#0ea5e9" : (loader.active ? "#22c55e" : "#a8a29e"),
        boxShadow: current ? "0 0 0 4px rgba(14,165,233,0.18)" : "0 0 0 4px rgba(34,197,94,0.12)",
        flexShrink: 0,
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 700, color: "#1c1917", display: "flex", alignItems: "center", gap: 6 }}>
          {loader.id}
          <span style={{ color: "#a8a29e", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>· {loader.name}</span>
          <span style={{ fontSize: 10, padding: "1px 5px", borderRadius: 999, background: loader.queue_type === "refrigerado" ? "#dbeafe" : "#ffedd5", color: loader.queue_type === "refrigerado" ? "#0c4a6e" : "#9a3412", fontWeight: 700, flexShrink: 0 }}>
            {loader.queue_type === "refrigerado" ? "❄" : "☼"}
          </span>
        </div>
        <div style={{ fontSize: 10.5, color: "#78716c", marginTop: 2 }}>
          PIN: <code style={{ fontFamily: "ui-monospace, monospace", color: "#1c1917" }}>{loader.pin}</code>
          {" · Muelle "}<b>{(loader.muelle_actual || "—").padStart(2, "0")}</b>
        </div>
      </div>
      {onEdit && (
        <div style={{ display: "flex", gap: 2, flexShrink: 0 }}>
          <button onClick={onEdit} style={{ ...QS.iconBtn, color: "#78716c", fontSize: 12 }} title="Editar cargador">✎</button>
          <button onClick={onRemove} style={{ ...QS.iconBtn, color: "#dc2626", fontSize: 12 }} title="Eliminar cargador">🗑</button>
        </div>
      )}
    </div>
    {current ? (
      <div style={QS.loaderCurrent}>
        {current.is_combined && <span style={{ color: "#6d28d9", marginRight: 6 }}>COMBO</span>}
        #{current.id} · {current.destino}
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
  odbcBtn: { display: "flex", alignItems: "center", gap: 5, padding: "6px 12px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 8, fontSize: 11, fontWeight: 700, color: "#15803d", cursor: "pointer", fontFamily: "inherit", marginRight: 6, letterSpacing: 0.5 },
  clearBtn: { display: "flex", alignItems: "center", gap: 6, padding: "6px 12px", background: "#fff", border: "1px solid #fecaca", borderRadius: 8, fontSize: 12, color: "#dc2626", cursor: "pointer", fontFamily: "inherit" },

  tabBar: { display: "flex", background: "#fff", borderBottom: "1px solid #e7e5e4", flexShrink: 0, padding: "0 16px", gap: 4 },
  tab: { padding: "10px 16px", fontSize: 12.5, fontWeight: 600, color: "#78716c", background: "transparent", border: "none", borderBottom: "2px solid transparent", cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6, marginBottom: -1 },
  tabActive: { color: "#1c1917", borderBottomColor: "#1c1917" },
  tabBadge: { fontSize: 10, fontWeight: 700, padding: "1px 7px", borderRadius: 999, background: "#f4f4f3", color: "#57534e" },

  searchBar: { display: "flex", alignItems: "center", gap: 8, padding: "8px 16px", background: "#fff", borderBottom: "1px solid #e7e5e4", flexShrink: 0 },
  searchInput: { flex: 1, padding: "6px 10px", border: "1px solid #e7e5e4", borderRadius: 8, fontSize: 12.5, fontFamily: "inherit", outline: "none", color: "#1c1917", background: "#fafaf9" },
  searchClear: { background: "transparent", border: "none", color: "#a8a29e", cursor: "pointer", fontSize: 13, padding: "2px 6px", lineHeight: 1 },

  grid: { flex: 1, display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 0, overflow: "hidden", minHeight: 0 },
  col: { display: "flex", flexDirection: "column", borderRight: "1px solid #e7e5e4", overflow: "hidden", minHeight: 0, background: "#fafaf9" },
  colHead: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 18px", background: "#fafaf9", borderBottom: "1px solid #e7e5e4", flexShrink: 0 },
  colTitle: { fontSize: 11, fontWeight: 700, letterSpacing: 1.2, color: "#1c1917", textTransform: "uppercase" },
  colCount: { fontSize: 11, fontWeight: 600, color: "#a8a29e", padding: "2px 9px", background: "#fff", borderRadius: 999, border: "1px solid #e7e5e4" },
  list: { flex: 1, overflowY: "auto", padding: "12px 12px 24px", display: "flex", flexDirection: "column", gap: 8 },

  card: { background: "#fff", border: "1px solid #e7e5e4", borderRadius: 8, padding: 12, position: "relative", transition: "all 160ms" },
  cardHead: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 },
  cardLeft: { display: "flex", alignItems: "center", gap: 8, minWidth: 0, flexWrap: "wrap" },
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

  commentDisplay: { display: "flex", alignItems: "flex-start", gap: 6, marginTop: 8, padding: "6px 8px", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6 },
  commentInputWrap: { marginTop: 8, padding: "8px", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6 },
  commentTextarea: { width: "100%", fontSize: 12, padding: "5px 7px", border: "1px solid #fde68a", borderRadius: 4, fontFamily: "inherit", resize: "none", outline: "none", background: "#fff", color: "#1c1917" },
  commentSaveBtn: { fontSize: 11, padding: "4px 10px", background: "#0ea5e9", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontFamily: "inherit", fontWeight: 600 },
  commentCancelBtn: { fontSize: 11, padding: "4px 10px", background: "transparent", border: "1px solid #d6d3d1", borderRadius: 4, cursor: "pointer", fontFamily: "inherit", color: "#78716c" },

  assignedBy: { display: "flex", alignItems: "center", gap: 4, fontSize: 11, color: "#0c4a6e", background: "#dbeafe", padding: "2px 8px", borderRadius: 999, fontWeight: 600 },

  reassignMenu: { marginTop: 10, paddingTop: 10, borderTop: "1px solid #f4f4f3", display: "flex", flexDirection: "column", gap: 4 },
  reassignHint: { fontSize: 10, fontWeight: 700, letterSpacing: 0.8, color: "#a8a29e", textTransform: "uppercase", marginBottom: 4 },
  reassignOpt: { display: "flex", alignItems: "center", gap: 6, padding: "7px 10px", background: "#fafaf9", border: "1px solid #e7e5e4", borderRadius: 6, fontSize: 12, color: "#1c1917", cursor: "pointer", fontFamily: "inherit", textAlign: "left" },
  reassignDot: { width: 7, height: 7, borderRadius: "50%", background: "#22c55e" },
  reassignMuelle: { fontSize: 10, color: "#a8a29e", fontFamily: "ui-monospace, monospace" },

  addLoaderBtn: { fontSize: 10.5, fontWeight: 700, padding: "3px 9px", background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 6, color: "#15803d", cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap" },
  loaderCard: { background: "#fff", border: "1px solid #e7e5e4", borderRadius: 8, padding: 12 },
  loaderCurrent: { fontSize: 11, color: "#0c4a6e", background: "#dbeafe", padding: "5px 8px", borderRadius: 4, marginTop: 8, fontWeight: 600, fontFamily: "ui-monospace, monospace", letterSpacing: 0.2 },

  doneCard: { background: "#fff", border: "1px solid #e7e5e4", borderRadius: 6, padding: "8px 12px" },

  // Sin mercancía tab
  sinMerchRoot: { flex: 1, overflowY: "auto", padding: "16px", display: "flex", flexDirection: "column", gap: 12 },
  pendGroup: { background: "#fff", border: "1px solid #e7e5e4", borderRadius: 8, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 8 },
  pendGroupHead: { display: "flex", justifyContent: "space-between", alignItems: "center", paddingBottom: 8, borderBottom: "1px solid #f4f4f3" },
  pendCard: { background: "#fafaf9", border: "1px solid #f4f4f3", borderRadius: 6, padding: "10px 12px" },
  pendCount: { fontSize: 11, fontWeight: 700, color: "#d97706", background: "#fef3c7", padding: "2px 8px", borderRadius: 999 },
  prioritizeBtn: { fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 6, background: "#fff7ed", border: "1px solid #fed7aa", color: "#c2410c", cursor: "pointer", fontFamily: "inherit" },
  comboBadge: { fontSize: 9, fontWeight: 700, letterSpacing: 0.8, background: "#ede9fe", color: "#6d28d9", padding: "2px 7px", borderRadius: 999, textTransform: "uppercase" },
  urgentBadge: { fontSize: 10, fontWeight: 700, color: "#d97706", background: "#fef3c7", padding: "2px 8px", borderRadius: 999 },
};

window.QueuePanel = QueuePanel;
