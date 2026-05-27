// QR Teku · Vista Cargador (Bleecker app)
// Móvil vertical. Login PIN → carga asignada (muelle + QR + precintos) → finalizar → siguiente.
// Diseño según mockups del usuario.

const { useState, useEffect, useRef, useCallback } = React;

const fmtTime = (iso) => {
  if (!iso) return "";
  try {
    const d = typeof iso === "string" ? new Date(iso) : iso;
    return d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" });
  } catch (_) { return ""; }
};

// ───────────────────────────────────────────────────────────────
// App raíz
// ───────────────────────────────────────────────────────────────
const LoaderApp = () => {
  const [loader, setLoader] = useState(() => {
    try {
      const cached = localStorage.getItem("bleecker.loader");
      return cached ? JSON.parse(cached) : null;
    } catch (_) { return null; }
  });
  const [screen, setScreen] = useState(loader ? "loading_or_waiting" : "login");
  // assigned | waiting | confirming | completing | requesting
  const [item, setItem] = useState(null);
  const [queuedCount, setQueuedCount] = useState(0);
  const [completedInfo, setCompletedInfo] = useState(null);
  const [requesting, setRequesting] = useState(false);
  const [toast, setToast] = useState(null);

  const showToast = (text) => {
    setToast(text);
    setTimeout(() => setToast(null), 2600);
  };

  // ── Cargar estado actual al entrar
  useEffect(() => {
    if (!loader) return;
    pollCurrent();
    const t = setInterval(pollCurrent, 3000);
    return () => clearInterval(t);
    // eslint-disable-next-line
  }, [loader]);

  const pollCurrent = async () => {
    if (!loader) return;
    try {
      const r = await window.api.call("loader_current", loader.id);
      if (r.ok) {
        setItem(r.item || null);
        setQueuedCount(r.queued_count || 0);
        setScreen(r.item ? "assigned" : "waiting");
      }
    } catch (e) { /* silencio */ }
  };

  const handleLogin = async (pin) => {
    try {
      const r = await window.api.call("loader_login", pin);
      if (r.ok) {
        setLoader(r.loader);
        localStorage.setItem("bleecker.loader", JSON.stringify(r.loader));
        setScreen("waiting");
      } else {
        showToast("PIN no válido");
      }
    } catch (e) {
      showToast("Error de conexión: " + (e.message || e));
    }
  };

  const handleRequestNext = async () => {
    if (!loader || requesting) return;
    setRequesting(true);
    try {
      const r = await window.api.call("loader_request_next", loader.id);
      if (r.ok && r.item) {
        setItem(r.item);
        setQueuedCount(r.queued_count || 0);
        setScreen("assigned");
      } else {
        showToast("No hay cargas en cola");
        setQueuedCount(0);
      }
    } catch (e) {
      showToast("Error: " + (e.message || e));
    }
    setRequesting(false);
  };

  const handleFinalize = () => setScreen("confirming");
  const handleCancelConfirm = () => setScreen("assigned");

  const handleConfirmFinish = async () => {
    if (!loader || !item) return;
    setCompletedInfo({ muelle: item.muelle, time: new Date().toLocaleTimeString("es-ES", { hour12: false }) });
    setScreen("completing");
    try {
      const r = await window.api.call("loader_finish", loader.id, item.id);
      if (r.ok) {
        // Pequeña pausa para mostrar la animación, luego asignar siguiente
        setTimeout(() => {
          if (r.next) {
            setItem(r.next);
            setQueuedCount(r.queued_count || 0);
            setScreen("assigned");
          } else {
            setItem(null);
            setQueuedCount(0);
            setScreen("waiting");
          }
          setCompletedInfo(null);
        }, 2800);
      } else {
        showToast("Error al finalizar: " + (r.error || ""));
        setScreen("assigned");
      }
    } catch (e) {
      showToast("Error: " + (e.message || e));
      setScreen("assigned");
    }
  };

  const handleLogout = () => {
    localStorage.removeItem("bleecker.loader");
    setLoader(null);
    setItem(null);
    setScreen("login");
  };

  // ── Render
  return (
    <div style={LS.root}>
      {screen === "login" && <LoginScreen onLogin={handleLogin} />}
      {screen === "waiting" && (
        <WaitingScreen
          loader={loader}
          queuedCount={queuedCount}
          requesting={requesting}
          onRequest={handleRequestNext}
          onLogout={handleLogout}
        />
      )}
      {(screen === "assigned" || screen === "confirming") && item && (
        <AssignedScreen
          item={item}
          queuedCount={queuedCount}
          loader={loader}
          onFinalize={handleFinalize}
        />
      )}
      {screen === "confirming" && item && (
        <ConfirmDialog
          item={item}
          onCancel={handleCancelConfirm}
          onConfirm={handleConfirmFinish}
        />
      )}
      {screen === "completing" && (
        <CompleteScreen info={completedInfo} queuedCount={queuedCount} />
      )}

      {toast && <Toast text={toast} />}
    </div>
  );
};

