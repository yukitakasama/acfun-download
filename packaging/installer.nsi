; AcFun 下载 · 安装程序（NSIS 3 / Unicode）
;
; 设计要点：
;   - 按用户安装（%LOCALAPPDATA%\Programs），不弹 UAC、不写 Program Files
;   - 装完点桌面/开始菜单图标 → AcFunDownload.exe → 只拉起本地服务并打开浏览器（无原生窗口）
;   - 卸载只删程序目录，保留 %APPDATA%\acfun-download 里的配置与历史

Unicode true
!include "MUI2.nsh"

!ifndef APP_VERSION
  !define APP_VERSION "1.0.0"
!endif
!ifndef STAGE_DIR
  !error "需要用 /DSTAGE_DIR=<打包暂存目录> 指定文件来源"
!endif
!ifndef OUT_FILE
  !define OUT_FILE "AcFun下载-Setup-${APP_VERSION}.exe"
!endif
!ifndef ICON_FILE
  !define ICON_FILE "${STAGE_DIR}\app.ico"
!endif

Name "AcFun 下载"
OutFile "${OUT_FILE}"
InstallDir "$LOCALAPPDATA\Programs\AcFun下载"
InstallDirRegKey HKCU "Software\acfun-download" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma
ShowInstDetails show
ShowUninstDetails show
BrandingText "AcFun 下载 · 浏览器 GUI"

Icon "${ICON_FILE}"
UninstallIcon "${ICON_FILE}"

!define MUI_ABORTWARNING
!define MUI_ICON "${ICON_FILE}"
!define MUI_UNICON "${ICON_FILE}"
!define MUI_WELCOMEPAGE_TITLE "AcFun 视频下载 ${APP_VERSION}"
!define MUI_WELCOMEPAGE_TEXT "安装后会得到一个带图标的启动图标。$\r$\n$\r$\n点击它不会打开任何原生窗口，而是启动本地服务并用浏览器打开界面。$\r$\n$\r$\n需要先装好 ffmpeg（转封装与核验用，不随安装包提供）；没装也没关系，界面设置页会提示并允许手填路径。"
!define MUI_FINISHPAGE_RUN "$INSTDIR\AcFunDownload.exe"
!define MUI_FINISHPAGE_RUN_TEXT "立即打开 AcFun 下载（会在浏览器中打开界面）"
!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\使用说明.txt"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "查看使用说明"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Section "AcFun 下载（必需）" SecMain
  SectionIn RO
  SetOutPath "$INSTDIR"
  File "${STAGE_DIR}\AcFunDownload.exe"
  File "${STAGE_DIR}\app.ico"
  File "${STAGE_DIR}\使用说明.txt"
  File "${STAGE_DIR}\node.exe"

  SetOutPath "$INSTDIR\server"
  File "${STAGE_DIR}\server\index.js"
  File "${STAGE_DIR}\server\package.json"

  SetOutPath "$INSTDIR\web"
  File /r "${STAGE_DIR}\web\*.*"

  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; 桌面 + 开始菜单快捷方式（图标用 exe 内嵌的，带 Ac 标识）
  CreateShortcut "$DESKTOP\AcFun 下载.lnk" "$INSTDIR\AcFunDownload.exe" "" "$INSTDIR\AcFunDownload.exe" 0
  CreateDirectory "$SMPROGRAMS\AcFun 下载"
  CreateShortcut "$SMPROGRAMS\AcFun 下载\AcFun 下载.lnk" "$INSTDIR\AcFunDownload.exe" "" "$INSTDIR\AcFunDownload.exe" 0
  CreateShortcut "$SMPROGRAMS\AcFun 下载\使用说明.lnk" "$INSTDIR\使用说明.txt"
  CreateShortcut "$SMPROGRAMS\AcFun 下载\卸载 AcFun 下载.lnk" "$INSTDIR\uninstall.exe"

  ; 安装信息（控制面板「应用」里可见，可按用户卸载）
  WriteRegStr HKCU "Software\acfun-download" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\acfun-download" "DisplayName" "AcFun 下载"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\acfun-download" "DisplayVersion" "${APP_VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\acfun-download" "Publisher" "acfun-download"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\acfun-download" "DisplayIcon" "$INSTDIR\AcFunDownload.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\acfun-download" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\acfun-download" "UninstallString" "$\"$INSTDIR\uninstall.exe$\""
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\acfun-download" "QuietUninstallString" "$\"$INSTDIR\uninstall.exe$\" /S"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\acfun-download" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\acfun-download" "NoRepair" 1
SectionEnd

Section "Uninstall"
  ; 先让正在跑的服务退出（如果有），否则 node.exe 占着文件删不掉。
  ; 启动器自带 --shutdown：读 server.json 的端口/token → POST /api/shutdown，不按进程名乱杀。
  IfFileExists "$INSTDIR\AcFunDownload.exe" 0 +2
    ExecWait '"$INSTDIR\AcFunDownload.exe" --shutdown'

  Delete "$DESKTOP\AcFun 下载.lnk"
  Delete "$SMPROGRAMS\AcFun 下载\AcFun 下载.lnk"
  Delete "$SMPROGRAMS\AcFun 下载\使用说明.lnk"
  Delete "$SMPROGRAMS\AcFun 下载\卸载 AcFun 下载.lnk"
  RMDir "$SMPROGRAMS\AcFun 下载"

  RMDir /r "$INSTDIR\server"
  RMDir /r "$INSTDIR\web"
  Delete "$INSTDIR\AcFunDownload.exe"
  Delete "$INSTDIR\app.ico"
  Delete "$INSTDIR\使用说明.txt"
  Delete "$INSTDIR\uninstall.exe"
  ; node.exe 可能被杀软/残留子进程短暂占用：登记「重启后删除」，不静默失败
  IfFileExists "$INSTDIR\node.exe" 0 +2
    Delete /REBOOTOK "$INSTDIR\node.exe"
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\acfun-download"
  DeleteRegKey HKCU "Software\acfun-download"

  ; 有意保留用户数据：%APPDATA%\acfun-download（配置/历史/日志）
  MessageBox MB_ICONINFORMATION|MB_OK "已卸载。$\r$\n$\r$\n配置与历史仍保留在：$\r$\n%APPDATA%\acfun-download"
SectionEnd
