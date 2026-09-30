import { useState } from 'react';
import { api } from '../api';
import { ConfirmButton, MoneyText } from './ui';
import { centsToYuanString, yuanStringToCents } from '../../shared/money';
import type { ApplicationRecord, FinanceState, OrderRecord } from '../../shared/types';

type Candidate = ApplicationRecord & { finance: FinanceState };
export default function WorkflowPanel({ app, order, reload, compact = false }: { app: Candidate; order: OrderRecord; reload: () => Promise<void>; compact?: boolean }) {
  const [modal, setModal] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [fee, setFee] = useState('');
  const [deposit, setDeposit] = useState('');
  const [amount, setAmount] = useState('');
  const [received, setReceived] = useState(false);
  const [operationId, setOperationId] = useState('');
  const current = order.currentApplicationId === app.id;
  const fin = app.finance;
  const canDirect = order.status === 'recruiting' && !order.currentApplicationId && app.status === 'recommended';
  const canSchedule = canDirect;
  const awaiting = current && order.status === 'awaiting_trial';
  const trialing = current && order.status === 'trialing';
  const settling = current && order.status === 'reviewing';
  const labels: Record<string, string> = { schedule: '安排试课', prepare: '登记试课费用与保证金', 'receive-start': '确认保证金到账并开始试课', start: '开始试课', pass: '试课通过并结算', fail: '试课未通过', withdraw: '主动退出', direct: '直接合作并收费', settle: '收取中介费', refund: '登记退款', complete: '完成订单' };
  const open = (action: string) => {
    setModal(action); setError(''); setReceived(false); setOperationId(crypto.randomUUID());
    setFee(fin.agencyFeeCents === null ? '' : centsToYuanString(fin.agencyFeeCents));
    setDeposit(action === 'direct' ? '0' : fin.depositDueCents === null ? '' : centsToYuanString(fin.depositDueCents));
    setAmount(centsToYuanString(action === 'refund' ? fin.pendingRefundCents : ['schedule','prepare','receive-start'].includes(action) ? Math.max((fin.depositDueCents ?? 0) - fin.depositNetCents, 0) : Math.max((fin.agencyFeeCents ?? 0) - fin.netReceivedCents, 0)));
  };
  const submit = async () => {
    setBusy(true); setError('');
    try {
      const payload: Record<string, unknown> = { action: modal, operationId, version: app.version, orderVersion: order.version };
      if (['schedule', 'prepare', 'direct'].includes(modal)) {
        payload.agencyFeeCents = yuanStringToCents(fee); payload.depositDueCents = yuanStringToCents(deposit);
        payload.amountCents = modal === 'schedule' ? 0 : received ? yuanStringToCents(amount) : 0;
      } else if (modal === 'refund' || modal === 'settle' || modal === 'receive-start') {
        if (!received) throw new Error(modal === 'refund' ? '请确认实际已退款，再登记' : '请确认实际已收到款项，再登记');
        payload.amountCents = yuanStringToCents(amount);
      } else if (modal === 'pass') payload.amountCents = received ? yuanStringToCents(amount) : 0;
      const r = await api.post<{ message: string }>(`/api/applications/${app.id}/workflow`, payload);
      setNotice(r.message); window.dispatchEvent(new CustomEvent('tam:notice', { detail: r.message })); setModal(''); await reload();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <div className={compact ? 'workflow-inline' : 'card workflow-panel'}>
    {!compact && <><h2>试课与结算 · {app.teacherName}</h2><div className="money-panel">
      <div className="money-item"><div className="k">中介费</div><div className="v"><MoneyText cents={fin.agencyFeeCents} /></div></div>
      <div className="money-item"><div className="k">实际净收</div><div className="v"><MoneyText cents={fin.netReceivedCents} /></div></div>
      {awaiting && <div className="money-item warn"><div className="k">尚需收保证金</div><div className="v"><MoneyText cents={fin.pendingDepositCents} /></div></div>}
      {settling && <div className="money-item warn"><div className="k">尚需收中介费</div><div className="v"><MoneyText cents={fin.pendingSupplementCents} /></div></div>}
      {fin.pendingRefundCents > 0 && <div className="money-item danger"><div className="k">应退款</div><div className="v"><MoneyText cents={fin.pendingRefundCents} /></div></div>}
    </div></>}
    {notice && <div className="alert ok" role="status">{notice}</div>}
    <div className="btn-row">
      {!compact && app.status === 'submitted' && order.status === 'recruiting' && <ConfirmButton label="标记已推荐" confirmTitle="标记已推荐" confirmBody="确认已把这位老师的简历发送给家长？" onConfirm={async () => { await api.post(`/api/applications/${app.id}/actions`, { action: 'recommend', version: app.version }); await reload(); }} />}
      {canSchedule && <button className="btn primary" onClick={() => open('schedule')}>安排试课</button>}
      {canDirect && <button className="btn" onClick={() => open('direct')}>直接合作（跳过试课）</button>}
      {awaiting && (fin.agencyFeeCents === null || fin.depositDueCents === null) && <button className="btn primary" onClick={() => open('prepare')}>登记试课费用与保证金</button>}
      {awaiting && fin.agencyFeeCents !== null && fin.depositDueCents !== null && (fin.pendingDepositCents ?? 0) > 0 && <button className="btn primary" onClick={() => open('receive-start')}>确认保证金到账并开始试课</button>}
      {awaiting && fin.agencyFeeCents !== null && fin.depositDueCents !== null && fin.pendingDepositCents === 0 && <button className="btn primary" onClick={() => open('start')}>开始试课</button>}
      {trialing && <><button className="btn primary" onClick={() => open('pass')}>试课通过</button><button className="btn danger" onClick={() => open('fail')}>试课未通过</button></>}
      {settling && (fin.pendingSupplementCents ?? 0) > 0 && <button className="btn primary" onClick={() => open('settle')}>收取中介费</button>}
      {settling && fin.settled && <button className="btn primary" onClick={() => open('complete')}>完成订单</button>}
      {order.status !== 'completed' && fin.pendingRefundCents > 0 && <button className="btn danger" onClick={() => open('refund')}>登记退款</button>}
      {order.status !== 'completed' && order.status !== 'cancelled' && ['submitted', 'recommended', 'awaiting_trial', 'trial_passed', 'direct_cooperation'].includes(app.status) && <button className="btn" onClick={() => open('withdraw')}>主动退出</button>}
    </div>
    {!compact && <p className="hint">试课通过即确认合作；保证金抵扣中介费，款项结清后自动完成订单。收款与退款均按实际到账登记。</p>}
    {modal && <div className="modal-backdrop"><div className="modal-panel" role="dialog" aria-modal="true" aria-label={labels[modal]}>
      <h3>{labels[modal]} · {app.teacherName}</h3>
      {['schedule', 'prepare', 'direct'].includes(modal) && <><label>中介费（元）<input aria-label="中介费（元）" value={fee} onChange={e => { setFee(e.target.value); if (modal === 'direct') setAmount(e.target.value); }} /></label><label>保证金（元）<input aria-label="保证金（元）" value={deposit} disabled={modal === 'direct'} onChange={e => { setDeposit(e.target.value); try { setAmount(centsToYuanString(Math.max(yuanStringToCents(e.target.value) - fin.depositNetCents, 0))); } catch { setAmount(''); } }} /></label>{modal !== 'schedule' && <label>{modal === 'direct' ? '本次实收中介费（元）' : '本次实收保证金（元）'}<input aria-label={modal === 'direct' ? '本次实收中介费（元）' : '本次实收保证金（元）'} value={amount} onChange={e => setAmount(e.target.value)} /></label>}<p className="hint">金额必须明确填写，免费个案填0。设置金额本身不会登记到账。</p></>}
      {['pass', 'settle'].includes(modal) && <><p>中介费 <MoneyText cents={fin.agencyFeeCents} />，保证金净额 <MoneyText cents={fin.depositNetCents} /> 已抵扣，尚需收取 <MoneyText cents={Math.max((fin.agencyFeeCents ?? 0) - fin.netReceivedCents, 0)} />。</p><label>本次实收中介费（元）<input aria-label="本次实收中介费（元）" value={amount} onChange={e => setAmount(e.target.value)} /></label></>}
      {modal === 'schedule' && <p className="hint">安排后保留待试课，不登记收款。请先向老师收取保证金，到账后回来确认并开始试课。</p>}
      {modal === 'receive-start' && <><label>本次实收保证金（元）<input aria-label="本次实收保证金（元）" value={amount} onChange={e => setAmount(e.target.value)} /></label><p className="hint">确认实际到账后登记；保证金收齐即开始试课，部分到账仍保留待试课。</p></>}
      {modal === 'refund' && <label>本次退款（元）<input aria-label="本次退款（元）" value={amount} onChange={e => setAmount(e.target.value)} /></label>}
      {['prepare', 'receive-start', 'direct', 'pass', 'settle', 'refund'].includes(modal) && <label className="receipt-confirm"><input type="checkbox" checked={received} onChange={e => setReceived(e.target.checked)} />{modal === 'refund' ? '我已实际退回本次款项' : ['prepare', 'receive-start'].includes(modal) ? '我已实际收到本次保证金' : '我已实际收到本次中介费'}</label>}
      {modal === 'pass' && <p className="hint">确认后试课通过并确认合作。未收到剩余费用时可不勾选，订单保留待结算。</p>}
      {modal === 'start' && <p>保证金已收齐，确认现在开始试课？</p>}
      {['fail', 'withdraw'].includes(modal) && <p>登记后本次报名结束；当前老师退出或未通过时，订单恢复招募。已经收到的款项需要实际退款后登记。</p>}
      {modal === 'complete' && <p>系统将校验中介费和其他老师的退款，全部结清后完成订单。</p>}
      {error && <div className="alert error" role="alert">{error}</div>}
      <div className="btn-row"><button className="btn" disabled={busy} onClick={() => setModal('')}>取消</button><button className="btn primary" disabled={busy} onClick={() => void submit()}>{busy ? '处理中…' : '确认'}</button></div>
    </div></div>}
  </div>;
}
