; Remove the PearGuardWatchdog scheduled task when PearGuard is uninstalled.
; The task itself is registered by the app's main process on first run so it
; lives under the interactive user's account; schtasks /delete run from an
; elevated uninstaller removes it regardless of owner. Best-effort: suppress
; failures so an absent task doesn't block uninstall.
!macro customUnInstall
  nsExec::Exec 'schtasks.exe /delete /tn "PearGuardWatchdog" /f'
!macroend
