@echo off
rem ============================================================================
rem  Yu Code 一键打包脚本：双击即可生成安装包
rem
rem  产出：release\Yu Code Setup <版本>.exe
rem  这个安装包已经把 Pi 运行时和便携 Node 一起打进去了，用户机器上不需要
rem  另外装 Pi。安装完右键文件夹就能用 Yu Code 打开。
rem
rem  文件必须是 UTF-8 编码，且第 2 行要切到 65001，否则下面的中文提示会乱码。
rem ============================================================================
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================
echo   Yu Code 安装包构建
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 goto :no_node

echo [1/5] Node 版本：
node -v
echo.

echo [2/5] 清理上一次残留的 dev 进程...
echo   上一次 npm run dev 没退干净的话，会锁住原生模块，打包必然失败。
node scripts\dev-cleanup.js
echo.

if not exist "node_modules" goto :install_deps
echo [3/5] 依赖已存在，跳过 npm install
goto :vendor

:install_deps
echo [3/5] 首次构建，安装依赖（这一步比较慢）...
call npm install
if errorlevel 1 goto :failed
echo.

:vendor
echo [4/5] 准备 Pi 运行时与便携 Node 22（已经下载过会自动跳过）...
echo   这一步会访问 nodejs.org 与 npm registry，国内网络可能需要几分钟。
echo [5/5] 构建前端并生成安装包...
echo.
call npm run build
if errorlevel 1 goto :failed

echo.
echo ============================================
echo   构建成功
echo ============================================
echo 安装包位置：
dir /b "release\*.exe"
echo.
echo 双击上面这个 exe 即可安装。装完后：
echo   - Pi 运行时随程序一起装好，无需另装
echo   - 右键文件夹（或文件夹内空白处）-「用 Yu Code 打开」
echo   - Windows 11 的右键是精简菜单，这项在「显示更多选项」里
echo.
pause
exit /b 0

:no_node
echo [错误] 没找到 node 命令。
echo 请先安装 Node.js 18 或更高版本：https://nodejs.org/
echo.
pause
exit /b 1

:failed
echo.
echo ============================================
echo   [失败] 构建中断
echo ============================================
echo 请把上面最后一段报错发出来排查。
echo.
pause
exit /b 1