// ───────────────────────────────────────────────────────────────
// Login
// ───────────────────────────────────────────────────────────────
const LoginScreen = ({ onLogin }) => {
  const [pin, setPin] = useState("");
  const press = (k) => setPin((p) => (p + k).slice(0, 6));
  const back = () => setPin((p) => p.slice(0, -1));
  const submit = () => pin && onLogin(pin);

  return (
    <div style={LS.loginRoot}>
      <div style={LS.loginLogoBox}>
        <img
          src="assets/logo-rojo.png"
          alt="PULSO"
          style={{ height: 70, width: "auto", maxWidth: 260 }}
          onError={(e) => {
            e.target.src = "assets/pulso-icon.svg";
            e.target.style.height = "70px";
            e.target.style.width = "70px";
            e.target.style.borderRadius = "16px";
            e.target.onerror = () => {
              e.target.style.display = "none";
              e.target.nextElementSibling.style.display = "flex";
            };
          }}
        />
        <div style={{ display: "none", flexDirection: "column", alignItems: "center", gap: 6 }}>
          <div style={LS.loginLogo}>P</div>
          <div style={LS.loginBrand}>PULSO</div>
        </div>
        <div style={LS.loginSubtitle}>App Cargador · Bleecker</div>
      </div>

      <div style={LS.pinRow}>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} style={{
            ...LS.pinDot,
            background: i < pin.length ? "#fafaf9" : "transparent",
            borderColor: i === pin.length ? "#dc2626" : "rgba(255,255,255,0.25)",
          }} />
        ))}
      </div>

      <div style={LS.pinHint}>Introduce tu PIN</div>

      <div style={LS.keypad}>
        {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => (
          <button key={n} onClick={() => press(String(n))} style={LS.keyBtn}>{n}</button>
        ))}
        <button onClick={back} style={{ ...LS.keyBtn, ...LS.keySecondary }}>⌫</button>
        <button onClick={() => press("0")} style={LS.keyBtn}>0</button>
        <button
          onClick={submit}
          disabled={!pin}
          style={{
            ...LS.keyBtn,
            background: pin ? "#dc2626" : "rgba(255,255,255,0.05)",
            color: pin ? "#fff" : "rgba(255,255,255,0.3)",
            fontSize: 18,
          }}
        >✓</button>
      </div>
    </div>
  );
};

// ───────────────────────────────────────────────────────────────
// Esperando carga
// ───────────────────────────────────────────────────────────────
const WaitingScreen = ({ loader, queuedCount, requesting, onRequest, onLogout }) => (
  <div style={LS.waitRoot}>
    <div style={LS.waitTop}>
      <div style={LS.waitDot} />
      <div style={LS.waitTopText}>EN ESPERA</div>
      <div style={{ flex: 1 }} />
      <img src="assets/pulso-icon.svg" alt="PULSO" style={LS.topLogo}
        onError={(e) => { e.target.style.display = "none"; }} />
      <button onClick={onLogout} style={LS.waitLogout}>Cerrar sesión</button>
    </div>

    <div style={LS.waitBody}>
      <div style={LS.waitGiantNum}>{queuedCount}</div>
      <div style={LS.waitGiantLabel}>cargas en cola</div>
      <div style={LS.waitLoaderName}>{loader?.name} · {loader?.id}</div>
      <div style={LS.waitMuelleHint}>Posición actual: muelle {loader?.muelle_actual || "—"}</div>

      <button
        onClick={onRequest}
        disabled={requesting || queuedCount === 0}
        style={{
          ...LS.waitCTA,
          background: queuedCount === 0 ? "#3f3f3e" : "#dc2626",
          color: queuedCount === 0 ? "rgba(255,255,255,0.4)" : "#fff",
          cursor: queuedCount === 0 ? "not-allowed" : "pointer",
        }}
      >
        {requesting ? "Asignando…" : queuedCount === 0 ? "Sin cargas disponibles" : "Pedir siguiente carga"}
      </button>
    </div>
  </div>
);

