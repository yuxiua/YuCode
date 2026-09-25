; electron-builder 的自定义 NSIS 片段（由 electron-builder.json 的 nsis.include 引入）
;
; 作用：
; 1. 给「文件夹」和「文件夹内空白处」加上右键菜单项「用 Yu Code 打开」。
; 2. 把 Yu Code 登记进代码类扩展名的「打开方式」候选列表。
; 3. 安装/卸载前强制结束还在跑的 Yu Code 进程树（覆盖 electron-builder 自带的检查）。
; 4. 覆盖安装时先把老版本整个删掉再装，绕开老卸载器在本项目路径深度下必然失败的一步；
;    效果就是一次「清洁安装」，不残留任何老版本的文件（用户配置不在删除范围内）。
;
; 第 2 点有两个坑，写在前面：
; - electron-builder 自带的 fileAssociations 除了登记候选，还会顺手把
;   HKCU\Software\Classes\.<ext> 的默认值改成 Yu Code
;   （见 app-builder-lib/templates/nsis/include/FileAssociation.nsh，WriteRegStr ... ".${EXT}" ...），
;   装完用户双击什么文件都进 Yu Code。所以配置里已经把它清空（fileAssociations: []），
;   改在这里只写 OpenWithProgids：双击仍走用户原来的默认程序，「打开方式」里能看到 Yu Code。
; - 安装期批量改文件关联也是杀软行为引擎重点关照的动作（实测被电脑管家拦过安装包），
;   只写 OpenWithProgids 能把这类写入降到最低。
;
; 两点说明：
; 1. 写 HKCU 而不是 HKLM。安装器是 perMachine:false（按用户安装），
;    写 HKCU 既不需要管理员权限，卸载时也不会留下需要提权才能删掉的残留。
; 2. Windows 11 默认的右键菜单是精简版，这些项会出现在「显示更多选项」里；
;    这是系统的行为，不是注册失败。
;
; %V 是资源管理器传进来的目标目录（图标所在位置），Directory 与 Directory\Background
; 两个位置都用它，不需要额外拼引号。

; 卸载清理为什么要在这里再删一次：
;   卸载时应用常常还开着（用户从开始菜单卸载、没关窗口），Electron 会一直占着
;   Yu Code.exe / *.dll / app.asar，electron-builder 自己的 RMDir /r $INSTDIR 删不动这些文件，
;   于是留下一个只剩 exe/dll/pak 的空壳目录。实测残留目录里就剩这些被占用的文件。
;   所以卸载收尾时先结束进程（/T 连它拉起的子进程一起），再补删一次 $INSTDIR。
;   升级安装（isUpdated）时 $INSTDIR 归新安装程序管，不能碰，全部跳过。
;
; 用户配置的位置：Electron 的 userData 按应用名走，本应用 package.json 的 name 是 yu-code，
; 所以配置在 %APPDATA%\yu-code（productName 那份 $APPDATA\Yu Code 一并删，兼容老版本）。
; 这里默认不删，而是问一次 —— 模型配置里有用户自己填的 API Key，删掉不可恢复。

; 单个扩展名的登记/清理。MODE=install 登记，MODE=uninstall 清理。
!macro YU_EXT MODE EXT
  !if "${MODE}" == "install"
    WriteRegStr HKCU "Software\Classes\Yucode.${EXT}" "" "Yu Code ${EXT} 文件"
    WriteRegStr HKCU "Software\Classes\Yucode.${EXT}\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
    WriteRegStr HKCU "Software\Classes\Yucode.${EXT}\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'
    ; 只登记成「打开方式」候选。注意这里千万不能再写 .${EXT} 的默认值，那就是抢默认。
    WriteRegStr HKCU "Software\Classes\.${EXT}\OpenWithProgids" "Yucode.${EXT}" ""
  !else
    DeleteRegValue HKCU "Software\Classes\.${EXT}\OpenWithProgids" "Yucode.${EXT}"
    ; 有的扩展名（比如 .md）HKCU 下原本没有这个键，是我们新建的，清空后顺手删掉
    DeleteRegKey /ifempty HKCU "Software\Classes\.${EXT}\OpenWithProgids"
    DeleteRegKey /ifempty HKCU "Software\Classes\.${EXT}"
    DeleteRegKey HKCU "Software\Classes\Yucode.${EXT}"
  !endif
