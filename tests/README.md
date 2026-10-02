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

## 目录与产物

- `unit/`：模板解析、金额计算、定时备份等单元测试。
- `integration/`：真实 HTTP、SQLite、附件、备份恢复及进程启停测试。
- `e2e/`：页面操作、流程、布局及导航测试，包括服务启动器与辅助代码。
- `helpers/`：集成测试服务和模拟数据生成工具。
- `fixtures/`：测试依赖的模板、图片与 PDF，请保留并提交。

`test-results/`、`playwright-report/`、`coverage/`、临时数据库和运行备份继续由 `.gitignore` 排除，可在测试结束后清理。