// ───────────────────────────────────────────────────────────────
// Carga asignada (la pantalla principal del cargador)
// ───────────────────────────────────────────────────────────────
const AssignedScreen = ({ item, queuedCount, loader, onFinalize }) => {
  const tipoRefr = item.tipo_carga === "REFRIGERADO";
  return (
    <div style={LS.assignRoot}>
      {/* ─── Top bar ─── */}
      <div style={LS.topBar}>
        <div style={LS.topBarLeft}>
          <span style={LS.topGreenDot} />
          <span style={LS.topBarTitle}>CARGA ASIGNADA</span>
        </div>
        <img src="assets/pulso-icon.svg" alt="PULSO" style={LS.topLogo}
          onError={(e) => { e.target.style.display = "none"; }} />
        <div style={LS.topBarRight}>
          <span style={LS.topBarTicket}>#{item.id}</span>
          <span style={LS.topBarSep}>·</span>
          <span style={LS.topBarQueue}>{queuedCount} en cola</span>
        </div>
      </div>

      {/* Scroll body */}
      <div style={LS.assignScroll}>
        {/* ─── Muelle card ─── */}
        <div style={LS.muelleCard}>
          <div style={LS.muelleHeadRow}>
            <span style={LS.muelleLabel}>MUELLE</span>
            <span style={LS.muellePill}>P-{item.playa ? Math.ceil((parseInt(item.playa, 10) || 0) / 100) || 1 : 1}</span>
          </div>
          {/* Viaje combinado: mostrar todos los centros */}
          {item.is_combined && item.trip_destinos && item.trip_destinos.length > 1 && (
            <div style={{
              fontSize: 10.5, fontWeight: 700, color: "#6d28d9",
              background: "#f5f3ff", borderRadius: 6, padding: "6px 10px",
              letterSpacing: 0.5, marginBottom: 6,
            }}>
              VIAJE COMBINADO: {item.trip_destinos.join(" → ")}
            </div>
          )}
          <div style={LS.muelleRow}>
            <div style={LS.muelleNum}>{(item.muelle || "—").padStart(2, "0")}</div>
            <div style={LS.muelleMeta}>
              <div style={LS.muelleMetaRow}>
                <div style={LS.muelleMetaLabel}>PLAYA</div>
                <div style={LS.muelleMetaValue}>{item.playa || "—"}</div>
              </div>
              <div style={LS.muelleMetaRow}>
                <div style={LS.muelleMetaLabel}>SALIDA</div>
                <div style={LS.muelleMetaValue}>{item.hora_salida || "—"}</div>
              </div>
            </div>
          </div>
          <div style={LS.muelleFoot}>
            <span style={LS.muelleFootKey}>TRACTORA</span> <span style={LS.muelleFootVal}>{item.tractora || "—"}</span>
            <span style={LS.muelleFootSep}>·</span>
            <span style={LS.muelleFootKey}>REMOLQUE</span> <span style={LS.muelleFootVal}>{item.remolque || "—"}</span>
            <span style={LS.muelleFootSep}>·</span>
            <span style={LS.muelleFootKey}>CAM</span> <span style={LS.muelleFootVal}>{(item.cam || "").toString().padStart(3, "0")}</span>
            {item.cod_centro && (
              <>
                <span style={LS.muelleFootSep}>·</span>
                <span style={LS.muelleFootKey}>CLIENTE</span> <span style={LS.muelleFootVal}>{item.cod_centro}</span>
              </>
            )}
          </div>
        </div>

        {/* ─── Comentario del supervisor ─── */}
        {item.comment && (
          <div style={LS.commentCard}>
            <div style={LS.commentHead}>
              <span style={LS.commentIcon}>📌</span>
              <span style={LS.commentLabel}>NOTA DEL SUPERVISOR</span>
            </div>
            <div style={LS.commentText}>{item.comment}</div>
          </div>
        )}

        {/* ─── QR card ─── */}
        <div style={LS.qrCard}>
          <div style={LS.qrCardHead}>
            <span style={LS.qrCardKicker}>CARGA TEKU · CÓDIGO BLEECKER</span>
            <span style={{
              ...LS.tipoPill,
              background: tipoRefr ? "#0ea5e9" : "#fb923c",
              color: "#fff",
            }}>
              {tipoRefr ? "❄ REFRIGERADO" : "☼ AMBIENTE"}
            </span>
          </div>
          <div style={LS.qrCardTitle}>EXP. {(item.destino || "").toUpperCase()}</div>
          <div style={LS.qrWrap}>
            {item.qr_png_b64 ? (
              <img src={item.qr_png_b64} alt="QR" style={LS.qrImg} />
            ) : (
              <div style={LS.qrPlaceholder}>QR no disponible</div>
            )}
          </div>
          <div style={LS.qrSubtle}>QR TEKU / BLEECKER</div>
          <div style={LS.qrFoot}>
            <div style={LS.qrFootL}>{item.agencia || ""} {item.cif ? ` · CIF ${item.cif}` : ""}</div>
            <div style={LS.qrFootR}>{(item.queued_at || "").replace("T", " ").slice(0, 16)}</div>
          </div>
        </div>

        {/* ─── Precintos ─── */}
        <div style={LS.precSec}>
          <div style={LS.precHead}>
            <div style={LS.precTitle}>Precintos</div>
            <div style={LS.precCount}>{(item.precintos || []).length} PRECINTO{(item.precintos || []).length !== 1 ? "S" : ""}</div>
          </div>
          <div style={LS.precList}>
            {(item.precintos || []).map((p, i) => (
              <PrecintoRow
                key={`${p.precinto}-${i}`}
                index={i + 1}
                total={item.precintos.length}
                centro={p.centro || item.destino}
                code={p.precinto}
              />
            ))}
            {(item.precintos || []).length === 0 && (
              <div style={LS.precEmpty}>Sin precintos asignados</div>
            )}
          </div>
        </div>

        <div style={{ height: 100 }} /> {/* spacer para el botón fijo */}
      </div>

      {/* ─── Botón finalizar (fijo) ─── */}
      <button onClick={onFinalize} style={LS.finalizeBtn}>
        <span style={{ fontSize: 17, fontWeight: 700 }}>✓</span>
        <span>FINALIZAR CARGA</span>
      </button>
    </div>
  );
};

