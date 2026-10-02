import { useEffect, useRef, useState } from 'react';
import { ensureSession } from './api';
import { useHashRoute } from './components/ui';
import Dashboard from './pages/Dashboard';
import OrderForm from './pages/OrderForm';
import OrderDetail from './pages/OrderDetail';
import ApplicationForm from './pages/ApplicationForm';
import ApplicationDetail from './pages/ApplicationDetail';
import Maintenance from './pages/Maintenance';
import Icon, { type IconName } from './components/Icon';

export default function App() {
  const { path, navigate } = useHashRoute();
  const history = useRef<string[]>([]);
  const previousPath = useRef(path);
  useEffect(() => {
    if (previousPath.current !== path) { history.current.push(previousPath.current); previousPath.current = path; }
  }, [path]);
  const [dialog, setDialog] = useState<{ title: string; message: string; onConfirm?: () => void } | null>(null);
  const executeBack = () => {
    const prior = history.current.pop();
    const fallback = /^\/orders\/\d+\/(edit|apply)/.test(path) ? path.split('/').slice(0, 3).join('/') : /^\/applications\/\d+\/edit/.test(path) ? path.replace(/\/edit$/, '') : base.startsWith('/applications/') ? document.querySelector<HTMLAnchorElement>('a.btn[href^="#/orders/"]')?.getAttribute('href')?.slice(1) ?? '/' : '/';
    previousPath.current = prior ?? fallback; navigate(prior ?? fallback, { restoreScroll: true });
  };
  const goBack = () => {
    if (document.querySelector('form[data-dirty="true"]')) {
      setDialog({ title: '放弃未保存的修改？', message: '有未保存的资料，确定返回并放弃修改？', onConfirm: executeBack });
    } else executeBack();
  };
  useEffect(() => {
    const show = (event: Event) => setDialog((event as CustomEvent<{ title: string; message: string }>).detail);
    window.addEventListener('tam:dialog', show);
    return () => window.removeEventListener('tam:dialog', show);
  }, []);
  useEffect(() => {
    if (!dialog) return;
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setDialog(null); };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [dialog]);
  const [toast, setToast] = useState('');
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const show = (e: Event) => { setToast((e as CustomEvent<string>).detail); clearTimeout(timer); timer = setTimeout(() => setToast(''), 7000); };
    window.addEventListener('tam:notice', show);
    return () => { window.removeEventListener('tam:notice', show); clearTimeout(timer); };
  }, []);
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState('');

  useEffect(() => {
    ensureSession()
      .then(() => setReady(true))
      .catch((e) => setBootError((e as Error).message));
  }, []);

  const base = path.split('?')[0] ?? '/';
  const query = new URLSearchParams(path.includes('?') ? path.slice(path.indexOf('?') + 1) : '');
  const isHome = base === '/' || base === '';
  const isOrder = base.startsWith('/orders/');
  const isApplication = base === '/apply' || base.startsWith('/applications/');
  const section = base === '/maintenance' ? '数据管理' : isApplication ? '老师报名' : '订单管理';
  const title = isHome ? '订单工作台' : base === '/orders/new' ? '登记新的家教需求' : base.endsWith('/edit') ? '编辑资料' : base === '/apply' || base.endsWith('/apply') ? '录入老师报名' : base.startsWith('/applications/') ? '老师报名详情' : isOrder ? '家教订单详情' : '清理与备份';
  const description = isHome ? '从家长需求到正式合作，在这里掌握每一单的进展。' : base === '/maintenance' ? '管理数据备份、恢复与到期清理，让日常记录安心留存。' : isApplication || base.endsWith('/apply') ? '围绕当前订单管理老师资料、试课安排与费用结算。' : '记录家长需求，跟进候选老师与合作进度。';
  const navItems: { href: string; label: string; icon: IconName; active: boolean }[] = [
    { href: '#/', label: '订单列表', icon: 'grid', active: isHome || base.startsWith('/applications/') || (isOrder && base !== '/orders/new' && !base.endsWith('/apply')) },
    { href: '#/orders/new', label: '新建订单', icon: 'plus', active: base === '/orders/new' },
    { href: '#/apply', label: '老师报名', icon: 'users', active: base === '/apply' || base.endsWith('/apply') },
    { href: '#/maintenance', label: '清理与备份', icon: 'shield', active: base === '/maintenance' },
  ];

  let page: React.ReactNode;
  if (!ready) {
    page = <div className="empty">{bootError || '正在连接本机服务…'}</div>;
  } else if (base === '/' || base === '') {
    page = <Dashboard navigate={navigate} query={query} />;
  } else if (base === '/orders/new') {
    page = <OrderForm key={base} navigate={navigate} />;
  } else if (/^\/orders\/\d+\/edit$/.test(base)) {
    page = <OrderForm key={base} navigate={navigate} orderId={Number(base.split('/')[2])} />;
  } else if (/^\/orders\/\d+$/.test(base)) {
    page = <OrderDetail key={base} navigate={navigate} orderId={Number(base.split('/')[2])} />;
  } else if (/^\/orders\/\d+\/apply$/.test(base)) {
    page = <ApplicationForm key={base} navigate={navigate} orderId={Number(base.split('/')[2])} autoPaste={query.get('paste') === '1'} />;
  } else if (base === '/apply') {
    page = <ApplicationForm key={base} navigate={navigate} autoPaste={query.get('paste') === '1'} />;
  } else if (/^\/applications\/\d+\/edit$/.test(base)) {
    page = <ApplicationForm key={base} navigate={navigate} applicationId={Number(base.split('/')[2])} />;
  } else if (/^\/applications\/\d+$/.test(base)) {
    page = <ApplicationDetail key={base} navigate={navigate} applicationId={Number(base.split('/')[2])} />;
  } else if (base === '/maintenance') {
    page = <Maintenance navigate={navigate} />;
  } else {
    page = <div className="empty">页面不存在</div>;
  }

  return (
    <div className="app-shell">
      {dialog && <div className="modal-backdrop" onClick={event => { if (event.target === event.currentTarget) setDialog(null); }}>
        <div className="modal-panel" role="dialog" aria-modal="true" aria-label={dialog.title}>
          <h3 style={{ marginTop: 0 }}>{dialog.title}</h3>
          <p style={{ whiteSpace: 'pre-line' }}>{dialog.message}</p>
          <div className="btn-row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
            {dialog.onConfirm && <button type="button" className="btn" autoFocus onClick={() => setDialog(null)}>取消</button>}
            <button type="button" className="btn primary" autoFocus={!dialog.onConfirm} onClick={() => { const action = dialog.onConfirm; setDialog(null); action?.(); }}>{dialog.onConfirm ? '确认放弃' : '知道了'}</button>
          </div>
        </div>
      </div>}
      <a className="skip-link" href="#main-content" onClick={(e) => { e.preventDefault(); document.getElementById('main-content')?.focus(); }}>跳到主要内容</a>
      <aside className="sidebar">
        <a className="brand" href="#/" aria-label="家教中介管理系统首页">
          <span className="brand-mark"><Icon name="book" size={23} /></span>
          <span>家教中介<span className="brand-subtitle">业务管理工作台</span></span>
        </a>
        <div className="nav-caption">工作空间</div>
        <nav aria-label="主导航">
          {navItems.map((item) => <a key={item.href} href={item.href} className={item.active ? 'active' : ''} aria-current={item.active ? 'page' : undefined}><Icon name={item.icon} /><span>{item.label}</span>{item.active && <span className="nav-dot" />}</a>)}
        </nav>
      </aside>
      <div className="workspace">
      <header className="topbar">
        <div className="breadcrumb"><span>工作空间</span><span className="breadcrumb-separator">/</span><strong>{section}</strong></div>
        <div className="topbar-meta"><span className="today">{new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'long', timeZone: 'Asia/Hong_Kong' }).format(new Date())}</span></div>
      </header>
      <main className={`container ${isHome ? 'dashboard-page' : 'detail-page'} ${/^\/applications\/\d+$/.test(base) ? 'application-page' : /^\/orders\/\d+$/.test(base) ? 'order-detail-page' : ''}`} id="main-content" tabIndex={-1}>
        <div className="page-heading"><div><button className="btn small back-button" onClick={goBack}>← 返回上一页</button><div className="eyebrow">{section}</div><h1>{title}</h1><p>{description}</p></div><div className="page-heading-mark"><Icon name={isHome ? 'grid' : base === '/maintenance' ? 'shield' : 'file'} size={26} /></div></div>
        {toast && <div className="alert ok success-toast" role="status"><span>{toast}</span><button type="button" className="toast-close" aria-label="关闭提示" title="关闭提示" onClick={() => setToast('')}><svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg></button></div>}
        {page}
        <footer className="page-footer"><span>家教中介管理系统</span><span>用清晰的记录，连接每一次教学合作</span></footer>
      </main>
      </div>
    </div>
  );
}
