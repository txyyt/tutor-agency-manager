// 报名录入：全局粘贴（按订单编号定位）或指定订单。老师无授课区域字段。
import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { CopyButton, ErrorAlert, Field, TextBlock } from '../components/ui';
import { centsToYuanString, yuanStringToCents } from '../../shared/money';
import { TEACHER_TEMPLATE } from '../../shared/templates';
import type { TemplateParseResult } from '../../shared/parsing/parseTemplate';
import { ORDER_STATUS_LABELS } from '../../shared/types';
import type { ApplicationRecord, OrderRecord } from '../../shared/types';

type ParseResponse = TemplateParseResult & {
  form: Record<string, unknown>;
  orderInfo: { orderId: number; orderNo: string; status: string; statusLabel: string; canApply: boolean } | null;
  orderMismatch: string | null;
};

type FormState = {
  teacherName: string; gender: string; wechat: string; phone: string;
  university: string; major: string; studyYear: string;
  teachableSubjectsGrades: string; achievements: string; teachingExperience: string; strengthsAndPlan: string;
  availableSchedule: string; earliestStartDate: string;
  acceptsOrderPay: string; expectedHourlyPay: string; canAttendTrial: string; trialConstraints: string;
  notes: string;
};

const EMPTY: FormState = {
  teacherName: '', gender: '', wechat: '', phone: '',
  university: '', major: '', studyYear: '',
  teachableSubjectsGrades: '', achievements: '', teachingExperience: '', strengthsAndPlan: '',
  availableSchedule: '', earliestStartDate: '',
  acceptsOrderPay: '', expectedHourlyPay: '', canAttendTrial: '', trialConstraints: '',
  notes: '',
};

