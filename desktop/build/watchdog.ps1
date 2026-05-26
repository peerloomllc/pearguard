# PearGuard watchdog service script. Wrapped by NSSM as
# PearGuardWatchdogSvc and runs as LocalSystem. Polls once per minute for
# PearGuard.exe and, if missing, launches it inside the active console
# user's session via WTSQueryUserToken + CreateProcessAsUser. Session 0
# isolation means a plain Start-Process from SYSTEM would land the
# relaunched exe in the service session with no visible tray or window;
# routing through the user's token fixes that.
#
# This is the second, independent watchdog. The scheduled-task watchdog
# (registered by the app from src/main/watchdog.js) still runs; deleting
# either one leaves the other intact. An admin child has to locate and
# remove both to defeat relaunch.
#
# The WTSQueryUserToken + DuplicateTokenEx + CreateProcessAsUser sequence
# lives in a C# class loaded via Add-Type. An earlier PowerShell-native
# implementation returned ERROR_INVALID_NAME (123) from CreateProcess,
# almost certainly due to STARTUPINFO boxing/marshaling weirdness across
# the `ref` boundary in PowerShell. Keeping the whole Win32 dance inside
# one compiled C# method is simpler and unambiguous.

$ErrorActionPreference = 'Continue'
$exePath = Join-Path ${env:ProgramFiles} 'PearGuard\PearGuard.exe'
$pollSeconds = 60

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.ComponentModel;

public static class PGWatchdog {
    const uint INVALID_SESSION_ID = 0xFFFFFFFF;
    const uint TOKEN_ALL_ACCESS = 0xF01FF;
    const int SecurityImpersonation = 2;
    const int TokenPrimary = 1;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    const uint NORMAL_PRIORITY_CLASS = 0x00000020;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct STARTUPINFO {
        public int cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll")]
    static extern uint WTSGetActiveConsoleSessionId();

    [DllImport("wtsapi32.dll", SetLastError = true)]
    static extern bool WTSQueryUserToken(uint SessionId, out IntPtr Token);

    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool DuplicateTokenEx(
        IntPtr hExistingToken, uint dwDesiredAccess,
        IntPtr lpTokenAttributes, int ImpersonationLevel,
        int TokenType, out IntPtr phNewToken);

    [DllImport("userenv.dll", SetLastError = true)]
    static extern bool CreateEnvironmentBlock(
        out IntPtr lpEnvironment, IntPtr hToken, bool bInherit);

    [DllImport("userenv.dll", SetLastError = true)]
    static extern bool DestroyEnvironmentBlock(IntPtr lpEnvironment);

    [DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    static extern bool CreateProcessAsUser(
        IntPtr hToken, string lpApplicationName, string lpCommandLine,
        IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles,
        uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory,
        ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);

    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr hObject);

    /// Returns a short status string on success (e.g. "pid=1234 session=1"),
    /// or throws Win32Exception on failure so PowerShell can log the error
    /// code that came from the actual failing call.
    public static string LaunchInActiveSession(string exePath) {
        uint sessionId = WTSGetActiveConsoleSessionId();
        if (sessionId == INVALID_SESSION_ID) {
            throw new InvalidOperationException("no active console session");
        }

        IntPtr userToken;
        if (!WTSQueryUserToken(sessionId, out userToken)) {
            throw new Win32Exception(Marshal.GetLastWin32Error(), "WTSQueryUserToken");
        }

        try {
            IntPtr dupToken;
            if (!DuplicateTokenEx(userToken, TOKEN_ALL_ACCESS, IntPtr.Zero,
                    SecurityImpersonation, TokenPrimary, out dupToken)) {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "DuplicateTokenEx");
            }

            try {
                IntPtr envBlock;
                bool haveEnv = CreateEnvironmentBlock(out envBlock, dupToken, false);
                // If CreateEnvironmentBlock fails, envBlock is IntPtr.Zero and
                // CreateProcessAsUser will inherit the calling (SYSTEM) env.
                // That's acceptable; we just won't have user-specific env vars.

                try {
                    STARTUPINFO si = new STARTUPINFO();
                    si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
                    PROCESS_INFORMATION pi;

                    uint flags = NORMAL_PRIORITY_CLASS;
                    if (haveEnv) flags |= CREATE_UNICODE_ENVIRONMENT;

                    bool ok = CreateProcessAsUser(
                        dupToken, exePath, null,
                        IntPtr.Zero, IntPtr.Zero, false,
                        flags,
                        haveEnv ? envBlock : IntPtr.Zero,
                        null, ref si, out pi);

                    if (!ok) {
                        throw new Win32Exception(Marshal.GetLastWin32Error(), "CreateProcessAsUser");
                    }

                    if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
                    if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);

                    return "pid=" + pi.dwProcessId + " session=" + sessionId;
                } finally {
                    if (haveEnv) DestroyEnvironmentBlock(envBlock);
                }
            } finally {
                CloseHandle(dupToken);
            }
        } finally {
            CloseHandle(userToken);
        }
    }
}
'@

function Write-Log {
  param([string]$line)
  # NSSM captures stdout to a log file configured at install time.
  Write-Host ("[" + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + "] " + $line)
}

Write-Log 'service started'

while ($true) {
  try {
    if (-not (Test-Path $exePath)) {
      # Uninstaller has removed the exe. Nothing to do; NSSM will be
      # stopped and removed by the uninstaller anyway.
      Start-Sleep -Seconds $pollSeconds
      continue
    }

    $running = @(Get-Process -Name PearGuard -ErrorAction SilentlyContinue).Count -gt 0
    if (-not $running) {
      Write-Log 'PearGuard.exe not running; attempting relaunch'
      try {
        $status = [PGWatchdog]::LaunchInActiveSession($exePath)
        Write-Log ("relaunched " + $exePath + " " + $status)
      } catch {
        Write-Log ("launch failed: " + $_.Exception.Message)
      }
    }
  }
  catch {
    Write-Log ("tick error: " + $_.Exception.Message)
  }

  Start-Sleep -Seconds $pollSeconds
}
