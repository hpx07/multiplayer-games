@echo off
title System Process Manager v4.0
color 0A
echo ============================================================
echo  SYSTEM PROCESS MANAGER v4.0
echo  Games: Tic-Tac-Toe  |  Bingo  |  Dots and Boxes
echo ============================================================
echo.
node --version >nul 2>&1
if errorlevel 1 (
    echo ERROR: Node.js not installed! Get it from https://nodejs.org/
    pause & exit
)
echo [OK] Node.js found
echo.
echo Installing dependencies...
call npm install --silent
echo [OK] Ready
echo.
echo ============================================================
echo  YOUR LAN IP (share with players):
ipconfig | findstr /i "IPv4"
echo.
echo  Players visit: http://YOUR_IP_ABOVE:3000
echo  Press Ctrl+C to stop
echo ============================================================
echo.
node server.js
pause
