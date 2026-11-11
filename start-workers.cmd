@echo off
setlocal
if not exist "%~dp0src\worker.mjs" (
    echo Coloque este script na pasta do Mini Juiz, junto da pasta src.
    pause
    exit /b 1
)
where node.exe >nul 2>&1
if errorlevel 1 (
    echo Node.js nao encontrado no PATH.
    pause
    exit /b 1
)

start "Mini Juiz - worker-1" /D "%~dp0." "%ComSpec%" /d /k "set WORKER_ID=worker-1&&node src\worker.mjs"
if errorlevel 1 exit /b 1
start "Mini Juiz - worker-2" /D "%~dp0." "%ComSpec%" /d /k "set WORKER_ID=worker-2&&node src\worker.mjs"
exit /b %errorlevel%
