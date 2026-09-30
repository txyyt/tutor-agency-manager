// 报名详情：资料、状态动作、费用面板（累计/最近）、收退款、更正登记、附件上传/预览/下载。
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, downloadFile } from '../api';
import { ConfirmButton, ErrorAlert, Field, MoneyText, StatusBadge, TextBlock, TimeText } from '../components/ui';
import { centsToYuanString, yuanStringToCents } from '../../shared/money';
import { buildFeeNotice } from '../../shared/textgen';
import type { ApplicationRecord, FinanceState, OrderRecord } from '../../shared/types';

interface DetailResponse {
  application: ApplicationRecord & { finance: FinanceState; isCurrent: boolean };
  order: OrderRecord;
}

const ACTION_LABELS = {
  recommend: '标记已推荐',
  'schedule-trial': '安排试课',
  pass: '试课通过',
  fail: '试课未通过',
  withdraw: '主动退出',
  'confirm-cooperation': '确认合作',
  'direct-cooperation': '直接合作（跳过试课）',
};

export default function ApplicationDetail({ applicationId }: { navigate: (to: string) => void; applicationId: number }) {
  const [data, setData] = useState<DetailResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [feeError, setFeeError] = useState('');
  const [amount, setAmount] = useState('');
  const [feeInput, setFeeInput] = useState({ agencyFee: '', depositDue: '' });
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [correction, setCorrection] = useState({ reason: '', agencyFee: '', depositDue: '', depReceived: '', depRefunded: '', supReceived: '', supRefunded: '' });
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [feeNoticeText, setFeeNoticeText] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<{ url: string; mime: string; name: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.get<DetailResponse>(`/api/applications/${applicationId}`);
      setData(d);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [applicationId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !data) return <ErrorAlert error={error} />;
  if (!data) return <div className="empty">加载中…</div>;
  const { application: app, order } = data;
  const fin = app.finance;

  const doAppAction = async (action: string, extra?: Record<string, unknown>) => {
    try {
      const r = await api.post<{ message: string }>(`/api/applications/${applicationId}/actions`, {
        action,
        version: app.version,
        orderVersion: order.version,
        ...extra,
      });
      setNotice(r.message);
      await load();
    } catch (e) {
      setError(e);
    }
  };

  const doFinance = async (type: string, amountCents?: number, extra?: Record<string, unknown>) => {
    setFeeError('');
    try {
      const r = await api.post<{ message: string }>(`/api/applications/${applicationId}/finance`, {
        type,
        operationId: crypto.randomUUID(),
        version: app.version,
        amountCents,
        ...extra,
      });
      setNotice(r.message);
      setAmount('');
      await load();
    } catch (e) {
      setFeeError((e as ApiError).message);
    }
  };

  const submitCorrection = async () => {
    setFeeError('');
    try {
      const num = (v: string): number | undefined => (v.trim() === '' ? undefined : yuanStringToCents(v));
      const corrected: Record<string, number | undefined> = {};
      if (correction.agencyFee !== '') corrected.agencyFeeCents = num(correction.agencyFee);
      if (correction.depositDue !== '') corrected.depositDueCents = num(correction.depositDue);
      if (correction.depReceived !== '') corrected.depositReceivedCents = num(correction.depReceived);
      if (correction.depRefunded !== '') corrected.depositRefundedCents = num(correction.depRefunded);
      if (correction.supReceived !== '') corrected.feeSupplementReceivedCents = num(correction.supReceived);
      if (correction.supRefunded !== '') corrected.feeSupplementRefundedCents = num(correction.supRefunded);
      const r = await api.post<{ message: string }>(`/api/applications/${applicationId}/finance/corrections`, {
        operationId: crypto.randomUUID(),
        version: app.version,
        reason: correction.reason,
        corrected,
      });
      setNotice(r.message);
      setCorrectionOpen(false);
      setCorrection({ reason: '', agencyFee: '', depositDue: '', depReceived: '', depRefunded: '', supReceived: '', supRefunded: '' });
      await load();
    } catch (e) {
      setFeeError((e as ApiError).message);
    }
  };

  const doUpload = async () => {
    if (files.length === 0) return;
    setUploading(true);
    setFeeError('');
    try {
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
      fd.append('version', String(app.version));
      await api.postForm(`/api/applications/${applicationId}/attachments`, fd);
      setFiles([]);
      setNotice('附件已上传');
      await load();
    } catch (e) {
      setFeeError((e as ApiError).message);
    } finally {
      setUploading(false);
    }
  };

  const doDeleteAttachment = async (fileId: string) => {
    try {
      await api.delete(`/api/applications/${applicationId}/attachments/${fileId}?version=${app.version}`);
      setNotice('附件已删除');
      await load();
    } catch (e) {
      setError(e);
    }
  };

  const openPreview = async (fileId: string) => {
    try {
      const meta = app.attachments.find((a) => a.fileId === fileId);
      const blobUrl = `/api/applications/${applicationId}/attachments/${fileId}/preview`;
      if (meta?.mimeType === 'application/pdf' || meta?.mimeType.startsWith('image/')) {
        setPreviewData({ url: blobUrl, mime: meta.mimeType, name: meta.originalName });
      } else {
        await downloadFile(blobUrl, meta?.originalName ?? 'attachment');
      }
    } catch (e) {
      setError(e);
    }
  };

  const canScheduleTrial = ['submitted', 'recommended'].includes(app.status) && ['recruiting', 'reviewing'].includes(order.status) && order.currentApplicationId === null;
  const isCurrent = order.currentApplicationId === app.id;
  const canSetFees = order.status !== 'completed' && order.status !== 'cancelled';
  const canReceiveDeposit = isCurrent && app.status === 'awaiting_trial' && order.status === 'awaiting_trial' && fin.agencyFeeCents !== null && fin.depositDueCents !== null;
  const canReceiveSupplement = isCurrent && ['trial_passed', 'direct_cooperation'].includes(app.status) && app.cooperationConfirmedAt !== null && order.status === 'reviewing' && fin.agencyFeeCents !== null && (fin.pendingSupplementCents ?? 0) > 0;
  const canRefund = order.status !== 'completed' && fin.netReceivedCents > 0 && !(
    isCurrent && ['awaiting_trial', 'trialing'].includes(order.status) && (fin.agencyFeeCents === null || fin.netReceivedCents <= fin.agencyFeeCents)
  );

  return (
    <>
      <div className="card">
        <div className="btn-row" style={{ justifyContent: 'space-between' }}>
          <h2 className="mt0 mb0">
            {app.applicationNo} <StatusBadge status={app.status} />
            {isCurrent && <span className="badge b-awaiting_trial" style={{ marginLeft: 8 }}>当前老师</span>}
            {order.matchedApplicationId === app.id && <span className="badge b-trial_passed" style={{ marginLeft: 8 }}>成交</span>}
          </h2>
          <a className="btn" href={`#/orders/${order.id}`}>返回订单 {order.orderNo}</a>
        </div>
        <div className="section-divider" />
        <dl className="kv">
          <dt>老师</dt><dd>{app.teacherName}（{app.gender === 'male' ? '男' : '女'}）</dd>
          <dt>微信 / 电话</dt><dd>{app.wechat} / {app.phone}</dd>
          <dt>学校 / 专业 / 年级</dt><dd>{app.university} / {app.major} / {app.studyYear}</dd>
          <dt>可辅导科目及年级</dt><dd>{app.teachableSubjectsGrades}</dd>
          <dt>成绩与能力</dt><dd>{app.achievements || '未填写'}</dd>
          <dt>教学经验</dt><dd>{app.teachingExperience}</dd>
          <dt>优势与思路</dt><dd>{app.strengthsAndPlan}</dd>
          <dt>可上课时间</dt><dd>{app.availableSchedule}</dd>
          <dt>最早开始</dt><dd>{app.earliestStartDate ?? '协商'}</dd>
          <dt>薪资</dt><dd>{app.acceptsOrderPay ? `接受订单薪资${centsToYuanString(order.hourlyPayCents)}元/小时` : `期望${app.expectedHourlyPayCents !== null ? centsToYuanString(app.expectedHourlyPayCents) + '元/小时' : '未填写'}`}</dd>
          <dt>试课</dt><dd>{app.canAttendTrial ? `可试课${app.trialConstraints ? `（${app.trialConstraints}）` : ''}` : app.trialConstraints ? `时间受限：${app.trialConstraints}` : '不能按安排试课'}</dd>
          <dt>内部备注</dt><dd>{app.notes || '—'}</dd>
          <dt>试课安排时间</dt><dd><TimeText iso={app.trialAt} /></dd>
          <dt>合作确认时间</dt><dd><TimeText iso={app.cooperationConfirmedAt} /></dd>
          <dt>创建 / 修改</dt><dd><TimeText iso={app.createdAt} /> / <TimeText iso={app.updatedAt} /></dd>
        </dl>
        {notice && <div className="alert ok" style={{ marginTop: 10 }}>{notice}</div>}
        <div className="btn-row" style={{ marginTop: 10 }}>
          {app.status === 'submitted' && (
            <button type="button" className="btn" onClick={() => void doAppAction('recommend')}>{ACTION_LABELS.recommend}</button>
          )}
          {canScheduleTrial && (
            <button type="button" className="btn primary" onClick={() => void doAppAction('schedule-trial')}>{ACTION_LABELS['schedule-trial']}（设为当前老师）</button>
          )}
          {isCurrent && app.status === 'awaiting_trial' && (
            <button type="button" className="btn primary" onClick={() => void doAppAction('pass')}>{ACTION_LABELS.pass}（订单回到挑选中）</button>
          )}
          {isCurrent && app.status === 'awaiting_trial' && (
            <button type="button" className="btn danger" onClick={() => void doAppAction('fail')}>{ACTION_LABELS.fail}（清当前引用）</button>
          )}
          {app.status === 'trial_passed' && isCurrent && !app.cooperationConfirmedAt && (
            <button type="button" className="btn primary" onClick={() => void doAppAction('confirm-cooperation')}>{ACTION_LABELS['confirm-cooperation']}</button>
          )}
          {['submitted', 'recommended'].includes(app.status) && ['recruiting', 'reviewing'].includes(order.status) && order.currentApplicationId === null && (
            <button type="button" className="btn primary" onClick={() => void doAppAction('direct-cooperation')}>{ACTION_LABELS['direct-cooperation']}</button>
          )}
          {['submitted', 'recommended', 'awaiting_trial', 'trial_passed', 'direct_cooperation'].includes(app.status) && order.status !== 'completed' && (
            <ConfirmButton
              label={ACTION_LABELS.withdraw}
              confirmTitle="登记老师主动退出"
              confirmBody={
                <div>
                  <p>退出后报名状态变为“主动退出”，不能重新激活（重新投递请新建报名）。</p>
                  {isCurrent && <p>该老师是当前试课/待结算老师，退出将清空当前引用，订单回到家长挑选中，已收款项变为待退款。</p>}
                </div>
              }
              onConfirm={() => doAppAction('withdraw')}
            />
          )}
        </div>
      </div>

      {/* 费用面板 */}
      <div className="card">
        <h2>费用面板（金额由老师支付；显示“累计”与“最近”）</h2>
        <div className="money-panel">
          <div className="money-item"><div className="k">应收中介费（F）</div><div className="v"><MoneyText cents={fin.agencyFeeCents} /></div></div>
          <div className="money-item"><div className="k">计划保证金</div><div className="v"><MoneyText cents={fin.depositDueCents} /></div></div>
          <div className="money-item"><div className="k">累计实收保证金</div><div className="v">{(fin.depositReceivedCents / 100).toFixed(2)}元</div><div className="k">最近：<TimeText iso={app.depositReceivedAt} /></div></div>
          <div className="money-item"><div className="k">累计退保证金</div><div className="v">{(fin.depositRefundedCents / 100).toFixed(2)}元</div><div className="k">最近：<TimeText iso={app.depositRefundedAt} /></div></div>
          <div className="money-item"><div className="k">累计补收中介费</div><div className="v">{(fin.feeSupplementReceivedCents / 100).toFixed(2)}元</div><div className="k">最近：<TimeText iso={app.feeSupplementReceivedAt} /></div></div>
          <div className="money-item"><div className="k">累计退补款</div><div className="v">{(fin.feeSupplementRefundedCents / 100).toFixed(2)}元</div><div className="k">最近：<TimeText iso={app.feeSupplementRefundedAt} /></div></div>
          <div className="money-item warn"><div className="k">当前净收（N=D+S）</div><div className="v">{(fin.netReceivedCents / 100).toFixed(2)}元</div></div>
          {fin.pendingDepositCents !== null && fin.pendingDepositCents > 0 && (
            <div className="money-item warn"><div className="k">待收保证金</div><div className="v">{(fin.pendingDepositCents / 100).toFixed(2)}元</div></div>
          )}
          {fin.pendingSupplementCents !== null && fin.pendingSupplementCents > 0 && (
            <div className="money-item warn"><div className="k">待补中介费（确认合作后）</div><div className="v">{(fin.pendingSupplementCents / 100).toFixed(2)}元</div></div>
          )}
          {fin.pendingRefundCents > 0 && (
            <div className="money-item danger"><div className="k">待退款</div><div className="v">{(fin.pendingRefundCents / 100).toFixed(2)}元</div></div>
          )}
          {fin.settled && <div className="money-item ok"><div className="k">结清状态</div><div className="v">已结清（N=F）</div></div>}
        </div>

        <ErrorAlert error={feeError || null} />

        <div className="btn-row" style={{ marginTop: 10 }}>
          {canSetFees && (
            <div className="inline-flex">
              <input type="text" placeholder="中介费（元）" value={feeInput.agencyFee} onChange={(e) => setFeeInput((f) => ({ ...f, agencyFee: e.target.value }))} style={{ width: 110 }} />
              <input type="text" placeholder="计划保证金（元）" value={feeInput.depositDue} onChange={(e) => setFeeInput((f) => ({ ...f, depositDue: e.target.value }))} style={{ width: 130 }} />
              <button
                type="button"
                className="btn"
                onClick={() => {
                  if (feeInput.agencyFee.trim() === '' || feeInput.depositDue.trim() === '') {
                    setFeeError('中介费和计划保证金都要填写（免费个案填0）。开始试课前必须设定。');
                    return;
                  }
                  try {
                    void doFinance('set-fees', undefined, {
                      agencyFeeCents: yuanStringToCents(feeInput.agencyFee),
                      depositDueCents: yuanStringToCents(feeInput.depositDue),
                    });
                    setFeeInput({ agencyFee: '', depositDue: '' });
                  } catch (err) {
                    setFeeError((err as Error).message);
                  }
                }}
              >
                {fin.agencyFeeCents === null ? '设定收费' : '调整收费'}
              </button>
            </div>
          )}
          {canReceiveDeposit && (
            <div className="inline-flex">
              <input type="text" placeholder="本次实收保证金（元）" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 150 }} />
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  try {
                    void doFinance('receive-deposit', yuanStringToCents(amount));
                  } catch (err) {
                    setFeeError((err as Error).message);
                  }
                }}
              >
                登记收保证金
              </button>
            </div>
          )}
          {canReceiveSupplement && (
            <div className="inline-flex">
              <input type="text" placeholder="本次补款（元）" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 130 }} />
              <button
                type="button"
                className="btn primary"
                onClick={() => {
                  try {
                    void doFinance('receive-supplement', yuanStringToCents(amount));
                  } catch (err) {
                    setFeeError((err as Error).message);
                  }
                }}
              >
                登记补收中介费
              </button>
            </div>
          )}
          {canRefund && (
            <div className="inline-flex">
              <input type="text" placeholder="本次退款（元）" value={amount} onChange={(e) => setAmount(e.target.value)} style={{ width: 130 }} />
              <button
                type="button"
                className="btn danger"
                onClick={() => {
                  try {
                    const cents = yuanStringToCents(amount);
                    // 优先退保证金（净额计算D在前）；实际规则服务端校验
                    void doFinance(fin.depositNetCents > 0 ? 'refund-deposit' : 'refund-supplement', cents);
                  } catch (err) {
                    setFeeError((err as Error).message);
                  }
                }}
              >
                登记退款
              </button>
            </div>
          )}
          {order.status !== 'completed' && (
            <button type="button" className="btn" onClick={() => setCorrectionOpen(!correctionOpen)}>更正登记（录错金额）</button>
          )}
          <button type="button" className="btn" onClick={() => setFeeNoticeText(buildFeeNotice(app, order.orderNo))}>复制费用告知</button>
        </div>

        {correctionOpen && (
          <div className="paste-result" style={{ marginTop: 10 }}>
            <h3>更正登记（只在未完成订单可用；填写理由，展示前后累计值；真实退款请走“登记退款”）</h3>
            <div className="form-grid">
              <Field label="更正理由（必填）" required full>
                <input type="text" value={correction.reason} onChange={(e) => setCorrection((c) => ({ ...c, reason: e.target.value }))} placeholder="如：登记时多按了一个0" />
              </Field>
              <Field label="中介费累计（元，留空不变）"><input type="text" value={correction.agencyFee} onChange={(e) => setCorrection((c) => ({ ...c, agencyFee: e.target.value }))} /></Field>
              <Field label="计划保证金累计（元）"><input type="text" value={correction.depositDue} onChange={(e) => setCorrection((c) => ({ ...c, depositDue: e.target.value }))} /></Field>
              <Field label="累计实收保证金（元）"><input type="text" value={correction.depReceived} onChange={(e) => setCorrection((c) => ({ ...c, depReceived: e.target.value }))} /></Field>
              <Field label="累计退保证金（元）"><input type="text" value={correction.depRefunded} onChange={(e) => setCorrection((c) => ({ ...c, depRefunded: e.target.value }))} /></Field>
              <Field label="累计补收（元）"><input type="text" value={correction.supReceived} onChange={(e) => setCorrection((c) => ({ ...c, supReceived: e.target.value }))} /></Field>
              <Field label="累计退补款（元）"><input type="text" value={correction.supRefunded} onChange={(e) => setCorrection((c) => ({ ...c, supRefunded: e.target.value }))} /></Field>
            </div>
            <div className="btn-row">
              <button type="button" className="btn primary" disabled={!correction.reason.trim()} onClick={submitCorrection}>提交更正</button>
            </div>
          </div>
        )}

        {feeNoticeText && (
          <div style={{ marginTop: 10 }}>
            <TextBlock text={feeNoticeText} maxHeight={200} />
            <div className="btn-row" style={{ marginTop: 6 }}>
              <ConfirmCopyButton text={feeNoticeText} />
              <button type="button" className="btn" onClick={() => setFeeNoticeText(null)}>关闭</button>
            </div>
          </div>
        )}

        <div className="alert info" style={{ marginTop: 10 }}>
          规则提示：收保证金前先设定收费；实收不超过当时计划值；确认合作后才允许补款（不超过待补）；取消/失败/退出后只允许退款；
          收款后下调费用产生合法待退；重复提交由操作ID幂等保护。
        </div>
      </div>

      {/* 附件 */}
      <div className="card">
        <h2>简历附件（PDF/JPEG/PNG，最多{5}个、每个10MB）</h2>
        <ErrorAlert error={error} />
        {app.attachments.length > 0 && (
          <ul className="attach-list">
            {app.attachments.map((a) => (
              <li key={a.fileId}>
                <span>{a.originalName}</span>
                <span style={{ color: 'var(--muted)', fontSize: 12 }}>{(a.size / 1024).toFixed(0)}KB · <TimeText iso={a.uploadedAt} /></span>
                <button type="button" className="btn small" onClick={() => void openPreview(a.fileId)}>预览</button>
                <a className="btn small" href="#" onClick={(e) => { e.preventDefault(); void downloadFile(`/api/applications/${applicationId}/attachments/${a.fileId}`, a.originalName); }}>下载</a>
                {order.status !== 'completed' && (
                  <ConfirmButton label="删除" small confirmTitle="删除附件" confirmBody={`确定删除“${a.originalName}”？`} onConfirm={() => doDeleteAttachment(a.fileId)} className="btn small danger" />
                )}
              </li>
            ))}
          </ul>
        )}
        {order.status !== 'completed' && (
          <>
            <div
              className={`dropzone ${dragOver ? 'dragover' : ''}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                setFiles(Array.from(e.dataTransfer.files));
              }}
            >
              {files.length === 0 ? '点击选择文件，或拖拽 PDF/JPG/PNG 到这里' : `已选择 ${files.length} 个文件：${files.map((f) => f.name).join('、')}`}
            </div>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept=".pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png"
              style={{ display: 'none' }}
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
            <div className="btn-row">
              <button type="button" className="btn primary" disabled={uploading || files.length === 0} onClick={doUpload}>
                {uploading ? '上传中…' : '上传所选文件'}
              </button>
              {files.length > 0 && <button type="button" className="btn" onClick={() => setFiles([])}>清除选择</button>}
            </div>
            <div className="alert info" style={{ marginTop: 8 }}>
              一次上传多个文件会全部校验后才提交；任一失败不会留下半组记录。上传失败时表单数据不丢失。
            </div>
          </>
        )}
      </div>

      {previewData && (
        <div className="card">
          <h2>附件预览：{previewData.name}</h2>
          {previewData.mime === 'application/pdf' ? (
            <iframe src={previewData.url} style={{ width: '100%', height: 500, border: '1px solid var(--line)', borderRadius: 6 }} title="附件预览" />
          ) : (
            <img src={previewData.url} style={{ maxWidth: '100%', maxHeight: 500 }} alt="附件预览" />
          )}
          <div className="btn-row" style={{ marginTop: 10 }}>
            <a className="btn" href="#" onClick={(e) => { e.preventDefault(); void downloadFile(previewData.url, previewData.name); }}>下载原文件</a>
            <button type="button" className="btn" onClick={() => setPreviewData(null)}>关闭</button>
          </div>
        </div>
      )}

      {/* 财务操作历史 */}
      <div className="card">
        <h2>财务操作与更正记录（幂等凭证，随报名保存）</h2>
        {app.financeOperations.length === 0 && <div className="empty">暂无财务操作</div>}
        {app.financeOperations.length > 0 && (
          <table className="list">
            <thead>
              <tr><th>时间</th><th>类型</th><th>金额/内容</th><th>结果</th></tr>
            </thead>
            <tbody>
              {app.financeOperations.map((op, i) => (
                <tr key={`${op.operationId}-${i}`}>
                  <td><TimeText iso={op.at} /></td>
                  <td>{op.type}{op.type === 'correction' ? `（理由：${op.reason}）` : ''}</td>
                  <td style={{ fontSize: 12, fontFamily: 'Consolas, monospace' }}>{JSON.stringify(op.payload)}</td>
                  <td>{op.applied ? '已执行' : '幂等重放（未重复）'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function ConfirmCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn primary"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        } catch {
          setCopied(false);
        }
      }}
    >
      {copied ? '已复制' : '复制费用告知'}
    </button>
  );
}