!macroend

; 扩展名清单只维护这一份，安装与卸载都从这里展开，避免两边漏改。
!macro YU_ALL_EXTS MODE
  !insertmacro YU_EXT ${MODE} "js"
  !insertmacro YU_EXT ${MODE} "mjs"
  !insertmacro YU_EXT ${MODE} "cjs"
  !insertmacro YU_EXT ${MODE} "ts"
  !insertmacro YU_EXT ${MODE} "tsx"
  !insertmacro YU_EXT ${MODE} "jsx"
  !insertmacro YU_EXT ${MODE} "json"
  !insertmacro YU_EXT ${MODE} "jsonc"
  !insertmacro YU_EXT ${MODE} "html"
  !insertmacro YU_EXT ${MODE} "htm"
  !insertmacro YU_EXT ${MODE} "css"
  !insertmacro YU_EXT ${MODE} "scss"
  !insertmacro YU_EXT ${MODE} "less"
  !insertmacro YU_EXT ${MODE} "py"
  !insertmacro YU_EXT ${MODE} "md"
  !insertmacro YU_EXT ${MODE} "mdx"
  !insertmacro YU_EXT ${MODE} "sh"
  !insertmacro YU_EXT ${MODE} "bat"
  !insertmacro YU_EXT ${MODE} "ps1"
  !insertmacro YU_EXT ${MODE} "yml"
  !insertmacro YU_EXT ${MODE} "yaml"
  !insertmacro YU_EXT ${MODE} "xml"
  !insertmacro YU_EXT ${MODE} "sql"
  !insertmacro YU_EXT ${MODE} "go"
  !insertmacro YU_EXT ${MODE} "rs"
  !insertmacro YU_EXT ${MODE} "java"
  !insertmacro YU_EXT ${MODE} "c"
  !insertmacro YU_EXT ${MODE} "h"
  !insertmacro YU_EXT ${MODE} "cpp"
  !insertmacro YU_EXT ${MODE} "hpp"
  !insertmacro YU_EXT ${MODE} "txt"
!macroend

; ------------------------------------------------------------ 安装/卸载前的准备
;
; customCheckAppRunning 是 electron-builder 留给自定义检查的宏名
; （见 templates/nsis/include/allowOnlyOneInstallerInstance.nsh 的 CHECK_APP_RUNNING：
; 只要它被定义，自带逻辑就整体让位）。它在两处被调到：
;   - 新安装包进入安装流程时（templates/nsis/installSection.nsh，先于调起老卸载器）；
;   - 卸载器启动时（templates/nsis/uninstaller.nsh 的 un.checkAppRunning）。
; 所以只改这一处，安装和卸载都从这里过。
;
; 这里要做两件事：
;   1) 强杀还在跑的整棵进程树 —— 安装、卸载都要；
;   2) 覆盖安装时先把老版本整个删掉 —— 只在安装器里做，原因见下面「覆盖安装前的清理」。
;
; 为什么必须换掉自带逻辑：
;   自带逻辑按「IMAGENAME eq Yu Code.exe + USERNAME eq %USERNAME%」找进程，找到先
;   taskkill /im（第一轮还不带 /F），杀不掉就重试，重试到头弹一句
;   「Yu Code cannot be closed. Please close it manually and click Retry to continue.」
;   —— 用户遇到的「退了也关不掉」就是这句。两个硬伤：
;     1. 不带 /T：pi 引擎是应用自己 spawn 出来的便携 node
;        （$INSTDIR\resources\vendor\node\node.exe），主进程死了它还活着，
;        它占住安装目录里的文件，后面搬/删这些文件时会失败；
;     2. 只认当前 USERNAME：旧实例只要是提权或别的身份起的，它根本发现不了，直接装 → 撞锁。
;   这里改成按镜像名 /F /T 强杀整棵进程树，并轮询等它真的退出再往下走。
;
; 刻意不弹确认框：安装/卸载本来就要独占安装目录，问一句只会把用户堵在
; 「关不掉 → 重试 → 还是关不掉」的死循环里，退出这件事交给这里负责。

