@echo off
chcp 65001 > nul
REM -----------------------------------------------------------
REM Genera dist\Pulso.exe usando PyInstaller
REM
REM Requiere haber instalado deps:
REM   python -m pip install -r requirements.txt
REM -----------------------------------------------------------

REM Icono: usa QRTeku.ico si existe, si no intenta generar Pulso.ico
set ICO_FILE=
if exist QRTeku.ico (
    set ICO_FILE=QRTeku.ico
) else if exist Pulso.ico (
    set ICO_FILE=Pulso.ico
) else if exist make_ico.py (
    echo Generando Pulso.ico...
    python make_ico.py
    if exist Pulso.ico set ICO_FILE=Pulso.ico
)

REM Limpia builds previos
if exist build      rmdir /s /q build
if exist dist       rmdir /s /q dist
if exist Pulso.spec del /f Pulso.spec

REM Construir
if "%ICO_FILE%"=="" (
    echo AVISO: Sin icono encontrado, compilando sin icono...
    python -m PyInstaller ^
      --name Pulso ^
      --onefile ^
      --windowed ^
      --add-data "web;web" ^
      --collect-all pywebview ^
      --hidden-import pyodbc ^
      --hidden-import barcode ^
      --hidden-import openpyxl ^
      --hidden-import xlrd ^
      --hidden-import tkinter ^
      --hidden-import tkinter.filedialog ^
      main.py
) else (
    echo Usando icono: %ICO_FILE%
    python -m PyInstaller ^
      --name Pulso ^
      --onefile ^
      --windowed ^
      --icon="%ICO_FILE%" ^
      --add-data "web;web" ^
      --collect-all pywebview ^
      --hidden-import pyodbc ^
      --hidden-import barcode ^
      --hidden-import openpyxl ^
      --hidden-import xlrd ^
      --hidden-import tkinter ^
      --hidden-import tkinter.filedialog ^
      main.py
)

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
