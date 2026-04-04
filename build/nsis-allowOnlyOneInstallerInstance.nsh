; Override the default "app running" check to avoid the electron-builder bug where
; the installer incorrectly reports "oprocs cannot be closed". We proactively close
; the app (APP_EXECUTABLE_FILENAME is oprocs.exe; the installer is *-Setup.exe so
; we never target the installer), then actively wait until the process is confirmed
; dead and the OS has released all file handles before proceeding.
!macro customCheckAppRunning
  DetailPrint "Closing running application..."
  nsExec::ExecToLog `taskkill /IM "${APP_EXECUTABLE_FILENAME}" /T /F`
  ; Wait until the process is confirmed gone (up to 10 s), then give Windows an
  ; extra 2 s to release memory-mapped file handles (e.g. app.asar, DLLs).
  ; If PowerShell is unavailable the command fails silently and the Sleep below
  ; acts as a fallback.
  nsExec::ExecToLog `powershell -NonInteractive -NoProfile -Command "Get-Process '${PRODUCT_FILENAME}' -ErrorAction SilentlyContinue | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue; Start-Sleep -Seconds 2"`
  Sleep 2000
!macroend
