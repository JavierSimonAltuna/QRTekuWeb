// WordPreview — replica el layout del Word real (tus capturas PAMPLONA / MARKET VALLADOLID).
// Ciudad gigante, agencia/CIF a la derecha, QR + 3x2 data cards, grid precintos 2-col con código de barras.
// Es EDITABLE: clic en cualquier campo para modificarlo. Estilo "documento", no "formulario".

const WordPreview = ({
  row, state, loadingOdbc,
  onField, onAddObs, onDelObs, onAddPrec, onDelPrec, onPrecCentro,
  onClose, onConfirm, onCopy, onSendToQueue, showJson,
}) => {
  const [obsH, setObsH] = React.useState("");
  const [obsD, setObsD] = React.useState("");
  const [newPrec, setNewPrec] = React.useState("");
  const [newPrecCentro, setNewPrecCentro] = React.useState(row.destino || "");

  React.useEffect(() => setNewPrecCentro(row.destino || ""), [row.destino]);

  if (!state) return null;

  // Auto-shrink city font according to length (igual que en Python)
  const cityLen = (row.destino || "").length;
  let cityPx = 56;
  if (cityLen > 8) cityPx = 48;
  if (cityLen > 12) cityPx = 40;
  if (cityLen > 16) cityPx = 34;
  if (cityLen > 22) cityPx = 28;

  const fechaDisplay = state.D && state.D.length === 8 && /^\d+$/.test(state.D)
    ? `${state.D.slice(0,4)}-${state.D.slice(4,6)}-${state.D.slice(6)}`
    : state.D;

  const payload = { T: state.T, R: state.R, N: state.N, D: state.D, C: state.C, E: state.E, P: state.obs.map((o) => ({ H: o.H, D: o.D })) };
  const compactJson = JSON.stringify(payload);
  const prettyJson = JSON.stringify(payload, null, 2);
  const qrSeed = (compactJson.length * 13) % 100 + 5;

  const nPrec = state.precintos.length;
  const cityUpper = (row.destino || "—").toUpperCase();

  return (
    <div style={WP.root}>
      {/* Sticky header bar with actions */}
      <div style={WP.bar}>
        <div>
          <div style={{ fontSize: 11, color: "#a8a29e", textTransform: "uppercase", letterSpacing: 1.2, fontWeight: 600 }}>Vista previa Word</div>
          <div style={{ fontSize: 13, color: "#1c1917", fontWeight: 500, marginTop: 2 }}>
            Viaje #{row.n} · {row.destino}
          </div>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button onClick={onCopy} style={WP.btnGhost}><IconCopy size={13} />JSON</button>
          {onSendToQueue && (
            <button onClick={onSendToQueue} style={WP.btnGhost} title="Enviar a la cola Bleecker">
              <IconTruck size={13} />Encolar
            </button>
          )}
          <button onClick={onClose} style={WP.btnGhost}>Cerrar <kbd style={WP.kbdLight}>Esc</kbd></button>
          <button onClick={onConfirm} style={WP.btnPrimary}>
            <IconPrinter size={14} />Imprimir Word
            <kbd style={WP.kbdInDark}>⌘⏎</kbd>
          </button>
        </div>
      </div>

      {/* The paper */}
      <div style={WP.paperWrap}>
        <div style={WP.paper}>

          {/* ─── Cabecera ─── */}
          <div style={WP.header}>
            <div style={{ flex: 1 }}>
              <div style={WP.subtitle}>CARGA TEKU · CÓDIGO BLEECKER</div>
              <div style={{ ...WP.city, fontSize: cityPx }}>{cityUpper}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={WP.agencyHeader}>
                <EditableValue
                  value={state.E}
                  onChange={(v) => onField("E", v)}
                  placeholder="AGENCIA"
                  style={{ fontSize: 16, fontWeight: 700, color: state.E ? "#1c1917" : "#dc2626", letterSpacing: 0.2, textAlign: "right" }}
                />
              </div>
              <div style={WP.metaRight}>
                CIF{" "}
                <EditableValue
                  value={state.C}
                  onChange={(v) => onField("C", v.toUpperCase())}
                  placeholder="—"
                  style={{ fontSize: 11, color: state.C ? "#666" : "#dc2626", fontFamily: "ui-monospace, monospace", display: "inline" }}
                  inline
                />
              </div>
              <div style={{ ...WP.metaRight, color: "#888", marginTop: 1 }}>
                Generado {new Date().toLocaleString("es-ES", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}
              </div>
              {loadingOdbc && (
                <div style={{ fontSize: 10, color: "#15803d", marginTop: 6, display: "inline-flex", alignItems: "center", gap: 4 }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#15803d", animation: "pulse 1s infinite" }} />
                  Consultando ODBC…
                </div>
              )}
            </div>
          </div>

          <div style={WP.divider} />

          {/* ─── QR + data grid 3x2 ─── */}
          <div style={WP.qrDataRow}>
            <div style={WP.qrFrame}>
              <QrPattern size={108} seed={qrSeed} />
              <div style={WP.qrCaption}>QR - TEKU/BLEECKER</div>
            </div>

            <div style={WP.dataGrid}>
              <DataCard label="TRACTORA"   value={state.T} onChange={(v) => onField("T", v.toUpperCase())} mono />
              <DataCard label="REMOLQUE"   value={state.R} onChange={(v) => onField("R", v.toUpperCase())} mono />
              <DataCard label="Nº CAMIÓN"  value={state.N} onChange={(v) => onField("N", v)} mono />
              <DataCard label="FECHA"      value={state.D} onChange={(v) => onField("D", v)} mono display={fechaDisplay} />
              <DataCard label="CIF"        value={state.C} onChange={(v) => onField("C", v.toUpperCase())} mono required={!state.C} />
              <DataCard label="AGENCIA"    value={state.E} onChange={(v) => onField("E", v)} required={!state.E} />
              <DataCard label="MUELLE"     value={state.MU || ""} onChange={(v) => onField("MU", v)} mono />
              <DataCard label="PLAYA"      value={state.PL || ""} onChange={(v) => onField("PL", v)} mono />
            </div>
          </div>

          {/* ─── Precintos ─── */}
          <div style={WP.sectionHead}>
            <span style={WP.sectionTitle}>Precintos</span>
            <span style={WP.sectionCount}>{nPrec} PRECINTO{nPrec !== 1 ? "S" : ""}</span>
          </div>

          {nPrec > 0 ? (
            <div style={WP.precGrid}>
              {state.precintos.map((p, i) => (
                <PrecintoCard
                  key={p.id}
                  index={i + 1}
                  total={nPrec}
                  centro={p.centro}
                  code={p.code}
                  onCentroChange={(v) => onPrecCentro(p.id, v)}
                  onDelete={() => onDelPrec(p.id)}
                />
              ))}
            </div>
          ) : (
            <div style={WP.precEmpty}>Sin precintos · añade uno abajo</div>
          )}

          {/* Add precinto */}
          <div style={WP.addPrecRow}>
            <input
              value={newPrecCentro}
              onChange={(e) => setNewPrecCentro(e.target.value)}
              placeholder="Centro"
              style={{ ...WP.addPrecInput, width: 160, textTransform: "uppercase" }}
            />
            <input
              value={newPrec}
              onChange={(e) => setNewPrec(e.target.value.toUpperCase())}
              onKeyDown={(e) => { if (e.key === "Enter") { onAddPrec(newPrec, newPrecCentro); setNewPrec(""); } }}
              placeholder="Nº precinto"
              style={{ ...WP.addPrecInput, flex: 1, fontFamily: "ui-monospace, monospace" }}
            />
            <button
              onClick={() => { onAddPrec(newPrec, newPrecCentro); setNewPrec(""); }}
              style={WP.addBtn}
              disabled={!newPrec}
            >
              <IconPlus size={13} />Añadir precinto
            </button>
          </div>

          {/* Footer */}
          <div style={WP.footer}>
            Generado: {new Date().toISOString().replace("T", " ").slice(0, 19)}
          </div>
        </div>

        {/* Observaciones (fuera del papel) */}
        <details style={WP.obsCard} open={state.obs.length > 0}>
          <summary style={WP.obsSummary}>
            <span style={{ fontSize: 12.5, fontWeight: 600, color: "#1c1917" }}>Observaciones</span>
            <span style={{ fontSize: 11.5, color: "#a8a29e" }}>{state.obs.length} {state.obs.length === 1 ? "observación" : "observaciones"} · array P[] del JSON</span>
          </summary>
          <div style={{ padding: "12px 16px 16px" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 10 }}>
              {state.obs.map((o) => (
                <div key={o.id} style={WP.obsRow}>
                  <IconClock size={12} style={{ color: "#a8a29e" }} />
                  <span style={{ fontSize: 11.5, fontFamily: "ui-monospace, monospace", color: "#57534e" }}>{o.H}</span>
                  <span style={{ width: 1, height: 12, background: "#e7e5e4" }} />
                  <span style={{ fontSize: 12.5, color: "#1c1917", flex: 1 }}>{o.D}</span>
                  <button onClick={() => onDelObs(o.id)} style={WP.iconBtn}><IconTrash size={11} /></button>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 6 }}>
              <input
                value={obsH}
                onChange={(e) => setObsH(e.target.value)}
                placeholder="HH:MM"
                style={{ ...WP.addPrecInput, width: 80, fontFamily: "ui-monospace, monospace" }}
                onKeyDown={(e) => { if (e.key === "Enter") { onAddObs(obsH, obsD); setObsH(""); setObsD(""); } }}
              />
              <input
                value={obsD}
                onChange={(e) => setObsD(e.target.value)}
                placeholder="Descripción"
                style={{ ...WP.addPrecInput, flex: 1 }}
                onKeyDown={(e) => { if (e.key === "Enter") { onAddObs(obsH, obsD); setObsH(""); setObsD(""); } }}
              />
              <button onClick={() => { onAddObs(obsH, obsD); setObsH(""); setObsD(""); }} style={WP.addBtn}>
                <IconPlus size={12} />Añadir
              </button>
            </div>
          </div>
        </details>

        {/* JSON panel (opcional vía tweak) */}
        {showJson && (
          <div style={WP.jsonCard}>
            <div style={WP.jsonHead}>
              <span style={{ fontSize: 10.5, color: "rgba(255,255,255,0.55)", letterSpacing: 0.8, fontWeight: 600, textTransform: "uppercase" }}>JSON · payload del QR</span>
              <span style={{ fontSize: 10.5, color: "rgba(255,255,255,0.4)", fontFamily: "ui-monospace, monospace" }}>{compactJson.length} chars</span>
            </div>
            <pre style={WP.jsonPre}>{prettyJson}</pre>
          </div>
        )}
      </div>
    </div>
  );
};

// ───────────────────────────────────────────────────────────────────
// Editable bits
// ───────────────────────────────────────────────────────────────────
const EditableValue = ({ value, onChange, placeholder, style = {}, inline = false }) => {
  const [editing, setEditing] = React.useState(false);
  const [tmp, setTmp] = React.useState(value);
  React.useEffect(() => setTmp(value), [value]);

  if (editing) {
    return (
      <input
        autoFocus
        value={tmp}
        onChange={(e) => setTmp(e.target.value)}
        onBlur={() => { onChange(tmp); setEditing(false); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") { onChange(tmp); setEditing(false); }
          if (e.key === "Escape") { setTmp(value); setEditing(false); }
        }}
        style={{
          ...style,
          background: "#fffbea",
          border: "1px solid #f59e0b",
          borderRadius: 4,
          padding: "2px 6px",
          outline: "none",
          fontFamily: style.fontFamily || "inherit",
          margin: "-2px -6px",
          width: inline ? "auto" : "100%",
          boxSizing: "border-box",
        }}
      />
    );
  }
  const isEmpty = !value || value === "";
  return (
    <span
      onClick={() => setEditing(true)}
      style={{
        ...style,
        cursor: "text",
        borderRadius: 3,
        padding: "1px 3px",
        margin: "-1px -3px",
        background: isEmpty ? "#fef2f2" : "transparent",
        border: isEmpty ? "1px dashed #fca5a5" : "1px solid transparent",
        display: inline ? "inline-block" : "block",
        minWidth: isEmpty ? 50 : 0,
      }}
    >
      {isEmpty ? placeholder : value}
    </span>
  );
};

const DataCard = ({ label, value, display, onChange, mono, required }) => {
  const [editing, setEditing] = React.useState(false);
  const [tmp, setTmp] = React.useState(value);
  React.useEffect(() => setTmp(value), [value]);
  const showVal = (display !== undefined && !editing) ? display : value;
  const isEmpty = !value;

  return (
    <div style={{
      ...WP.dataCard,
      borderColor: required ? "#fca5a5" : "#cfcfcf",
      background: required ? "#fef2f2" : "#fff",
    }}>
      <div style={WP.dataCardLabel}>{label}</div>
      {editing ? (
        <input
          autoFocus
          value={tmp}
          onChange={(e) => setTmp(e.target.value)}
          onBlur={() => { onChange(tmp); setEditing(false); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { onChange(tmp); setEditing(false); }
            if (e.key === "Escape") { setTmp(value); setEditing(false); }
          }}
          style={{
            ...WP.dataCardValue,
            fontFamily: mono ? "ui-monospace, 'JetBrains Mono', monospace" : "inherit",
            background: "#fffbea",
            border: "1px solid #f59e0b",
            borderRadius: 4,
            padding: "1px 4px",
            margin: "-1px -4px",
            outline: "none",
            width: "100%",
            boxSizing: "border-box",
          }}
        />
      ) : (
        <div
          onClick={() => setEditing(true)}
          style={{
            ...WP.dataCardValue,
            fontFamily: mono ? "ui-monospace, 'JetBrains Mono', monospace" : "inherit",
            color: isEmpty ? "#dc2626" : "#111",
            cursor: "text",
            minHeight: 18,
          }}
        >
          {isEmpty ? (required ? "REQUERIDO" : "—") : showVal}
        </div>
      )}
    </div>
  );
};

const PrecintoCard = ({ index, total, centro, code, onCentroChange, onDelete }) => (
  <div style={WP.precCard}>
    <div style={WP.precCardHead}>
      <EditableValue
        value={centro}
        onChange={onCentroChange}
        placeholder="CENTRO"
        style={{ fontSize: 9, fontWeight: 700, color: "#777", letterSpacing: 1.8, textTransform: "uppercase", flex: 1 }}
      />
      <span style={{ fontSize: 10, color: "#999", fontFamily: "ui-monospace, monospace", letterSpacing: 0.5, marginLeft: 8 }}>
        {String(index).padStart(2, "0")} / {String(total).padStart(2, "0")}
      </span>
      <button onClick={onDelete} style={{ ...WP.iconBtn, marginLeft: 4 }}><IconX size={11} /></button>
    </div>
    <div style={WP.precCardNum}>{code}</div>
    <div style={{ marginTop: 4 }}>
      <BarcodePattern width={170} height={32} seed={code.length * 0.5 + 1} />
    </div>
  </div>
);

// ───────────────────────────────────────────────────────────────────
// Styles
// ───────────────────────────────────────────────────────────────────
const WP = {
  root: { display: "flex", flexDirection: "column", height: "100%" },
  bar: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 20px", background: "#fff", borderBottom: "1px solid #e7e5e4", position: "sticky", top: 0, zIndex: 5 },
  btnGhost: { display: "flex", alignItems: "center", gap: 6, padding: "7px 11px", background: "#fff", border: "1px solid #e7e5e4", borderRadius: 7, fontSize: 12, color: "#1c1917", fontWeight: 500, cursor: "pointer", fontFamily: "inherit" },
  btnPrimary: { display: "flex", alignItems: "center", gap: 8, padding: "8px 14px 8px 12px", background: "#dc2626", color: "#fff", border: "none", borderRadius: 7, fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" },
  kbdLight: { fontSize: 10, color: "#78716c", background: "#fafaf9", border: "1px solid #e7e5e4", padding: "1px 5px", borderRadius: 3, fontFamily: "ui-monospace, monospace", marginLeft: 6 },
  kbdInDark: { fontSize: 10, color: "rgba(255,255,255,0.85)", background: "rgba(255,255,255,0.18)", padding: "1px 5px", borderRadius: 3, fontFamily: "ui-monospace, monospace", marginLeft: 4 },

  // Paper
  paperWrap: { flex: 1, padding: 24, overflow: "auto" },
  paper: { background: "#fff", border: "1px solid #e7e5e4", borderRadius: 6, padding: "32px 28px 20px", boxShadow: "0 1px 2px rgba(0,0,0,0.04), 0 8px 24px rgba(0,0,0,0.06)", fontFamily: "Helvetica, Arial, sans-serif" },

  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 24 },
  subtitle: { fontSize: 10, color: "#7A7A7A", fontWeight: 700, letterSpacing: 2.2, marginBottom: 8 },
  city: { fontWeight: 800, color: "#111", letterSpacing: -2, lineHeight: 0.95, fontFamily: "Helvetica, Arial, sans-serif" },
  agencyHeader: { marginBottom: 2 },
  metaRight: { fontSize: 11, color: "#666", lineHeight: 1.45 },
  divider: { height: 1, background: "#CFCFCF", margin: "12px 0 14px" },

  qrDataRow: { display: "flex", gap: 12, alignItems: "stretch", marginBottom: 18 },
  qrFrame: { width: 122, padding: 6, border: "1px solid #CFCFCF", borderRadius: 2, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-start", gap: 2 },
  qrCaption: { fontSize: 7.5, color: "#999", letterSpacing: 0.8, marginTop: 2 },

  dataGrid: { flex: 1, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 },
  dataCard: { padding: "8px 10px 9px", border: "1px solid #CFCFCF", borderRadius: 2, transition: "background 80ms" },
  dataCardLabel: { fontSize: 9, color: "#9A9A9A", letterSpacing: 1.4, fontWeight: 700, marginBottom: 3 },
  dataCardValue: { fontSize: 13, fontWeight: 700, color: "#111", letterSpacing: 0.3, lineHeight: 1.2 },

  sectionHead: { display: "flex", justifyContent: "space-between", alignItems: "baseline", borderBottom: "1px solid transparent", paddingBottom: 6, marginBottom: 8 },
  sectionTitle: { fontSize: 16, fontWeight: 700, color: "#1c1917", letterSpacing: -0.2, fontFamily: "Helvetica, Arial, sans-serif" },
  sectionCount: { fontSize: 11, color: "#888", fontWeight: 700, letterSpacing: 1.4 },

  precGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 8 },
  precEmpty: { padding: "18px 14px", border: "1px dashed #d6d3d1", borderRadius: 4, fontSize: 12, color: "#a8a29e", textAlign: "center", marginBottom: 8 },

  precCard: { border: "1px solid #CFCFCF", borderRadius: 2, padding: "8px 12px 10px" },
  precCardHead: { display: "flex", alignItems: "center" },
  precCardNum: { fontSize: 17, fontWeight: 700, color: "#111", marginTop: 1, letterSpacing: 0.2, fontFamily: "Helvetica, Arial, sans-serif" },

  addPrecRow: { display: "flex", gap: 6, marginTop: 8 },
  addPrecInput: { padding: "7px 10px", background: "#fff", border: "1px solid #e7e5e4", borderRadius: 6, fontSize: 12, color: "#1c1917", outline: "none", fontFamily: "inherit" },
  addBtn: { display: "flex", alignItems: "center", gap: 4, padding: "7px 12px", background: "#fafaf9", border: "1px solid #e7e5e4", borderRadius: 6, fontSize: 12, color: "#57534e", fontWeight: 500, cursor: "pointer", fontFamily: "inherit" },

  iconBtn: { background: "transparent", border: "none", cursor: "pointer", color: "#d6d3d1", padding: 2, display: "flex" },

  footer: { fontSize: 8, color: "#BBB", textAlign: "right", marginTop: 18, paddingTop: 6, borderTop: "1px solid #E3E3E3", fontStyle: "italic", fontFamily: "Helvetica, Arial, sans-serif" },

  // Outside paper
  obsCard: { marginTop: 18, background: "#fff", border: "1px solid #e7e5e4", borderRadius: 10 },
  obsSummary: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", cursor: "pointer", listStyle: "none" },
  obsRow: { display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", background: "#fafaf9", border: "1px solid #e7e5e4", borderRadius: 6 },

  jsonCard: { marginTop: 12, background: "#1c1917", borderRadius: 10, overflow: "hidden" },
  jsonHead: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid #292524" },
  jsonPre: { margin: 0, padding: "12px 16px", fontSize: 11.5, lineHeight: 1.55, color: "#e7e5e4", fontFamily: "ui-monospace, 'JetBrains Mono', monospace", overflow: "auto", maxHeight: 280, whiteSpace: "pre" },
};

window.WordPreview = WordPreview;