; 探测进程是否还在跑：0 = 还在。tasklist 匹配不到时退出码同样是 0，所以接一个
; find 用它的退出码判断。这里不带 USERNAME 过滤，理由见上。
!macro YU_APP_STILL_RUNNING OUT
  nsExec::Exec `$SYSDIR\cmd.exe /c $SYSDIR\tasklist.exe /FI "IMAGENAME eq ${APP_EXECUTABLE_FILENAME}" /NH | $SYSDIR\find.exe "${APP_EXECUTABLE_FILENAME}"`
  Pop ${OUT}
!macroend

; 强杀整棵进程树，直到确认它真的没了（最多 6 轮）。安装、卸载共用。
!macro YU_KILL_APP_TREE
  !insertmacro YU_APP_STILL_RUNNING $R0
  ${if} $R0 == 0
    StrCpy $R1 0

    yu_kill_app:
      DetailPrint `正在结束 ${PRODUCT_NAME} 及其子进程...`
      nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
      ; 进程被杀掉不等于文件句柄马上释放，等一拍再复查
      Sleep 600

      !insertmacro YU_APP_STILL_RUNNING $R0
      ${if} $R0 == 0
        IntOp $R1 $R1 + 1
        ${if} $R1 < 6
          DetailPrint `等待 ${PRODUCT_NAME} 退出（安装目录里的文件仍被占用）...`
          Goto yu_kill_app
        ${endIf}
        DetailPrint `${PRODUCT_NAME} 没能结束，继续安装（后面可能报文件占用）`
      ${endIf}
  ${endIf}
!macroend

; ------------------------------------------------------------ 覆盖安装前的清理
;
; 1.0.13 → 1.0.14 覆盖安装实测失败（安装器退出码 2、装完还是 1.0.13）的真凶在这里。
;
; electron-builder 的安装器不做原地覆盖，它的流程是：
;   用 /S --updated 调起老卸载器 → 老卸载器把 $INSTDIR 里每一项逐个 Rename 到
;   $PLUGINSDIR\old-install（即 %TEMP%\nsXXXXXX.tmp\old-install）暂存 → 全搬成了才整份删掉；
;   有任何一项搬不动就 Abort、把已搬的挪回去，安装器重试 5 次后弹「Yu Code cannot be closed」
;   并以退出码 2 退出（见 include/installUtil.nsh 的 uninstallOldVersion / handleUninstallResult，
;   以及 uninstaller.nsh 的 un.atomicRMDir / un.restoreFiles）。
;
; 而本项目 $INSTDIR 里最深的文件已经到 252 个字符：
;   resources\vendor\pi\node_modules\@earendil-works\pi-coding-agent\node_modules\@aws-sdk\core\
;   dist-types\ts3.4\submodules\client\middleware-recursion-detection\getRecursionDetectionPlugin.browser.d.ts
; 挂到 $PLUGINSDIR\old-install 下面后前缀变长，整条路径变成 265 个字符，超过 Windows 的
; 260（MAX_PATH），Rename 必然失败（实测 MoveFileExW 报 "The system cannot find the path specified"）。
; 注意：这一步跟进程有没有关干净无关，进程全杀光也一样失败；只要安装目录里存在这么深的路径，
; 老卸载器就必然走不通 —— 所以光杀进程解决不了「再次安装失败」。
;
; 老卸载器早就装到用户机器上了，改不动；能改的只有新安装器。因此在安装流程里抢在
; uninstallOldVersion 之前把老版本整个删掉，再抹掉注册表里的卸载信息 ——
; uninstallOldVersion 读不到 UninstallString 会直接返回，安装流程就变成一次干净的重新安装。
; 用户配置（%APPDATA%\yu-code：模型配置、会话、检查点）不在 $INSTDIR 里，不受影响。
;
; 为什么删得动：RMDir /r 走的是文件的真实路径（最长 252 字符，没超 MAX_PATH），
; 只有搬到 $PLUGINSDIR\old-install 那一层前缀下才会超。这也是「清洁安装」的落点。
!macro YU_WIPE_OLD_INSTALL
  ; 只在确实装了老版本时才清：安装流程里 $INSTDIR 取自注册表的 InstallLocation
  ; （.onInit 的 initMultiUser 设的）。全新安装时这个键不存在，$INSTDIR 只是默认目录，
  ; 里面可能有用户自己的东西，绝不能删。
  ReadRegStr $R2 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${if} $R2 != ""
    DetailPrint `清理旧版本 ${PRODUCT_NAME}（$R2）...`
    RMDir /r "$INSTDIR"

    ; 下面老卸载器不会再跑了，快捷方式自己删一遍；新版本装完会在同一路径重建
    Delete "$oldStartMenuLink"
    Delete "$oldDesktopLink"

    ; 抹掉卸载信息，让 uninstallOldVersion 读不到 UninstallString 直接返回
    DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"
    DeleteRegKey SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}"
  ${endIf}
