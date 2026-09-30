// 模板解析器单元测试：使用实际完整填写模板及格式变体（AC33-40、AC57）。
import { describe, expect, it } from 'vitest';
import {
  ParseStructureError,
  parseTemplate,
  parentDraftToForm,
  teacherDraftToForm,
} from '../../src/shared/parsing/parseTemplate.js';

const CTX = { hkToday: '2026-09-30' };

// 完整填写的家长模板（微信真实粘贴风格：带编号、组标题、空行、说明行残留）
const FILLED_PARENT = `【家教需求登记】

1. 家长称呼：王女士
2. 微信：wxp_2026mom
3. 电话：138 0013 8000

【孩子及辅导需求】
4. 孩子年级：初三
5. 辅导科目：数学、物理
6. 目前学习情况：
   基础薄弱，几何证明题失分严重
   （例如：基础薄弱、成绩中等、希望提高解题能力）
7. 辅导目标：
   （例如：巩固基础、作业辅导、考试复习）
   期中考前重点复习函数

【上课安排】
8. 上课方式：线下
9. 上课区域及地点：
   阳光花园小区附近，奶茶店可自习
10. 每周可上课的日期和时间：
    （例如：周二、周四 19:00—21:00）
    周六下午2点到4点，周日上午
11. 每周上课次数：每周2次
12. 每次上课时长：1.5小时
13. 预计开始时间：2026-10-15

【薪资及老师要求】
14. 薪资：150元/小时
    是否可以协商：是
15. 老师性别要求：女
16. 对老师的其他要求：
    （例如：专业、教学经验、擅长科目等）
    有初三带教经验，最好女研究生

17. 其他备注（选填）：
    孩子有点内向，希望老师有耐心

请按一份独立家教需求填写一份表。
如需分别聘请不同老师，请分别填写。`;

// 完整填写的老师模板（含多行正文、正文中的括号与冒号、成绩说明）
const FILLED_TEACHER = `【大学生家教报名】

1. 报名订单编号：JJ-20260930-0001
2. 姓名：李明
3. 性别：男
4. 微信：limi_g2026
5. 电话：+86 139-1234-5678

【个人情况】
6. 就读学校：示范大学
7. 专业：数学与应用数学
8. 当前年级：
   （例如：大二、研一）
   研一

【针对本订单的教学能力】
9. 可辅导的科目及年级：初中数学、高中数学（文科）
10. 相关成绩或能力说明（选填）：
    高考数学142分（2023年，满分150分）；全国高中数学联赛省二等奖
11. 家教或其他教学经验：
    初三学生数学，每周2次，共4个月，从70分提升到95分；
    大一做过数学辅导班助教（年级：高二班级，负责答疑）
12. 针对本订单的优势及辅导思路：
    擅长几何与函数专题；先诊断薄弱章节（通过一次摸底小测），
    再按“知识点梳理→例题精讲→限时训练”三步走

【时间及薪资】
13. 每周可上课的日期和时间：周二、周四 19:00—21:00；周末可加一次
14. 最早可开始时间：2026年10月08日
15. 是否接受订单中的薪资：是
    如不接受，期望薪资：____元/小时
16. 是否可以按安排参加试课：是
    如有时间限制，请说明：试课只能安排在工作日晚上

17. 其他备注（选填）：可长期带到中考
18. 简历附件（选填，可附 PDF 或图片）：简历见附件

请针对本订单填写。
如报名多个订单，请分别提交，每份注明订单编号。
请如实填写资料和教学经历。`;

