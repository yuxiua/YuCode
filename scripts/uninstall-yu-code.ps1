#Requires -Version 5.1
<#
  彻底卸载 Yu Code（当前用户，必要时含机器范围残留）。

  为什么不能只靠自带的卸载程序：
    - electron-builder 的卸载器在应用还开着的时候删不动 Yu Code.exe / *.dll / app.asar，
      会在 %LOCALAPPDATA%\Programs\Yu Code 留下一个空壳目录；
    - 用户配置（模型、API Key、会话）在 %APPDATA%\yu-code，卸载默认不删，
      所以「删掉软件目录重装」之后旧模型还在；
    - 右键菜单与「打开方式」的注册表项写在 HKCU\Software\Classes 下，也可能残留。

  这个脚本的顺序是：先结束进程 → 跑一次官方卸载器（静默）→ 再逐项核对并强制清除。
  每一步都会打印出来，删不掉的东西会在最后单独列出来。

  用法（在脚本所在目录执行）：
    powershell -NoProfile -ExecutionPolicy Bypass -File .\uninstall-yu-code.ps1

  可选开关：
    -Yes            不询问，直接开始
    -KeepUserData   保留 %APPDATA%\yu-code（模型配置、对话历史、改动检查点）
    -KeepPiExtras   保留 ~\.pi 下本应用塞进去的内置扩展（默认会清掉，让重装时重新铺一遍）
#>
[CmdletBinding()]
param(
  [switch]$Yes,
  [switch]$KeepUserData,
  [switch]$KeepPiExtras
)

$ErrorActionPreference = 'Continue'

$APP_EXE      = 'Yu Code.exe'
$UNINSTALLER  = 'Uninstall Yu Code.exe'
$PRODUCT      = 'Yu Code'

$script:Remaining = New-Object System.Collections.Generic.List[string]

function Say  ($m, $c = 'Gray')     { Write-Host $m -ForegroundColor $c }
function Step ($m)                  { Write-Host "`n==> $m" -ForegroundColor Cyan }
function Ok   ($m)                  { Write-Host "    [已删] $m" -ForegroundColor Green }
function Skip ($m)                  { Write-Host "    [无]   $m" -ForegroundColor DarkGray }
function Warn ($m)                  { Write-Host "    [注意] $m" -ForegroundColor Yellow }

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Host ''
Write-Host '=============================================' -ForegroundColor White
Write-Host '   Yu Code 彻底卸载' -ForegroundColor White
Write-Host '=============================================' -ForegroundColor White
Say "当前用户：$env:USERNAME"
Say "管理员权限：$(if ($isAdmin) { '是' } else { '否（HKLM 下的残留会被跳过）' })"
if ($KeepUserData) { Say '模式：保留用户配置（-KeepUserData）' -c Yellow }
else               { Say '模式：连用户配置一起删除（模型、API Key、对话历史都会没）' -c Yellow }

if (-not $Yes) {
  Write-Host ''
  $answer = Read-Host '确认开始？输入 y 回车继续，其他任意键取消'
  if ($answer -notmatch '^(y|Y|yes|YES)$') { Say '已取消。' Yellow; exit 0 }
}

# ---------------------------------------------------------------- 工具函数

function Stop-YuCodeProcess {
  $killed = $false
  foreach ($name in @($APP_EXE, $UNINSTALLER)) {
    $procName = [IO.Path]::GetFileNameWithoutExtension($name)
    if (-not (Get-Process -Name $procName -ErrorAction SilentlyContinue)) { continue }
    Say "    结束进程 $name"
    # /T 连它拉起的子进程一起结束（pi 引擎是它 spawn 出来的 node）
    & taskkill.exe /F /T /IM $name 2>&1 | Out-Null
    $killed = $true
  }
  if ($killed) { Start-Sleep -Milliseconds 1000 }
  return $killed
}

