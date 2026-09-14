; App data is beside the executable. Remove only known shipped files, never the whole install tree.
!include "app-files.nsh"

!macro customRemoveFiles
  !insertmacro removePackagedFiles
  Delete "$INSTDIR\${UNINSTALL_FILENAME}"
  RMDir "$INSTDIR"
!macroend

; A fresh install defaults beside the Setup executable; /D and previous installations take priority.
!macro customInit
  ${if} $hasPerUserInstallation == "0"
  ${andIf} $hasPerMachineInstallation == "0"
    !insertmacro GetDParameter $R0
    ${if} $R0 == ""
      StrCpy $INSTDIR "$EXEDIR\Modbus Debugger"
    ${endif}
  ${endif}
!macroend

!macro customInstallMode
  ; This app always installs for the current user. Skip the mode page without resetting $INSTDIR.
  StrCpy $installMode CurrentUser
  SetShellVarContext current
  Abort
!macroend
