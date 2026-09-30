$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Set-Location D:\tutor-agency-manager
Write-Host "--- typescript 5.x latest:"
npm view typescript@5 version 2>$null | Select-Object -Last 1
Write-Host "--- vite 7.x latest:"
npm view vite@7 version 2>$null | Select-Object -Last 1
Write-Host "--- @vitejs/plugin-react 5.x latest:"
npm view '@vitejs/plugin-react@5' version 2>$null | Select-Object -Last 1
Write-Host "--- eslint 9.x latest:"
npm view eslint@9 version 2>$null | Select-Object -Last 1
Write-Host "--- typescript-eslint peerDeps:"
npm view typescript-eslint@8.71.0 peerDependencies 2>$null
Write-Host "--- vitest 5 peerDeps:"
npm view vitest@5.0.2 peerDependencies 2>$null
Write-Host "--- @types/node 25.x latest:"
npm view '@types/node@25' version 2>$null | Select-Object -Last 1
Write-Host "--- express 5 engines:"
npm view express@5.2.1 engines 2>$null
Write-Host "--- playwright 1.63 engines:"
npm view playwright@1.63.0 engines 2>$null
Write-Host "--- zod 4 engines:"
npm view zod@4.6.5 engines 2>$null
