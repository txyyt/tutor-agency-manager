// 报名详情：资料、状态动作、费用面板（累计/最近）、收退款、更正登记、附件上传/预览/下载。
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, downloadFile } from '../api';
import { ConfirmButton, ErrorAlert, Field, StatusBadge, TextBlock, TimeText } from '../components/ui';
import { centsToYuanString, yuanStringToCents } from '../../shared/money';
import { buildFeeNotice } from '../../shared/textgen';
import WorkflowPanel from '../components/WorkflowPanel';
import DeleteRecord from '../components/DeleteRecord';
import AttachmentPreview from '../components/AttachmentPreview';
import type { ApplicationRecord, FinanceOperationRecord, FinanceState, OrderRecord } from '../../shared/types';

interface DetailResponse {
  application: ApplicationRecord & { finance: FinanceState; isCurrent: boolean };
  order: OrderRecord;
}

export default function ApplicationDetail({ applicationId, navigate }: { navigate: (to: string) => void; applicationId: number }) {
  const [data, setData] = useState<DetailResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState('');
  const [feeError, setFeeError] = useState('');
  const [correctionOpen, setCorrectionOpen] = useState(false);
  const [correction, setCorrection] = useState({ reason: '', agencyFee: '', depositDue: '', depReceived: '', depRefunded: '', supReceived: '', supRefunded: '' });
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [feeNoticeText, setFeeNoticeText] = useState<string | null>(null);
  const [previewData, setPreviewData] = useState<{ url: string; mime: string; name: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const closePreview = useCallback(() => setPreviewData(null), []);
  const [attachmentError, setAttachmentError] = useState('');

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
    setAttachmentError('');
    try {
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
      fd.append('version', String(app.version));
      await api.postForm(`/api/applications/${applicationId}/attachments`, fd);
      setFiles([]);
      setNotice('附件已上传');
      await load();
    } catch (e) {
      setAttachmentError((e as ApiError).message);
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

  const isCurrent = order.currentApplicationId === app.id;
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
      <WorkflowPanel app={app} order={order} reload={load} />
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
          <a className="btn" href={`#/applications/${app.id}/edit`}>编辑老师资料</a>
          <DeleteRecord kind="applications" id={app.id} version={app.version} no={app.applicationNo} onDeleted={() => navigate(`/orders/${order.id}`)} />
        </div>
      </div>

      <div className="card fee-tools"><details><summary><span><strong>更多费用操作</strong><small>金额更正与费用告知</small></span><span className="fee-tools-chevron" aria-hidden="true">⌄</span></summary>
        <ErrorAlert error={feeError || null} />
        <div className="fee-tool-grid">
          {order.status !== 'completed' && <button className="fee-tool" onClick={() => setCorrectionOpen(!correctionOpen)}><strong>更正金额</strong><span>录错金额时调整，保留更正记录</span></button>}
          <button className="fee-tool" onClick={() => setFeeNoticeText(buildFeeNotice(app, order.orderNo))}><strong>费用告知</strong><span>生成文字，核对后复制给老师</span></button>
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

      </details></div>

      {/* 附件 */}
      <div className="card">
        <ErrorAlert error={attachmentError || null} />
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

      {previewData && <AttachmentPreview path={previewData.url} name={previewData.name} mime={previewData.mime} onClose={closePreview} />}

      {/* 财务操作历史 */}
      <div className="card">
        <h2>收退款与更正历史</h2>
        {app.financeOperations.filter(op => op.type !== 'workflow').length === 0 && <div className="empty">暂无财务操作</div>}
        {app.financeOperations.filter(op => op.type !== 'workflow').length > 0 && (
          <table className="list">
            <thead>
              <tr><th>时间</th><th>类型</th><th>金额/内容</th><th>结果</th></tr>
            </thead>
            <tbody>
              {app.financeOperations.filter(op => op.type !== 'workflow').map((op, i) => (
                <tr key={`${op.operationId}-${i}`}>
                  <td><TimeText iso={op.at} /></td>
                  <td>{FINANCE_LABELS[op.type] ?? op.type}{op.type === 'correction' ? `（理由：${op.reason}）` : ''}</td>
                  <td>{financeDescription(op)}</td>
                  <td>{op.applied ? '已登记' : '未改变金额'}</td>
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

const FINANCE_LABELS: Record<string, string> = { 'set-fees': '约定费用', 'receive-deposit': '收到保证金', 'receive-supplement': '收到中介费', 'refund-deposit': '退回保证金', 'refund-supplement': '退回中介费', correction: '金额更正' };
function financeDescription(op: FinanceOperationRecord): string {
  const payload = op.payload as { amountCents?: number };
  const money = (v: number | null | undefined) => v == null ? '未设置' : `${centsToYuanString(v)}元`;
  if (op.type === 'set-fees') return `中介费 ${money(op.after.agencyFeeCents)}，保证金 ${money(op.after.depositDueCents)}`;
  if (op.type === 'correction') return `保证金累计收 ${money(op.after.depositReceivedCents)} / 退 ${money(op.after.depositRefundedCents)}；中介费累计收 ${money(op.after.feeSupplementReceivedCents)} / 退 ${money(op.after.feeSupplementRefundedCents)}`;
  return `本次 ${money(payload.amountCents)}`;
}
