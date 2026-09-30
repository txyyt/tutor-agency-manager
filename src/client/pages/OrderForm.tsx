// 订单录入/编辑：粘贴家长模板自动解析填写 + 普通表单。解析阶段不写库，保存走统一校验。
import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { CopyButton, ErrorAlert, Field } from '../components/ui';
import { yuanStringToCents, MoneyFormatError } from '../../shared/money';
import { PARENT_TEMPLATE } from '../../shared/templates';

interface ParseResponse {
  draft: Record<string, unknown>;
  form: Record<string, unknown>;
  fieldErrors: Record<string, string>;
  warnings: string[];
  unrecognizedFields: string[];
  conflicts: Record<string, string[]>;
  sourceText: string;
}

type FormState = {
  parentName: string; parentWechat: string; parentPhone: string;
  childGrade: string; subjects: string; learningSituation: string; tutoringGoal: string;
  teachingMode: string; locationDetail: string; publicArea: string;
  weeklySchedule: string; publicSchedule: string;
  sessionsPerWeek: string; sessionMinutes: string; expectedStartDate: string;
  hourlyPay: string; payNegotiable: string; genderPreference: string;
  teacherRequirements: string; publicRequirements: string; notes: string;
};

const EMPTY: FormState = {
  parentName: '', parentWechat: '', parentPhone: '',
  childGrade: '', subjects: '', learningSituation: '', tutoringGoal: '',
  teachingMode: '', locationDetail: '', publicArea: '',
  weeklySchedule: '', publicSchedule: '', sessionsPerWeek: '', sessionMinutes: '', expectedStartDate: '',
  hourlyPay: '', payNegotiable: '', genderPreference: '',
  teacherRequirements: '', publicRequirements: '', notes: '',
};

