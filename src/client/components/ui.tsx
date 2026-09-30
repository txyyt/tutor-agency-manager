// 基础UI组件：字段、徽章、复制按钮、确认按钮、金额显示、分页、粘贴解析框。
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ORDER_STATUS_LABELS, APPLICATION_STATUS_LABELS, type OrderStatus, type ApplicationStatus } from '../../shared/types';
import { formatHkDateTimeCn } from '../../shared/datetime';
import { centsToYuanString } from '../../shared/money';

export function StatusBadge({ status }: { status: OrderStatus | ApplicationStatus }) {
  const label = (ORDER_STATUS_LABELS as Record<string, string>)[status] ?? (APPLICATION_STATUS_LABELS as Record<string, string>)[status] ?? status;
  return <span className={`badge b-${status}`}>{label}</span>;
}

export function Field(props: {
  label: string;
  required?: boolean;
  error?: string;
  hint?: string;
  children: ReactNode;
  full?: boolean;
}) {
  return (
    <div className={`field ${props.error ? 'has-error' : ''} ${props.full ? 'full' : ''}`}>
      <label>
        {props.label}
        {props.required && <span className="req">*</span>}
      </label>
      {props.children}
      {props.error && <div className="err">{props.error}</div>}
      {!props.error && props.hint && <div className="hint">{props.hint}</div>}
    </div>
  );
}

export function MoneyText({ cents, suffix }: { cents: number | null | undefined; suffix?: string }) {
  if (cents === null || cents === undefined) return <span>未填写</span>;
  return (
    <span>
      {centsToYuanString(cents)}
      {suffix ?? '元'}
    </span>
  );
}

export function CopyButton({ text, label = '复制', small }: { text: string; label?: string; small?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const doCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setFailed(false);
    } catch {
      // 剪贴板API失败：回退到选中文本让用户手动Ctrl+C
      setFailed(true);
      setCopied(false);
    }
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <span className="inline-flex">
      <button type="button" className={`btn ${small ? 'small' : ''}`} onClick={doCopy}>
        {label}
      </button>
      {copied && <span className="copied-note">已复制</span>}
      {failed && <span className="copied-note" style={{ color: 'var(--warn)' }}>复制失败，请手动选中文本复制</span>}
    </span>
  );
}

export function ConfirmButton(props: {
  label: string;
  confirmTitle: string;
  confirmBody: ReactNode;
  onConfirm: () => Promise<void> | void;
  className?: string;
  disabled?: boolean;
  confirmLabel?: string;
  small?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <>
      <button
        type="button"
        className={props.className ?? 'btn'}
        disabled={props.disabled}
        onClick={() => {
          setError('');
          setOpen(true);
        }}
      >
        {props.label}
      </button>
      {open && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget && !busy) setOpen(false);
          }}
        >
          <div className="modal-panel" role="dialog" aria-modal="true" aria-label={props.confirmTitle}>
            <h3 style={{ marginTop: 0 }}>{props.confirmTitle}</h3>
            <div style={{ fontSize: 13 }}>{props.confirmBody}</div>
            {error && <div className="alert error" style={{ marginTop: 10 }}>{error}</div>}
            <div className="btn-row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
              <button type="button" className="btn" disabled={busy} onClick={() => setOpen(false)}>
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setError('');
                  try {
                    await props.onConfirm();
                    setOpen(false);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? '处理中…' : (props.confirmLabel ?? '确认')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

export function TimeText({ iso }: { iso: string | null | undefined }) {
  if (!iso) return <span>—</span>;
  return <span>{formatHkDateTimeCn(iso)}</span>;
}

export function Pagination(props: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(props.total / props.pageSize));
  return (
    <div className="pagination">
      <button type="button" className="btn small" disabled={props.page <= 1} onClick={() => props.onPage(props.page - 1)}>
        上一页
      </button>
      <span>
        第 {props.page} / {pages} 页，共 {props.total} 条
      </span>
      <button type="button" className="btn small" disabled={props.page >= pages} onClick={() => props.onPage(props.page + 1)}>
        下一页
      </button>
    </div>
  );
}

export function ErrorAlert({ error }: { error: unknown }) {
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => {
      const field = document.querySelector<HTMLElement>('.has-error');
      field?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      field?.querySelector<HTMLElement>('input,select,textarea')?.focus({ preventScroll: true });
    }, 100);
    return () => clearTimeout(timer);
  }, [error]);
  if (!error) return null;
  const e = error as { message?: string; fieldErrors?: Record<string, string> };
  return (
    <div className="alert error error-toast" role="alert">
      {e.message ?? String(error)}
      {e.fieldErrors && (
        <pre>
          {Object.entries(e.fieldErrors)
            .map(([k, v]) => `${k}：${v}`)
            .join('\n')}
        </pre>
      )}
    </div>
  );
}

/** 自动选中文本的只读文本块（剪贴板失败时的兜底） */
export function TextBlock({ text, maxHeight }: { text: string; maxHeight?: number }) {
  const ref = useRef<HTMLPreElement>(null);
  return (
    <pre className="plain editable" ref={ref} style={maxHeight ? { maxHeight, overflow: 'auto' } : undefined}>
      {text}
    </pre>
  );
}

export function useHashRoute(): { path: string; navigate: (to: string) => void } {
  const [hash, setHash] = useState(() => window.location.hash.slice(1) || '/');
  useEffect(() => {
    const onChange = () => setHash(window.location.hash.slice(1) || '/');
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return {
    path: hash,
    navigate: (to: string) => {
      window.location.hash = to;
      window.scrollTo(0, 0);
    },
  };
}

export function parseQuery(path: string): URLSearchParams {
  const idx = path.indexOf('?');
  return new URLSearchParams(idx >= 0 ? path.slice(idx + 1) : '');
}