export default function ApplicationForm({ navigate, orderId, applicationId, autoPaste }: { navigate: (to: string) => void; orderId?: number; applicationId?: number; autoPaste?: boolean }) {
  void autoPaste; // 从订单页跳转时带 paste=1；粘贴区默认展开，无需额外处理
  const creationRequestId = useRef(crypto.randomUUID());
  const [files, setFiles] = useState<File[]>([]);
  const editing = Boolean(applicationId);
  const fixedOrder = Boolean(orderId) || editing;
  const [version, setVersion] = useState<number | null>(null);
  const [targetOrder, setTargetOrder] = useState<OrderRecord | null>(null);
  const [orderNoInput, setOrderNoInput] = useState('');
  const [orderLookupError, setOrderLookupError] = useState('');
  const [form, setForm] = useState<FormState>(EMPTY);
  const [pasteText, setPasteText] = useState('');
  const [parseResult, setParseResult] = useState<ParseResponse | null>(null);
  const [pasteError, setPasteError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState('');
  const [parsing, setParsing] = useState(false);

  // 指定订单：加载订单信息（供编号校验）
  useEffect(() => {
    if (applicationId) {
      void api.get<{ application: ApplicationRecord; order: OrderRecord }>(`/api/applications/${applicationId}`)
        .then(({ application: a, order }) => {
          setTargetOrder(order);
          setVersion(a.version);
          setForm({
            teacherName: a.teacherName, gender: a.gender, wechat: a.wechat, phone: a.phone,
            university: a.university, major: a.major, studyYear: a.studyYear,
            teachableSubjectsGrades: a.teachableSubjectsGrades, achievements: a.achievements,
            teachingExperience: a.teachingExperience, strengthsAndPlan: a.strengthsAndPlan,
            availableSchedule: a.availableSchedule, earliestStartDate: a.earliestStartDate ?? '',
            acceptsOrderPay: a.acceptsOrderPay ? 'yes' : 'no',
            expectedHourlyPay: a.expectedHourlyPayCents === null ? '' : centsToYuanString(a.expectedHourlyPayCents),
            canAttendTrial: a.canAttendTrial ? 'yes' : 'no', trialConstraints: a.trialConstraints, notes: a.notes,
          });
        }).catch(setError);
    } else if (orderId) {
      void api
        .get<{ order: OrderRecord }>(`/api/orders/${orderId}`)
        .then((d) => setTargetOrder(d.order))
        .catch(setError);
    }
  }, [applicationId, orderId]);

  const lookUpOrder = async () => {
    setOrderLookupError('');
    setTargetOrder(null);
    try {
      const d = await api.get<{ order: OrderRecord }>(`/api/orders/${encodeURIComponent(orderNoInput.trim())}`);
      setTargetOrder(d.order);
    } catch {
      setOrderLookupError(`订单“${orderNoInput.trim()}”不存在，请核对编号（支持 JJ-YYYYMMDD-XXXX 或数字ID）`);
    }
  };

  const applyDraft = (r: ParseResponse) => {
    const d = r.form;
    setForm({
      teacherName: str(d.teacherName), gender: str(d.gender), wechat: str(d.wechat), phone: str(d.phone),
      university: str(d.university), major: str(d.major), studyYear: str(d.studyYear),
      teachableSubjectsGrades: str(d.teachableSubjectsGrades), achievements: str(d.achievements),
      teachingExperience: str(d.teachingExperience), strengthsAndPlan: str(d.strengthsAndPlan),
      availableSchedule: str(d.availableSchedule), earliestStartDate: str(d.earliestStartDate),
      acceptsOrderPay: d.acceptsOrderPay === true ? 'yes' : d.acceptsOrderPay === false ? 'no' : '',
      expectedHourlyPay: str(d.expectedHourlyPayRaw),
      canAttendTrial: d.canAttendTrial === true ? 'yes' : d.canAttendTrial === false ? 'no' : '',
      trialConstraints: str(d.trialConstraints),
      notes: str(d.notes),
    });
    requestAnimationFrame(() => { document.querySelector('form')?.setAttribute('data-dirty', 'true'); });
    setFieldErrors(r.fieldErrors);
    if (r.orderInfo && !fixedOrder) {
      setTargetOrder({
        id: r.orderInfo.orderId,
        orderNo: r.orderInfo.orderNo,
        status: r.orderInfo.status as OrderRecord['status'],
      } as OrderRecord);
    }
  };

  const doParse = async () => {
    setParsing(true);
    setPasteError('');
    setParseResult(null);
    try {
      const r = await api.post<ParseResponse>('/api/imports/parse', {
        kind: 'teacher',
        text: pasteText,
        contextOrderId: fixedOrder ? orderId : null,
      });
      setParseResult(r);
      applyDraft(r);
      if (r.orderMismatch) setPasteError(r.orderMismatch);
    } catch (e) {
      setPasteError((e as ApiError).message);
    } finally {
      setParsing(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setFieldErrors({});
    if (!targetOrder) {
      setError(new Error('请先确定报名订单（粘贴模板自动定位，或输入订单编号查询）'));
      return;
    }
    setSaving(true);
    try {
      const accepts = form.acceptsOrderPay === 'yes';
      const payload: Record<string, unknown> = {
        teacherName: form.teacherName,
        gender: form.gender,
        wechat: form.wechat,
        phone: form.phone,
        university: form.university,
        major: form.major,
        studyYear: form.studyYear,
        teachableSubjectsGrades: form.teachableSubjectsGrades,
        achievements: form.achievements,
        teachingExperience: form.teachingExperience,
        strengthsAndPlan: form.strengthsAndPlan,
        availableSchedule: form.availableSchedule,
        earliestStartDate: form.earliestStartDate || null,
        acceptsOrderPay: form.acceptsOrderPay === '' ? undefined : accepts,
        expectedHourlyPayCents: accepts ? null : form.expectedHourlyPay.trim() === '' ? null : yuanStringToCents(form.expectedHourlyPay),
        canAttendTrial: form.canAttendTrial === '' ? undefined : form.canAttendTrial === 'yes',
        trialConstraints: form.trialConstraints,
        notes: form.notes,
        creationRequestId: creationRequestId.current,
      };
      if (parseResult) payload.sourceTemplateText = parseResult.sourceText ?? pasteText;
      if (editing) {
        const fd = new FormData(); fd.append('payload', JSON.stringify({ ...payload, version }));
        for (const file of files) fd.append('files', file);
        await api.postForm(`/api/applications/${applicationId}/profile`, fd);
        window.dispatchEvent(new CustomEvent('tam:notice', { detail: '老师资料与附件修改已保存' }));
        navigate(`/applications/${applicationId}`);
        return;
      }
      const fd = new FormData(); fd.append('payload', JSON.stringify(payload));
      for (const file of files) fd.append('files', file);
      const r = await api.postForm<{ application: { id: number }; duplicated: boolean; duplicateWarning: string | null }>(`/api/orders/${targetOrder.id}/applications`, fd);
      if (r.duplicateWarning) setNotice(r.duplicateWarning);
      window.dispatchEvent(new CustomEvent('tam:notice', { detail: r.duplicateWarning || '报名资料与附件已保存' }));
      navigate(`/applications/${r.application.id}`);
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors) setFieldErrors(err.fieldErrors);
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  const orderStatusBad = !editing && targetOrder && !['recruiting', 'awaiting_trial', 'trialing'].includes(targetOrder.status);
  const orderMismatched = parseResult?.orderInfo && targetOrder && parseResult.orderInfo.orderNo !== targetOrder.orderNo;

  return (
    <>
      <div className="card">
        <h2>{editing ? '编辑老师资料' : '老师报名录入（微信、电话必填）'}</h2>
        {notice && <div className="alert warn">{notice}</div>}
        {!fixedOrder && (
          <>
            <div className="alert info">粘贴老师模板会自动按“报名订单编号”定位订单；也可以手动输入编号查询。</div>
            <div className="filter-bar">
              <input
                placeholder="订单编号，如 JJ-20260930-0001"
                value={orderNoInput}
                onChange={(e) => setOrderNoInput(e.target.value)}
                style={{ width: 260 }}
              />
              <button type="button" className="btn" onClick={lookUpOrder}>查询订单</button>
            </div>
            {orderLookupError && <div className="alert error">{orderLookupError}</div>}
          </>
        )}
        {targetOrder && (
          <div className={`alert ${orderStatusBad ? 'error' : 'info'}`}>
            报名订单：{targetOrder.orderNo}
            {editing ? ' — 修改本次报名的资料' : orderStatusBad
              ? ` — 当前状态为“${ORDER_STATUS_LABELS[targetOrder.status]}”，不能接收报名`
              : targetOrder.status === 'recruiting'
                ? ' — 可接收候选报名（不会自动改变订单进度）'
                : ' — 可接收候选报名'}
            {orderMismatched && <div style={{ color: 'var(--danger)' }}>粘贴原文中的订单编号与该订单不一致，请重新粘贴或更换订单。</div>}
          </div>
        )}
      </div>

      {!editing && <div className="card paste-box">
        <h2>粘贴老师模板自动填写</h2>
        <textarea
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
          placeholder="【大学生家教报名】1. 报名订单编号：…"
          style={{ minHeight: 180 }}
        />
        <div className="btn-row" style={{ marginTop: 8 }}>
          <button type="button" className="btn primary" disabled={parsing || !pasteText.trim()} onClick={doParse}>
            {parsing ? '解析中…' : '解析并填入表单'}
          </button>
          <CopyButton text={targetOrder ? TEACHER_TEMPLATE.replace('1. 报名订单编号：', `1. 报名订单编号：${targetOrder.orderNo}`) : TEACHER_TEMPLATE} label="复制空白模板" />
        </div>
        {pasteError && <div className="alert error" style={{ marginTop: 10 }}>{pasteError}</div>}
        {parseResult && (
          <div className="paste-result">
            <strong>解析结果：</strong>
            {Object.keys(parseResult.fieldErrors).length === 0 ? (
              <span style={{ color: 'var(--ok)' }}>全部字段识别成功，请确认后保存。</span>
            ) : (
              <ul style={{ color: 'var(--danger)', paddingLeft: 18 }}>
                {Object.entries(parseResult.fieldErrors).map(([k, v]) => <li key={k}>{v}</li>)}
              </ul>
            )}
            {parseResult.warnings.length > 0 && (
              <ul style={{ color: 'var(--warn)', paddingLeft: 18 }}>
                {parseResult.warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            )}
            <div className="alert warn" style={{ marginTop: 8 }}>文本中提到附件不代表文件已上传，请在下方报名表单选择简历文件，与资料一起保存（PDF/JPG/PNG，最多5个、每个10MB）。</div>
            {parseResult.sourceText && (
              <details>
                <summary style={{ cursor: 'pointer', color: 'var(--muted)' }}>查看原文（保存后随记录保存）</summary>
                <TextBlock text={parseResult.sourceText} maxHeight={180} />
              </details>
            )}
          </div>
        )}
      </div>}

      <form onChange={(e) => { e.currentTarget.dataset.dirty = 'true'; }} className="card" onSubmit={submit}>
        <h2>报名表单</h2>
        <ErrorAlert error={error} />
        <h3>【基本信息】</h3>
        <div className="form-grid">
          <Field label="姓名" required error={fieldErrors.teacherName}>
            <input type="text" value={form.teacherName} onChange={(e) => setForm((f) => ({ ...f, teacherName: e.target.value }))} />
          </Field>
          <Field label="性别" required error={fieldErrors.gender}>
            <select value={form.gender} onChange={(e) => setForm((f) => ({ ...f, gender: e.target.value }))}>
              <option value="">请选择</option>
              <option value="male">男</option>
              <option value="female">女</option>
            </select>
          </Field>
          <Field label="微信" required error={fieldErrors.wechat}>
            <input type="text" value={form.wechat} onChange={(e) => setForm((f) => ({ ...f, wechat: e.target.value }))} />
          </Field>
          <Field label="电话" required error={fieldErrors.phone}>
            <input type="text" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} />
          </Field>
          <Field label="就读学校" required error={fieldErrors.university}>
            <input type="text" value={form.university} onChange={(e) => setForm((f) => ({ ...f, university: e.target.value }))} />
          </Field>
          <Field label="专业" required error={fieldErrors.major}>
            <input type="text" value={form.major} onChange={(e) => setForm((f) => ({ ...f, major: e.target.value }))} />
          </Field>
          <Field label="当前年级（如大二、研一）" required error={fieldErrors.studyYear}>
            <input type="text" value={form.studyYear} onChange={(e) => setForm((f) => ({ ...f, studyYear: e.target.value }))} />
          </Field>
        </div>
        <h3>【针对本订单的教学能力】</h3>
        <div className="form-grid">
          <Field label="可辅导的科目及年级" required error={fieldErrors.teachableSubjectsGrades} full>
            <textarea value={form.teachableSubjectsGrades} onChange={(e) => setForm((f) => ({ ...f, teachableSubjectsGrades: e.target.value }))} />
          </Field>
          <Field label="相关成绩或能力说明（选填）" error={fieldErrors.achievements} full>
            <textarea value={form.achievements} onChange={(e) => setForm((f) => ({ ...f, achievements: e.target.value }))} />
          </Field>
          <Field label="家教或其他教学经验（没有填“暂无”）" required error={fieldErrors.teachingExperience} full>
            <textarea value={form.teachingExperience} onChange={(e) => setForm((f) => ({ ...f, teachingExperience: e.target.value }))} />
          </Field>
          <Field label="针对本订单的优势及辅导思路" required error={fieldErrors.strengthsAndPlan} full>
            <textarea value={form.strengthsAndPlan} onChange={(e) => setForm((f) => ({ ...f, strengthsAndPlan: e.target.value }))} />
          </Field>
        </div>
        <h3>【时间及薪资】</h3>
        <div className="form-grid">
          <Field label="每周可上课的日期和时间" required error={fieldErrors.availableSchedule} full>
            <textarea value={form.availableSchedule} onChange={(e) => setForm((f) => ({ ...f, availableSchedule: e.target.value }))} />
          </Field>
          <Field label="最早可开始时间（留空=协商）" error={fieldErrors.earliestStartDate}>
            <input type="date" value={form.earliestStartDate} onChange={(e) => setForm((f) => ({ ...f, earliestStartDate: e.target.value }))} />
          </Field>
          <Field label="是否接受订单中的薪资" required error={fieldErrors.acceptsOrderPay}>
            <select value={form.acceptsOrderPay} onChange={(e) => setForm((f) => ({ ...f, acceptsOrderPay: e.target.value }))}>
              <option value="">请选择</option>
              <option value="yes">接受</option>
              <option value="no">不接受</option>
            </select>
          </Field>
          {form.acceptsOrderPay === 'no' && (
            <Field label="期望薪资（元/小时）" required error={fieldErrors.expectedHourlyPayCents ?? fieldErrors.expectedHourlyPay}>
              <input type="text" value={form.expectedHourlyPay} onChange={(e) => setForm((f) => ({ ...f, expectedHourlyPay: e.target.value }))} />
            </Field>
          )}
          <Field label="是否可以按安排参加试课" required error={fieldErrors.canAttendTrial}>
            <select value={form.canAttendTrial} onChange={(e) => setForm((f) => ({ ...f, canAttendTrial: e.target.value }))}>
              <option value="">请选择</option>
              <option value="yes">可以</option>
              <option value="no">不能/受限</option>
            </select>
          </Field>
          <Field label="试课时间限制（不能时填写）" error={fieldErrors.trialConstraints} full>
            <textarea value={form.trialConstraints} onChange={(e) => setForm((f) => ({ ...f, trialConstraints: e.target.value }))} />
          </Field>
          <Field label="内部备注（选填）" error={fieldErrors.notes} full>
            <textarea value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} />
          </Field>
        </div>
        <h3>简历附件（选填）</h3>
        <p className="hint">PDF/JPG/PNG，最多5个，每个10MB。文件会与报名资料一起保存，失败时保留填写内容。</p>
        <input aria-label="报名简历附件" type="file" multiple accept=".pdf,.jpg,.jpeg,.png" onChange={e => setFiles(Array.from(e.target.files ?? []))} />
        {files.length > 0 && <ul>{files.map((f, i) => <li key={i}>{f.name} <button type="button" className="btn small" onClick={() => setFiles(old => old.filter((_, index) => i !== index))}>移除</button></li>)}</ul>}
        <div className="btn-row">
          <button type="submit" className="btn primary" aria-busy={saving} disabled={saving || !targetOrder || Boolean(orderStatusBad) || Boolean(orderMismatched)}>
            {saving ? '保存中…' : editing ? '保存修改' : '保存报名（状态：已报名）'}
          </button>
          <button type="button" className="btn" onClick={() => navigate(editing ? `/applications/${applicationId}` : fixedOrder ? `/orders/${orderId}` : '/')}>取消</button>
        </div>
      </form>
    </>
  );
}

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}