const PrecintoRow = ({ index, total, centro, code }) => (
  <div style={LS.precRow}>
    <div style={LS.precRowHead}>
      <div style={LS.precRowCentro}>EXP. {(centro || "").toUpperCase()}</div>
      <div style={LS.precRowIdx}>{String(index).padStart(2, "0")}/{String(total).padStart(2, "0")}</div>
    </div>
    <div style={LS.precRowCode}>{code}</div>
    <Barcode code={code} />
  </div>
);

// Barcode Code128 (real, escaneable). Auto-detecta subset C (todo dígitos par)
// para mejor densidad, si no usa subset B (alfanumérico).
const C128_PATTERNS = [
  "212222","222122","222221","121223","121322","131222","122213","122312","132212","221213",
  "221312","231212","112232","122132","122231","113222","123122","123221","223211","221132",
  "221231","213212","223112","312131","311222","321122","321221","312212","322112","322211",
  "212123","212321","232121","111323","131123","131321","112313","132113","132311","211313",
  "231113","231311","112133","112331","132131","113123","113321","133121","313121","211331",
  "231131","213113","213311","213131","311123","311321","331121","312113","312311","332111",
  "314111","221411","431111","111224","111422","121124","121421","141122","141221","112214",
  "112412","122114","122411","142112","142211","241211","221114","413111","241112","134111",
  "111242","121142","121241","114212","124112","124211","411212","421112","421211","212141",
  "214121","412121","111143","111341","131141","114113","114311","411113","411311","113141",
  "114131","311141","411131",
  "211412", // 103 Start A
  "211214", // 104 Start B
  "211232", // 105 Start C
  "2331112",// 106 Stop (7 elementos)
];

function encodeCode128(text) {
  text = String(text || "");
  const useC = /^\d+$/.test(text) && text.length >= 2 && text.length % 2 === 0;
  const values = [];
  if (useC) {
    values.push(105);
    for (let i = 0; i < text.length; i += 2) values.push(parseInt(text.substr(i, 2), 10));
  } else {
    values.push(104);
    for (const c of text) {
      const cc = c.charCodeAt(0);
      values.push(Math.max(0, Math.min(94, cc - 32)));
    }
  }
  // Checksum
  let sum = values[0];
  for (let i = 1; i < values.length; i++) sum += values[i] * i;
  values.push(sum % 103);
  values.push(106); // Stop
  return values;
}

const Barcode = ({ code, height = 36 }) => {
  const values = encodeCode128(code);
  const unit = 1.3; // px por módulo
  const bars = [];
  let x = 0;
  for (const v of values) {
    const pat = C128_PATTERNS[v];
    if (!pat) continue;
    for (let k = 0; k < pat.length; k++) {
      const w = parseInt(pat[k], 10) * unit;
      if (k % 2 === 0) bars.push({ x, w });
      x += w;
    }
  }
  const totalW = x;
  return (
    <svg
      viewBox={`0 0 ${totalW} ${height}`}
      width={totalW}
      height={height}
      style={{ display: "block", marginTop: 6, maxWidth: "100%" }}
    >
      {bars.map((b, i) => (
        <rect key={i} x={b.x} y="0" width={b.w} height={height} fill="#1c1917" />
      ))}
    </svg>
  );
};

