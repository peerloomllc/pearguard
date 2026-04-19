; Uninstaller extension: remove the watchdog scheduled task and wipe each
; user profile's PearGuard state. Electron uses the package.json `name`
; field for userData, so state lives at %APPDATA%\pearguard-windows (not
; %APPDATA%\PearGuard), plus auto-updater cache at
; %LOCALAPPDATA%\pearguard-windows-updater. The uninstaller runs elevated
; so $APPDATA/$LOCALAPPDATA would resolve to the admin's profile, which is
; rarely the account that actually ran PearGuard; iterating C:\Users also
; covers the multi-child case. $PROFILE\.. avoids hard-coding the drive
; letter.
;
; Code is inlined here rather than split into a Function un.* helper
; because electron-builder's NSIS template only includes this file at its
; customUnInstall extension point; a standalone un.* Function triggers
; NSIS warning 6020 and electron-builder builds with /WX.
!macro customUnInstall
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
