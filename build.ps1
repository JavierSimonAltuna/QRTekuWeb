# -----------------------------------------------------------
# Genera dist\Pulso.exe usando PyInstaller
#
# Uso:
#   .\build.ps1
#
# Requiere haber instalado deps:
#   python -m pip install -r requirements.txt
# -----------------------------------------------------------

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Generar icono si no existe
if (-not (Test-Path "Pulso.ico")) {
    Write-Host "Generando Pulso.ico..." -ForegroundColor Cyan
    python make_ico.py
}

# Limpiar builds previos
foreach ($d in @("build", "dist")) {
    if (Test-Path $d) {
        Write-Host "Limpiando $d..." -ForegroundColor Yellow
        Remove-Item -Recurse -Force $d
    }
}
if (Test-Path "Pulso.spec") { Remove-Item -Force "Pulso.spec" }

# Construir
Write-Host ""
Write-Host "Construyendo Pulso.exe..." -ForegroundColor Cyan

python -m PyInstaller `
    --name Pulso `
    --onefile `
    --windowed `
    --icon="Pulso.ico" `
    --add-data "web;web" `
    --collect-all pywebview `
    --hidden-import pyodbc `
    --hidden-import barcode `
    --hidden-import openpyxl `
    --hidden-import xlrd `
    --hidden-import tkinter `
    --hidden-import tkinter.filedialog `
    main.py

# Resultado
Write-Host ""
if (Test-Path "dist\Pulso.exe") {
    Write-Host "=============================================" -ForegroundColor Green
    Write-Host "  OK  Tu .exe esta en:  dist\Pulso.exe" -ForegroundColor Green
    Write-Host "=============================================" -ForegroundColor Green
} else {
    Write-Host "=============================================" -ForegroundColor Red
    Write-Host "  ERROR  El .exe NO se ha generado." -ForegroundColor Red
    Write-Host "  Revisa los mensajes de arriba." -ForegroundColor Red
    Write-Host "=============================================" -ForegroundColor Red
    exit 1
}
