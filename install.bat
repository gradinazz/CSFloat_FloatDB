@echo off
chcp 65001 >nul
title CSFloat FloatDB — Installer
echo.
echo  ╔══════════════════════════════════════════════╗
echo  ║       CSFloat FloatDB — Установка            ║
echo  ╚══════════════════════════════════════════════╝
echo.

:: ── 1. Проверка Node.js ──
echo [1/5] Проверка Node.js...
node --version >nul 2>&1
if errorlevel 1 (
    echo   [X] Node.js не найден! Установите с https://nodejs.org/
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('node --version') do echo   [OK] Node.js %%v

:: ── 2. Проверка Python ──
echo.
echo [2/5] Проверка Python...
python --version >nul 2>&1
if errorlevel 1 (
    echo   [X] Python не найден! Установите с https://python.org/ ^(3.10+^)
    echo.
    pause
    exit /b 1
)
for /f "tokens=*" %%v in ('python --version') do echo   [OK] %%v

:: ── 3. Установка npm зависимостей ──
echo.
echo [3/5] Установка npm зависимостей...
cd /d "%~dp0"
call npm install
if errorlevel 1 (
    echo   [X] npm install не удался!
    pause
    exit /b 1
)
echo   [OK] npm зависимости установлены

:: ── 4. Установка Turnstile Solver (BotsForge_CloudFlare) ──
echo.
echo [4/5] Установка Turnstile Solver...

set "SOLVER_DIR=%~dp0solver"

if not exist "%SOLVER_DIR%" (
    echo   Клонирование BotsForge/CloudFlare...
    git clone https://github.com/BotsForge/CloudFlare.git "%SOLVER_DIR%"
    if errorlevel 1 (
        echo   [X] git clone не удался! Установите Git: https://git-scm.com/
        pause
        exit /b 1
    )
) else (
    echo   [OK] Solver уже скачан
)

echo   Установка Python зависимостей solver...
pip install -r "%SOLVER_DIR%\requirements.txt" -q
if errorlevel 1 (
    echo   [X] pip install не удался!
    pause
    exit /b 1
)

echo   Установка Patchright браузера...
python -m patchright install chromium

:: Создание .env для solver (API_KEY)
if not exist "%SOLVER_DIR%\.env" (
    echo API_KEY=floatdb-local-key> "%SOLVER_DIR%\.env"
    echo   [OK] Создан solver\.env с API_KEY
) else (
    echo   [OK] solver\.env уже существует
)

:: Патч solver для совместимости с CSFloat
echo   Применение патчей solver...
cd /d "%~dp0"
node solver-patch.js
echo   [OK] Turnstile Solver установлен и пропатчен

:: ── 5. Создание account.json ──
echo.
echo [5/5] Проверка account.json...

if not exist "%~dp0account.json" (
    echo   [!] account.json не найден.
    echo   Скопирован шаблон account.example.json -^> account.json
    copy "%~dp0account.example.json" "%~dp0account.json" >nul
    echo   Заполните account.json данными Steam аккаунта!
) else (
    echo   [OK] account.json найден
)

:: ── Готово ──
echo.
echo  ╔══════════════════════════════════════════════╗
echo  ║            Установка завершена!               ║
echo  ╚══════════════════════════════════════════════╝
echo.
echo  Следующие шаги:
echo.
echo   1. Заполните account.json данными Steam аккаунта
echo      (если ещё не сделали)
echo.
echo   2. Запустите Turnstile Solver:
echo      start-solver.bat
echo.
echo   3. Запустите поиск:
echo      node index.js --url "https://csfloat.com/db?..."
echo.
pause
