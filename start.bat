@echo off
setlocal
cd /d "%~dp0"
title MUTOSHOP

rem ===================================================================
rem  MUTOSHOP 실행기 - 더블클릭하면 필요한 준비를 하고 프로그램 창을 엽니다.
rem ===================================================================

if exist ".venv\Scripts\python.exe" goto web

echo.
echo  [MUTOSHOP] 처음 실행 준비 중입니다. 필요한 구성요소를 설치합니다.
echo             (인터넷 연결 필요, 몇 분 걸릴 수 있어요)
echo.
where py >nul 2>nul
if %errorlevel%==0 (
  py -3.12 -m venv .venv 2>nul || py -3 -m venv .venv
) else (
  python -m venv .venv
)
if not exist ".venv\Scripts\python.exe" goto nopython
".venv\Scripts\python.exe" -m pip install --upgrade pip
".venv\Scripts\python.exe" -m pip install -r server\requirements.txt
if errorlevel 1 goto pipfail

:web
if exist "web\dist\index.html" goto run
echo.
echo  [MUTOSHOP] 편집기 화면을 만드는 중입니다...
where npm >nul 2>nul
if errorlevel 1 goto nonode
pushd web
call npm install
if errorlevel 1 (popd & goto buildfail)
call npm run build
if errorlevel 1 (popd & goto buildfail)
popd

:run
".venv\Scripts\python.exe" server\app.py %*
if errorlevel 1 pause
exit /b 0

:nopython
echo.
echo  Python 3.10 이상이 필요합니다.
echo  https://www.python.org/downloads/ 에서 설치한 뒤 다시 실행해 주세요.
pause
exit /b 1

:pipfail
echo.
echo  구성요소 설치에 실패했습니다. 인터넷 연결을 확인하고 다시 실행해 주세요.
echo  (계속 실패하면 .venv 폴더를 지우고 다시 실행해 보세요)
pause
exit /b 1

:nonode
echo.
echo  편집기 화면을 만들려면 Node.js 가 필요합니다.
echo  https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행해 주세요.
pause
exit /b 1

:buildfail
echo.
echo  편집기 화면을 만드는 중 오류가 났습니다. 위의 메시지를 확인해 주세요.
pause
exit /b 1
