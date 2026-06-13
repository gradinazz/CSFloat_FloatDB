@echo off
chcp 65001 >nul
title Turnstile Solver

set "SOLVER_DIR=%~dp0solver"

if not exist "%SOLVER_DIR%\app.py" (
    echo [X] Solver не установлен! Сначала запустите install.bat
    pause
    exit /b 1
)

echo [Solver] Запуск Turnstile Solver на http://127.0.0.1:5033 ...
echo [Solver] Для остановки закройте это окно или нажмите Ctrl+C
echo.

cd /d "%SOLVER_DIR%"
python app.py
pause
