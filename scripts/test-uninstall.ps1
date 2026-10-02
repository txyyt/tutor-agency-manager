param([string]$MakensisPath)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
if (-not $MakensisPath) {
    $builderCache = if ($env:ELECTRON_BUILDER_CACHE) { $env:ELECTRON_BUILDER_CACHE } else { Join-Path $env:LOCALAPPDATA 'electron-builder/Cache' }
    $MakensisPath = Get-ChildItem -LiteralPath $builderCache -Filter makensis.exe -Recurse |
        Where-Object { $_.FullName -match 'nsis-' -and $_.Directory.Name -eq 'Bin' } |
        Select-Object -First 1 -ExpandProperty FullName
}
if (-not $MakensisPath) { throw '先构建 Windows 安装包，以下载 NSIS 编译器。' }
$testRoot = Join-Path $projectRoot ('test-results/uninstall-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $testRoot -Force | Out-Null
$cases = @(
    @{ Name = 'unchecked'; Selected = 0; Confirmed = 0; Updating = 0; Silent = 0; Delete = $false },
    @{ Name = 'declined'; Selected = 1; Confirmed = 0; Updating = 0; Silent = 0; Delete = $false },
    @{ Name = 'confirmed'; Selected = 1; Confirmed = 1; Updating = 0; Silent = 0; Delete = $true },
    @{ Name = 'upgrade'; Selected = 1; Confirmed = 1; Updating = 1; Silent = 0; Delete = $false },
    @{ Name = 'silent'; Selected = 1; Confirmed = 1; Updating = 0; Silent = 1; Delete = $false },
    @{ Name = 'root-junction'; Selected = 1; Confirmed = 1; Updating = 0; Silent = 0; Delete = $false },
    @{ Name = 'nested-junction'; Selected = 1; Confirmed = 1; Updating = 0; Silent = 0; Delete = $true }
)
$sections = @()
foreach ($case in $cases) {
    $profile = Join-Path $testRoot ($case.Name + '/TutorAgencyManager')
    $external = Join-Path $testRoot ($case.Name + '/external-backups')
    New-Item -ItemType Directory -Path $external -Force | Out-Null
    Set-Content -LiteralPath (Join-Path $external 'backup.txt') -Value 'external backup must remain' -Encoding utf8
    if ($case.Name -eq 'root-junction') {
        New-Item -ItemType Junction -Path $profile -Target $external | Out-Null
    } else {
        New-Item -ItemType Directory -Path (Join-Path $profile 'data/attachments') -Force | Out-Null
        Set-Content -LiteralPath (Join-Path $profile 'data/attachments/resume.txt') -Value 'isolated fixture' -Encoding utf8
        if ($case.Name -eq 'nested-junction') {
            New-Item -ItemType Junction -Path (Join-Path $profile 'external-link') -Target $external | Out-Null
        }
    }
    $sections += '!insertmacro TutorDeleteConfirmedData "{0}" "{1}" "{2}" "{3}" "$EXEDIR\{4}\TutorAgencyManager" ""' -f $case.Selected, $case.Confirmed, $case.Updating, $case.Silent, $case.Name
}
$nsisScript = @'
Unicode true
Name "Isolated uninstall policy regression"
OutFile "@OUTPUT@"
RequestExecutionLevel user
SilentInstall silent
!include "@INCLUDE@"
!insertmacro TutorDefineSafeRemove ""
Section
  @SECTIONS@
SectionEnd
'@
$nsisScript = $nsisScript.Replace('@OUTPUT@', (Join-Path $testRoot 'policy-test.exe')).Replace('@INCLUDE@', (Join-Path $projectRoot 'desktop/uninstall-data.nsh')).Replace('@SECTIONS@', ($sections -join "`n  "))
$source = Join-Path $testRoot 'policy-test.nsi'
Set-Content -LiteralPath $source -Value $nsisScript -Encoding utf8
& $MakensisPath /V2 $source
if ($LASTEXITCODE -ne 0) { throw 'NSIS 回归程序编译失败' }
$process = Start-Process -FilePath (Join-Path $testRoot 'policy-test.exe') -WindowStyle Hidden -Wait -PassThru
if ($process.ExitCode -ne 0) { throw 'NSIS 回归程序运行失败' }
foreach ($case in $cases) {
    $profile = Join-Path $testRoot ($case.Name + '/TutorAgencyManager')
    if ((Test-Path -LiteralPath $profile) -eq $case.Delete) { throw "卸载策略失败：$($case.Name)" }
    if (-not (Test-Path -LiteralPath (Join-Path $testRoot ($case.Name + '/external-backups/backup.txt')))) { throw '外部备份被误删' }
    Write-Output "通过：$($case.Name)"
}
Write-Output '真实 NSIS 删除逻辑通过：未勾选、取消确认、确认删除、升级保护、静默保护、目录链接保护及外部备份保留。'
