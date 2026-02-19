; Override the default "app running" check to avoid the electron-builder bug where
; the installer incorrectly reports "oprocs cannot be closed". We proactively close
; the app (APP_EXECUTABLE_FILENAME is oprocs.exe; the installer is *-Setup.exe so
; we never target the installer), then give it a moment to exit before proceeding.
!macro customCheckAppRunning
  DetailPrint "Closing running application..."
  nsExec::ExecToLog `taskkill /IM "${APP_EXECUTABLE_FILENAME}" /T /F`
  Sleep 2000
!macroend
