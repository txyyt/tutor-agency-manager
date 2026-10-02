# 家教中介管理系统

面向家教中介的 Windows 桌面管理工具。从家长需求录入、老师报名与推荐，到试课、费用结清和备份恢复，在本机完成管理。中文界面，数据保存在自己的电脑上，安装版自带运行环境。

## 下载与使用

前往 [Releases](https://github.com/txyyt/tutor-agency-manager/releases) 下载正式版本：

- **安装版**：下载 `TutorAgencyManager-Setup-版本-x64.exe`，按向导安装后使用快捷方式启动。
- **免安装版**：下载 `TutorAgencyManager-Unpacked-版本-x64.zip`，完整解压后运行 `win-unpacked/家教中介管理系统.exe`。请保留整个文件夹，不能只复制 EXE。
- **校验文件**：`SHA256SUMS.txt` 提供两个下载包的 SHA-256 校验值。

适用于 Windows x64。默认窗口为 1440×900，最小为 1100×720。点击右上角 × 或按 Alt+F4 会隐藏到托盘，后台继续运行；托盘右键“退出”才会等待关闭备份并退出程序。再次启动会唤起已有窗口。

## 日常业务流程

1. 在“新建订单”复制家长模板，收到填写内容后粘贴解析、检查并保存，订单立即进入招募中。
2. 导出全部招募中文字，复制或下载 TXT，手动发布到微信群。公开文字不包含家长联系方式、内部地点或内部备注。
3. 老师按订单编号提交报名模板。在“老师报名”粘贴解析，可同时上传简历附件；每份报名独立关联一个订单。
4. 在订单详情多选候选生成摘要，或在老师详情复制老师信息，发送给家长后标记“已推荐”。
5. 家长确定试课老师后，安排试课并约定中介费、保证金；实际收到保证金后确认到账，收齐即开始试课。
6. 点击“试课通过”先确认合作，再单独点击“收取中介费”登记到账。保证金抵扣中介费，费用结清且其他候选无待退款时，订单自动完成。
7. 跳过试课直接合作同样先确认，再单独收费；未推荐的报名不能安排试课或直接合作。试课失败、主动退出或家长取消时，实际退款后登记退款。

全部中介费用由报名老师支付。系统记录收退款，不处理真实支付。订单完成后，中介任务结束。

## 主要功能

- **模板录入**：家长与老师微信、电话必填；支持常见中文时间表达，解析结果可补正。线下内部地点可留空，显示“试课时问家长”；线上无需填写区域。
- **订单管理**：搜索、状态/科目/年级筛选、分页与页码跳转；默认待办优先，可按最近修改或订单编号升降序排列。最近修改取订单及关联报名中的最新时间。
- **报名与简历**：候选全选、批量推荐、老师资料编辑、PDF/JPEG/PNG 上传、预览与下载；每份报名最多 5 个附件，每个不超过 10MB。
- **费用管理**：保证金分次到账、中介费补收、分次退款和收退款历史。金额更正按单项操作并填写理由；未设置金额时不可更正，已完成订单费用锁定。
- **误录删除**：删除报名及附件，删除订单级联删除关联报名；删除前自动备份，并检查试课及未结清款项。
- **90天清理**：按最后实际修改日期评估，保护在办订单、未结清款项和关联记录；有可删除数据时先备份再执行。
- **桌面体验**：自定义窗口按钮、托盘运行、开屏与加载动画、操作通知、未保存提醒及页面滚动位置管理。

## 数据与备份

正式桌面版数据固定保存在：

```text
%APPDATA%/TutorAgencyManager/data/
```

其中 `runtime.json` 保存运行配置与活动数据代指针，`generations/<数据代>/database.sqlite` 保存数据库，同一数据代内的 `attachments/` 保存简历附件。桌面开发版使用 `.desktop-dev/data/`，网页版默认使用项目 `data/`，三个环境的数据独立。

备份包含数据库一致性快照、全部附件及校验清单，可在“清理与备份”下载完整 ZIP。恢复既可选择已有备份，也可上传 ZIP，校验预览后确认替换当前数据；恢复前会自动备份。

| 备份类别 | 触发方式 | 保留规则 |
| --- | --- | --- |
| 定时备份 | 默认北京时间每天 20:00，可修改；程序运行到设置时间才执行，错过不补做 | 最近 5 份 |
| 启动/关闭备份 | 启动及正常退出各一次；隐藏到托盘不算退出 | 两者合计最近 5 份 |
| 手动备份 | 点击“立即备份” | 最近 5 份 |
| 安全备份 | 删除、清理和恢复等操作前 | 合计最多 5 份，且不超过 30 天 |

备份目录可通过“选择文件夹”设置，通过“打开备份文件夹”查看。保存新目录并确认后，系统复制、校验并迁移已有登记备份，再清理旧副本与空分类目录；无关文件保留。自行下载到其他位置的副本不参与系统轮换。

## 升级已安装程序

1. 在旧版立即备份，并把完整 ZIP 另存到其他位置。
2. 从托盘右键退出，等待关闭备份完成。
3. 下载新版安装包，沿用原安装方式和位置覆盖安装，无需先卸载。
4. 打开新版，检查订单、老师报名、附件与设置。

固定数据目录使新版继续读取原有业务数据。免安装用户退出旧版后，完整解压新版并运行新 EXE，同样使用正式数据目录。当前更新方式是下载新版安装或解压升级。

## 本地开发与测试

开发环境使用 Windows、PowerShell 7 和 Node.js 24，依赖版本由 `package-lock.json` 锁定。

```powershell
npm ci
npm run dev:desktop
```

网页版开发使用 `npm run dev`；生产方式使用 `npm run build` 后执行 `npm start`，默认地址为 `http://127.0.0.1:3000`。端口和网页版数据目录可通过 `APP_PORT`、`APP_DATA_DIR` 设置。

```powershell
npm run release:check
npm run typecheck
npm run lint
npm test
npx playwright install chromium
npm run build
npm run test:e2e
npm run test:desktop
```

自动测试使用隔离的模拟数据，覆盖业务、数据库、附件、备份恢复、浏览器页面及真实 Electron 操作。`tests/fixtures/` 是测试依赖的虚构素材；测试产物和业务数据不提交 Git。

本地构建 Windows 安装包和免安装 ZIP：

```powershell
npm run dist:win
$env:DESKTOP_TEST_EXECUTABLE = (Resolve-Path 'release/win-unpacked/家教中介管理系统.exe').Path
npm run test:desktop
Remove-Item Env:DESKTOP_TEST_EXECUTABLE
./scripts/create-release-assets.ps1
```

产物保存在 `release/`。技术栈为 TypeScript、React、Vite、Express、SQLite、Electron 与 electron-builder；测试使用 Vitest 和 Playwright。

## GitHub 自动构建与发布

工作流位于 `.github/workflows/windows.yml`：

- 推送 `main` 或提交到 `main` 的 PR：自动检查、测试、构建 Windows 包，并验收打包后的程序。
- 在 [Actions](https://github.com/txyyt/tutor-agency-manager/actions) → Windows CI and Release → Run workflow 可手动触发。
- 普通构建的下载包位于对应运行的 Artifacts，保留 14 天。
- 推送与 `package.json` 版本一致的 `v版本号` 标签：检查通过后自动创建正式 Release，上传安装包、免安装 ZIP 与校验文件。

发布当前 `1.0.0`：

```powershell
git tag v1.0.0
git push origin v1.0.0
```

后续修订版本先执行 `npm version patch --no-git-tag-version`，提交并推送代码，再为实际版本创建并推送新标签。发布工作流使用 GitHub 自动提供的 `GITHUB_TOKEN`。

## 本机文档

`docs/` 仅保留 `使用手册.md` 和 `自动构建与升级指南.md`。按本项目的版本管理约定，该目录保留在本机，不上传 GitHub；仓库的使用、开发与发布入口统一在本 README。