!macroend

; 卸载器里 $INSTDIR 归卸载流程自己管（un.atomicRMDir / RMDir /r），这里只负责结束进程；
; BUILD_UNINSTALLER 是 electron-builder 编译卸载器时传进来的 -D 开关。
!ifdef BUILD_UNINSTALLER
  !macro customCheckAppRunning
    !insertmacro YU_KILL_APP_TREE
  !macroend
!else
  !macro customCheckAppRunning
    !insertmacro YU_KILL_APP_TREE
    !insertmacro YU_WIPE_OLD_INSTALL
  !macroend
!endif

!macro customInstall
  ; 右键文件夹本身
  WriteRegStr HKCU "Software\Classes\Directory\shell\YuCode" "" "用 Yu Code 打开"
  WriteRegStr HKCU "Software\Classes\Directory\shell\YuCode" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\shell\YuCode\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%V"'

  ; 右键文件夹内的空白处
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\YuCode" "" "用 Yu Code 打开"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\YuCode" "Icon" "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  WriteRegStr HKCU "Software\Classes\Directory\Background\shell\YuCode\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%V"'

  ; 代码类文件的「打开方式」候选
  !insertmacro YU_ALL_EXTS install
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Classes\Directory\shell\YuCode"
  DeleteRegKey HKCU "Software\Classes\Directory\Background\shell\YuCode"
  !insertmacro YU_ALL_EXTS uninstall

  ; 升级安装（安装器以 /S --updated 调起老卸载器）时只清注册表就够，
  ; $INSTDIR 与用户配置都要留给新版本，绝不能删。
  ${ifNot} ${isUpdated}
    ; 先结束还在跑的应用，否则下面这次删除同样会卡在被占用的 exe/dll 上
    nsExec::ExecToLog '"$SYSDIR\taskkill.exe" /F /T /IM "${APP_EXECUTABLE_FILENAME}"'
    Sleep 800
    RMDir /r "$INSTDIR"

    ; 用户配置：默认保留，问一次再删（/SD IDNO 保证静默卸载时不阻塞）
    MessageBox MB_YESNO|MB_ICONQUESTION "是否同时删除 Yu Code 的本机用户配置？$\r$\n$\r$\n包含：模型配置（含 API Key）、对话历史、改动检查点。$\r$\n选择「否」则保留，重装后配置和会话还在。$\r$\n$\r$\n（Pi 引擎目录 $PROFILE\.pi 不会被删除，用户自己配的 Pi 模型不受影响。）" /SD IDNO IDNO yu_keep_appdata
    RMDir /r "$APPDATA\yu-code"
    RMDir /r "$APPDATA\Yu Code"
    yu_keep_appdata:
  ${endIf}
!macroend