describe('家长模板解析（AC33、AC35、AC40）', () => {
  const result = parseTemplate('parent', FILLED_PARENT, CTX);

  it('完整模板自动填好全部对应字段', () => {
    expect(result.fieldErrors).toEqual({});
    expect(result.draft.parentName).toBe('王女士');
    expect(result.draft.parentWechat).toBe('wxp_2026mom');
    expect(result.draft.parentPhone).toBe('138 0013 8000');
    expect(result.draft.childGrade).toBe('初三');
    expect(result.draft.subjects).toBe('数学、物理');
    expect(result.draft.teachingMode).toBe('offline');
    expect(result.draft.locationDetail).toBe('阳光花园小区附近，奶茶店可自习');
    expect(result.draft.weeklySchedule).toBe('周六下午2点到4点，周日上午');
    expect(result.draft.sessionsPerWeek).toBe(2);
    expect(result.draft.sessionMinutes).toBe(90);
    expect(result.draft.expectedStartDate).toBe('2026-10-15');
    expect(result.draft.hourlyPay).toBe(15000); // 150元/小时 → 15000分
    expect(result.draft.payNegotiable).toBe(true);
    expect(result.draft.genderPreference).toBe('female');
    expect(result.draft.otherRequirements).toBe('有初三带教经验，最好女研究生');
    expect(result.draft.notes).toBe('孩子有点内向，希望老师有耐心');
  });

  it('多行正文完整保留（不丢内容、不误删括号说明）', () => {
    expect(result.draft.learningSituation).toBe('基础薄弱，几何证明题失分严重');
    expect(result.draft.tutoringGoal).toBe('期中考前重点复习函数');
  });

  it('固定说明文本与页脚被忽略、不进入正文', () => {
    const text = JSON.stringify(result.draft);
    expect(text).not.toContain('例如：基础薄弱');
    expect(text).not.toContain('请按一份独立家教需求填写一份表');
  });

  it('格式变体：英文冒号、顺序调整、无编号、别名（微信号/手机号）、CRLF、空行', () => {
    const variant = [
      '【家教需求登记】',
      '薪资: 200元/小时',
      '微信号: mother_wx_88',
      '家长称呼：张爸爸',
      '手机号：+86 159 0000 0000',
      '孩子年级: 高一',
      '辅导科目: 物理',
      '目前学习情况: 力学部分薄弱',
      '辅导目标: 提高解题速度',
      '上课方式: 线上',
      '上课区域及地点: 线上',
      '每周可上课的日期和时间: 周五晚',
      '每周上课次数: 1',
      '每次上课时长: 90分钟',
      '是否可以协商: 否',
      '老师性别要求: 不限',
      '对老师的其他要求: 无',
      '',
      '',
    ].join('\r\n');
    const r = parseTemplate('parent', variant, CTX);
    expect(r.fieldErrors).toEqual({});
    expect(r.draft.hourlyPay).toBe(20000);
    expect(r.draft.parentWechat).toBe('mother_wx_88');
    expect(r.draft.parentPhone).toBe('+86 159 0000 0000');
    expect(r.draft.payNegotiable).toBe(false);
    expect(r.draft.genderPreference).toBe('any');
    expect(r.draft.otherRequirements).toBe('无');
    expect(r.draft.teachingMode).toBe('online');
  });

  it('空白占位（____元/小时、保留“是 / 否”提示）视为缺失并提示补正', () => {
    const r = parseTemplate('parent', FILLED_PARENT.replace('150元/小时', '____元/小时').replace('是否可以协商：是', '是否可以协商：是 / 否'), CTX);
    expect(r.fieldErrors.hourlyPay).toContain('未填写');
    expect(r.fieldErrors.payNegotiable).toContain('请填写是或否');
    expect(r.draft.hourlyPay).toBeNull();
  });

  it('薪资区间保留原文并要求选定，不擅自取最低值', () => {
    const r = parseTemplate('parent', FILLED_PARENT.replace('150元/小时', '120-150元/小时'), CTX);
    expect(r.fieldErrors.hourlyPay).toContain('区间');
    expect(r.draft.hourlyPay).toBeNull();
    expect(r.draft.hourlyPayRaw).toBe('120-150元/小时');
  });

  it('相对日期保留原文并提示补正，不静默猜日期；协商留空可接受', () => {
    const r = parseTemplate('parent', FILLED_PARENT.replace('2026-10-15', '下周一'), CTX);
    expect(r.fieldErrors.expectedStartDate).toContain('具体日期');
    expect(r.draft.expectedStartDate).toBeNull();
    expect(r.draft.expectedStartDateRaw).toBe('下周一');
    const r2 = parseTemplate('parent', FILLED_PARENT.replace('2026-10-15', '协商'), CTX);
    expect(r2.draft.expectedStartDate).toBeNull();
    expect(r2.fieldErrors.expectedStartDate).toBeUndefined();
  });

  it('线上/线下选择提示与双含值按缺失/歧义处理', () => {
    const r = parseTemplate('parent', FILLED_PARENT.replace('上课方式：线下', '上课方式：线上 / 线下'), CTX);
    expect(r.fieldErrors.teachingMode).toContain('请填写线上或线下');
    const r2 = parseTemplate('parent', FILLED_PARENT.replace('上课方式：线下', '上课方式：线下或者线上'), CTX);
    expect(r2.fieldErrors.teachingMode).toContain('二选一');
  });

  it('单个“联系方式”不猜测映射，给出明确提示', () => {
    const r = parseTemplate('parent', FILLED_PARENT.replace('电话：138 0013 8000', '联系方式：138 0013 8000'), CTX);
    expect(r.warnings.join('\n')).toContain('联系方式');
    expect(r.unrecognizedFields.some((l) => l.includes('联系方式'))).toBe(true);
    expect(r.fieldErrors.parentPhone).toContain('缺失');
  });

  it('时长变体：90分钟/两小时/1小时30分钟/半小时', () => {
    expect(parseTemplate('parent', FILLED_PARENT.replace('1.5小时', '90分钟'), CTX).draft.sessionMinutes).toBe(90);
    expect(parseTemplate('parent', FILLED_PARENT.replace('1.5小时', '两小时'), CTX).draft.sessionMinutes).toBe(120);
    expect(parseTemplate('parent', FILLED_PARENT.replace('1.5小时', '1小时30分钟'), CTX).draft.sessionMinutes).toBe(90);
    expect(parseTemplate('parent', FILLED_PARENT.replace('1.5小时', '半小时'), CTX).draft.sessionMinutes).toBe(30);
    expect(parseTemplate('parent', FILLED_PARENT.replace('1.5小时', '1.25小时'), CTX).draft.sessionMinutes).toBe(75);
  });

  it('草稿映射到表单（公开字段分离）', () => {
    const form = parentDraftToForm(result.draft);
    expect(form.parentName).toBe('王女士');
    expect(form.publicSchedule).toBe('周六下午2点到4点，周日上午');
    expect(form.publicArea).toBe(''); // 公开区域要求操作人补正
    expect(form.hourlyPayRaw).toBe('150'); // 表单显示元
  });
});

