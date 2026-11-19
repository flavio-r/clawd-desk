@echo off
rem ClawdDesk - dois cliques para abrir (Windows).
rem Na primeira vez configura tudo; nas proximas so inicia o monitor.
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   O Node.js nao esta instalado neste computador.
  echo   1. Abra https://nodejs.org e baixe a versao LTS.
  echo   2. Instale ^(e so avancar^) e abra este arquivo de novo.
  echo.
  pause
  exit /b 1
)

call npm run setup
echo.
pause
