!include LogicLib.nsh

; Shared by the real uninstaller and the isolated NSIS regression harness.
; The root is fixed by the caller; never read the configured external backup path.
!macro TutorDeleteConfirmedData selected confirmed updating silent root prefix
  ${If} "${selected}" == "1"
  ${AndIf} "${confirmed}" == "1"
  ${AndIf} "${updating}" != "1"
  ${AndIf} "${silent}" != "1"
    ; Do not traverse a redirected profile root.
    System::Call 'kernel32::GetFileAttributesW(w "${root}") i .r0'
    ${If} $0 != -1
      IntOp $0 $0 & 0x400
      ${If} $0 == 0
        ClearErrors
        Push "${root}"
        Call ${prefix}TutorSafeRemove
        Pop $0
        ${If} $0 != 0
          SetErrors
        ${EndIf}
      ${Else}
        SetErrors
      ${EndIf}
    ${EndIf}
  ${EndIf}
!macroend

; NSIS RMDir /r follows nested junctions. Walk explicitly and remove links
; themselves without visiting their targets, to preserve external backups.
!macro TutorDefineSafeRemove prefix
  Function ${prefix}TutorSafeRemove
    Exch $R0
    Push $R1
    Push $R2
    Push $R3
    Push $R4
    Push $R5
    StrCpy $R4 0
    FindFirst $R1 $R2 "$R0\*.*"
    ${DoWhile} $R2 != ""
      ${If} $R2 != "."
      ${AndIf} $R2 != ".."
        System::Call 'kernel32::GetFileAttributesW(w "$R0\$R2") i .s'
        Pop $R3
        IntOp $R5 $R3 & 0x10
        ClearErrors
        ${If} $R5 != 0
          IntOp $R5 $R3 & 0x400
          ${If} $R5 != 0
            RMDir "$R0\$R2"
          ${Else}
            Push "$R0\$R2"
            Call ${prefix}TutorSafeRemove
            Pop $R5
            ${If} $R5 != 0
              SetErrors
            ${EndIf}
          ${EndIf}
        ${Else}
          Delete "$R0\$R2"
        ${EndIf}
        ${If} ${Errors}
          StrCpy $R4 1
        ${EndIf}
      ${EndIf}
      FindNext $R1 $R2
    ${Loop}
    FindClose $R1
    ClearErrors
    RMDir "$R0"
    ${If} ${Errors}
      StrCpy $R4 1
    ${EndIf}
    StrCpy $R0 $R4
    Pop $R5
    Pop $R4
    Pop $R3
    Pop $R2
    Pop $R1
    Exch $R0
  FunctionEnd
!macroend