# 删除文件/目录；被占用时先结束进程再试一次，仍失败就记进 Remaining
function Remove-Path($target) {
  if (-not $target) { return }
  if (-not (Test-Path -LiteralPath $target)) { return }
  for ($attempt = 1; $attempt -le 3; $attempt++) {
    try {
      Remove-Item -LiteralPath $target -Recurse -Force -ErrorAction Stop
      Ok $target
      return
    } catch {
      if ($attempt -eq 1) { Stop-YuCodeProcess | Out-Null }
      Start-Sleep -Milliseconds 500
    }
  }
  Warn "删不掉（可能被占用）：$target"
  $script:Remaining.Add($target)
}

function Remove-RegKey($path) {
  if (-not (Test-Path $path)) { return }
  try { Remove-Item -Path $path -Recurse -Force -ErrorAction Stop; Ok "注册表 $path" }
  catch { Warn "注册表删不掉：$path （$($_.Exception.Message)）"; $script:Remaining.Add($path) }
}

function Remove-RegValue($path, $name) {
  if (-not (Test-Path $path)) { return }
  $item = Get-Item -Path $path -ErrorAction SilentlyContinue
  if (-not $item) { return }
  if ($item.GetValueNames() -notcontains $name) { return }
  try { Remove-ItemProperty -Path $path -Name $name -Force -ErrorAction Stop; Ok "注册表值 $path\$name" }
  catch { Warn "注册表值删不掉：$path\$name" }
}

# 只在「这个键空空如也」时才删（对应安装器里的 DeleteRegKey /ifempty）
function Remove-RegKeyIfEmpty($path) {
  if (-not (Test-Path $path)) { return }
  $item = Get-Item -Path $path -ErrorAction SilentlyContinue
  if (-not $item) { return }
  if ($item.GetValueNames().Count -gt 0) { return }
  if ($item.GetSubKeyNames().Count -gt 0) { return }
  try { Remove-Item -Path $path -Force -ErrorAction Stop; Ok "空注册表项 $path" } catch { }
}

# ---------------------------------------------------------------- 1. 结束进程

Step '结束正在运行的 Yu Code'
if (Stop-YuCodeProcess) { Ok '进程已结束' } else { Skip '没有在运行的进程' }

# ---------------------------------------------------------------- 2. 官方卸载器

Step '调用官方卸载程序（静默）'
$uninstallString = $null
$candidates = New-Object System.Collections.Generic.List[string]
$uninstallRoots = @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall')
if ($isAdmin) {
  $uninstallRoots += 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
  $uninstallRoots += 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'
}
foreach ($root in $uninstallRoots) {
  if (-not (Test-Path $root)) { continue }
  foreach ($key in (Get-ChildItem $root -ErrorAction SilentlyContinue)) {
    $display = (Get-ItemProperty -Path $key.PSPath -Name DisplayName -ErrorAction SilentlyContinue).DisplayName
    if ($display -and $display -like "*$PRODUCT*") {
      $candidates.Add($key.PSPath)
      $q = (Get-ItemProperty -Path $key.PSPath -Name QuietUninstallString -ErrorAction SilentlyContinue).QuietUninstallString
      $u = (Get-ItemProperty -Path $key.PSPath -Name UninstallString -ErrorAction SilentlyContinue).UninstallString
      Say "    发现卸载项：$display （$($key.PSPath)）"
      if (-not $uninstallString) { $uninstallString = if ($q) { $q } else { $u } }
    }
  }
}

