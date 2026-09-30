# 家教中介管理系统

中介内部使用的本机Web应用：管理家长需求（订单）、大学生老师报名、推荐试课、保证金与中介费收退、90天到期清理，以及完整备份与恢复。中文界面，仅监听 `127.0.0.1`，不云部署、不自动发微信、不接入真实支付。

已按 [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) 完成实现与验收（AC01—AC61），结果见 [docs/ACCEPTANCE_REPORT.md](docs/ACCEPTANCE_REPORT.md)。

## 快速开始

```powershell
npm install       # 安装依赖（lockfile锁定版本）
npm run build     # 构建前端(vite)与后端(tsc)
npm start         # 启动：http://127.0.0.1:3000（数据目录默认 ./data）
```

开发模式：`npm run dev`（前端5173热更新，/api代理到3000）。端口/数据目录可用 `APP_PORT` / `APP_DATA_DIR` 环境变量调整。详细操作见 [docs/USER_GUIDE.md](docs/USER_GUIDE.md)。

## 功能一览

- **两张业务表**：订单 `orders`、老师报名 `applications`；每次需求、每次投递独立保存。
- **粘贴自动录入**：直接粘贴填写好的家长/老师微信模板，确定性解析（TypeScript实现，无AI/外部网络），补正标红项后保存；按订单编号精确关联，创建请求ID防重复提交。
- **状态与费用**：招募 → 挑选 → 安排试课 → 试课 → 通过/直接合作 → 确认合作 → 结清完成；保证金抵扣中介费、失败/退出/取消退款、录错带理由更正；财务操作ID幂等（重启后重放不重复加钱）。
- **90天清理**：按最后实际修改计算，保护在办订单、未退清款项与被引用记录；确有可删数据才生成清理前备份，失败暂缓删除。
- **备份恢复**：界面导出完整ZIP（数据库一致性快照+全部附件+SHA-256清单）、校验预览后原子切换恢复（自动data_epoch防旧请求覆盖）；每日02:00自动备份+启动补做，日备份默认保留30份，安全备份最多10份/30天。
- **本机安全**：单实例运行锁、Host/Origin/CSRF校验、附件类型与大小服务端校验、受控预览与下载。

## 常用命令

```text
npm run dev            # 开发（前后端热更新）
npm run build          # 构建生产产物到 dist/
npm start              # 启动服务（127.0.0.1:3000）
npm run typecheck      # TypeScript检查（server/client/scripts）
npm run lint           # ESLint
npm test               # 单元+集成测试（vitest，隔离临时库）
npm run test:unit      # 仅单元
npm run test:integration # 仅集成
npm run test:e2e       # Playwright真实浏览器E2E（隔离数据目录）
npm run cleanup:preview # 预览90天到期清理
npm run cleanup        # 执行清理（先备份再删）
npm run backup         # 手动完整备份
npm run restore -- --from <备份ZIP> --yes   # 恢复（先停止服务）
```

## 技术栈

React 19 + TypeScript + Vite（前端）；Node.js + Express 5 + TypeScript（后端）；`node:sqlite`（SQLite 3，参数化SQL+事务+外键，迁移在 `migrations/*.sql`，以 `user_version` 管理）；Zod 服务端校验；Vitest（单元/集成）+ Playwright（浏览器E2E）。解析、文本生成、金额与时间处理在 `src/shared` 前后端共用。

## 数据目录

`data/`（不入Git）：`runtime.json` 活动数据代指针与配置；`generations/<代ID>/database.sqlite` 与 `attachments/` 业务数据；`backups/` 备份；`staging/` 暂存。可用 `APP_DATA_DIR` 重定向。备份请定期另存到其他磁盘/U盘，系统不自动上云。

## 实际限制（第一版边界）

- 服务停止期间无法自动备份/清理，重启补做当前快照，不补造历史日期包。
- 已完成订单财务锁定；后续课程与授课工资管理不在范围。
- 人工保存的备份不会随清理自动删除；换电脑恢复仅保证备份内已知编号不复用。
- 单机单实例；多设备同时办公、公网部署需另行增加认证，未包含。

## 文档

- [实施与验收方案](docs/IMPLEMENTATION_PLAN.md) / [微信模板](docs/WECHAT_TEMPLATES.md)
- [使用手册](docs/USER_GUIDE.md) / [验收报告](docs/ACCEPTANCE_REPORT.md)（AC01—AC61逐条证据）/ [关键截图](docs/screenshots/)
