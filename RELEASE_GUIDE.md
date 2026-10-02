# GitHub 自动构建与升级

## 自动构建

工作流为 `.github/workflows/windows.yml`，使用 GitHub Windows x64 机器和 Node.js 24，依赖按 lockfile 安装。

- 推送 `main` 或向 `main` 提交 PR：类型检查、lint、单元/集成测试、浏览器验收、Electron 验收、安装包构建及打包程序验收。
- Actions → Windows CI and Release → Run workflow：手动构建选定分支。
- 推送 `v版本号` 标签：全部验证通过后自动创建 GitHub Release，上传安装包、免安装 ZIP 和 SHA256 清单。标签必须对应 `package.json` 的版本。

仓库 Settings → Actions → General 应允许 GitHub Actions。发布任务已声明 `contents: write`，使用自动提供的 `GITHUB_TOKEN`，不需要个人访问令牌。组织策略若禁止工作流写入，需管理员放行。当前未配置 Windows 代码签名证书。

普通构建成功后，在该次 Actions 运行下方 Artifacts 下载 `windows-x64-提交SHA`，保留14天；正式版本在 Releases → Assets 下载。安装包为 `TutorAgencyManager-Setup-版本-x64.exe`，免安装包为 `TutorAgencyManager-Unpacked-版本-x64.zip`。完整解压后运行其中 `win-unpacked/家教中介管理系统.exe`，不能只复制exe。

## 首次发布

当前版本是1.0.0。main构建通过后执行：

```powershell
git tag v1.0.0
git push origin v1.0.0
```

标签构建通过后 Releases 自动出现v1.0.0和下载附件。不要只创建一个没有构建附件的空Release。发布失败可以查看日志并重试；代码需要修复时使用新版本和新标签，不覆盖已经交付的版本。

## 后续发布

代码改好并测试后，发布修订版示例：

```powershell
npm version patch --no-git-tag-version
npm run release:check
git add .
git commit -m "发布1.0.1：修复和改进"
git push origin main
git tag v1.0.1
git push origin v1.0.1
```

`npm version` 同时更新package.json和package-lock.json。patch把1.0.0改为1.0.1，minor把1.0.1改为1.1.0；示例标签按实际版本调整。普通源码推送生成测试构建，正式发布由标签触发。

## 已安装程序如何升级

1. 旧版“清理与备份”立即备份，另存完整ZIP。
2. 托盘右键“退出”，等待关闭备份结束。窗口右上角×只是隐藏，不能代替退出。
3. 在Releases下载新版Setup，直接安装并沿用原安装方式和位置，无需先卸载。
4. 打开新版，检查订单、老师报名、附件与备份设置。

固定程序标识为 `cn.tutoragency.manager`，正式数据目录为 `%APPDATA%/TutorAgencyManager/data/`。版本号和安装路径变化不会改变正式数据位置，覆盖安装继续读取原数据和配置，设置在其他磁盘的备份目录也会沿用。启动时自动运行数据库migrations；今后增加迁移仍需验证从上一版数据库升级。

免安装用户退出旧版，将新版ZIP完整解压到新文件夹，再运行新exe。它使用同一正式数据目录，新旧版不能同时运行。开发命令使用独立的 `.desktop-dev` 数据目录。

当前是**GitHub自动构建/发布＋用户覆盖安装升级**，没有程序内自动检查、下载和安装更新。更新后的数据库可能包含旧版不认识的结构，不建议直接降级；回退前保护最新资料，必要时用旧版对应的完整备份恢复。

## 本地同等验证

```powershell
npm ci
npx playwright install chromium
npm run release:check
npm run typecheck
npm run lint
npm test
npm run build
npm run test:e2e
npm run test:desktop
npm run dist:win
$env:DESKTOP_TEST_EXECUTABLE = (Resolve-Path 'release/win-unpacked/家教中介管理系统.exe').Path
npm run test:desktop
Remove-Item Env:DESKTOP_TEST_EXECUTABLE
./scripts/create-release-assets.ps1
```

标志源文件为 `desktop/brand.svg`，已提交生成的PNG/ICO；修改标志时执行 `node scripts/generate-desktop-icon.mjs` 重新生成并提交。CI直接使用仓库内图标。
