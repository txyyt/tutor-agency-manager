import { useEffect, useState } from 'react';
import { ensureSession } from './api';
import { useHashRoute } from './components/ui';
import Dashboard from './pages/Dashboard';
import OrderForm from './pages/OrderForm';
import OrderDetail from './pages/OrderDetail';
import ApplicationForm from './pages/ApplicationForm';
import ApplicationDetail from './pages/ApplicationDetail';
import Maintenance from './pages/Maintenance';

export default function App() {
  const { path, navigate } = useHashRoute();
  const [ready, setReady] = useState(false);
  const [bootError, setBootError] = useState('');

  useEffect(() => {
    ensureSession()
      .then(() => setReady(true))
      .catch((e) => setBootError((e as Error).message));
  }, []);

  const base = path.split('?')[0] ?? '/';
  const query = new URLSearchParams(path.includes('?') ? path.slice(path.indexOf('?') + 1) : '');

  let page: React.ReactNode;
  if (!ready) {
    page = <div className="empty">{bootError || '正在连接本机服务…'}</div>;
  } else if (base === '/' || base === '') {
    page = <Dashboard navigate={navigate} query={query} />;
  } else if (base === '/orders/new') {
    page = <OrderForm navigate={navigate} />;
  } else if (/^\/orders\/\d+\/edit$/.test(base)) {
    page = <OrderForm navigate={navigate} orderId={Number(base.split('/')[2])} />;
  } else if (/^\/orders\/\d+$/.test(base)) {
    page = <OrderDetail navigate={navigate} orderId={Number(base.split('/')[2])} />;
  } else if (/^\/orders\/\d+\/apply$/.test(base)) {
    page = <ApplicationForm navigate={navigate} orderId={Number(base.split('/')[2])} autoPaste={query.get('paste') === '1'} />;
  } else if (base === '/apply') {
    page = <ApplicationForm navigate={navigate} autoPaste={query.get('paste') === '1'} />;
  } else if (/^\/applications\/\d+\/edit$/.test(base)) {
    page = <ApplicationForm key={base} navigate={navigate} applicationId={Number(base.split('/')[2])} />;
  } else if (/^\/applications\/\d+$/.test(base)) {
    page = <ApplicationDetail navigate={navigate} applicationId={Number(base.split('/')[2])} />;
  } else if (base === '/maintenance') {
    page = <Maintenance navigate={navigate} />;
  } else {
    page = <div className="empty">页面不存在</div>;
  }

  return (
    <>
      <header className="topbar">
        <span className="brand">家教中介管理系统</span>
        <nav>
          <a href="#/" className={base === '/' || base === '' ? 'active' : ''}>订单列表</a>
          <a href="#/orders/new" className={base === '/orders/new' ? 'active' : ''}>新建订单</a>
          <a href="#/apply" className={base === '/apply' ? 'active' : ''}>粘贴老师报名</a>
          <a href="#/maintenance" className={base === '/maintenance' ? 'active' : ''}>清理与备份</a>
        </nav>
        <span className="spacer" />
        <span className="meta">本机服务 · 仅127.0.0.1</span>
      </header>
      <main className="container">{page}</main>
    </>
  );
}
