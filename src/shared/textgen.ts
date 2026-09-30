// 群内招募文字、候选摘要、费用告知的确定性生成。只输出允许公开的字段。
import { centsToYuanString } from './money.js';
import type { ApplicationRecord, OrderRecord } from './types.js';

const SEPARATOR = '——————————';

export function buildRecruitingEntry(order: OrderRecord): string {
  const lines = [
    `【家教招募｜${order.orderNo}】`,
    `年级：${order.childGrade}`,
    `科目：${order.subjects}`,
    `方式：${order.teachingMode === 'online' ? '线上' : '线下'}`,
    `区域：${order.publicArea}`,
    `时间：${order.publicSchedule}`,
    `频次：每周${order.sessionsPerWeek}次，每次${(order.sessionMinutes / 60).toString().replace(/\.0$/, '')}小时`,
    `开始时间：${order.expectedStartDate ?? '协商'}`,
    `薪资：${centsToYuanString(order.hourlyPayCents)}元/小时（${order.payNegotiable ? '可协商' : '不可协商'}）`,
    `性别要求：${order.genderPreference === 'any' ? '不限' : order.genderPreference === 'male' ? '男' : '女'}`,
    `其他要求：${order.publicRequirements || '无'}`,
  ];
  return lines.join('\n');
}

/** 全部招募中订单的群发文字；多单用空行+分隔线隔开 */
export function buildRecruitingText(orders: OrderRecord[]): string {
  const entries = orders.map(buildRecruitingEntry);
  const header = `【今日家教招募 ${orders.length}单】有意向请联系中介，注明订单编号并提交报名模板。`;
  if (orders.length === 0) {
    return `${header}\n\n（当前没有招募中的订单）`;
  }
  return `${header}\n\n${entries.join(`\n\n${SEPARATOR}\n\n`)}`;
}

export function buildCandidateSummary(order: OrderRecord, app: ApplicationRecord): string {
  const payText = app.acceptsOrderPay
    ? `接受订单薪资${centsToYuanString(order.hourlyPayCents)}元/小时`
    : app.expectedHourlyPayCents !== null
      ? `期望薪资${centsToYuanString(app.expectedHourlyPayCents)}元/小时`
      : '期望薪资未填写';
  const trialText = app.canAttendTrial
    ? `可试课${app.trialConstraints ? `（${app.trialConstraints}）` : ''}`
    : app.trialConstraints
      ? `时间受限：${app.trialConstraints}`
      : '不能按安排试课';
  const lines = [
    `【${order.orderNo}｜候选老师 ${app.applicationNo}】`,
    `姓名：${app.teacherName}`,
    `性别：${app.gender === 'male' ? '男' : '女'}`,
    `学校：${app.university}`,
    `专业：${app.major}`,
    `年级：${app.studyYear}`,
    `可辅导科目及年级：${app.teachableSubjectsGrades}`,
    `成绩与能力：${app.achievements || '未填写'}`,
    `教学经验：${app.teachingExperience}`,
    `优势与辅导思路：${app.strengthsAndPlan}`,
    `可上课时间：${app.availableSchedule}`,
    `最早开始：${app.earliestStartDate ?? '协商'}`,
    `薪资：${payText}`,
    `试课安排：${trialText}`,
  ];
  return lines.join('\n');
}

/** 多位候选摘要合并文本 */
export function buildCandidateSummaries(
  order: OrderRecord,
  apps: ApplicationRecord[],
): string {
  return apps.map((a) => buildCandidateSummary(order, a)).join(`\n\n${SEPARATOR}\n\n`);
}

/** 安排试课前的费用告知（金额按报名填写） */
export function buildFeeNotice(app: ApplicationRecord, orderNo: string): string {
  const fee = app.agencyFeeCents !== null ? `${centsToYuanString(app.agencyFeeCents)}元` : '未设定';
  const deposit =
    app.depositDueCents !== null ? `${centsToYuanString(app.depositDueCents)}元` : '未设定';
  return `【${orderNo}｜费用说明】
本单中介费：${fee}。
试课前保证金：${deposit}。
上述费用均由报名老师支付。
试课成功并确认正式合作后，保证金抵扣中介费，补齐剩余费用。
试课未通过、老师主动退出或家长取消订单，退回保证金。
双方直接确认合作、跳过试课时，收取中介费；已交保证金同样抵扣。`;
}
