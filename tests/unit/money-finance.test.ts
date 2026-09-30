// 金额精确转换与财务计算单元测试（AC18、AC19、AC20、AC59）。
import { describe, expect, it } from 'vitest';
import { MoneyFormatError, centsToYuanString, yuanStringToCents } from '../../src/shared/money.js';
import { computeFinanceState } from '../../src/shared/finance.js';

describe('金额字符串→分（不走浮点累计）', () => {
  it('精确转换', () => {
    expect(yuanStringToCents('150')).toBe(15000);
    expect(yuanStringToCents('150.5')).toBe(15050);
    expect(yuanStringToCents('150.55')).toBe(15055);
    expect(yuanStringToCents('0.1')).toBe(10);
    expect(yuanStringToCents('0.2')).toBe(20);
    expect(yuanStringToCents('0')).toBe(0);
  });
  it('拒绝负数、三位小数、非法输入', () => {
    expect(() => yuanStringToCents('-100')).toThrow(MoneyFormatError);
    expect(() => yuanStringToCents('1.234')).toThrow(MoneyFormatError);
    expect(() => yuanStringToCents('abc')).toThrow(MoneyFormatError);
    expect(() => yuanStringToCents('1e3')).toThrow(MoneyFormatError);
    expect(() => yuanStringToCents('')).toThrow(MoneyFormatError);
  });
  it('分→元字符串可逆', () => {
    expect(centsToYuanString(15000)).toBe('150');
    expect(centsToYuanString(15050)).toBe('150.5');
    expect(centsToYuanString(15055)).toBe('150.55');
    expect(centsToYuanString(10)).toBe('0.1');
  });
});

describe('财务状态计算', () => {
  const base = {
    agencyFeeCents: 30000,
    depositDueCents: 10000,
    depositReceivedCents: 10000,
    depositRefundedCents: 0,
    feeSupplementReceivedCents: 0,
    feeSupplementRefundedCents: 0,
  };

  it('持有期（待试课）：显示待收保证金，不算已赚中介费', () => {
    const s = computeFinanceState(base, 'holding');
    expect(s.depositNetCents).toBe(10000);
    expect(s.pendingDepositCents).toBe(0);
    expect(s.pendingSupplementCents).toBeNull();
    expect(s.settled).toBe(false);
  });
  it('示例：F=300实收100，通过确认后待补200（AC11）', () => {
    const s = computeFinanceState(base, 'settling');
    expect(s.pendingSupplementCents).toBe(20000);
    expect(s.pendingRefundCents).toBe(0);
    expect(s.settled).toBe(false);
    const settled = computeFinanceState({ ...base, feeSupplementReceivedCents: 20000 }, 'settling');
    expect(settled.pendingSupplementCents).toBe(0);
    expect(settled.settled).toBe(true);
  });
  it('失败/退出/取消：净收成为待退，退清后净收0（AC13、AC14、AC15）', () => {
    const s = computeFinanceState(base, 'closing');
    expect(s.pendingRefundCents).toBe(10000);
    const refunded = computeFinanceState({ ...base, depositRefundedCents: 10000 }, 'closing');
    expect(refunded.pendingRefundCents).toBe(0);
    expect(refunded.netReceivedCents).toBe(0);
  });
  it('收费下调产生合法超收待退（AC20、AC59）', () => {
    const s = computeFinanceState({ ...base, agencyFeeCents: 5000 }, 'settling');
    expect(s.pendingRefundCents).toBe(5000); // N=100 > F=50
    expect(s.pendingSupplementCents).toBe(0);
  });
  it('0.10/0.20计算准确（AC19）', () => {
    const s = computeFinanceState(
      { agencyFeeCents: 30, depositDueCents: 10, depositReceivedCents: 10, depositRefundedCents: 0, feeSupplementReceivedCents: 20, feeSupplementRefundedCents: 0 },
      'settling',
    );
    expect(s.netReceivedCents).toBe(30);
    expect(s.settled).toBe(true);
  });
});
