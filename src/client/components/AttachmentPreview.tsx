import { useEffect, useState } from 'react';
import { downloadFile, ensureSession } from '../api';
export default function AttachmentPreview({ path, name, mime, onClose }: { path: string; name: string; mime: string; onClose: () => void }) {
  const [url, setUrl] = useState(''); const [error, setError] = useState('');
  useEffect(() => {
    let alive = true; let objectUrl = ''; const controller = new AbortController();
    void (async () => {
      try {
        const session = await ensureSession();
        const res = await fetch(path, { signal: controller.signal, headers: { 'X-CSRF-Token': session.csrfToken, 'X-Data-Epoch': String(session.dataEpoch) } });
        if (!res.ok) { const data = await res.json(); throw new Error(data.message ?? '附件预览失败'); }
        objectUrl = URL.createObjectURL(await res.blob()); if (alive) setUrl(objectUrl);
      } catch (e) { if (alive) setError((e as Error).message); }
    })();
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', escape);
    return () => { alive = false; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl); window.removeEventListener('keydown', escape); };
  }, [path, onClose]);
  return <div className="modal-backdrop"><div className="modal-panel attachment-preview" role="dialog" aria-modal="true" aria-label="附件预览">
    <h3>附件预览：{name}</h3>{error ? <div role="alert" className="alert error">{error}</div> : !url ? <p>正在读取附件…</p> : mime === 'application/pdf' ? <iframe src={url} title="PDF附件预览" /> : <img src={url} alt={name} onError={() => setError('图片无法预览，请下载原文件检查')} />}
    {mime === 'application/pdf' && <p className="hint">如果浏览器未启用PDF预览，可打开原文件或下载查看。</p>}
    <div className="btn-row">{url && <a className="btn" href={url} target="_blank" rel="noreferrer">打开原文件</a>}<button className="btn" onClick={() => { void downloadFile(path, name).catch(e => setError((e as Error).message)); }}>下载原文件</button><button className="btn" onClick={onClose}>关闭</button></div>
  </div></div>;
}
