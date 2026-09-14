; Project-owned no-install launcher. electron-builder supplies product/version/icon commands.
!include "LogicLib.nsh"
!include "FileFunc.nsh"
Unicode true
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
Var AppDirectory
Var RunDirectory

Function .onInit
  ; No NSIS plug-ins are used, so nothing is extracted to the system plugin/temp directory.
  CreateDirectory "$EXEDIR\temp"
  ClearErrors
  GetTempFileName $RunDirectory "$EXEDIR\temp"
  IfErrors unwritable
  Delete "$RunDirectory"
  CreateDirectory "$RunDirectory"
  IfErrors unwritable
  StrCpy $AppDirectory "$RunDirectory\app"
  Return
unwritable:
  MessageBox MB_ICONSTOP "Portable needs a writable folder beside this executable. Move it to a writable location and retry."
  SetErrorLevel 1
  Quit
FunctionEnd

Section
  SetOutPath "$AppDirectory"
  File /r "@@APP_DIRECTORY@@\*.*"
  ${GetParameters} $0
  ExecWait '"$AppDirectory\modbus-debugger.exe" --portable-dir="$EXEDIR" $0' $1
  SetOutPath "$EXEDIR"
  ; RunDirectory is exclusively this invocation's GetTempFileName path, never the user's data tree.
  RMDir /r "$RunDirectory"
  SetErrorLevel $1
SectionEnd
