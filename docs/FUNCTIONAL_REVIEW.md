# 实现功能复核报告

日期：2026-09-30。复核当前工作区实现，以IMPLEMENTATION_PLAN.md V1.3为基准。

当前结论：复核发现的 R01—R09 已修复并通过回归验收。下方保留首次复核的问题证据；原位置行号以首次复核时的代码为准。

## 修复后的验收结果

| 检查 | 2026-09-30 修复后结果 |
| --- | --- |
| npm run typecheck | 通过，0错误 |
| npm run lint | 通过，0错误0警告 |
| npm run build | 通过，前后端产物已重新构建 |
| npm test | 10个测试文件、131项通过（原119项 + 新增12项） |
| npm run test:e2e | 18项通过（原16项 + 新增2项），真实Chromium |
| node scripts/review-functional.mjs | 8项正确行为断言通过，隔离数据，输出test-results/functional-review.json |

| 问题 | 最终处理与回归证据 |
| --- | --- |
| R01 | HTTP写请求检查维护锁；在途附件上传完成后复查维护状态和epoch。测试覆盖快照生成后写入返回503、快照包含维护前最新记录、恢复后旧上传返回409且未保存附件。 |
| R02 | 配置替换保存失败还原缓存；切换前保存原配置副本；新数据库打开失败回退配置及连接；切换成功后的收尾失败交由启动对账重试。三种故障注入均已验收。 |
| R03 | 报名详情增加“编辑老师资料”，预填表单并携带version；浏览器用有保证金和附件的报名验证修改资料后状态、订单、费用、附件保持完整。 |
| R04 | GET订单详情兼容公开订单编号与数字ID，错误编号返回404；HTTP与浏览器均验证。 |
| R05 | 使用原始领域类型比较，SQL参数绑定时才把布尔转换为0/1；订单和报名完整相同表单保存均不更新updatedAt或version，真实修改会更新。 |
| R06 | PATCH文本字段不注入默认空字符串；缺字段保留资料，明确空字符串仍可清空。老师薪资修改同时校验合并后数据。 |
| R07 | 启动补做不受凌晨2点门槛限制；01:00首次启动生成当天备份，同日再次启动及02:00不重复。 |
| R08 | commit重新检查15分钟TTL；16分钟后令牌返回TOKEN_INVALID，当前数据、epoch不变，未执行恢复前备份。 |
| R09 | 清除未使用代码及无效lint禁用；重新执行全部检查并更新验收报告与使用手册。 |

新增自动测试：tests/integration/review-regressions.test.ts、tests/e2e/review-regressions.spec.ts。复核脚本也已转换为正确行为断言，遇到错误退出，不再接受缺陷行为。

## 首次复核验证结果（修复前）

| 检查 | 本次真实结果 |
| --- | --- |
| npm run typecheck | 通过 |
| npm run build | 通过 |
| npm test | 9个测试文件、119项通过 |
| npm run test:e2e | Chromium真实浏览器16项通过 |
| npm run lint | 失败：4个错误、1个警告（截图脚本3个未使用变量，备份恢复测试1个未使用变量，清理服务1个无效disable警告） |
| node scripts/review-functional.mjs | 8个独立问题均复现，输出test-results/functional-review.json |

测试使用隔离数据，不操作项目data业务目录。现有测试首次受沙箱spawn EPERM阻止，获准启动子进程后重新执行成功，该环境限制不算产品缺陷。构建产物重新生成后执行浏览器测试，未使用旧构建来代替当前实现。

## 按影响排序的问题

### R01 [P1] 恢复期间仍接受新记录，随后消失且未进入安全备份

位置：src/server/http/app.ts:165；src/server/services/restoreService.ts:337。

复现：完成恢复前备份后暂停恢复操作，在另一个HTTP请求创建订单；接口返回201保存成功。继续恢复后该订单返回404，恢复前安全备份也只有先前的1单，不包含新订单。

原因：维护门只检查active.isOpen。恢复前备份异步打包期间库仍开放，普通写入不检查维护锁；关闭库发生在最后同步切换阶段，挡不住此前写入。

修正方向：从确认恢复开始设置持久/进程维护状态，禁止新业务写入，等待在途上传和写请求完成，之后生成安全备份；维护状态持续至切换完成。不能只给备份/清理/恢复加锁而忽略普通CRUD。

### R02 [P1] 恢复配置落盘失败时没有回滚到原数据

位置：src/server/services/restoreService.ts:392—398、414。

