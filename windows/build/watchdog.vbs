' PearGuard watchdog. Invoked by the PearGuardWatchdog scheduled task every
' couple of minutes + at user logon. If PearGuard.exe isn't running, relaunch
' it. The main process holds a single-instance lock, so a benign race here
' just quits the second instance.
Option Explicit

Dim fso, scriptPath, resourcesDir, instDir, exePath
Set fso = CreateObject("Scripting.FileSystemObject")
scriptPath = WScript.ScriptFullName
resourcesDir = fso.GetParentFolderName(scriptPath)
instDir = fso.GetParentFolderName(resourcesDir)
exePath = fso.BuildPath(instDir, "PearGuard.exe")

If Not fso.FileExists(exePath) Then
  WScript.Quit 0
End If

Dim wmi, procs, proc, running
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery("Select ProcessId From Win32_Process Where Name = 'PearGuard.exe'")
running = False
For Each proc In procs
  running = True
  Exit For
Next

If Not running Then
  Dim shell
  Set shell = CreateObject("WScript.Shell")
  ' 1 = normal window, False = don't wait for the process to exit.
  shell.Run """" & exePath & """", 1, False
End If
