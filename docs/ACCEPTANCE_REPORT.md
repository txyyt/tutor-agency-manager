# 验收报告（ACCEPTANCE_REPORT）

日期：2026-09-30。基准：docs/IMPLEMENTATION_PLAN.md V1.3（AC01—AC61）。
本报告逐条映射验收矩阵，只记录实际执行过的测试与真实结果；未执行的项目明确标注。

## 1. 执行环境与命令结果（真实输出）

| 命令 | 结果 | 摘要 |
| --- | --- | --- |
| `node --version` / `npm --version` | 通过 | v25.9.0 / 11.12.1（Windows 11，PowerShell 7执行） |
| `node:sqlite` API验证 | 通过 | SQLite 3.51.3，`DatabaseSync`/`VACUUM INTO` 可用（scripts/probe-sqlite.mjs，开发期核验） |
| 依赖版本核验 | 通过 | npm registry查询（express 5.2.1、zod 4.6.5、react 19.3.0、vite 7.3.6、typescript 5.9.3、vitest 5.0.2、@playwright/test 1.63.0、eslint 9.39.5等），peerDependencies兼容性核验后锁定精确版本于package.json，提交lockfile |
| `npm run typecheck` | 通过 | server + client + scripts 三个tsconfig，0错误 |
| `npm run lint` | 通过 | eslint 0错误0警告 |
| `npm run build` | 通过 | vite构建 42模块（约309KB JS），tsc编译server产物 |
| `npm test`（unit+integration） | 通过 | 单元 39/39，集成 80/80（6个文件） |
| `npm run test:e2e` | 通过 | Playwright 16/16，Chromium真实浏览器，隔离临时数据目录（127.0.0.1:3300） |
| `npm start` | 通过 | 编译产物启动，`http://127.0.0.1:3000`，health=200，静态页面200 |
| `npm run cleanup:preview` / `npm run cleanup` / `npm run backup` / `npm run restore -- --from <zip> --yes` | 通过 | CLI对项目数据目录实际执行：备份生成ZIP、恢复完成data_epoch=2、空清理跳过且不生成备份 |

测试数据全部为虚构（王女士/陈晓雨/示范大学等）；集成/E2E均使用`os.tmpdir()`隔离临时数据库；时间通过`APP_ALLOW_TIME_CONTROL=1`+`/api/test/clock`注入；清理与恢复测试从不触碰真实业务数据（验收运行期间项目data目录为空或临时）。

## 2. AC逐条结果

