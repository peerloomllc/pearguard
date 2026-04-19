; Uninstaller extension: remove the watchdog scheduled task, stop + remove
; the watchdog Windows Service, and wipe each user profile's PearGuard
; state. Electron uses the package.json `name` field for userData, so
; state lives at %APPDATA%\pearguard-windows (not %APPDATA%\PearGuard),
; plus auto-updater cache at %LOCALAPPDATA%\pearguard-windows-updater.
; The uninstaller runs elevated so $APPDATA/$LOCALAPPDATA would resolve
; to the admin's profile, which is rarely the account that actually ran
; PearGuard; iterating C:\Users also covers the multi-child case.
; $PROFILE\.. avoids hard-coding the drive letter.
;
; Installer extension: register the watchdog Windows Service via NSSM at
; end of install. The service runs as LocalSystem, wraps
; resources\watchdog.ps1, and relaunches PearGuard.exe in the active
; console user's session via WTSQueryUserToken + CreateProcessAsUser.
; It's a second independent watchdog alongside the scheduled task
; registered by the app itself on first run; killing either one leaves
; the other intact.
;
; Code is inlined into the macros rather than split into Functions
; because electron-builder's NSIS template only includes this file at
; its customInstall/customUnInstall extension points; a standalone
; un.* Function triggers NSIS warning 6020 and electron-builder builds
; with /WX.

!define PG_SVC_NAME "PearGuardWatchdogSvc"

!macro customUnInit
  ; Runs at the top of the uninstaller, BEFORE electron-builder's built-in
  ; "close the app" check. Without this, the watchdog service (and
  ; scheduled task) immediately relaunches PearGuard.exe whenever the
  ; uninstaller tries to terminate it, so the user is stuck in the
  ; "PearGuard cannot be closed. Please close it manually" loop. Stop the
  ; watchdogs first, then kill any running PearGuard so the downstream
  ; uninstall logic sees a quiet system.
  nsExec::Exec 'sc.exe stop ${PG_SVC_NAME}'
  nsExec::Exec 'schtasks.exe /delete /tn "PearGuardWatchdog" /f'
  nsExec::Exec 'taskkill.exe /im PearGuard.exe /f /t'
!macroend

!macro customInstall
  ; Install + start PearGuardWatchdogSvc. All nssm calls are best-effort
  ; so a failure here doesn't abort the install - the app-registered
  ; scheduled-task watchdog still provides relaunch coverage.
  nsExec::Exec '"$INSTDIR\resources\nssm.exe" install ${PG_SVC_NAME} "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"$INSTDIR\resources\watchdog.ps1\""'
  nsExec::Exec '"$INSTDIR\resources\nssm.exe" set ${PG_SVC_NAME} DisplayName "PearGuard Watchdog"'
  nsExec::Exec '"$INSTDIR\resources\nssm.exe" set ${PG_SVC_NAME} Description "Relaunches PearGuard in the interactive user session if it is not running."'
  nsExec::Exec '"$INSTDIR\resources\nssm.exe" set ${PG_SVC_NAME} Start SERVICE_AUTO_START'
  nsExec::Exec '"$INSTDIR\resources\nssm.exe" set ${PG_SVC_NAME} ObjectName LocalSystem'
  nsExec::Exec '"$INSTDIR\resources\nssm.exe" set ${PG_SVC_NAME} AppStdout "$INSTDIR\resources\watchdog.log"'
  nsExec::Exec '"$INSTDIR\resources\nssm.exe" set ${PG_SVC_NAME} AppStderr "$INSTDIR\resources\watchdog.log"'
  nsExec::Exec '"$INSTDIR\resources\nssm.exe" set ${PG_SVC_NAME} AppRotateFiles 1'
  nsExec::Exec '"$INSTDIR\resources\nssm.exe" set ${PG_SVC_NAME} AppRotateBytes 1048576'
  ; Auto-restart if the PS wrapper dies for any reason.
  nsExec::Exec 'sc.exe failure ${PG_SVC_NAME} reset= 86400 actions= restart/60000/restart/60000/restart/60000'
  nsExec::Exec '"$INSTDIR\resources\nssm.exe" start ${PG_SVC_NAME}'
!macroend

!macro customUnInstall
  ; Stop + remove the watchdog service before deleting files, so the PS
  ; script isn't holding watchdog.ps1 open when we try to RMDir $INSTDIR.
  nsExec::Exec '"$INSTDIR\resources\nssm.exe" stop ${PG_SVC_NAME}'
  nsExec::Exec '"$INSTDIR\resources\nssm.exe" remove ${PG_SVC_NAME} confirm'
  ; Fallback: if nssm.exe has already been removed from $INSTDIR by a
  ; prior partial uninstall, sc.exe can still dismantle the service.
  nsExec::Exec 'sc.exe stop ${PG_SVC_NAME}'
  nsExec::Exec 'sc.exe delete ${PG_SVC_NAME}'

  ; Best-effort: suppress schtasks failures so an absent task doesn't block
  ; uninstall.
  nsExec::Exec 'schtasks.exe /delete /tn "PearGuardWatchdog" /f'

  ; Remove Hyperbee store, overrides.json, usage.json, seen-exes.json, etc.
  ; from every user profile on the machine.
  Push $0
  Push $1
  Push $2

  StrCpy $0 "$PROFILE\.."

  FindFirst $1 $2 "$0\*"
  pg_userdata_loop:
    StrCmp $2 "" pg_userdata_done
    StrCmp $2 "." pg_userdata_next
    StrCmp $2 ".." pg_userdata_next
    StrCmp $2 "Public" pg_userdata_next
    StrCmp $2 "Default" pg_userdata_next
    StrCmp $2 "Default User" pg_userdata_next
    StrCmp $2 "All Users" pg_userdata_next
    IfFileExists "$0\$2\AppData\Roaming\pearguard-windows\*.*" 0 +2
      RMDir /r "$0\$2\AppData\Roaming\pearguard-windows"
    IfFileExists "$0\$2\AppData\Local\pearguard-windows-updater\*.*" 0 +2
      RMDir /r "$0\$2\AppData\Local\pearguard-windows-updater"
  pg_userdata_next:
    FindNext $1 $2
    Goto pg_userdata_loop
  pg_userdata_done:
    FindClose $1

  Pop $2
  Pop $1
  Pop $0
!macroend