if ($uninstallString) {
  # UninstallString 形如 "C:\...\Uninstall Yu Code.exe" /currentuser，拆出 exe 与参数
  $m = [regex]::Match($uninstallString, '^\s*"([^"]+)"\s*(.*)$')
  if ($m.Success) { $exe = $m.Groups[1].Value; $argLine = $m.Groups[2].Value }
  else { $exe = $uninstallString.Trim(); $argLine = '' }

  if (-not ($argLine -split '\s+' -contains '/S')) { $argLine = "$argLine /S".Trim() }

  if (Test-Path -LiteralPath $exe) {
    Say "    执行：`"$exe`" $argLine"
    try {
      $proc = Start-Process -FilePath $exe -ArgumentList $argLine -PassThru -ErrorAction Stop
      # 卸载器会复制自己到临时目录再重启一次，所以多等一会儿
      $proc | Wait-Process -Timeout 180 -ErrorAction SilentlyContinue
      Ok '官方卸载程序已跑完'
    } catch {
      Warn "官方卸载程序执行失败：$($_.Exception.Message)"
    }
  } else {
    Warn "卸载程序文件不存在，直接进入强制清理：$exe"
  }
} else {
  Skip '注册表里没有找到卸载项'
}

Stop-YuCodeProcess | Out-Null
Start-Sleep -Milliseconds 500

# ---------------------------------------------------------------- 3. 安装目录

Step '删除安装目录'
$installDirs = New-Object System.Collections.Generic.List[string]
$installDirs.Add((Join-Path $env:LOCALAPPDATA 'Programs\Yu Code'))
$installDirs.Add((Join-Path $env:LOCALAPPDATA 'Programs\yu-code'))
$installDirs.Add((Join-Path $env:LOCALAPPDATA 'Yu Code'))
$installDirs.Add((Join-Path ${env:ProgramFiles} 'Yu Code'))
if (${env:ProgramFiles(x86)}) { $installDirs.Add((Join-Path ${env:ProgramFiles(x86)} 'Yu Code')) }

# 注册表里记的安装位置（HKCU\Software\<guid>\InstallLocation）也一并纳入
foreach ($root in @('HKCU:\Software', 'HKLM:\Software')) {
  if ($root -like 'HKLM*' -and -not $isAdmin) { continue }
  if (-not (Test-Path $root)) { continue }
  foreach ($sub in (Get-ChildItem $root -ErrorAction SilentlyContinue)) {
    $loc = (Get-ItemProperty -Path $sub.PSPath -Name InstallLocation -ErrorAction SilentlyContinue).InstallLocation
    if ($loc -and $loc -like "*$PRODUCT*") { $installDirs.Add($loc) }
  }
}

$seen = @{}
foreach ($dir in $installDirs) {
  if (-not $dir) { continue }
  $key = $dir.ToLower()
  if ($seen.ContainsKey($key)) { continue }
  $seen[$key] = $true
  Remove-Path $dir
}

# ---------------------------------------------------------------- 4. 用户配置

Step '处理用户配置（userData）'
# Electron 的 userData 按 package.json 的 name 走，本应用是 yu-code；
# Yu Code 那份是早期 productName 版本留下的，一起清。
$userData = @(
  (Join-Path $env:APPDATA 'yu-code'),
  (Join-Path $env:APPDATA 'Yu Code')
)
if ($KeepUserData) {
  Skip "保留用户配置（-KeepUserData）：$($userData -join '、')"
} else {
  foreach ($dir in $userData) { Remove-Path $dir }
}

# 首次启动解压内置扩展用的临时目录
Remove-Path (Join-Path $env:TEMP 'yucode-pi-extensions')

# ---------------------------------------------------------------- 5. 快捷方式

Step '删除快捷方式'
$shortcuts = New-Object System.Collections.Generic.List[string]
$shortcuts.Add((Join-Path ([Environment]::GetFolderPath('Desktop')) "$PRODUCT.lnk"))
$shortcuts.Add((Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$PRODUCT.lnk"))
$shortcuts.Add((Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$PRODUCT"))
if ($env:ProgramData) {
  $shortcuts.Add((Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs\$PRODUCT.lnk"))
  $shortcuts.Add((Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs\$PRODUCT"))
}
foreach ($lnk in $shortcuts) { Remove-Path $lnk }
Warn '任务栏上手动固定的图标系统不认脚本删除，需要用户自己右键「从任务栏取消固定」'

# ---------------------------------------------------------------- 6. 注册表

Step '清理注册表'
# 右键菜单两项
Remove-RegKey 'HKCU:\Software\Classes\Directory\shell\YuCode'
Remove-RegKey 'HKCU:\Software\Classes\Directory\Background\shell\YuCode'

# 「打开方式」候选：安装器写过 Yucode.<ext> 这套 progid。
# 直接从注册表里扫出所有 Yucode.* 项，比照着扩展名清单硬编码更稳（能扫到旧版本留下的）。
$exts = New-Object System.Collections.Generic.HashSet[string]
foreach ($item in (Get-ChildItem 'HKCU:\Software\Classes' -ErrorAction SilentlyContinue)) {
  if ($item.PSChildName -match '^Yucode\.(.+)$') { [void]$exts.Add($Matches[1]) }
}
# 兜底：即使 progid 项已经不在了，也要把自己写进 OpenWithProgids 的值摘掉
$fallback = @('js','mjs','cjs','ts','tsx','jsx','json','jsonc','html','htm','css','scss','less',
  'py','md','mdx','sh','bat','ps1','yml','yaml','xml','sql','go','rs','java','c','h','cpp','hpp','txt')
foreach ($e in $fallback) { [void]$exts.Add($e) }

foreach ($ext in $exts) {
  $progId = "Yucode.$ext"
  $openWith = "HKCU:\Software\Classes\.$ext\OpenWithProgids"
  Remove-RegValue $openWith $progId
  Remove-RegKeyIfEmpty $openWith
  Remove-RegKey "HKCU:\Software\Classes\$progId"
  # .<ext> 这个键一般是系统的，只有在完全为空（我们新建的）时才删
  Remove-RegKeyIfEmpty "HKCU:\Software\Classes\.$ext"
}

# 程序自己登记的键与「添加/删除程序」里的条目
foreach ($root in @('HKCU:\Software', 'HKLM:\Software')) {
  if ($root -like 'HKLM*' -and -not $isAdmin) { continue }
  if (-not (Test-Path $root)) { continue }
  foreach ($sub in (Get-ChildItem $root -ErrorAction SilentlyContinue)) {
    $shortcutName = (Get-ItemProperty -Path $sub.PSPath -Name ShortcutName -ErrorAction SilentlyContinue).ShortcutName
    if ($shortcutName -eq $PRODUCT) { Remove-RegKey $sub.PSPath }
  }
}
foreach ($key in $candidates) {
  Remove-RegKey $key
}

# ---------------------------------------------------------------- 7. Pi 引擎侧

Step '清理 Pi 引擎侧的本应用痕迹'
$piAgent = Join-Path $HOME '.pi\agent'
# 这个指纹文件是应用写的；留着会让重装后以为「扩展已同步」而跳过铺包
Remove-Path (Join-Path $piAgent '.yucode-bundled.json')
if (-not $KeepPiExtras) {
  # 内置扩展被复制到了 pi 的包目录，清掉让重装时按新版本重新铺
  $bundled = @('pi-subagents','pi-hermes-memory','pi-lens','pi-simplify','cc-safety-net',
    'rpiv-todo','@narumitw/pi-plan-mode','pi-web-access','@earendil-works/pi-tui')
  foreach ($name in $bundled) { Remove-Path (Join-Path $piAgent "npm\node_modules\$($name -replace '/', '\')") }
} else {
  Skip '保留 pi 扩展目录（-KeepPiExtras）'
}
if (Test-Path $piAgent) {
  Warn "$piAgent 下的 models.json / settings.json 不动：用户自己配的 Pi 模型和在别处装的 pi 扩展都在那儿，删了影响面太大"
}

# ---------------------------------------------------------------- 8. 收尾

Step '结果'
if ($script:Remaining.Count -eq 0) {
  Write-Host '    清理完成，没有残留。' -ForegroundColor Green
} else {
  Write-Host '    以下内容没能删掉，请手动处理（多半是被占用）：' -ForegroundColor Yellow
  foreach ($r in $script:Remaining) { Write-Host "      - $r" -ForegroundColor Yellow }
  Write-Host '    处理办法：注销/重启后重新运行本脚本，或手动删除。' -ForegroundColor Yellow
}

Write-Host ''
Write-Host '    复核清单（建议打开看一眼）：' -ForegroundColor White
Write-Host "      1. $env:LOCALAPPDATA\Programs\Yu Code"
Write-Host "      2. $env:APPDATA\yu-code"
Write-Host '      3. 设置 → 应用 → 已安装的应用，搜 Yu Code'
Write-Host '      4. 桌面/开始菜单快捷方式、任务栏图标'
Write-Host '      5. 任意文件夹右键 → 不应再有「用 Yu Code 打开」'
Write-Host ''
