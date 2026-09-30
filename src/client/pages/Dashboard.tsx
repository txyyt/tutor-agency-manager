// 首页：统计 + 订单列表（搜索/筛选/分页）+ 新建/粘贴/招募导出入口。
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, downloadFile, fetchText } from '../api';
import { CopyButton, Pagination, StatusBadge, TextBlock, TimeText, ErrorAlert } from '../components/ui';
import { ORDER_STATUS_LABELS } from '../../shared/types';
import { centsToYuanString } from '../../shared/money';
import type { OrderTask } from '../../shared/orderTasks';
import type { OrderRecord } from '../../shared/types';
import Icon from '../components/Icon';

interface ListResponse {
  items: Array<OrderRecord & { tasks: OrderTask[] }>;
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
  const [needsAction, setNeedsAction] = useState(false);
  const [sort, setSort] = useState('updated-desc');
  const [tasksFirst, setTasksFirst] = useState(true);
  const [page, setPage] = useState(Number(query.get('page') ?? 1));
  const [recruitingPreview, setRecruitingPreview] = useState<string | null>(null);
  const exportPreviewRef = useRef<HTMLDivElement>(null);
  const [exportScrollRequest, setExportScrollRequest] = useState(0);
  useEffect(() => {
    if (exportScrollRequest > 0 && recruitingPreview !== null) {
      exportPreviewRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, [exportScrollRequest, recruitingPreview]);

  const load = useCallback(async () => {
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: '20', sort, tasksFirst: tasksFirst ? '1' : '0' });
      if (needsAction) params.set('needsAction', '1');
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
  }, [page, q, status, subject, grade, needsAction, sort, tasksFirst]);

  useEffect(() => {
    void load();
  }, [load]);

  const showRecruitingExport = async () => {
    try {
      setRecruitingPreview(await fetchText('/api/exports/recruiting'));
      setExportScrollRequest(n => n + 1);
    } catch (e) {
      setError(e);
    }
  };

  return (
    <>
      {dash && (
        <div className="stat-grid">
          <div className="stat"><div className="stat-top"><span className="label">招募中</span><span className="stat-icon green"><Icon name="file" /></span></div><div className="num">{dash.statusCounts.recruiting ?? 0}<span className="stat-unit">单</span></div><div className="stat-foot">等待合适的老师报名</div></div>
          <div className="stat"><div className="stat-top"><span className="label">待结算</span><span className="stat-icon blue"><Icon name="users" /></span></div><div className="num">{dash.statusCounts.reviewing ?? 0}<span className="stat-unit">单</span></div><div className="stat-foot">合作已确认，等待费用结清</div></div>
          <div className="stat"><div className="stat-top"><span className="label">待试课/试课中</span><span className="stat-icon purple"><Icon name="clock" /></span></div><div className="num">{(dash.statusCounts.awaiting_trial ?? 0) + (dash.statusCounts.trialing ?? 0)}<span className="stat-unit">单</span></div><div className="stat-foot">关注试课安排与反馈</div></div>
          <div className="stat warn"><div className="stat-top"><span className="label">待退款</span><span className="stat-icon orange"><Icon name="wallet" /></span></div><div className="num">{dash.pendingRefund.count}<span className="stat-unit">笔</span></div><div className="stat-foot">待退金额 ¥{(dash.pendingRefund.cents / 100).toFixed(2)}</div></div>
          <div className="stat"><div className="stat-top"><span className="label">待收中介费</span><span className="stat-icon green"><Icon name="check" /></span></div><div className="num">{dash.pendingSupplement.count}<span className="stat-unit">笔</span></div><div className="stat-foot">待收金额 ¥{(dash.pendingSupplement.cents / 100).toFixed(2)}</div></div>
        </div>
      )}

      <div className="card order-board">
        <div className="board-heading"><div><h2>订单</h2><p>集中查看需求，跟进每一个合作机会。</p></div><span className="record-count">{data ? `${data.total} 条记录` : '加载中…'}</span></div>
        <div className="btn-row board-actions">
          <button type="button" className="btn primary" onClick={() => navigate('/orders/new')}><Icon name="plus" size={17} />新建订单</button>
          <button type="button" className="btn" onClick={showRecruitingExport}>导出全部招募中文字</button>
          <a className="btn" href="#" onClick={(e) => { e.preventDefault(); void downloadFile('/api/exports/recruiting', 'recruiting.txt'); }}>
            下载招募TXT
          </a>
        </div>

        <div className="filter-bar">
          <input placeholder="搜索编号/称呼/微信/电话" value={q} onChange={(e) => { setPage(1); setQ(e.target.value); }} style={{ width: 220 }} />
          <select value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }}>
            <option value="">全部状态</option>
            {Object.entries(ORDER_STATUS_LABELS).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
<label className="inline-flex"><input type="checkbox" checked={needsAction} onChange={e => { setNeedsAction(e.target.checked); setPage(1); }} />只看需要处理</label>
          <select aria-label="订单排序" value={sort} onChange={e => { setSort(e.target.value); setPage(1); }}>
            <option value="updated-desc">最近修改：新到旧</option>
            <option value="updated-asc">最近修改：旧到新</option>
            <option value="number-desc">订单编号：大到小</option>
            <option value="number-asc">订单编号：小到大</option>
          </select>
          <label className="inline-flex"><input type="checkbox" checked={tasksFirst} onChange={e => { setTasksFirst(e.target.checked); setPage(1); }} />待办优先</label>
          <input placeholder="科目筛选" value={subject} onChange={(e) => { setPage(1); setSubject(e.target.value); }} style={{ width: 110 }} />
          <input placeholder="年级筛选" value={grade} onChange={(e) => { setPage(1); setGrade(e.target.value); }} style={{ width: 110 }} />
        </div>

        <ErrorAlert error={error} />

        {data && data.items.length === 0 && <div className="empty">暂无订单。点击“新建订单”或“粘贴家长模板建单”开始。</div>}

        {data && data.items.length > 0 && (
          <div className="table-scroll"><table className="list">
            <thead>
              <tr>
                <th>编号</th>
                <th>状态</th>
                <th>家长称呼</th>
                <th>年级/科目</th>
                <th>方式/区域</th>
                <th>薪资</th>
                <th>待办提示</th>
                <th className="table-action">操作</th>
                <th>最近修改</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((o) => (
                <tr key={o.id} className={o.tasks?.length ? 'needs-action' : ''}>
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
                  <td><div className="task-list">{o.tasks?.map(t => <span key={t.kind} className={`task-tag task-${t.kind}`}>{t.label}</span>)}{!o.tasks?.length && <span className="hint">—</span>}</div></td>
                  <td className="table-action"><a href={`#/orders/${o.id}`}>查看/报名</a></td>
                  <td><TimeText iso={o.updatedAt} /></td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
        {data && <Pagination page={data.page} pageSize={data.pageSize} total={data.total} onPage={setPage} />}
      </div>

      {recruitingPreview !== null && (
        <div className="card" ref={exportPreviewRef}>
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

    </>
  );
}
