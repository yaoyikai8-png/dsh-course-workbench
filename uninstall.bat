@echo off
chcp 65001 >nul 2>&1
setlocal

cd /d "%~dp0"

echo ==========================================
echo    课程工作台  Course Workbench  卸载
echo ==========================================
echo.
echo 这会删掉 ~/.dsh/skills 下的五个技能和 ~/.dsh/tools 里的 PDF 工具。
echo 你自己的课程文件夹和已经生成的笔记都不会被动。
echo.

set /p CONFIRM=确认卸载吗？输入 y 回车：
if /i not "%CONFIRM%"=="y" (
  echo 已取消。
  echo.
  pause
  exit /b 0
)

if not exist "scripts\uninstall.ps1" (
  echo [X] 找不到 scripts\uninstall.ps1
  echo.
  pause
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\uninstall.ps1"

echo.
echo 面板本身请到 DSH 的 plugin manager 里移除。
echo.
pause
endlocal
