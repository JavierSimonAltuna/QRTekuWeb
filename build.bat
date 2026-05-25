@echo off
chcp 65001 > nul
REM -----------------------------------------------------------
REM Genera dist\QRTeku.exe usando PyInstaller
REM Requiere haber instalado deps:  python -m pip install -r requirements.txt
REM -----------------------------------------------------------

REM Limpia builds previos
if exist build  rmdir /s /q build
if exist dist   rmdir /s /q dist
if exist QRTeku.spec del QRTeku.spec

REM Usa python -m PyInstaller (NO pyinstaller.exe directamente,
REM porque el antivirus corporativo suele bloquearlo)
python -m PyInstaller ^
  --name QRTekuWeb ^
  --onefile ^
  --windowed ^
  --icon="QRTeku.ico" ^
  --add-data "web;web" ^
  --collect-all pywebview ^
  --hidden-import pyodbc ^
  --hidden-import barcode ^
  --hidden-import openpyxl ^
  --hidden-import xlrd ^
  main.py

echo.
if exist dist\QRTekuWeb.exe (
    echo =============================================
    echo  OK  Tu .exe esta en  dist\QRTeku.exe
    echo =============================================
) else (
    echo =============================================
    echo  ERROR  El .exe NO se ha generado
    echo  Revisa los mensajes de arriba para ver
    echo  que ha fallado.
    echo =============================================
)
pause
