@echo off
setlocal
cd /d "%~dp0"
where npm >nul 2>&1
if errorlevel 1 (
  echo npm is not installed or not on PATH.
  exit /b 1
)
where cargo >nul 2>&1
if errorlevel 1 (
  echo Rust is not installed, install it from https://rustup.rs.
  exit /b 1
)
if not exist node_modules (
  echo Installing npm dependencies.
  call npm install
  if errorlevel 1 exit /b 1
)
echo Starting development app.
call npm run tauri dev
if errorlevel 1 exit /b 1
exit /b 0