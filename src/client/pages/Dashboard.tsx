// 首页：统计 + 订单列表（搜索/筛选/分页）+ 新建/粘贴/模板复制/招募导出入口。
import { useCallback, useEffect, useState } from 'react';
import { api, downloadFile, fetchText } from '../api';
import { CopyButton, Pagination, StatusBadge, TextBlock, TimeText, ErrorAlert } from '../components/ui';
import { ORDER_STATUS_LABELS } from '../../shared/types';
import { centsToYuanString } from '../../shared/money';
import type { OrderRecord } from '../../shared/types';

interface ListResponse {
  items: OrderRecord[];
  total: number;
  page: number;
  pageSize: number;
}

interface DashboardData {
  statusCounts: Record<string, number>;
  pendingRefund: { count: number; cents: number };
  pendingSupplement: { count: number; cents: number };
  totals: { orders: number; applications: number };
}

export default function Dashboard({ navigate, query }: { navigate: (to: string) => void; query: URLSearchParams }) {
  const [data, setData] = useState<ListResponse | null>(null);
  const [dash, setDash] = useState<DashboardData | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [q, setQ] = useState(query.get('q') ?? '');
  const [status, setStatus] = useState(query.get('status') ?? '');
  const [subject, setSubject] = useState(query.get('subject') ?? '');
  const [grade, setGrade] = useState(query.get('grade') ?? '');
  const [page, setPage] = useState(Number(query.get('page') ?? 1));
  const [recruitingPreview, setRecruitingPreview] = useState<string | null>(null);
  const [templates, setTemplates] = useState<{ parent: string | null; teacher: string | null }>({ parent: null, teacher: null });

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: '20' });
      if (q) params.set('q', q);
      if (status) params.set('status', status);
      if (subject) params.set('subject', subject);
      if (grade) params.set('grade', grade);
      setData(await api.get<ListResponse>(`/api/orders?${params.toString()}`));
      setDash(await api.get<DashboardData>('/api/dashboard'));
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [page, q, status, subject, grade]);

  useEffect(() => {
    void load();
  }, [load]);

  const showRecruitingExport = async () => {
    try {
      setRecruitingPreview(await fetchText('/api/exports/recruiting'));
    } catch (e) {
      setError(e);
    }
  };

  const loadTemplate = async (name: 'parent' | 'teacher') => {
    try {
      const t = await api.get<{ name: string; text: string }>(`/api/templates/${name}`);
      setTemplates((prev) => ({ ...prev, [name]: t.text }));
    } catch (e) {
      setError(e);
    }
  };

  return (
    <>
      {dash && (
        <div className="stat-grid">
          <div className="stat"><div className="num">{dash.statusCounts.recruiting ?? 0}</div><div className="label">招募中</div></div>
          <div className="stat"><div className="num">{dash.statusCounts.reviewing ?? 0}</div><div className="label">家长挑选中</div></div>
          <div className="stat"><div className="num">{(dash.statusCounts.awaiting_trial ?? 0) + (dash.statusCounts.trialing ?? 0)}</div><div className="label">待试课/试课中</div></div>
          <div className="stat warn"><div className="num">{dash.pendingRefund.count}</div><div className="label">待退款（{(dash.pendingRefund.cents / 100).toFixed(2)}元）</div></div>
          <div className="stat"><div className="num">{dash.pendingSupplement.count}</div><div className="label">待补款（{(dash.pendingSupplement.cents / 100).toFixed(2)}元）</div></div>
        </div>
      )}

      <div className="card">
        <h2>订单</h2>
        <div className="btn-row" style={{ marginBottom: 12 }}>
          <button type="button" className="btn primary" onClick={() => navigate('/orders/new')}>新建订单</button>
          <button type="button" className="btn" onClick={() => navigate('/orders/new?paste=1')}>粘贴家长模板建单</button>
          <button type="button" className="btn" onClick={showRecruitingExport}>导出全部招募中文字</button>
          <a className="btn" href="#" onClick={(e) => { e.preventDefault(); void downloadFile('/api/exports/recruiting', 'recruiting.txt'); }}>
            下载招募TXT
          </a>
          <button type="button" className="btn" onClick={() => void loadTemplate('parent')}>家长模板</button>
          <button type="button" className="btn" onClick={() => void loadTemplate('teacher')}>老师模板</button>
        </div>

        <div className="filter-bar">
          <input placeholder="搜索编号/称呼/微信/电话" value={q} onChange={(e) => { setPage(1); setQ(e.target.value); }} style={{ width: 220 }} />
          <select value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }}>
            <option value="">全部状态</option>
            {Object.entries(ORDER_STATUS_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          <input placeholder="科目筛选" value={subject} onChange={(e) => { setPage(1); setSubject(e.target.value); }} style={{ width: 110 }} />
          <input placeholder="年级筛选" value={grade} onChange={(e) => { setPage(1); setGrade(e.target.value); }} style={{ width: 110 }} />
        </div>

        <ErrorAlert error={error} />

        {data && data.items.length === 0 && <div className="empty">暂无订单。点击“新建订单”或“粘贴家长模板建单”开始。</div>}

        {data && data.items.length > 0 && (
          <table className="list">
            <thead>
              <tr>
                <th>编号</th>
                <th>状态</th>
                <th>家长称呼</th>
                <th>年级/科目</th>
                <th>方式/区域</th>
                <th>薪资</th>
                <th>报名</th>
                <th>最近修改</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((o) => (
                <tr key={o.id}>
                  <td><a href={`#/orders/${o.id}`}>{o.orderNo}</a></td>
                  <td><StatusBadge status={o.status} /></td>
                  <td>{o.parentName}</td>
                  <td>
                    {o.childGrade}
                    <br />
                    <span style={{ color: 'var(--muted)' }}>{o.subjects}</span>
                  </td>
                  <td>
                    {o.teachingMode === 'online' ? '线上' : '线下'}
                    <br />
                    <span style={{ color: 'var(--muted)' }}>{o.publicArea}</span>
                  </td>
                  <td>{centsToYuanString(o.hourlyPayCents)}元/时{o.payNegotiable ? '（可协商）' : ''}</td>
                  <td><a href={`#/orders/${o.id}`}>查看/报名</a></td>
                  <td><TimeText iso={o.updatedAt} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      </div>

      {recruitingPreview !== null && (
        <div className="card">
          <h2>全部招募中导出预览</h2>
          <div className="alert info">导出不受筛选/分页影响，包含全部“招募中”订单。复制后手动粘贴到微信群；不含家长联系方式、详细地址、内部备注与费用。</div>
          <TextBlock text={recruitingPreview} maxHeight={400} />
          <div className="btn-row" style={{ marginTop: 10 }}>
            <CopyButton text={recruitingPreview} label="复制全部招募文字" />
            <button type="button" className="btn" onClick={() => void downloadFile('/api/exports/recruiting', 'recruiting.txt')}>下载TXT</button>
            <button type="button" className="btn" onClick={() => setRecruitingPreview(null)}>关闭</button>
          </div>
        </div>
      )}

      {templates.parent && (
        <div className="card">
          <h2>家长需求模板</h2>
          <div className="alert info">把模板发给家长填写；收到后用“粘贴家长模板建单”自动录入。</div>
          <TextBlock text={templates.parent} maxHeight={360} />
          <div className="btn-row" style={{ marginTop: 10 }}>
            <CopyButton text={templates.parent} label="复制模板" />
            <button type="button" className="btn" onClick={() => setTemplates((t) => ({ ...t, parent: null }))}>关闭</button>
          </div>
        </div>
      )}
      {templates.teacher && (
        <div className="card">
          <h2>大学生报名模板</h2>
          <div className="alert info">老师按订单编号报名；收到后用“粘贴老师报名”自动录入。</div>
          <TextBlock text={templates.teacher} maxHeight={360} />
          <div className="btn-row" style={{ marginTop: 10 }}>
            <CopyButton text={templates.teacher} label="复制模板" />
            <button type="button" className="btn" onClick={() => setTemplates((t) => ({ ...t, teacher: null }))}>关闭</button>
          </div>
        </div>
      )}
    </>
  );
}
