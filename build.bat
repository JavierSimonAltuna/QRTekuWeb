@echo off
chcp 65001 > nul
REM -----------------------------------------------------------
REM Genera dist\Pulso.exe usando PyInstaller
REM
REM Antes de la primera vez (o si cambias el icono):
REM   python make_ico.py
REM
REM Requiere haber instalado deps:
REM   python -m pip install -r requirements.txt
REM -----------------------------------------------------------

REM Generar icono si no existe
if not exist Pulso.ico (
    echo Generando Pulso.ico...
    python make_ico.py
)

REM Limpia builds previos
if exist build      rmdir /s /q build
if exist dist       rmdir /s /q dist
if exist Pulso.spec del /f Pulso.spec

REM Usa python -m PyInstaller (NO pyinstaller.exe directamente,
REM porque el antivirus corporativo suele bloquearlo)
python -m PyInstaller ^
  --name Pulso ^
  --onefile ^
  --windowed ^
  --icon="Pulso.ico" ^
  --add-data "web;web" ^
  --collect-all pywebview ^
  --hidden-import pyodbc ^
  --hidden-import barcode ^
  --hidden-import openpyxl ^
  --hidden-import xlrd ^
  --hidden-import tkinter ^
  --hidden-import tkinter.filedialog ^
  main.py

echo.
if exist dist\Pulso.exe (
    echo =============================================
    echo  OK  Tu .exe esta en:  dist\Pulso.exe
    echo =============================================
) else (
    echo =============================================
    echo  ERROR  El .exe NO se ha generado.
    echo  Revisa los mensajes de arriba.
    echo =============================================
)
pause
