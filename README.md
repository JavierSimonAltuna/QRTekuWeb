# QR Teku · Versión Web/Desktop con PyWebView

App de escritorio Windows que combina:
- **Frontend** moderno en HTML/React (la UI que has visto en el mockup)
- **Backend** Python con tu lógica existente (ODBC a AS400, lectura Excel, generación QR, exportación Word)
- **Distribución** como `.exe` único con PyInstaller — el usuario hace doble clic y se abre la ventana

Sin servidor, sin internet, sin instalar nada. La UI se renderiza dentro de una ventana nativa usando Edge WebView2 (ya viene con Windows 10/11).

---

## 📁 Estructura

```
pywebview-project/
├── main.py              ← Punto de entrada · crea la ventana
├── api.py               ← Bridge: métodos que llama el JS
├── qr_teku_core.py      ← Lógica de negocio (ODBC, Excel, QR, Word)
├── web/
│   └── index.html       ← Frontend bundleado (se genera desde el mockup)
├── requirements.txt     ← Dependencias Python
├── build.bat            ← Generar el .exe con PyInstaller
└── README.md            ← Este archivo
```

---

## ⚙️ Instalación (una vez, en tu máquina de desarrollo)

```bat
cd pywebview-project
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

Necesitas Python 3.10+ y, para ODBC, los drivers de IBM i Access ya instalados (los mismos que ya usa tu app actual).

---

## ▶️ Ejecutar en modo desarrollo

```bat
python main.py
```

Se abre la ventana con la app. Cualquier cambio en `web/index.html` se refleja al recargar (F5 dentro de la ventana).

---

## 🚀 Generar el .exe distribuible

```bat
build.bat
```

Te crea `dist/QRTeku.exe` — ese es el archivo único que copias a las máquinas de los operadores. Pesa ~60 MB porque empaqueta Python + dependencias.

---

## 🔌 Cómo se comunican JS ↔ Python

Desde JS:
```js
const rows = await window.pywebview.api.load_excel("C:/ruta/Cargas.xlsx");
const [cif, agencia] = await window.pywebview.api.lookup_chf("8741JKM");
await window.pywebview.api.generate_word_and_print(payload, "TARRAGONA", precintos);
```

Cada método de `Api` (en `api.py`) está disponible como `window.pywebview.api.<método>(...)` desde el JS. Devuelve siempre una promesa.

---

## 🛠 Próximos pasos para integrar tu código actual

1. **Trasplanta tu lógica de `QRTeku_2.5.py`** a `qr_teku_core.py`:
   - Las funciones `_norm_tractor`, `_safe_str`, `_slug` ya están copiadas.
   - Pega tu `_odbc_lookup_chf` dentro del método del mismo nombre.
   - Pega tu `export_to_word_and_print` dentro de `generate_word_and_print`.
   - Pega tu carga de Excel + detección de fecha B2 + columna precinto dentro de `load_excel`.
2. **Ajusta las constantes** al inicio de `qr_teku_core.py`:
   - `ODBC_DSN`, `ODBC_UID`, `ODBC_PWD`, `TABLE_NAME`, `TABLE_CHF_PATH`, `LOGO_PATH`, `SAVE_DIR`.
3. **Prueba** con `python main.py` y carga un Excel real.
4. **Genera el `.exe`** con `build.bat`.

He dejado **stubs** en `qr_teku_core.py` con tu firma de funciones y `TODO:` marcando dónde pegar lo tuyo. El frontend ya está listo para llamarlos.
