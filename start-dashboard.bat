@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing required dependency...
  call npm install
  if errorlevel 1 (
    echo npm install failed. Ensure Node.js and npm are installed.
    pause
    exit /b 1
  )
)
start "" http://127.0.0.1:8765
call npm start
pause
