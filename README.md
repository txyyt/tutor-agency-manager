# 家教中介管理系统

中介内部使用的本机Web应用：管理家长需求（订单）、大学生老师报名、推荐试课、保证金与中介费收退、90天到期清理，以及完整备份与恢复。中文界面，仅监听 `127.0.0.1`，不云部署、不自动发微信、不接入真实支付。

Windows桌面验收见 [DESKTOP_ACCEPTANCE.md](DESKTOP_ACCEPTANCE.md)，GitHub构建、发布和升级见 [RELEASE_GUIDE.md](RELEASE_GUIDE.md)。历史实施资料保留在本机 `docs/`，不纳入版本管理。

## 快速开始

```powershell
npm ci            # 按lockfile安装依赖
npm run build     # 构建前端(vite)与后端(tsc)
npm start         # 启动：http://127.0.0.1:3000（数据目录默认 ./data）
```

开发模式：`npm run dev`（前端5173热更新，/api代理到3000）。端口/数据目录可用 `APP_PORT` / `APP_DATA_DIR` 环境变量调整。

## Windows 桌面版

```powershell
npm run dev:desktop  # 构建并打开桌面开发窗口（修改代码后重新运行）
npm run test:desktop # 真实 Electron 桌面回归，使用隔离模拟数据
npm run pack:win     # 输出 release/win-unpacked/ 供打包后验证
npm run dist:win     # 输出 release/TutorAgencyManager-Setup-1.0.0-x64.exe 安装包
```

安装版自带运行环境，无需安装 Node.js。默认窗口 1440×900，最小 1100×720，使用自定义标题栏与最小化、最大化/还原按钮。点击 × 或 Alt+F4 隐藏到托盘，未保存资料保留、后台与定时备份继续运行；单击/双击托盘图标或右键“打开主窗口”恢复窗口。托盘右键“退出”才检查未保存资料并等待关闭备份，重复启动唤起原窗口。桌面开发数据使用 `.desktop-dev/data/`；正式安装版固定使用 `%APPDATA%/TutorAgencyManager/data/`，数据库、附件和备份均在该目录，覆盖安装升级与卸载默认保留业务数据。

首次迁移：在原系统导出完整备份包，关闭原系统，再在桌面版“清理与备份”导入恢复。桌面开发版与正式安装版使用独立数据目录，不会自动读取网页版的 `data/`。桌面后台使用随机本机端口，继续只监听 `127.0.0.1`。GitHub在推送main/提交PR时自动测试和打包，推送与版本一致的 `v版本号` 标签后自动发布安装包与免安装ZIP。

安装包验收流程见 [DESKTOP_ACCEPTANCE.md](DESKTOP_ACCEPTANCE.md)。

## 功能一览

- **两张业务表**：订单 `orders`、老师报名 `applications`；每次需求、每次投递独立保存。
- **粘贴自动录入**：直接粘贴填写好的家长/老师微信模板，确定性解析（TypeScript实现，无AI/外部网络），补正标红项后保存；按订单编号精确关联，创建请求ID防重复提交。
- **状态与费用**：招募 → 推荐 → 安排试课 → 试课通过/直接合作 → 结清完成；保证金抵扣中介费、失败/退出/取消退款、录错带理由更正；财务操作ID幂等（重启后重放不重复加钱）。
- **90天清理**：按最后实际修改计算，保护在办订单、未退清款项与被引用记录；确有可删数据才生成清理前备份，失败暂缓删除。
- **备份恢复**：界面导出完整ZIP（数据库一致性快照+全部附件+SHA-256清单）、校验预览后原子切换恢复（自动data_epoch防旧请求覆盖）；定时备份默认北京时间20:00（可修改），运行到设置时间才执行、错过不补做，保留最近5份；启动和正常关闭各备份一次，合计保留最近5份；手动5份，安全备份合计最多5份/30天。
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

“清理与备份 → 设置 → 备份目录”留空使用数据目录内的 `backups`。定时、手动、启停、安全备份分别保存于其下 `daily`、`manual`、`lifecycle`、`safety` 子目录，各组保留5份（安全备份另限30天）。切换目录需确认，将全部登记的备份复制并校验，提交目录及索引后再清理旧文件；不移动自行下载的副本或其他文件。迁移日志支持启动对账；旧文件占用时提供重试清理。旧配置字段 `autoBackupDir` 保留兼容，含义统一为备份根目录。

## 实际限制（第一版边界）

- 服务停止期间不执行定时备份；启动和正常停止服务（Ctrl+C）各保存一份备份。关闭备份完成后才退出；强制结束进程、断电无法保证关闭备份。仅关闭浏览器页面不等于停止服务。开发模式后端重启也按此规则备份。
- 已完成订单财务锁定；后续课程与授课工资管理不在范围。
- 人工保存的备份不会随清理自动删除；换电脑恢复仅保证备份内已知编号不复用。
- 单机单实例；多设备同时办公、公网部署需另行增加认证，未包含。

## 文档

- [桌面验收](DESKTOP_ACCEPTANCE.md)
- [GitHub自动构建、版本发布与升级](RELEASE_GUIDE.md)