复现：备份后新增一单，模拟切换时runtime.save失败。恢复返回错误，但实际activeGenerationId已是目标代，dataEpoch从3变4，新单查询不到。

原因：先修改缓存中的cfg再save；失败捕获又从同一已修改缓存读取activeGenerationId，重新打开了目标代；外层也用该缓存判断已经切换，跳过原代回滚。

修正方向：保存原配置不可变副本，写入成功才发布新缓存；根据明确的持久提交阶段执行回滚。配置写失败、新库打开失败及收尾失败分别测试，不能统一假定原库仍可用。

### R03 [P2] 老师报名没有资料编辑界面

位置：src/client/App.tsx:36—41；src/client/pages/ApplicationDetail.tsx。

浏览器复现：创建报名后打开详情，编辑按钮0个、编辑链接0个；路由只包含新增和详情，不包含报名编辑。

影响：录错老师电话、学校、教学经验或后续补充资料后，用户无法在系统界面修正。后端PATCH存在不等于内部用户能操作。

修正方向：增加报名编辑表单与路由，预填现有资料、携带版本、不改变所属订单，补浏览器验收。

### R04 [P2] 手动输入公开订单编号查询失败

位置：src/client/pages/ApplicationForm.tsx:64；src/server/http/app.ts:269。

复现：请求GET /api/orders/JJ-20260930-0001返回404，消息为订单不存在id=NaN；页面宣称支持该编号，但服务端强制Number转换。

修正方向：使用现有getOrderByNoOrId方法，或提供明确查询编号的接口；数字ID和公开编号分别验收。

### R05 [P2] 不改内容保存仍刷新90天计时

位置：src/server/services/orderService.ts:215—217；src/server/services/applicationService.ts:154—155。

复现：以原完整需求保存，payNegotiable=true未变，结果changed=true且updatedAt前移一分钟。

原因：current布尔为true/false，nextNorm为1/0，比较String后永不相等。报名的acceptsOrderPay、canAttendTrial同样受影响。

修正方向：双方用一致的领域类型比较，转换成SQLite值只在绑定阶段执行；测试无变化全表单保存，不只测试空PATCH或单个文本字段。

### R06 [P2] 局部PATCH清空未提交的资料

位置：src/server/schemas.ts:8—9、75—77、118—127。

复现：仅提交家长电话变更，返回成功，但原teacherRequirements、publicRequirements和notes全部变成空字符串。

原因：创建和更新共用optionalText，default('')在PATCH缺字段时注入空值，服务误判为明确清空。报名成绩、备注、试课限制也有同类风险。

修正方向：创建可提供默认值；更新缺字段必须保持undefined，只有明确提交空字符串才清空。增加局部修改后其他字段不变断言。

### R07 [P2] 凌晨2点前启动不补当天备份

位置：src/server/services/schedulerService.ts:54、67—73。

复现：香港时间01:00触发启动调度路径，当日无成功备份，dailyBackup.lastSuccessDateHk仍null。

原因：onStartup仅传给清理，日备份始终要求pastTwoAm。与方案“当日首次启动立即补做”不同；只在凌晨使用并在2点前关闭系统的用户可能一直没有日备份。

修正方向：把启动补做标记传入日备份评估，启动不受2点门槛限制，成功后当天2点不重复备份。

### R08 [P2] 超过15分钟的恢复令牌仍可执行

位置：src/server/services/restoreService.ts:309—316、320—334。

复现：校验备份获得令牌，测试时钟前移16分钟，commit仍成功恢复。

原因：gcTokens仅在下一次validate调用；commit检查存在、已用、epoch，却不检查createdAtUtc是否过期。

修正方向：执行确认时重新验证TTL，过期清理暂存并返回需重新上传校验；预览上传后持续无其他上传也要正确过期。

### R09 [P2] lint与验收报告的通过声明不一致

位置：scripts/take-screenshots.mjs:61、91、94；tests/integration/backup-restore.test.ts:74；docs/ACCEPTANCE_REPORT.md第1节。

本次npm run lint返回退出码1，4个错误1个警告；报告声称0错误0警告。需修正代码、重跑，再更新验收报告，而不是沿用历史结论。

## 首次复核提出的验收要求（已落实）

优先修R01/R02，再补R03—R08回归测试和R09检查。保留现有119项和16项浏览器测试，并增加恢复期间并发写入、配置落盘失败回滚、报名编辑、公开编号查询、全表单无变化保存、局部更新保留资料、凌晨启动补备份、恢复令牌超时用例。

首次复核脚本用于记录缺陷；本轮已转换为正确行为断言，另增正式集成与浏览器回归套件。
