# 自动化测试

本目录纳入 Git，包含单元测试、集成测试、浏览器端到端测试及其模拟素材。
`fixtures/acceptance/` 中的家长、老师及简历资料均为虚构测试数据。

## 首次运行

使用符合项目 `engines` 要求、支持 `node:sqlite` 的 Node.js，在仓库根目录执行：

```powershell
npm ci
npm run typecheck
npm run lint
npm test
```

## 浏览器测试

```powershell
npx playwright install chromium
npm run build
npm run test:e2e
```

浏览器测试自动启动隔离服务，使用 `127.0.0.1:3300`，运行前请确保该端口空闲。
测试使用临时数据库，不使用正式业务数据目录。

## 桌面测试

构建后执行 `npm run test:desktop`。它在真实 Electron 中验证自定义窗口按钮、关闭到托盘保留后台、重复启动恢复、安全隔离、订单报名附件、正式退出确认、启停备份与重启持久化。
设置 `DESKTOP_TEST_EXECUTABLE` 为 `release/win-unpacked/家教中介管理系统.exe` 的绝对路径，可对打包后的程序执行同一套测试。
所有桌面测试使用临时数据目录，不读取正式业务资料。人工安装与升级验收见根目录 `DESKTOP_ACCEPTANCE.md`。

## 目录与产物

- `unit/`：模板解析、金额计算、定时备份等单元测试。
- `integration/`：真实 HTTP、SQLite、附件、备份恢复及进程启停测试。
- `integration/backup-migration.test.ts`：跨目录迁移、复制校验、配置提交失败回滚、旧文件占用重试、中断启动对账及各组5份保留规则。
- `e2e/`：页面操作、流程、布局及导航测试，包括服务启动器与辅助代码。
- `helpers/`：集成测试服务和模拟数据生成工具。
- `fixtures/`：测试依赖的模板、图片与 PDF，请保留并提交。

`test-results/`、`playwright-report/`、`coverage/`、临时数据库和运行备份继续由 `.gitignore` 排除，可在测试结束后清理。