describe('老师模板解析（AC34、AC35、AC40、AC57）', () => {
  const result = parseTemplate('teacher', FILLED_TEACHER, CTX);

  it('完整模板自动填好全部字段；编号精确识别', () => {
    expect(result.fieldErrors).toEqual({});
    expect(result.orderNo).toBe('JJ-20260930-0001');
    expect(result.draft.teacherName).toBe('李明');
    expect(result.draft.gender).toBe('male');
    expect(result.draft.wechat).toBe('limi_g2026');
    expect(result.draft.phone).toBe('+86 139-1234-5678');
    expect(result.draft.studyYear).toBe('研一');
    expect(result.draft.acceptsOrderPay).toBe(true);
    expect(result.draft.canAttendTrial).toBe(true);
    expect(result.draft.trialConstraints).toBe('试课只能安排在工作日晚上');
  });

  it('多行简历正文完整保留（含括号、冒号、“年级：”不误判为顶级字段）', () => {
    const exp = String(result.draft.teachingExperience);
    expect(exp).toContain('从70分提升到95分');
    expect(exp).toContain('（年级：高二班级，负责答疑）');
    expect(exp.split('\n').length).toBeGreaterThanOrEqual(2);
    const strengths = String(result.draft.strengthsAndPlan);
    expect(strengths).toContain('（通过一次摸底小测）');
    expect(strengths).toContain('三步走');
  });

  it('成绩说明多行保留', () => {
    expect(String(result.draft.achievements)).toContain('联赛省二等奖');
  });

  it('电话前导零与区号保留（AC40）', () => {
    const r = parseTemplate('teacher', FILLED_TEACHER.replace('+86 139-1234-5678', '021-6555 1234'), CTX);
    expect(r.draft.phone).toBe('021-6555 1234');
  });

  it('不接受薪资时需要期望薪资；接受时忽略占位期望', () => {
    const r = parseTemplate('teacher', FILLED_TEACHER.replace('是否接受订单中的薪资：是', '是否接受订单中的薪资：否').replace('期望薪资：____元/小时', '期望薪资：180元/小时'), CTX);
    expect(r.draft.acceptsOrderPay).toBe(false);
    expect(r.draft.expectedHourlyPay).toBe(18000);
    expect(r.fieldErrors.expectedHourlyPay).toBeUndefined();
    const r2 = parseTemplate('teacher', FILLED_TEACHER.replace('是否接受订单中的薪资：是', '是否接受订单中的薪资：否'), CTX);
    expect(r2.draft.expectedHourlyPay).toBeNull();
  });

  it('格式变体：中文/英文冒号、字段顺序变化、别名', () => {
    const variant = [
      '【大学生家教报名】',
      '订单编号: JJ-20260901-0002',
      '姓名: 张同学',
      '性别: 女',
      '微信号: zhangstu',
      '联系电话:17700000000',
      '就读学校: 工学院',
      '专业: 英语',
      '当前年级: 大二',
      '可辅导的科目及年级: 小学英语、初中英语',
      '相关成绩或能力说明（选填）: 雅思7.5',
      '家教或其他教学经验: 小学五年级英语，半年',
      '针对本订单的优势及辅导思路: 语音基础扎实',
      '每周可上课的日期和时间: 周末全天',
      '最早可开始时间: 尽快',
      '是否接受订单中的薪资: 是',
      '是否可以按安排参加试课: 否',
      '如有时间限制，请说明：仅周末可试课',
    ].join('\r\n');
    const r = parseTemplate('teacher', variant, CTX);
    expect(r.draft.orderNo ?? r.draft['orderNo']).toBeTruthy();
    expect(r.draft.phone).toBe('17700000000');
    expect(r.draft.canAttendTrial).toBe(false);
    expect(r.draft.trialConstraints).toBe('仅周末可试课');
    expect(r.fieldErrors.earliestStartDate).toContain('具体日期');
  });

  it('附件提示：粘贴不等于已上传', () => {
    expect(result.warnings.join('\n')).toContain('附件');
  });

  it('老师草稿映射到报名表单（无区域字段）', () => {
    const form = teacherDraftToForm(result.draft);
    expect(form.teacherName).toBe('李明');
    expect(form.availableSchedule).toContain('周二、周四');
    expect(Object.keys(form).some((k) => k.toLowerCase().includes('area') || k.includes('区域'))).toBe(false);
  });
});

