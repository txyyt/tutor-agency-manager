import { useEffect, useState } from 'react';

/** 快速请求不闪烁；慢请求展示占位，不遮挡导航和窗口按钮。 */
export default function LoadingState({ label = '正在加载资料', compact = false }: { label?: string; compact?: boolean }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => { const timer = setTimeout(() => setVisible(true), 180); return () => clearTimeout(timer); }, []);
  return <div className={`loading-state${compact ? ' compact' : ''}${visible ? ' visible' : ''}`} role="status" aria-label={label} aria-busy="true">
    <div className="loading-caption"><span className="loading-spinner" aria-hidden="true" /><span>{label}…</span></div>
    {!compact && <div className="loading-skeleton" aria-hidden="true"><span /><span /><span /></div>}
  </div>;
}
