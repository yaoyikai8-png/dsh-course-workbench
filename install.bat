@echo off
chcp 65001 >nul 2>&1
setlocal

cd /d "%~dp0"

echo ==========================================
echo    课程工作台  Course Workbench  安装
echo ==========================================
echo.

if not exist "scripts\install.ps1" (
  echo [X] 找不到 scripts\install.ps1
  echo     请把这个 bat 放在解压出来的 dsh-course-workbench 目录里再双击。
  echo.
  pause
  exit /b 1
)

where python >nul 2>&1
if errorlevel 1 (
  echo [!] 没找到 python。
  echo     PDF 导出需要 Python 3.9 以上；没有它技能和面板照样装，
  echo     但生成 PDF 会失败。装好 Python 后再双击本文件一次即可。
  echo.
)

powershell -NoProfile -ExecutionPolicy Bypass -File "scripts\install.ps1"
set RESULT=%errorlevel%

echo.
if not "%RESULT%"=="0" (
  echo [X] 安装脚本返回错误码 %RESULT%
  echo     把上面的输出发给作者。
) else (
  echo [OK] 五个技能和 PDF 工具已装好。
  echo.
  echo 还剩两步，都在 DSH 里做：
  echo   1^) 用 plugin manager 安装并启用这个目录：
  echo      %CD%
  echo   2^) 打开 cordis.patch.yml，把 courseRoot 改成你放课程的文件夹
  echo      ^(每个子文件夹算一门课^)
  echo.
  echo 然后刷新页面，侧边栏就会出现「课程」。
)
echo.
pause
endlocal
