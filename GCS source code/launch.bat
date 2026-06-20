@echo off
title CanSat GCS - Ground Control Station
echo.
echo  ============================================================
echo   CANSAT GROUND CONTROL STATION
echo   Checking Python installation...
echo  ============================================================
echo.

python --version >nul 2>&1
if errorlevel 1 (
    echo  [ERROR] Python is not installed or not in PATH.
    echo  Please install Python 3.8+ from https://python.org
    pause
    exit /b 1
)

echo  [OK] Python found. Starting GCS server...
echo.
echo  Open your browser and navigate to:
echo  ---->   http://localhost:3000
echo.
echo  Press Ctrl+C to stop the server.
echo.

python server.py
pause