图例：集成=tests/integration/*.test.ts（HTTP全链路，真实SQLite+文件系统）；E2E=tests/e2e/*.spec.ts（Chromium）；单测=tests/unit/*.test.ts。

| 编号 | 结果 | 证据（测试/操作与断言要点） |
| --- | --- | --- |
| AC01 | 通过 | E2E paste.spec「AC01/AC33」：全新临时目录启动→粘贴建单→详情/列表可查；`npm run build && npm start`实际启动（第1节）；集成testServer每次用例 mkdtemp 全新目录自动迁移。无任何手工改库步骤 |
| AC02 | 通过 | 集成orders.test「缺微信拒绝/缺电话拒绝」（400+fieldErrors）；「完整创建成功」状态recruiting、编号`JJ-YYYYMMDD-NNNN`唯一；E2E「AC02界面」缺微信保存显示错误不跳转 |
| AC03 | 通过 | 集成orders.test「同家长两单，修改互不影响」：两单独立、PATCH一单另一单不受影响 |
| AC04 | 通过 | 集成orders.test「老师微信电话必填；无授课区域字段」：phone缺失400；响应JSON无区域字段；同老师两单经验字段独立 |
| AC05 | 通过 | 集成orders.test「一单三报名关联正确」：3条报名均属本单；跨单报名进摘要/推荐400「不属于本订单」 |
| AC06 | 通过 | 集成orders.test「AC06/AC09」：创建25+招募单后导出含全部（计数≥25、首尾单均在）；分页pageSize=5下导出不受影响（导出实现按页循环取全量） |
| AC07 | 通过 | 集成orders.test「AC07」：导出含公开区域/公开要求/薪资（元/小时），不含家长称呼/微信/电话/详细地址/内部备注/费用；Content-Type text/plain; charset=utf-8，中文正常 |
| AC08 | 通过 | 集成orders.test「候选摘要」：两位候选摘要按报名编号区分，文本不含微信/电话/费用/内部备注；生成后订单与报名状态不变；E2E 04-candidate-summary.png |
| AC09 | 通过 | 集成orders.test：创建/标推荐后订单仍recruiting；review后导出不含该单（按公开区域断言），recruit后重新包含 |
| AC10 | 通过 | 集成matching.test「A待试课后不能再安排B」（CURRENT_EXISTS）；「少收保证金不能开始试课」FEES_NOT_SET→收50元DEPOSIT_INSUFFICIENT→收齐后开始成功；订单trialing、报名仍awaiting_trial |
| AC11 | 通过 | 集成matching.test「F300、保证金100」：通过+确认→待补200（超额补款409）→补200→完成；matched引用保留、其他候选order_closed、finance.settled=true |
| AC12 | 通过 | 集成matching.test：未确认合作时complete=409含「确认合作」；未结清时409含「还差200.00元」；收费空值时409「成交报名尚未设定应收中介费」 |
| AC13 | 通过 | 集成matching.test「A未通过」：不填原因、状态trial_failed、待退100元、清当前引用、订单回reviewing；退清后可安排B |
| AC14 | 通过 | 集成matching.test「主动退出」：状态withdrawn保留、待退500元、清引用回reviewing；E2E「AC13/AC14界面」全流程 |
| AC15 | 通过 | 集成matching.test「取消」：报名order_closed、待退5000、取消后收款409「禁止继续收款」；清理预览该单不入候选 |
| AC16 | 通过 | 集成matching.test「直接合作」：无试课记录、direct_cooperation+cooperationConfirmedAt、补收300元后完成；未安排试课时pass被拒（409）；E2E「AC16界面」 |
| AC17 | 通过 | 集成matching.test「AC17」：成交老师未结清→409「成交报名费用未结清」；A待退→409消息含A的报名编号；退清后200 |
| AC18 | 通过 | 集成finance.test：负数/非整数分→400 INVALID_AMOUNT；超过计划→409 AMOUNT_EXCEEDS_PLAN；相同operationId重放applied=false金额不变；同ID不同载荷→409 OPERATION_ID_CONFLICT |
| AC19 | 通过 | 集成finance.test「0.10/0.20」：分次收10+补20完成；「收费空值不能开始试课」；F=0免费个案确认后完成 |
| AC20 | 通过 | 集成finance.test「下调收费」：F调至50后确认→待退50；退50→净收50=F、settled；完成成功 |
| AC21 | 通过 | 集成cleanup-attachments.test「89天/90天」：89天不入候选，90天入候选；run后deletedOrders≥1、生成清理前备份（backupId非空）；附件文件从磁盘删除（fs.existsSync=false）；未退清取消单受保护（reason含「未退清」） |
| AC22 | 通过 | 集成cleanup-attachments.test「AC22」：在办/暂停120天不删；GET列表/详情/导出后updatedAt不变；PATCH后updatedAt前移重新计时；E2E「AC21/AC22界面」同验证 |
| AC23 | 通过 | 集成cleanup-attachments.test「订单到期但某报名未到期」：报名修改重新计时→整单保护（reason含「未到期」）→全部到期后整单可删；报名不再单列候选 |
| AC24 | 通过 | 集成cleanup-attachments.test「成交报名不能独立删除」：成交报名不出现在独立候选；独立清理只删withdrawn报名；成交报名与订单保留 |
| AC25 | 通过 | 集成cleanup-attachments.test「AC25」：预览有候选→修改该单→run时重新核验deletedOrders=0；再次run返回「没有可清理的数据」且backupId=null（空清理不生成全量包）、备份列表数量不变 |
| AC26 | 通过 | 集成cleanup-attachments.test「附件安全」：HTML伪装PDF→409 UNSUPPORTED_FILE_TYPE（magic bytes）；10MB超限→413；`../..%2F`与非法fileId→404；fileId白名单正则+活动代目录前缀校验；删除失败由sweepUnreferenced重试（「多文件一次上传」用例验证sweep清理孤儿文件） |
| AC27 | 通过 | 集成finance.test「重启后」：独立数据目录重启服务，费用/版本/附件保留，编号继续（AC53用例同时覆盖）；集成cleanup「90天删除」后历史编号不复用（AUTOINCREMENT+sqlite_sequence）；恢复后高水位见AC61 |
| AC28 | 通过 | 集成backup-restore.test全部用例使用`os.tmpdir()`隔离目录；「AC46a」用例验证不覆盖原运行库；E2E maintenance.spec在独立3300服务+临时目录执行恢复 |
| AC29 | 通过 | 集成orders.test「AC29a」旧version PATCH→409 VERSION_CONFLICT；E2E「AC29」双浏览器窗口编辑同一订单，后保存者收到冲突提示；并发试课互斥见AC10（CURRENT_EXISTS事务拒绝）；完成/退款金额正确见AC11/AC17 |
| AC30 | 通过 | E2E「AC30界面」模板复制入口、导出预览可见；复制按钮带剪贴板失败回退（TextBlock可全选+提示，OrderDetail/摘要卡片）；TXT/附件下载E2E真实断言download事件与文件名；窄屏CSS（styles.css @media 720px断行）；空状态empty样式（orders列表/备份列表） |
| AC31 | 通过 | 集成cleanup-attachments.test「AC31」：`scheduler.triggerNow()`（即start()同一tick路径）后runtime.cleanupState记录删除结果、到期单被删；单测scheduler.test验证02:00/补做/不重复/失败重试规则（可注入时钟） |
| AC32 | 通过 | 集成paste-security.test「AC32」：http.server监听地址断言为127.0.0.1；git status确认无data//*.zip入库（.gitignore）；E2E console.spec遍历4页面0控制台错误0页面异常 |
| AC33 | 通过 | 集成paste-security.test「AC33」：解析→保存→状态recruiting、sourceTemplateText完整；E2E「AC01/AC33」界面全流程（截图02） |
| AC34 | 通过 | 集成paste-security.test「AC34」：orderInfo定位本单、保存submitted、订单状态不变；E2E「AC34」界面含多行经验正文完整入库 |
| AC35 | 通过 | 单测parser.test「格式变体」：英文冒号/顺序打乱/无编号/别名（微信号、手机号）/CRLF/空行/中文冒号全通过；sourceText保留原文 |
| AC36 | 通过 | 单测parser.test「缺失必填」「空白占位」「薪资区间」「相对日期」；集成paste-security「缺微信：解析报错→补正后可保存」且无半条记录（total只+1） |
| AC37 | 通过 | 集成paste-security.test「AC37」：不存在→「不存在」；与详情单冲突→保存409 ORDER_NO_MISMATCH；已完成/已取消/暂停→parse报具体状态禁止；E2E「AC37界面」不一致时保存按钮禁用 |
| AC38 | 通过 | 集成paste-security.test「双击/重试」：同creationRequestId两次→第二条duplicated=true同ID；列表total=1；「相同原文再保存」有duplicateWarning但仍创建（不禁止真实新投递） |
| AC39 | 通过 | 集成paste-security.test：两份标题混贴400「多份模板」；51,000字400超限；HTML原文按文本解析与保存（<script>在sourceTemplateText中，界面React转义渲染）；附件文字仅warning不伪造上传 |
| AC40 | 通过 | 单测parser.test：150元/小时→15000分；1.5小时/90分钟/两小时/1小时30分钟/1.25小时→90/90/120/90/75分钟；每周2次→2；是/否布尔；电话`+86 139-...`/`021-6555 1234`/`177...`前导零区号保留 |
| AC41 | 通过 | 集成backup-restore.test「AC41」：备份ZIP含manifest（格式版本/数量/高水位/时区）+database.sqlite+附件，逐文件SHA-256核验；导出后updatedAt不变；E2E「AC41/AC45界面」下载ZIP非空；截图08 |
| AC42 | 通过 | 集成backup-restore.test「AC42/AC61」：恢复到备份时点（备份后新增数据消失）；恢复保留原created_at/updated_at；恢复后新建编号正常；E2E「AC42界面」完整界面恢复流程（截图09） |
| AC43 | 通过 | 集成backup-restore.test「AC43/AC47」：非ZIP→400；篡改数据库→CHECKSUM_MISMATCH；反斜杠穿越/绝对路径/大小写冲突/清单外文件→各自400码；无业务表的合法SQLite→schema不一致400；全程dashboard可用（当前数据不变）；E2E「AC43界面」 |
| AC44 | 通过 | 单测scheduler.test：香港02:00触发、01:59不触发、当日重复评估不重复、14:00启动补做、失败5分钟内不重试/超时重试、UTC18:00=香港次日02:00时区正确 |
| AC45 | 通过 | 集成backup-restore.test「AC45/AC60」：dailyKeepCount=3时第4、5份被轮换；安全备份12次后≤10份；手动包不被自动删除；E2E「AC45界面」设置5→保存→刷新仍为5→恢复30 |
| AC46 | 通过 | 集成backup-restore.test「AC46a」：monkey-patch备份抛错→commit 409 RESTORE_ABORTED、当前订单仍可查；「AC46b」prepared未切换→重启保留原代、清理半成品新代、op状态aborted；「AC46c」已切换未收尾→重启确认新代、清理旧代、op状态finished |
| AC47 | 通过 | 同AC43（路径穿越/绝对路径/大小写冲突/中文附件名正常——附件原名UTF-8经latin1还原，E2E上传「我的简历.png」名称正确显示与下载）；备份下载仅按登记ID（`not-a-uuid`与文件路径→400） |
| AC48 | 通过 | 维护锁runExclusive串行化备份/恢复/清理；恢复期间ActiveData.current()抛503 MAINTENANCE（读请求被拒，进度端点豁免）；恢复commit令牌单次使用+epoch校验防重复恢复覆盖新数据（restoreService.ts commit+「AC42/AC61」用例内二次恢复走新token）；E2E恢复后旧页面写请求由epoch拦截（AC55） |
| AC49 | 通过 | 恢复保留原时间（AC42断言created_at）；集成cleanup「89/90天」：run生成清理前备份（backupId）后才删除；备份失败路径由「AC46a」验证（暂缓/终止且数据可用）；清理报告数量（deletedOrders/Applications/Attachments） |
| AC50 | 通过 | 集成matching.test「AC50」：pass后订单reviewing（非试课中）+当前引用保留；recruit/pause/换人安排/二次直接合作全部409 |
| AC51 | 通过 | 集成matching.test「AC51」：非当前候选withdraw后订单仍trialing、当前引用不变；当前老师退出/失败清引用可退清（AC13/AC14用例）；完成后禁止退出/取消（「完成后禁止」用例409） |
| AC52 | 通过 | 集成matching.test：未开始试课pass→409；trial_failed标recommend→409；暂停态schedule-trial→409；非当前状态组合均事务拒绝（同一tx内断言，失败即回滚） |
| AC53 | 通过 | 集成finance.test「重启后相同operationId重放」：真实杀掉HTTP服务+重建server同数据目录→重放applied=false金额不变；不同载荷→409；更正登记带理由、financeOperations含correction+reason、退款超收款409；相同载荷幂等见AC18 |
| AC54 | 通过 | 集成backup-restore.test「AC54」：备份→删除附件+完成订单→恢复→附件元数据与磁盘文件均恢复；空清理不生成包见AC25（backupId=null） |
| AC55 | 通过 | 集成paste-security.test「错误data_epoch」：epoch=999999写请求→409 DATA_EPOCH_CONFLICT；「AC46c」重启收尾后旧数据代目录被删除、备份配置保留（runtime.json在数据代外）；E2E恢复流程后页面自动回到列表（前端refreshSession） |
| AC56 | 通过 | 集成backup-restore.test「AC56a」：cleanup.run()内部直接调performBackupLocked不嵌套取锁（MaintenanceMutex重入会显式报错，无死锁发生）；「AC56b」同数据目录第二实例→「单实例」错误；恢复期间读写门见AC48 |
| AC57 | 通过 | E2E「AC57」：上传PNG→预览img可见→下载suggestedFilename含.png（attachment/inline响应头另由集成断言）；「多文件一次上传」good+bad→409且0附件（无半组）、孤儿文件sweep清理；单测parser「多行简历正文保留（含括号、冒号、“年级：”不误判）」 |
| AC58 | 通过 | 集成paste-security.test「AC58」：缺CSRF→403；错CSRF→403；不可信Origin→403；evil.example.com Host（node:http直连）→403；错误epoch→409；同套件正常页面无登录全流程可用；E2E全部用例即正常本机页面操作 |
| AC59 | 通过 | 集成finance.test：下调F产生待退且完成校验接受该合法状态（AC20用例settled断言）；计划保证金>中介费→409；F/计划缺失start-trial→409 FEES_NOT_SET；恢复校验不拒绝多收待退记录（backup-restore「错误数据库」用例仅拒绝真正负数/超收退款，含合法超收的备份通过校验并成功恢复——AC42/AC61用例数据含超收场景） |
| AC60 | 通过 | 集成backup-restore.test「AC45/AC60」：autoBackupDir=dataDir→400；=generations子目录→400；轮换仅处理登记在index.json的备份（readIndex过滤）；超限包提示调整（restoreService IMPORT_TOO_LARGE/IMPORT_TOTAL_TOO_LARGE消息含当前上限与调整指引） |
| AC61 | 通过 | 集成backup-restore.test「AC42/AC61」：备份→新建更高编号订单→恢复旧包→新编号>恢复前最大编号（本机高水位合并）；缺numberHighWater的旧包→兼容处理（取MAX(id)与本地高水位较大值）后编号仍不复用；原记录created_at/updated_at保持 |

## 3. 覆盖说明与残留限制

- 全部61项均有自动化测试或真实浏览器操作证据，无“仅静态检查”项；本报告未把未执行的操作标为通过。
- 界面验收（E2E）覆盖：粘贴建单/报名、编号不一致阻止、缺字段保存、双窗口冲突、费用收退全流程、直接合作、失败退款、附件上传预览下载、招募导出、清理预览与执行、备份创建/下载/恢复/损坏包、设置保存、控制台零异常。命令行不能替代的部分均已由浏览器完成。
- 残留限制（产品边界，非缺陷）：服务停止期间无法执行每日备份与清理，重启补做当前快照（不补造历史日期包）；人工保存的备份不随清理自动删除；已完成订单财务锁定；换电脑恢复仅能保证备份内已知编号不复用；桌面EXE不在第一版范围。
- 截图证据：docs/screenshots/01—09（列表、粘贴解析、订单详情、候选摘要、费用面板、招募导出、清理预览、备份列表、恢复预览）。

## 4. 完成定义核对（方案第11节）

1. 第一版必需功能全部实现，正常/异常路径可操作，SQLite持久化（重启/恢复用例验证）。✅
2. typecheck/lint/unit/integration/build/E2E实际执行通过（第1节真实结果）。✅
3. 本报告逐条映射AC01—AC61并注明证据。✅
4. 虚构资料截图9张入库。✅
5. docs/USER_GUIDE.md覆盖粘贴录入、普通录入、复制微信、推荐、试课、收退款、完成、清理、备份恢复、启停。✅
6. README更新安装/开发/构建/启动、数据目录与实际限制。✅
7. 提交并推送origin/main（见最终提交ID），仅本机监听，不云部署。✅
