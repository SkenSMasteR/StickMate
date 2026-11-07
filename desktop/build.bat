@echo off
setlocal
cd /d "%~dp0"
set "BUILD_FLAG="
set "BUNDLE_DIR=src-tauri\target\release\bundle"
if "%~1"=="--debug" (
  set "BUILD_FLAG=--debug"
  set "BUNDLE_DIR=src-tauri\target\debug\bundle"
) else if not "%~1"=="" (
  echo Unknown argument %~1, expected --debug or no argument.
  exit /b 1
)
if not defined TAURI_SIGNING_PRIVATE_KEY (
  echo Set TAURI_SIGNING_PRIVATE_KEY before building, it is required to sign updater artifacts.
  exit /b 1
)
if not defined TAURI_SIGNING_PRIVATE_KEY_PASSWORD (
  echo Set TAURI_SIGNING_PRIVATE_KEY_PASSWORD before building, it is required to sign updater artifacts.
  exit /b 1
)
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
echo Building bundle.
call npm run tauri build %BUILD_FLAG%
if errorlevel 1 exit /b 1
echo Bundles are in %BUNDLE_DIR%.
exit /b 0