// ───────────────────────────────────────────────────────────────
// Diálogo confirmación
// ───────────────────────────────────────────────────────────────
const ConfirmDialog = ({ item, onCancel, onConfirm }) => (
  <div style={LS.dialogOverlay} onClick={onCancel}>
    <div style={LS.dialogCard} onClick={(e) => e.stopPropagation()}>
      <div style={LS.dialogIcon}>
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#dc2626" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
          <line x1="12" y1="9" x2="12" y2="13" />
          <line x1="12" y1="17" x2="12.01" y2="17" />
        </svg>
      </div>
      <div style={LS.dialogTitle}>¿Finalizar la carga del Muelle {(item.muelle || "").padStart(2, "0")}?</div>
      <div style={LS.dialogExp}>EXP. {(item.destino || "").toUpperCase()}</div>
      <div style={LS.dialogMeta}>
        {(item.precintos || []).length} PRECINTOS · PLAYA {item.playa} · {item.tractora}
      </div>
      <button onClick={onConfirm} style={LS.dialogBtnPri}>
        <span style={{ fontWeight: 700 }}>✓</span>
        <span>CONFIRMAR</span>
      </button>
      <button onClick={onCancel} style={LS.dialogBtnSec}>CANCELAR</button>
    </div>
  </div>
);

// ───────────────────────────────────────────────────────────────
// Carga completada → siguiente
// ───────────────────────────────────────────────────────────────
const CompleteScreen = ({ info, queuedCount }) => (
  <div style={LS.completeRoot}>
    <div style={LS.completeCheckWrap}>
      <svg width="56" height="56" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ position: "relative", zIndex: 2 }}>
        <polyline points="20 6 9 17 4 12" />
      </svg>
      <div style={LS.completeCheckRing} />
    </div>
    <div style={LS.completeTitle}>CARGA COMPLETADA</div>
    {info && (
      <div style={LS.completeMeta}>
        MUELLE {(info.muelle || "").padStart(2, "0")} · {info.time}
      </div>
    )}

    <div style={LS.completeDivider} />

    <div style={LS.completeNextLabel}>Asignando siguiente carga...</div>
    <div style={LS.completeQueue}>{queuedCount} en cola</div>

    <div style={LS.algoGrid}>
      <AlgoChip label="Prioridad" check />
      <AlgoChip label="Hora salida" check />
      <AlgoChip label="Dist. muelle" check />
      <AlgoChip label="Tipo carga" />
      <AlgoChip label="Soportes" />
      <AlgoChip label="Urgencias" />
    </div>
  </div>
);

const AlgoChip = ({ label, check }) => (
  <div style={LS.algoChip}>
    <span style={{ fontSize: 10, letterSpacing: 0.8, color: "#a8a29e", textTransform: "uppercase" }}>{label}</span>
    {check ? (
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
        <polyline points="20 6 9 17 4 12" />
      </svg>
    ) : (
      <span style={{ width: 11, height: 11, borderRadius: 3, border: "1px solid #57534e" }} />
    )}
  </div>
);

// ───────────────────────────────────────────────────────────────
// Toast simple
// ───────────────────────────────────────────────────────────────
const Toast = ({ text }) => (
  <div style={LS.toast}>{text}</div>
);

