$ErrorActionPreference = 'Stop'
$workspacePath = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$releasePath = Join-Path $workspacePath 'release'
$package = Get-Content -LiteralPath (Join-Path $workspacePath 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $package.version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw '正式版本号必须为 x.y.z' }
$installerPath = Join-Path $releasePath "TutorAgencyManager-Setup-$version-x64.exe"
$unpackedPath = Join-Path $releasePath 'win-unpacked'
if (-not (Test-Path -LiteralPath $installerPath -PathType Leaf)) { throw "安装包不存在：$installerPath" }
if (-not (Test-Path -LiteralPath (Join-Path $unpackedPath '家教中介管理系统.exe') -PathType Leaf)) { throw '免安装程序不存在' }
$zipPath = Join-Path $releasePath "TutorAgencyManager-Unpacked-$version-x64.zip"
if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[System.IO.Compression.ZipFile]::CreateFromDirectory($unpackedPath, $zipPath, [System.IO.Compression.CompressionLevel]::Optimal, $true)
$checksums = @($installerPath, $zipPath) | ForEach-Object {
    $hash = (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash.ToLowerInvariant()
    "$hash  $([System.IO.Path]::GetFileName($_))"
}
$checksums | Set-Content -LiteralPath (Join-Path $releasePath 'SHA256SUMS.txt') -Encoding utf8
Write-Output "发布文件已生成：$releasePath"
