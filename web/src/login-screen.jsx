// PULSO · Pantalla de inicio de sesión SSO + Email/contraseña
const { useState } = React;

const LoginScreen = () => {
  const [loading, setLoading] = useState(false);
  const [provider, setProvider] = useState(null);
  const [error, setError] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showEmailForm, setShowEmailForm] = useState(false);

  const _afterSignIn = async () => {
    try {
      const r = await window.api.call("check_auth");
      if (r && !r.allowed) {
        await window.PulsoAuth.signOut();
        setError(`Acceso no permitido para ${r.email || "este usuario"}. Contacta con el administrador.`);
      }
    } catch (_) {}
  };

  const handleSSO = async (providerFn, providerName) => {
    setLoading(true);
    setProvider(providerName);
    setError("");
    try {
      await providerFn();
      await _afterSignIn();
    } catch (e) {
      if (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request") {
        setError("");
      } else if (e.code === "auth/popup-blocked") {
        setError("El navegador bloqueó la ventana emergente. Permite las ventanas emergentes para este sitio.");
      } else {
        setError(e.message || "Error al iniciar sesión");
      }
    } finally {
      setLoading(false);
      setProvider(null);
    }
  };

  const handleEmailSignIn = async (e) => {
    e.preventDefault();
    if (!email || !password) return;
    setLoading(true);
    setProvider("email");
    setError("");
    try {
      await window.PulsoAuth.signInWithEmail(email, password);
      await _afterSignIn();
    } catch (e) {
      if (e.code === "auth/user-not-found" || e.code === "auth/wrong-password" || e.code === "auth/invalid-credential") {
        setError("Email o contraseña incorrectos.");
      } else if (e.code === "auth/too-many-requests") {
        setError("Demasiados intentos fallidos. Espera un momento.");
      } else if (e.code === "auth/user-disabled") {
        setError("Esta cuenta está desactivada.");
      } else {
        setError(e.message || "Error al iniciar sesión");
      }
    } finally {
      setLoading(false);
      setProvider(null);
    }
  };

  const btnSSO = {
    display: "flex", alignItems: "center", justifyContent: "center", gap: 10,
    width: "100%", padding: "11px 20px", borderRadius: 9, border: "1px solid #e7e5e4",
    background: "#fff", color: "#1c1917", fontSize: 13.5, fontWeight: 600,
    fontFamily: "inherit", cursor: "pointer", transition: "background 0.12s",
  };

  const inputStyle = {
    width: "100%", padding: "9px 11px", borderRadius: 8, fontSize: 13.5,
    border: "1px solid #d6d3d1", fontFamily: "inherit", outline: "none",
    boxSizing: "border-box", color: "#1c1917", background: "#fafaf9",
  };

  const btnPrimary = {
    width: "100%", padding: "11px", borderRadius: 9, border: "none",
    background: "#dc2626", color: "#fff", fontSize: 13.5, fontWeight: 700,
    fontFamily: "inherit", cursor: loading ? "not-allowed" : "pointer",
    opacity: loading ? 0.65 : 1,
  };

  return (
    <div style={{
      position: "fixed", inset: 0, display: "flex", alignItems: "center", justifyContent: "center",
      background: "#fafaf9", fontFamily: "'Inter Tight', Inter, system-ui, sans-serif",
    }}>
      <div style={{
        width: 380, maxWidth: "92vw", background: "#fff", borderRadius: 18,
        padding: "38px 34px", boxShadow: "0 8px 40px rgba(0,0,0,0.10), 0 1px 3px rgba(0,0,0,0.06)",
        border: "1px solid #f5f5f4",
      }}>
        {/* Logo */}
        <div style={{ textAlign: "center", marginBottom: 24 }}>
          <img src="assets/logo-rojo.png" alt="PULSO" style={{ height: 40, width: "auto" }}
            onError={e => { e.target.style.display = "none"; e.target.nextElementSibling.style.display = "flex"; }} />
          <div style={{
            display: "none", width: 46, height: 46, background: "#dc2626", borderRadius: 12,
            alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 22,
            fontWeight: 800, margin: "0 auto", boxShadow: "0 4px 14px rgba(220,38,38,0.25)",
          }}>P</div>
        </div>

        <div style={{ textAlign: "center", marginBottom: 26 }}>
          <div style={{ fontSize: 19, fontWeight: 700, color: "#1c1917", marginBottom: 3 }}>Acceder a PULSO</div>
          <div style={{ fontSize: 12.5, color: "#78716c" }}>Garvasa · Sistema de gestión de cargas</div>
        </div>

        {/* Botones SSO */}
        <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
          <button style={{ ...btnSSO, opacity: loading ? 0.6 : 1 }} disabled={loading}
            onClick={() => handleSSO(window.PulsoAuth.signInWithGoogle, "google")}
            onMouseEnter={e => e.currentTarget.style.background = "#f5f5f4"}
            onMouseLeave={e => e.currentTarget.style.background = "#fff"}>
            {loading && provider === "google" ? "Iniciando sesión…" : (
              <><svg width="17" height="17" viewBox="0 0 24 24">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>Acceder con Google</>
            )}
          </button>

          <button style={{ ...btnSSO, opacity: loading ? 0.6 : 1 }} disabled={loading}
            onClick={() => handleSSO(window.PulsoAuth.signInWithMicrosoft, "microsoft")}
            onMouseEnter={e => e.currentTarget.style.background = "#f5f5f4"}
            onMouseLeave={e => e.currentTarget.style.background = "#fff"}>
            {loading && provider === "microsoft" ? "Iniciando sesión…" : (
              <><svg width="17" height="17" viewBox="0 0 23 23">
                <rect x="1" y="1" width="10" height="10" fill="#f25022"/>
                <rect x="12" y="1" width="10" height="10" fill="#7fba00"/>
                <rect x="1" y="12" width="10" height="10" fill="#00a4ef"/>
                <rect x="12" y="12" width="10" height="10" fill="#ffb900"/>
              </svg>Acceder con Microsoft 365</>
            )}
          </button>
        </div>

        {/* Separador */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "18px 0" }}>
          <div style={{ flex: 1, height: 1, background: "#e7e5e4" }} />
          <span style={{ fontSize: 11.5, color: "#a8a29e", fontWeight: 500 }}>o con email</span>
          <div style={{ flex: 1, height: 1, background: "#e7e5e4" }} />
        </div>

        {/* Formulario email/contraseña */}
        {!showEmailForm ? (
          <button
            style={{ ...btnSSO, color: "#57534e", fontSize: 13 }}
            onClick={() => setShowEmailForm(true)}
            onMouseEnter={e => e.currentTarget.style.background = "#f5f5f4"}
            onMouseLeave={e => e.currentTarget.style.background = "#fff"}>
            Usar email y contraseña
          </button>
        ) : (
          <form onSubmit={handleEmailSignIn} style={{ display: "flex", flexDirection: "column", gap: 9 }}>
            <input
              style={inputStyle} type="email" placeholder="Email" value={email} autoFocus
              onChange={e => setEmail(e.target.value)} disabled={loading} required
            />
            <input
              style={inputStyle} type="password" placeholder="Contraseña" value={password}
              onChange={e => setPassword(e.target.value)} disabled={loading} required
            />
            <button type="submit" style={btnPrimary} disabled={loading || !email || !password}>
              {loading && provider === "email" ? "Entrando…" : "Entrar"}
            </button>
          </form>
        )}

        {/* Error */}
        {error && (
          <div style={{
            marginTop: 14, padding: "10px 13px", borderRadius: 8,
            background: "#fef2f2", border: "1px solid #fecaca", color: "#b91c1c", fontSize: 12.5, lineHeight: 1.5,
          }}>{error}</div>
        )}

        <div style={{ marginTop: 20, textAlign: "center", fontSize: 11, color: "#a8a29e" }}>
          Acceso exclusivo para empleados de Garvasa
        </div>
      </div>
    </div>
  );
};

window.LoginScreen = LoginScreen;
