!include nsDialogs.nsh
!include "${PROJECT_DIR}\desktop\uninstall-data.nsh"

!macro customHeader
!ifdef BUILD_UNINSTALLER
  !insertmacro TutorDefineSafeRemove "un."
  Var TutorDeleteDataCheckbox
  Var TutorDeleteDataSelected
  Var TutorDeleteDataConfirmed
  Var TutorUninstallUpdating
  Var TutorUninstallSilent

  Function un.TutorDataPageCreate
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    ${If} ${Silent}
      Abort
    ${EndIf}
    StrCpy $TutorDeleteDataSelected "0"
    StrCpy $TutorDeleteDataConfirmed "0"
    !insertmacro MUI_HEADER_TEXT "卸载家教中介管理系统" "请选择是否保留本机用户数据"
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 36u "默认只卸载程序，保留订单、老师资料、简历附件、设置和备份，方便重新安装后继续使用。"
    Pop $0
    ${NSD_CreateCheckbox} 0 46u 100% 16u "同时删除所有用户数据"
    Pop $TutorDeleteDataCheckbox
    ${NSD_SetState} $TutorDeleteDataCheckbox ${BST_UNCHECKED}
    ${NSD_CreateLabel} 0 72u 100% 58u "勾选后将删除当前 Windows 用户的数据目录：$\r$\n%APPDATA%\TutorAgencyManager$\r$\n包含订单、老师资料、附件、设置、日志及默认备份。另选的外部备份目录保留。"
    Pop $0
    nsDialogs::Show
  FunctionEnd

  Function un.TutorDataPageLeave
    StrCpy $TutorDeleteDataSelected "0"
    StrCpy $TutorDeleteDataConfirmed "0"
    ${NSD_GetState} $TutorDeleteDataCheckbox $0
    ${If} $0 == ${BST_CHECKED}
      MessageBox MB_YESNO|MB_ICONEXCLAMATION|MB_DEFBUTTON2 "确定同时删除所有用户数据？$\r$\n$\r$\n订单、老师资料、简历附件、设置和默认备份将被永久删除，无法撤销。另选的外部备份目录保留。$\r$\n$\r$\n建议先导出并另存完整备份。" /SD IDNO IDYES tutor_delete_confirmed
      Abort
      tutor_delete_confirmed:
      StrCpy $TutorDeleteDataSelected "1"
      StrCpy $TutorDeleteDataConfirmed "1"
    ${EndIf}
  FunctionEnd
!endif
!macroend

; Replace the welcome page, so the choice appears before any uninstall work.
!macro customUnWelcomePage
  UninstPage custom un.TutorDataPageCreate un.TutorDataPageLeave
!macroend

!macro customUnInstall
  StrCpy $TutorUninstallUpdating "0"
  StrCpy $TutorUninstallSilent "0"
  ${If} ${isUpdated}
    StrCpy $TutorUninstallUpdating "1"
  ${EndIf}
  ${If} ${Silent}
    StrCpy $TutorUninstallSilent "1"
  ${EndIf}
  ; For an all-users installation, delete only the invoking user's profile.
  SetShellVarContext current
  ClearErrors
  !insertmacro TutorDeleteConfirmedData "$TutorDeleteDataSelected" "$TutorDeleteDataConfirmed" "$TutorUninstallUpdating" "$TutorUninstallSilent" "$APPDATA\TutorAgencyManager" "un."
  ${If} ${Errors}
    MessageBox MB_OK|MB_ICONEXCLAMATION "部分用户数据无法删除（文件可能被占用，或数据目录是链接）。程序会继续卸载。$\r$\n请退出相关程序后检查 %APPDATA%\TutorAgencyManager 中的残留数据。" /SD IDOK
  ${EndIf}
  ${If} $installMode == "all"
    SetShellVarContext all
  ${EndIf}
!macroend
