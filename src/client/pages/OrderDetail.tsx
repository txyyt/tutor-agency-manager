// 订单详情：需求展示、受控状态动作、候选列表（多选/摘要/标推荐）、粘贴老师报名入口。
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { CopyButton, ErrorAlert, StatusBadge, TextBlock, TimeText } from '../components/ui';
import { centsToYuanString, yuanStringToCents } from '../../shared/money';
import type { ApplicationRecord, FinanceState, OrderRecord } from '../../shared/types';
import type { TemplateParseResult } from '../../shared/parsing/parseTemplate';

interface Candidate extends ApplicationRecord {
  finance: FinanceState;
  isCurrent: boolean;
  isMatched: boolean;
}

interface DetailResponse {
  order: OrderRecord;
  applications: Candidate[];
}

export default function OrderDetail({ navigate, orderId }: { navigate: (to: string) => void; orderId: number }) {
  const [data, setData] = useState<DetailResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  const [summaryText, setSummaryText] = useState<string | null>(null);
  const [feeFilter, setFeeFilter] = useState('');
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteText, setPasteText] = useState('');
  type OrderParseResponse = TemplateParseResult & { form: Record<string, unknown>; orderInfo: { orderId: number; orderNo: string; status: string; statusLabel: string; canApply: boolean } | null; orderMismatch: string | null };
  const [parseResult, setParseResult] = useState<OrderParseResponse | null>(null);
  const [pasteError, setPasteError] = useState('');
  const [savingApp, setSavingApp] = useState(false);
  const [appErrors, setAppErrors] = useState<Record<string, string>>({});
  const [confirmState, setConfirmState] = useState<{
    title: string;
    body: React.ReactNode;
    onOk: () => Promise<void>;
    danger?: boolean;
  } | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.get<DetailResponse>(`/api/orders/${orderId}`);
      setData(d);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [orderId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !data) {
    return <ErrorAlert error={error} />;
  }
  if (!data) return <div className="empty">加载中…</div>;
  const { order, applications } = data;

  const runOrderAction = async (action: string, extra?: Record<string, unknown>) => {
    const r = await api.post<{ message: string }>(`/api/orders/${orderId}/actions`, {
      action,
      version: order.version,
      ...extra,
    });
    setNotice(r.message);
    await load();
  };

  const doAction = (action: string, extra?: Record<string, unknown>, confirmTitle?: string, confirmBody?: React.ReactNode, danger?: boolean) => {
    if (confirmTitle) {
      setConfirmState({
        title: confirmTitle,
        body: confirmBody ?? '确定执行该操作？',
        danger,
        onOk: () => runOrderAction(action, extra),
      });
      return;
    }
    void runOrderAction(action, extra).catch(setError);
  };

  const toggle = (id: number) => {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  };

  const parseTeacherPaste = async () => {
    setPasteError('');
    setAppErrors({});
    try {
      const r = await api.post<OrderParseResponse>('/api/imports/parse', { kind: 'teacher', text: pasteText, contextOrderId: orderId });
      setParseResult(r);
      if (r.orderMismatch) setPasteError(r.orderMismatch);
      setAppErrors(r.fieldErrors);
    } catch (e) {
      setPasteError((e as ApiError).message);
    }
  };

  const saveTeacherApplication = async () => {
    if (!parseResult) return;
    setSavingApp(true);
    setAppErrors({});
    try {
      const d = parseResult.form;
      const acceptsPay = d.acceptsOrderPay === true;
      const expectedRaw = str(d.expectedHourlyPayRaw);
      const payload: Record<string, unknown> = {
        teacherName: str(d.teacherName),
        gender: str(d.gender),
        wechat: str(d.wechat),
        phone: str(d.phone),
        university: str(d.university),
        major: str(d.major),
        studyYear: str(d.studyYear),
        teachableSubjectsGrades: str(d.teachableSubjectsGrades),
        achievements: str(d.achievements),
        teachingExperience: str(d.teachingExperience),
        strengthsAndPlan: str(d.strengthsAndPlan),
        availableSchedule: str(d.availableSchedule),
        earliestStartDate: str(d.earliestStartDate) || null,
        acceptsOrderPay: acceptsPay,
        expectedHourlyPayCents: acceptsPay ? null : expectedRaw ? yuanStringToCents(expectedRaw) : null,
        canAttendTrial: d.canAttendTrial === true,
        trialConstraints: str(d.trialConstraints),
        notes: str(d.notes),
        sourceTemplateText: parseResult.draft && pasteText ? pasteText : null,
        creationRequestId: crypto.randomUUID(),
      };
      const r = await api.post<{ application: ApplicationRecord; duplicated: boolean; duplicateWarning: string | null }>(
        `/api/orders/${orderId}/applications`,
        payload,
      );
      if (r.duplicateWarning) setNotice(r.duplicateWarning);
      else setNotice('报名已创建（状态：已报名）');
      setPasteOpen(false);
      setPasteText('');
      setParseResult(null);
      await load();
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors) setAppErrors(err.fieldErrors);
      setPasteError((err as ApiError).message);
    } finally {
      setSavingApp(false);
    }
  };

  const showSummary = async () => {
    try {
      const r = await api.post<{ text: string }>(`/api/orders/${orderId}/recommendations`, {
        mode: 'summary',
        applicationIds: selected,
      });
      setSummaryText(r.text);
    } catch (e) {
      setError(e);
    }
  };

  const markRecommended = async () => {
    try {
      const r = await api.post<{ message: string }>(`/api/orders/${orderId}/recommendations`, {
        mode: 'mark-recommended',
        applicationIds: selected,
      });
      setNotice(r.message);
      await load();
    } catch (e) {
      setError(e);
    }
  };

  return (
    <>
      <div className="card">
        <div className="btn-row" style={{ justifyContent: 'space-between' }}>
          <h2 className="mt0 mb0">
            {order.orderNo} <StatusBadge status={order.status} />
            {order.status === 'reviewing' && order.currentApplicationId && (applications.find((a) => a.id === order.currentApplicationId)?.status === 'trial_passed' || applications.find((a) => a.id === order.currentApplicationId)?.status === 'direct_cooperation') && (
              <span className="badge b-reviewing" style={{ marginLeft: 8 }}>试课通过/直接合作，待确认与结算</span>
            )}
          </h2>
          <div className="btn-row">
            {order.status === 'recruiting' && (
              <button type="button" className="btn" onClick={() => void doAction('review', {}, '开始家长挑选', '将停止对外招募，进入挑选候选阶段。确定？')}>开始家长挑选</button>
            )}
            {order.status === 'reviewing' && !order.currentApplicationId && (
              <button type="button" className="btn" onClick={() => void doAction('recruit')}>继续招募</button>
            )}
            {(order.status === 'recruiting' || order.status === 'reviewing') && (
              <button type="button" className="btn" onClick={() => void doAction('pause', {}, '暂停订单', '暂停跟进该订单（不开始90天清理倒计时以外的影响）。确定？')}>暂停</button>
            )}
            {order.status === 'paused' && <button type="button" className="btn" onClick={() => void doAction('resume')}>恢复</button>}
            {order.status === 'awaiting_trial' && (
              <button type="button" className="btn primary" onClick={() => void doAction('start-trial', {}, '开始试课', '确认保证金已收齐，订单进入“试课中”。确定？')}>开始试课</button>
            )}
            {order.status !== 'completed' && order.status !== 'cancelled' && (
              <button type="button" className="btn danger" onClick={() => {
                const pendingRefunds = applications.filter((a) => a.finance.netReceivedCents > 0);
                setConfirmState({
                  title: '取消订单',
                  danger: true,
                  body: (
                    <div>
                      <p>取消后停止招募并结束有效报名；<strong>已收款项不会自动退款</strong>，需要逐条实际退款后登记。</p>
                      {pendingRefunds.length > 0 && (
                        <p style={{ color: 'var(--danger)' }}>
                          以下报名有已收款项，取消后变为待退款：
                          <br />
                          {pendingRefunds.map((a) => `${a.applicationNo}（${(a.finance.netReceivedCents / 100).toFixed(2)}元）`).join('、')}
                        </p>
                      )}
                    </div>
                  ),
                  onOk: async () => {
                    const r = await api.post<{ message: string }>(`/api/orders/${orderId}/actions`, { action: 'cancel', version: order.version });
                    setNotice(r.message);
                    await load();
                  },
                });
              }}>取消订单</button>
            )}
          </div>
        </div>
        <div className="section-divider" />
        <dl className="kv">
          <dt>家长称呼</dt><dd>{order.parentName}</dd>
          <dt>微信 / 电话</dt><dd>{order.parentWechat} / {order.parentPhone}</dd>
          <dt>年级 / 科目</dt><dd>{order.childGrade} / {order.subjects}</dd>
          <dt>学习情况</dt><dd>{order.learningSituation}</dd>
          <dt>辅导目标</dt><dd>{order.tutoringGoal}</dd>
          <dt>上课方式</dt><dd>{order.teachingMode === 'online' ? '线上' : '线下'}</dd>
          <dt>内部地点</dt><dd>{order.locationDetail}</dd>
          <dt>公开区域</dt><dd>{order.publicArea}</dd>
          <dt>内部时间</dt><dd>{order.weeklySchedule}</dd>
          <dt>公开时间</dt><dd>{order.publicSchedule}</dd>
          <dt>频次</dt><dd>每周{order.sessionsPerWeek}次 × {order.sessionMinutes}分钟</dd>
          <dt>开始时间</dt><dd>{order.expectedStartDate ?? '协商'}</dd>
          <dt>薪资</dt><dd>{centsToYuanString(order.hourlyPayCents)}元/小时（{order.payNegotiable ? '可协商' : '不可协商'}）</dd>
          <dt>性别要求</dt><dd>{order.genderPreference === 'any' ? '不限' : order.genderPreference === 'male' ? '男' : '女'}</dd>
          <dt>原始老师要求</dt><dd>{order.teacherRequirements || '无'}</dd>
          <dt>公开老师要求</dt><dd>{order.publicRequirements || '无'}</dd>
          <dt>内部备注</dt><dd>{order.notes || '—'}</dd>
          <dt>创建 / 修改</dt><dd><TimeText iso={order.createdAt} /> / <TimeText iso={order.updatedAt} />（90天清理按最近实际修改计算）</dd>
          {order.completedAt && (<><dt>完成时间</dt><dd><TimeText iso={order.completedAt} /></dd></>)}
          {order.cancelledAt && (<><dt>取消时间</dt><dd><TimeText iso={order.cancelledAt} /></dd></>)}
        </dl>
        <div className="btn-row" style={{ marginTop: 10 }}>
          <button type="button" className="btn" onClick={() => navigate(`/orders/${orderId}/edit`)}>编辑资料</button>
        </div>
        {notice && <div className="alert ok" style={{ marginTop: 10 }}>{notice}</div>}
      </div>

      {/* 状态提示：完成校验 */}
      {order.status === 'reviewing' && order.currentApplicationId && (
        <div className="card">
          <h3>完成订单（自动校验）</h3>
          <div className="alert info">
            完成前自动校验：当前老师已确认合作、成交报名费用结清（净收=中介费）、其他报名全部退清。任一不满足会提示具体缺什么。
          </div>
          <button type="button" className="btn primary" onClick={() => {
            setConfirmState({
              title: '完成订单',
              body: '确认合作且费用结清后完成中介任务。系统将自动校验全部条件，不满足时会显示具体原因。',
              onOk: async () => {
                const r = await api.post<{ message: string }>(`/api/orders/${orderId}/actions`, { action: 'complete', version: order.version });
                setNotice(r.message);
                await load();
              },
            });
          }}>完成订单</button>
        </div>
      )}

      {confirmState && (
        <ConfirmDialog
          title={confirmState.title}
          body={confirmState.body}
          danger={confirmState.danger}
          onCancel={() => setConfirmState(null)}
          onOk={async () => {
            await confirmState.onOk();
            setConfirmState(null);
          }}
        />
      )}

      {/* 候选列表 */}
      <div className="card">
        <div className="btn-row" style={{ justifyContent: 'space-between' }}>
          <h2 className="mt0 mb0">候选报名（{applications.length}）</h2>
          <div className="btn-row">
            <select value={feeFilter} onChange={(e) => setFeeFilter(e.target.value)}>
              <option value="">全部报名</option>
              <option value="pending-refund">有待退款</option>
              <option value="active">有效候选</option>
            </select>
            <button type="button" className="btn primary" onClick={() => setPasteOpen(true)}>粘贴老师模板报名</button>
            <button type="button" className="btn" onClick={() => navigate(`/orders/${orderId}/apply`)}>普通表单报名</button>
          </div>
        </div>

        <div className="btn-row" style={{ margin: '10px 0' }}>
          <span className="timeline-note">已选 {selected.length} 位：</span>
          <button type="button" className="btn" disabled={selected.length === 0} onClick={showSummary}>生成候选摘要（发家长）</button>
          <button type="button" className="btn" disabled={selected.length === 0} onClick={() => {
            setConfirmState({
              title: '批量标记已推荐',
              body: '实际把简历发送给家长后才标记。生成摘要不会自动改变状态。确定标记？',
              onOk: markRecommended,
            });
          }}>标记已推荐</button>
        </div>
        <ErrorAlert error={error} />

        {applications.length === 0 && (
          <div className="empty">还没有报名。点击“粘贴老师模板报名”自动录入，或用普通表单。</div>
        )}

        {applications.length > 0 && (
          <table className="list">
            <thead>
              <tr>
                <th></th>
                <th>报名编号</th>
                <th>老师</th>
                <th>学校/专业/年级</th>
                <th>状态</th>
                <th>费用</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {applications
                .filter((a) => {
                  if (feeFilter === 'pending-refund') return a.finance.netReceivedCents > 0;
                  if (feeFilter === 'active') return ['submitted', 'recommended', 'awaiting_trial', 'trial_passed', 'direct_cooperation'].includes(a.status);
                  return true;
                })
                .map((a) => (
                  <tr key={a.id}>
                    <td>
                      {['submitted', 'recommended'].includes(a.status) && (
                        <input type="checkbox" checked={selected.includes(a.id)} onChange={() => toggle(a.id)} />
                      )}
                      {a.isCurrent && <span className="badge b-awaiting_trial" style={{ marginLeft: 4 }}>当前</span>}
                      {a.isMatched && <span className="badge b-trial_passed" style={{ marginLeft: 4 }}>成交</span>}
                    </td>
                    <td><a href={`#/applications/${a.id}`}>{a.applicationNo}</a></td>
                    <td>{a.teacherName}（{a.gender === 'male' ? '男' : '女'}）</td>
                    <td>{a.university} / {a.major} / {a.studyYear}</td>
                    <td><StatusBadge status={a.status} /></td>
                    <td>
                      {a.finance.agencyFeeCents === null ? (
                        <span style={{ color: 'var(--muted)' }}>未设费</span>
                      ) : (
                        <span>
                          净收{(a.finance.netReceivedCents / 100).toFixed(2)}元
                          {a.finance.pendingRefundCents > 0 && <span style={{ color: 'var(--danger)' }}>，待退{(a.finance.pendingRefundCents / 100).toFixed(2)}元</span>}
                          {a.finance.pendingSupplementCents !== null && a.finance.pendingSupplementCents > 0 && (
                            <span style={{ color: 'var(--warn)' }}>，待补{(a.finance.pendingSupplementCents / 100).toFixed(2)}元</span>
                          )}
                          {a.finance.settled && <span style={{ color: 'var(--ok)' }}>，已结清</span>}
                        </span>
                      )}
                    </td>
                    <td>
                      <a href={`#/applications/${a.id}`}>详情/费用</a>
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>

      {summaryText && (
        <div className="card">
          <h2>候选摘要（按报名编号区分同名老师，不含微信/电话/费用/内部备注）</h2>
          <div className="alert info">发送家长后，请回来勾选并“标记已推荐”。附件请另行下载手动发送；摘要过滤不代表原附件已去除联系方式。</div>
          <TextBlock text={summaryText} maxHeight={400} />
          <div className="btn-row" style={{ marginTop: 10 }}>
            <CopyButton text={summaryText} label="复制摘要" />
            <button type="button" className="btn" onClick={() => setSummaryText(null)}>关闭</button>
          </div>
        </div>
      )}

      {/* 粘贴老师模板 */}
      {pasteOpen && (
        <div className="card paste-box">
          <h2>粘贴老师报名模板（自动关联本单）</h2>
          <div className="alert info">
            老师模板中的“报名订单编号”必须与本单一致（{order.orderNo}），不一致会阻止保存，不会静默替换。
          </div>
          <textarea value={pasteText} onChange={(e) => setPasteText(e.target.value)} placeholder="【大学生家教报名】1. 报名订单编号：…" />
          <div className="btn-row" style={{ marginTop: 8 }}>
            <button type="button" className="btn primary" disabled={!pasteText.trim()} onClick={parseTeacherPaste}>解析并填入</button>
            <button type="button" className="btn" onClick={() => { setPasteOpen(false); setParseResult(null); setPasteError(''); }}>关闭</button>
          </div>
          {pasteError && <div className="alert error" style={{ marginTop: 10 }}>{pasteError}</div>}
          {parseResult && (
            <div className="paste-result">
              <strong>解析结果：</strong>
              {parseResult.orderInfo && (
                <div>
                  识别订单编号：{parseResult.orderInfo.orderNo}（{parseResult.orderInfo.statusLabel}）
                  {parseResult.orderInfo.orderNo !== order.orderNo && <span style={{ color: 'var(--danger)' }}>与本单不一致，不能在本单保存</span>}
                </div>
              )}
              {Object.keys(appErrors).length === 0 ? (
                <div style={{ color: 'var(--ok)' }}>字段识别成功，请检查后保存。</div>
              ) : (
                <ul style={{ color: 'var(--danger)', paddingLeft: 18 }}>
                  {Object.entries(appErrors).map(([k, v]) => <li key={k}>{v}</li>)}
                </ul>
              )}
              {parseResult.warnings.length > 0 && (
                <ul style={{ color: 'var(--warn)', paddingLeft: 18 }}>
                  {parseResult.warnings.map((w, i) => <li key={i}>{w}</li>)}
                </ul>
              )}
              <div className="btn-row" style={{ marginTop: 8 }}>
                <button
                  type="button"
                  className="btn primary"
                  disabled={savingApp || parseResult.orderInfo?.orderNo !== order.orderNo}
                  onClick={saveTeacherApplication}
                >
                  {savingApp ? '保存中…' : '保存为已报名'}
                </button>
              </div>
              <div className="alert warn" style={{ marginTop: 8 }}>
                文本中的“见附件”不代表文件已上传。保存后请在报名详情页上传简历文件（PDF/JPG/PNG）。
              </div>
            </div>
          )}
        </div>
      )}
      {!pasteOpen && (
        <div style={{ textAlign: 'center' }}>
          <button type="button" className="btn" onClick={() => setPasteOpen(true)}>展开粘贴老师模板</button>
        </div>
      )}
      {parseResult && parseResult.sourceText && (
        <div className="card">
          <h3>原文（仅内部查看，随记录保存并随记录清理）</h3>
          <TextBlock text={parseResult.sourceText} maxHeight={200} />
        </div>
      )}
    </>
  );
}

function ConfirmDialog(props: {
  title: string;
  body: React.ReactNode;
  onOk: () => Promise<void>;
  onCancel: () => void;
  danger?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 100, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) props.onCancel();
      }}
    >
      <div style={{ background: 'var(--card)', borderRadius: 10, padding: 20, maxWidth: 500, width: '100%' }}>
        <h3 style={{ marginTop: 0, color: props.danger ? 'var(--danger)' : undefined }}>{props.title}</h3>
        <div style={{ fontSize: 13 }}>{props.body}</div>
        {error && <div className="alert error" style={{ marginTop: 10 }}>{error}</div>}
        <div className="btn-row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
          <button type="button" className="btn" disabled={busy} onClick={props.onCancel}>取消</button>
          <button
            type="button"
            className={`btn ${props.danger ? 'danger' : 'primary'}`}
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await props.onOk();
              } catch (e) {
                setError((e as ApiError).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? '处理中…' : '确认'}
          </button>
        </div>
      </div>
    </div>
  );
}

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}