// ───────────────────────────────────────────────────────────────
// Estilos
// ───────────────────────────────────────────────────────────────
const LS = {
  root: {
    width: "100%",
    minHeight: "100%", height: "100%",
    background: "#f4f4f3",
    fontFamily: "'Inter Tight', Inter, system-ui, sans-serif",
    color: "#1c1917",
    position: "relative",
    overflowX: "hidden",
    maxWidth: 480,
    margin: "0 auto",
    boxShadow: "0 0 24px rgba(0,0,0,0.06)",
  },

  // ── Login ────────────────────────────────────
  loginRoot: { width: "100%", minHeight: "100%", height: "100%", background: "#0c0a09", display: "flex", flexDirection: "column", alignItems: "center", padding: "60px 24px 32px", color: "#fafaf9" },
  loginLogoBox: { display: "flex", flexDirection: "column", alignItems: "center", gap: 10, marginBottom: 56 },
  loginLogo: { width: 64, height: 64, borderRadius: 14, background: "#dc2626", display: "grid", placeItems: "center", color: "#fff", fontSize: 32, fontWeight: 800, letterSpacing: -1 },
  loginBrand: { fontSize: 22, fontWeight: 800, letterSpacing: 2, marginTop: 4 },
  loginSubtitle: { fontSize: 12, color: "rgba(255,255,255,0.5)", letterSpacing: 0.3 },
  pinRow: { display: "flex", gap: 12, marginBottom: 14 },
  pinDot: { width: 14, height: 14, borderRadius: "50%", border: "2px solid rgba(255,255,255,0.25)", transition: "all 160ms" },
  pinHint: { fontSize: 12, color: "rgba(255,255,255,0.5)", marginBottom: 36, letterSpacing: 0.5, textTransform: "uppercase" },
  keypad: { display: "grid", gridTemplateColumns: "repeat(3, 80px)", gap: 14, justifyContent: "center" },
  keyBtn: { width: 80, height: 80, borderRadius: "50%", background: "rgba(255,255,255,0.06)", color: "#fafaf9", border: "1px solid rgba(255,255,255,0.08)", fontSize: 26, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", userSelect: "none" },
  keySecondary: { background: "rgba(255,255,255,0.03)", fontSize: 22, color: "rgba(255,255,255,0.6)" },

  // ── Waiting ──────────────────────────────────
  waitRoot: { width: "100%", minHeight: "100%", height: "100%", background: "#0c0a09", display: "flex", flexDirection: "column", color: "#fafaf9" },
  waitTop: { display: "flex", alignItems: "center", gap: 8, padding: "18px 20px", borderBottom: "1px solid rgba(255,255,255,0.06)" },
  waitDot: { width: 9, height: 9, borderRadius: "50%", background: "#fbbf24", boxShadow: "0 0 0 4px rgba(251,191,36,0.18)" },
  waitTopText: { fontSize: 11, fontWeight: 700, letterSpacing: 1.2 },
  waitLogout: { background: "transparent", border: "1px solid rgba(255,255,255,0.1)", color: "rgba(255,255,255,0.6)", padding: "5px 10px", borderRadius: 6, fontSize: 11, cursor: "pointer", fontFamily: "inherit" },
  waitBody: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "0 28px", textAlign: "center" },
  waitGiantNum: { fontSize: 130, fontWeight: 700, letterSpacing: -6, lineHeight: 1, color: "#fafaf9" },
  waitGiantLabel: { fontSize: 16, color: "rgba(255,255,255,0.55)", marginTop: -6, marginBottom: 36, letterSpacing: 0.5 },
  waitLoaderName: { fontSize: 14, fontWeight: 600, color: "#fafaf9" },
  waitMuelleHint: { fontSize: 12, color: "rgba(255,255,255,0.45)", marginTop: 4, marginBottom: 48 },
  waitCTA: { width: "100%", maxWidth: 420, padding: "20px 24px", borderRadius: 14, border: "none", fontSize: 16, fontWeight: 700, letterSpacing: 0.5, fontFamily: "inherit", textTransform: "uppercase" },

  // Logo pequeño en barras superiores
  topLogo: { width: 28, height: 28, borderRadius: 7, flexShrink: 0, margin: "0 8px" },

  // ── Top bar (carga asignada) ─────────────────
  assignRoot: { width: "100%", minHeight: "100%", height: "100%", display: "flex", flexDirection: "column", background: "#f4f4f3", position: "relative" },
  topBar: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 18px", background: "#fff", borderBottom: "1px solid #e7e5e4", flexShrink: 0 },
  topBarLeft: { display: "flex", alignItems: "center", gap: 8 },
  topGreenDot: { width: 9, height: 9, borderRadius: "50%", background: "#22c55e", boxShadow: "0 0 0 4px rgba(34,197,94,0.18)" },
  topBarTitle: { fontSize: 11, fontWeight: 700, letterSpacing: 1.2, color: "#1c1917" },
  topBarRight: { display: "flex", alignItems: "center", gap: 6, fontFamily: "ui-monospace, 'JetBrains Mono', monospace" },
  topBarTicket: { fontSize: 11, fontWeight: 600, color: "#1c1917" },
  topBarSep: { fontSize: 11, color: "#d6d3d1" },
  topBarQueue: { fontSize: 11, color: "#78716c", textTransform: "uppercase", letterSpacing: 0.5 },

  assignScroll: { flex: 1, overflowY: "auto", padding: "12px 14px 12px", WebkitOverflowScrolling: "touch" },

  // ── Muelle card ──────────────────────────────
  muelleCard: { background: "#0c0a09", color: "#fafaf9", borderRadius: 14, padding: "16px 18px", boxShadow: "0 1px 2px rgba(0,0,0,0.04)" },
  muelleHeadRow: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  muelleLabel: { fontSize: 10, fontWeight: 700, letterSpacing: 1.6, color: "rgba(255,255,255,0.55)", textTransform: "uppercase" },
  muellePill: { fontSize: 10, fontWeight: 700, letterSpacing: 0.8, color: "#0c0a09", background: "#fafaf9", padding: "3px 8px", borderRadius: 4, fontFamily: "ui-monospace, monospace" },
  muelleRow: { display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12, marginTop: -2 },
  muelleNum: { fontSize: 96, fontWeight: 700, letterSpacing: -5, lineHeight: 0.95, fontFamily: "'Inter Tight', Inter, sans-serif" },
  muelleMeta: { display: "flex", flexDirection: "column", gap: 6, paddingBottom: 12 },
  muelleMetaRow: { display: "flex", flexDirection: "column", alignItems: "flex-end", lineHeight: 1.1 },
  muelleMetaLabel: { fontSize: 9, fontWeight: 700, letterSpacing: 1.5, color: "rgba(255,255,255,0.45)" },
  muelleMetaValue: { fontSize: 17, fontWeight: 700, letterSpacing: -0.4, fontFamily: "ui-monospace, monospace" },
  muelleFoot: { marginTop: 10, paddingTop: 12, borderTop: "1px solid rgba(255,255,255,0.08)", fontSize: 10.5, color: "rgba(255,255,255,0.7)", display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", fontFamily: "ui-monospace, monospace" },
  muelleFootKey: { color: "rgba(255,255,255,0.4)", letterSpacing: 0.5 },
  muelleFootVal: { color: "#fafaf9", fontWeight: 600 },
  muelleFootSep: { color: "rgba(255,255,255,0.25)", margin: "0 2px" },

  // ── Comentario supervisor ────────────────────
  commentCard: { background: "#fffbeb", borderRadius: 12, padding: "12px 14px", marginTop: 10, border: "1px solid #fde68a" },
  commentHead: { display: "flex", alignItems: "center", gap: 6, marginBottom: 6 },
  commentIcon: { fontSize: 14, lineHeight: 1 },
  commentLabel: { fontSize: 9.5, fontWeight: 700, letterSpacing: 1.2, color: "#92400e", textTransform: "uppercase" },
  commentText: { fontSize: 14, fontWeight: 500, color: "#1c1917", lineHeight: 1.5 },

  // ── QR card ───────────────────────────────────
  qrCard: { background: "#fff", borderRadius: 14, padding: "14px 16px 16px", marginTop: 10, boxShadow: "0 1px 2px rgba(0,0,0,0.04)", border: "1px solid #e7e5e4" },
  qrCardHead: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  qrCardKicker: { fontSize: 9.5, fontWeight: 700, letterSpacing: 1.2, color: "#a8a29e", textTransform: "uppercase" },
  tipoPill: { fontSize: 10, fontWeight: 700, letterSpacing: 0.8, padding: "4px 9px", borderRadius: 4, textTransform: "uppercase" },
  qrCardTitle: { fontSize: 17, fontWeight: 700, letterSpacing: -0.4, marginTop: 8, color: "#1c1917" },
  qrWrap: { display: "flex", justifyContent: "center", marginTop: 14, marginBottom: 8 },
  qrImg: { width: 200, height: 200, imageRendering: "pixelated", border: "1px solid #f4f4f3", borderRadius: 4 },
  qrPlaceholder: { width: 200, height: 200, background: "#fafaf9", display: "grid", placeItems: "center", color: "#a8a29e", fontSize: 11, border: "1px dashed #d6d3d1", borderRadius: 4 },
  qrSubtle: { textAlign: "center", fontSize: 10, fontWeight: 700, letterSpacing: 1.6, color: "#a8a29e", textTransform: "uppercase", marginBottom: 12 },
  qrFoot: { display: "flex", justifyContent: "space-between", paddingTop: 10, borderTop: "1px solid #f4f4f3", fontSize: 10, color: "#78716c", fontFamily: "ui-monospace, monospace" },
  qrFootL: { letterSpacing: 0.2 },
  qrFootR: { letterSpacing: 0.2 },

  // ── Precintos ─────────────────────────────────
  precSec: { background: "#fff", borderRadius: 14, padding: "14px 16px 12px", marginTop: 10, border: "1px solid #e7e5e4" },
  precHead: { display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 10 },
  precTitle: { fontSize: 15, fontWeight: 700, color: "#1c1917" },
  precCount: { fontSize: 10, fontWeight: 700, letterSpacing: 1.2, color: "#a8a29e", textTransform: "uppercase" },
  precList: { display: "flex", flexDirection: "column", gap: 8 },
  precRow: { borderTop: "1px solid #f4f4f3", paddingTop: 10 },
  precRowHead: { display: "flex", justifyContent: "space-between", alignItems: "center" },
  precRowCentro: { fontSize: 10, fontWeight: 700, letterSpacing: 0.8, color: "#a8a29e", textTransform: "uppercase" },
  precRowIdx: { fontSize: 10, fontWeight: 600, letterSpacing: 0.5, color: "#a8a29e", fontFamily: "ui-monospace, monospace" },
  precRowCode: { fontSize: 17, fontWeight: 700, letterSpacing: -0.2, color: "#1c1917", fontFamily: "ui-monospace, monospace", marginTop: 2 },
  precEmpty: { fontSize: 12, color: "#a8a29e", textAlign: "center", padding: "12px 0" },
  barcode: { display: "flex", alignItems: "stretch", gap: 0, height: 28, marginTop: 6 },

  // ── Botón finalizar ────────────────────────────
  finalizeBtn: { position: "sticky", bottom: 0, left: 0, right: 0, width: "100%", padding: "20px 18px", background: "#dc2626", color: "#fff", border: "none", fontSize: 16, fontWeight: 700, letterSpacing: 1.2, textTransform: "uppercase", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, cursor: "pointer", fontFamily: "inherit", boxShadow: "0 -4px 16px rgba(0,0,0,0.08)" },

  // ── Diálogo ──────────────────────────────────
  dialogOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", padding: 24, zIndex: 100 },
  dialogCard: { background: "#fff", borderRadius: 14, padding: "28px 24px 18px", width: "100%", maxWidth: 360, textAlign: "left", boxShadow: "0 20px 50px rgba(0,0,0,0.25)" },
  dialogIcon: { width: 56, height: 56, borderRadius: 12, background: "#fee2e2", display: "grid", placeItems: "center", marginBottom: 16 },
  dialogTitle: { fontSize: 19, fontWeight: 700, letterSpacing: -0.4, lineHeight: 1.25, color: "#1c1917", marginBottom: 12 },
  dialogExp: { fontSize: 12, fontWeight: 700, letterSpacing: 0.5, color: "#dc2626", textTransform: "uppercase" },
  dialogMeta: { fontSize: 11, color: "#78716c", marginTop: 4, marginBottom: 22, fontFamily: "ui-monospace, monospace", letterSpacing: 0.2 },
  dialogBtnPri: { width: "100%", padding: "16px 18px", background: "#dc2626", color: "#fff", border: "none", borderRadius: 10, fontSize: 14, fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, cursor: "pointer", fontFamily: "inherit", marginBottom: 8 },
  dialogBtnSec: { width: "100%", padding: "14px 18px", background: "#fff", color: "#1c1917", border: "1px solid #e7e5e4", borderRadius: 10, fontSize: 13, fontWeight: 600, letterSpacing: 0.5, textTransform: "uppercase", cursor: "pointer", fontFamily: "inherit" },

  // ── Pantalla completada ─────────────────────
  completeRoot: { width: "100%", minHeight: "100%", height: "100%", background: "#0c0a09", color: "#fafaf9", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px 28px", textAlign: "center" },
  completeCheckWrap: { position: "relative", width: 88, height: 88, borderRadius: "50%", background: "#22c55e", display: "grid", placeItems: "center", marginBottom: 24 },
  completeCheckRing: { position: "absolute", inset: -10, borderRadius: "50%", border: "2px solid rgba(34,197,94,0.3)", animation: "pulse 1.6s ease-out infinite" },
  completeTitle: { fontSize: 14, fontWeight: 700, letterSpacing: 2, textTransform: "uppercase" },
  completeMeta: { fontSize: 11, color: "rgba(255,255,255,0.5)", marginTop: 6, letterSpacing: 0.5, fontFamily: "ui-monospace, monospace" },
  completeDivider: { width: 40, height: 1, background: "rgba(255,255,255,0.2)", margin: "32px 0 28px" },
  completeNextLabel: { fontSize: 16, fontWeight: 600, color: "#fafaf9" },
  completeQueue: { fontSize: 11, color: "rgba(255,255,255,0.5)", marginTop: 4, letterSpacing: 0.5, textTransform: "uppercase" },
  algoGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 28, width: "100%", maxWidth: 320 },
  algoChip: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "9px 12px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.06)", borderRadius: 8 },

  // ── Toast ────────────────────────────────────
  toast: { position: "fixed", bottom: 90, left: "50%", transform: "translateX(-50%)", background: "rgba(28,25,23,0.95)", color: "#fff", padding: "10px 18px", borderRadius: 999, fontSize: 13, fontWeight: 500, zIndex: 200, boxShadow: "0 10px 30px rgba(0,0,0,0.3)" },
};

window.LoaderApp = LoaderApp;