describe('结构性错误（AC36、AC39）', () => {
  it('多份模板标题拒绝并提示分开粘贴', () => {
    const mixed = `${FILLED_PARENT}\n\n【大学生家教报名】\n1. 报名订单编号：JJ-1`;
    expect(() => parseTemplate('parent', mixed, CTX)).toThrow(ParseStructureError);
    expect(() => parseTemplate('teacher', mixed, CTX)).toThrow(/多份模板/);
  });

  it('粘贴类型不匹配给出具体提示', () => {
    try {
      parseTemplate('teacher', FILLED_PARENT, CTX);
      expect.unreachable();
    } catch (e) {
      expect((e as ParseStructureError).message).toContain('家教需求登记');
    }
  });

  it('超过50000字上限明确提示', () => {
    const long = `【家教需求登记】\n${'x'.repeat(51_000)}`;
    try {
      parseTemplate('parent', long, CTX);
      expect.unreachable();
    } catch (e) {
      expect((e as ParseStructureError).code).toBe('TOO_LONG');
    }
  });

  it('重复冲突字段不静默取最后一项', () => {
    const dup = FILLED_TEACHER.replace('姓名：李明', '姓名：李明').replace('就读学校：示范大学', '就读学校：第一大学');
    const doubleSchool = dup.replace('专业：数学与应用数学', '专业：数学与应用数学\n就读学校：第二大学');
    const r = parseTemplate('teacher', doubleSchool, CTX);
    expect(r.fieldErrors.university).toContain('不一致');
    expect(r.conflicts.university?.length).toBe(2);
    expect(r.draft.university).toBe('第一大学'); // 取第一次出现并明确提示
  });

  it('完全无法识别时给出结构性错误', () => {
    try {
      parseTemplate('parent', '今天天气不错，我们出去走走。', CTX);
      expect.unreachable();
    } catch (e) {
      expect((e as ParseStructureError).code).toBe('NO_RECOGNIZED_CONTENT');
    }
  });

  it('缺失必填字段逐项显示并保留草稿（AC36）', () => {
    const missing = FILLED_TEACHER
      .replace('微信：limi_g2026', '微信：')
      .replace('电话：+86 139-1234-5678', '电话：')
      .replace('姓名：李明', '姓名：');
    const r = parseTemplate('teacher', missing, CTX);
    expect(r.fieldErrors.wechat).toContain('必填');
    expect(r.fieldErrors.phone).toContain('必填');
    expect(r.fieldErrors.teacherName).toContain('必填');
    expect(r.draft.orderNo).toBe('JJ-20260930-0001'); // 其余字段仍在
    expect(r.sourceText).toContain('报名订单编号');
  });
});
