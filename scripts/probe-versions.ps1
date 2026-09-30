$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Set-Location D:\tutor-agency-manager
foreach ($p in @('express','zod','react','react-dom','vite','@vitejs/plugin-react','typescript','vitest','playwright','@playwright/test','jszip','multer','tsx','eslint','typescript-eslint','@types/express','@types/multer','@types/node','@types/react','@types/react-dom')) {
  $v = npm view $p version 2>$null
  Write-Host "$p = $v"
}