export default function OrderForm({ navigate, orderId }: { navigate: (to: string) => void; orderId?: number }) {
  const editing = Boolean(orderId);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [version, setVersion] = useState<number | null>(null);
  const [pasteOpen, setPasteOpen] = useState(!editing);
  const [pasteText, setPasteText] = useState('');
  const [parsing, setParsing] = useState(false);
  const [parseResult, setParseResult] = useState<ParseResponse | null>(null);
  const [pasteError, setPasteError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);
  const [loadedId, setLoadedId] = useState<number | null>(null);

  useEffect(() => {
    if (editing) {
      void api
        .get<{ order: Record<string, unknown> }>(`/api/orders/${orderId}`)
        .then(({ order }) => {
          setVersion(order.version as number);
          setLoadedId(order.id as number);
          setForm({
            parentName: order.parentName as string,
            parentWechat: order.parentWechat as string,
            parentPhone: order.parentPhone as string,
            childGrade: order.childGrade as string,
            subjects: order.subjects as string,
            learningSituation: order.learningSituation as string,
            tutoringGoal: order.tutoringGoal as string,
            teachingMode: order.teachingMode as string,
            locationDetail: order.locationDetail as string,
            publicArea: order.publicArea as string,
            weeklySchedule: order.weeklySchedule as string,
            publicSchedule: order.publicSchedule as string,
            sessionsPerWeek: String(order.sessionsPerWeek ?? ''),
            sessionMinutes: String(order.sessionMinutes ?? ''),
            expectedStartDate: (order.expectedStartDate as string) ?? '',
            hourlyPay: (order.hourlyPayCents as number) ? String((order.hourlyPayCents as number) / 100) : '',
            payNegotiable: order.payNegotiable ? 'yes' : 'no',
            genderPreference: order.genderPreference as string,
            teacherRequirements: order.teacherRequirements as string,
            publicRequirements: order.publicRequirements as string,
            notes: order.notes as string,
          });
        })
        .catch(setError);
    }
  }, [editing, orderId]);

  const set = (key: keyof FormState, value: string) => setForm((f) => ({ ...f, [key]: value }));

  const applyDraft = (r: ParseResponse) => {
    const d = r.form;
    setForm({
      parentName: str(d.parentName), parentWechat: str(d.parentWechat), parentPhone: str(d.parentPhone),
      childGrade: str(d.childGrade), subjects: str(d.subjects),
      learningSituation: str(d.learningSituation), tutoringGoal: str(d.tutoringGoal),
      teachingMode: str(d.teachingMode), locationDetail: str(d.locationDetail), publicArea: str(d.publicArea),
      weeklySchedule: str(d.weeklySchedule), publicSchedule: str(d.publicSchedule),
      sessionsPerWeek: d.sessionsPerWeek === null || d.sessionsPerWeek === undefined ? '' : String(d.sessionsPerWeek),
      sessionMinutes: d.sessionMinutes === null || d.sessionMinutes === undefined ? '' : String(d.sessionMinutes),
      expectedStartDate: str(d.expectedStartDate),
      hourlyPay: str(d.hourlyPayRaw) || (d.hourlyPayCents ? String((d.hourlyPayCents as number) / 100) : ''),
      payNegotiable: d.payNegotiable === true ? 'yes' : d.payNegotiable === false ? 'no' : '',
      genderPreference: str(d.genderPreference),
      teacherRequirements: str(d.teacherRequirements), publicRequirements: str(d.publicRequirements),
      notes: str(d.notes),
    });
    setFieldErrors(r.fieldErrors);
  };

  const doParse = async () => {
    setParsing(true);
    setPasteError('');
    setParseResult(null);
    try {
      const r = await api.post<ParseResponse>('/api/imports/parse', { kind: 'parent', text: pasteText });
      setParseResult(r);
      applyDraft(r);
      setFieldErrors(r.fieldErrors);
    } catch (e) {
      setPasteError((e as ApiError).message);
    } finally {
      setParsing(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setFieldErrors({});
    try {
      const payCents = form.hourlyPay.trim() === '' ? null : yuanStringToCents(form.hourlyPay);
      const payload: Record<string, unknown> = {
        parentName: form.parentName,
        parentWechat: form.parentWechat,
        parentPhone: form.parentPhone,
        childGrade: form.childGrade,
        subjects: form.subjects,
        learningSituation: form.learningSituation,
        tutoringGoal: form.tutoringGoal,
        teachingMode: form.teachingMode,
        locationDetail: form.locationDetail,
        publicArea: form.publicArea,
        weeklySchedule: form.weeklySchedule,
        publicSchedule: form.publicSchedule,
        sessionsPerWeek: form.sessionsPerWeek === '' ? null : Number(form.sessionsPerWeek),
        sessionMinutes: form.sessionMinutes === '' ? null : Number(form.sessionMinutes),
        expectedStartDate: form.expectedStartDate || null,
        hourlyPayCents: payCents,
        payNegotiable: form.payNegotiable === 'yes',
        genderPreference: form.genderPreference,
        teacherRequirements: form.teacherRequirements || '无',
        publicRequirements: form.publicRequirements,
        notes: form.notes,
      };
      if (editing) {
        await api.patch(`/api/orders/${orderId}?version=${version}`, payload);
        navigate(`/orders/${orderId}`);
      } else {
        if (payCents === null) {
          throw new MoneyFormatError('薪资为必填项，请填写金额（元/小时）');
        }
        payload.creationRequestId = crypto.randomUUID();
        if (parseResult) payload.sourceTemplateText = parseResult.sourceText;
        const result = await api.post<{ order: { id: number }; duplicateWarning: string | null; duplicated: boolean }>(
          '/api/orders',
          payload,
        );
        if (result.duplicateWarning) {
          alert(`${result.duplicateWarning}\n\n已进入订单详情，请确认。`);
        }
        navigate(`/orders/${result.order.id}`);
      }
    } catch (err) {
      if (err instanceof ApiError && err.fieldErrors) setFieldErrors(err.fieldErrors);
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {!editing && (
        <div className="card paste-box">
          <h2>粘贴家长模板自动建单</h2>
          <div className="alert info">
            把家长填写好的整份模板粘贴到下面，系统自动解析并填入右侧/下方表单；只需检查并补正标红项，再点保存。
            解析不写数据库；一次只粘贴一份模板。
          </div>
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder="【家教需求登记】1. 家长称呼：…"
          />
          <div className="btn-row" style={{ marginTop: 8 }}>
            <button type="button" className="btn primary" disabled={parsing || !pasteText.trim()} onClick={doParse}>
              {parsing ? '解析中…' : '解析并填入表单'}
            </button>
            <CopyButton text={PARENT_TEMPLATE} label="复制空白模板" />
            <button type="button" className="btn" onClick={() => setPasteOpen(false)}>不用粘贴，直接填写</button>
          </div>
          {pasteError && <div className="alert error" style={{ marginTop: 10 }}>{pasteError}</div>}
          {parseResult && (
            <div className="paste-result">
              <strong>解析结果：</strong>
              {Object.keys(parseResult.fieldErrors).length === 0 ? (
                <span style={{ color: 'var(--ok)' }}>全部字段识别成功，请确认后保存。</span>
              ) : (
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: 'var(--danger)' }}>
                  {Object.entries(parseResult.fieldErrors).map(([k, v]) => (
                    <li key={k}>{v}</li>
                  ))}
                </ul>
              )}
              {parseResult.warnings.length > 0 && (
                <ul style={{ margin: '6px 0 0', paddingLeft: 18, color: 'var(--warn)' }}>
                  {parseResult.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              )}
              {parseResult.unrecognizedFields.length > 0 && (
                <div style={{ marginTop: 6, color: 'var(--muted)' }}>
                  未识别的行（已保留原文，不会丢失）：
                  <pre>{parseResult.unrecognizedFields.join('\n')}</pre>
                </div>
              )}
            </div>
          )}
        </div>
      )}
      {pasteOpen && !editing && pasteText && !parseResult && (
        <div className="alert warn">尚未解析。点击“解析并填入表单”，或点击“不用粘贴，直接填写”。</div>
      )}

      <form className="card" onSubmit={submit}>
        <h2>{editing ? `编辑订单 #${loadedId ?? ''}` : '新建订单（立即进入招募中）'}</h2>
        <ErrorAlert error={error} />
        <h3>【家长联系】微信、电话均必填</h3>
        <div className="form-grid">
          <Field label="家长称呼" required error={fieldErrors.parentName}>
            <input type="text" value={form.parentName} onChange={(e) => set('parentName', e.target.value)} />
          </Field>
          <Field label="电话（区号/空格/连字符均可）" required error={fieldErrors.parentPhone}>
            <input type="text" value={form.parentPhone} onChange={(e) => set('parentPhone', e.target.value)} />
          </Field>
          <Field label="微信" required error={fieldErrors.parentWechat} full>
            <input type="text" value={form.parentWechat} onChange={(e) => set('parentWechat', e.target.value)} />
          </Field>
        </div>

        <h3>【孩子及辅导需求】</h3>
        <div className="form-grid">
          <Field label="孩子年级" required error={fieldErrors.childGrade}>
            <input type="text" value={form.childGrade} onChange={(e) => set('childGrade', e.target.value)} />
          </Field>
          <Field label="辅导科目（可多个）" required error={fieldErrors.subjects}>
            <input type="text" value={form.subjects} onChange={(e) => set('subjects', e.target.value)} />
          </Field>
          <Field label="目前学习情况" required error={fieldErrors.learningSituation} full>
            <textarea value={form.learningSituation} onChange={(e) => set('learningSituation', e.target.value)} />
          </Field>
          <Field label="辅导目标" required error={fieldErrors.tutoringGoal} full>
            <textarea value={form.tutoringGoal} onChange={(e) => set('tutoringGoal', e.target.value)} />
          </Field>
        </div>

        <h3>【上课安排】</h3>
        <div className="form-grid">
          <Field label="上课方式" required error={fieldErrors.teachingMode}>
            <select value={form.teachingMode} onChange={(e) => set('teachingMode', e.target.value)}>
              <option value="">请选择</option>
              <option value="offline">线下</option>
              <option value="online">线上</option>
            </select>
          </Field>
          <Field label="内部区域及地点（线下填小区/地标，线上填“线上”）" required error={fieldErrors.locationDetail}>
            <input type="text" value={form.locationDetail} onChange={(e) => set('locationDetail', e.target.value)} />
          </Field>
          <Field
            label="公开区域（仅用于群内发布，不填详细住址）"
            required
            error={fieldErrors.publicArea}
            hint={form.locationDetail && !form.publicArea ? '请从内部地点提炼大致区域，不要整段复制' : undefined}
            full
          >
            <input type="text" value={form.publicArea} onChange={(e) => set('publicArea', e.target.value)} />
          </Field>
          <Field label="内部时间（每周可上课日期和时间）" required error={fieldErrors.weeklySchedule} full>
            <textarea value={form.weeklySchedule} onChange={(e) => set('weeklySchedule', e.target.value)} />
          </Field>
          <Field label="公开时间（用于群内发布）" required error={fieldErrors.publicSchedule} full>
            <textarea value={form.publicSchedule} onChange={(e) => set('publicSchedule', e.target.value)} />
          </Field>
          <Field label="每周上课次数" required error={fieldErrors.sessionsPerWeek}>
            <input type="number" min={1} max={28} value={form.sessionsPerWeek} onChange={(e) => set('sessionsPerWeek', e.target.value)} />
          </Field>
          <Field label="每次时长（分钟）" required error={fieldErrors.sessionMinutes}>
            <input type="number" min={15} max={600} step={5} value={form.sessionMinutes} onChange={(e) => set('sessionMinutes', e.target.value)} />
          </Field>
          <Field label="预计开始时间（留空=协商）" error={fieldErrors.expectedStartDate}>
            <input type="date" value={form.expectedStartDate} onChange={(e) => set('expectedStartDate', e.target.value)} />
          </Field>
        </div>

        <h3>【薪资及老师要求】</h3>
        <div className="form-grid">
          <Field label="薪资（元/小时）" required error={fieldErrors.hourlyPayCents ?? fieldErrors.hourlyPay}>
            <input type="text" value={form.hourlyPay} onChange={(e) => set('hourlyPay', e.target.value)} placeholder="如 150 或 150.5" />
          </Field>
          <Field label="是否可以协商" required error={fieldErrors.payNegotiable}>
            <select value={form.payNegotiable} onChange={(e) => set('payNegotiable', e.target.value)}>
              <option value="">请选择</option>
              <option value="yes">可以协商</option>
              <option value="no">不可协商</option>
            </select>
          </Field>
          <Field label="老师性别要求" required error={fieldErrors.genderPreference}>
            <select value={form.genderPreference} onChange={(e) => set('genderPreference', e.target.value)}>
              <option value="">请选择</option>
              <option value="any">不限</option>
              <option value="male">男</option>
              <option value="female">女</option>
            </select>
          </Field>
          <Field label="对老师的其他要求（原始）" error={fieldErrors.teacherRequirements} full>
            <textarea value={form.teacherRequirements} onChange={(e) => set('teacherRequirements', e.target.value)} />
          </Field>
          <Field label="公开老师要求（用于群内发布，发送前自行检查）" error={fieldErrors.publicRequirements} full>
            <textarea value={form.publicRequirements} onChange={(e) => set('publicRequirements', e.target.value)} />
          </Field>
          <Field label="内部备注（不公开）" error={fieldErrors.notes} full>
            <textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} />
          </Field>
        </div>

        <div className="btn-row">
          <button type="submit" className="btn primary" disabled={saving}>
            {saving ? '保存中…' : editing ? '保存修改' : '保存并开始招募'}
          </button>
          <button type="button" className="btn" onClick={() => navigate(editing ? `/orders/${orderId}` : '/')}>取消</button>
        </div>
      </form>
    </>
  );
}

function str(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}
