// 清理与备份维护页：90天清理预览/执行、备份列表/导出/设置、恢复上传/校验/确认、调度状态。
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, downloadFile, refreshSession } from '../api';
import { ConfirmButton, ErrorAlert, Field, TextBlock, TimeText } from '../components/ui';
import { formatHkDateTimeCn } from '../../shared/datetime';
import type { BackupIndexEntry } from '../../shared/types';
import LoadingState from '../components/LoadingState';

interface CleanupPreviewData {
  cutoffIso: string;
  candidates: Array<{ type: string; id: number; no: string; reason: string; updatedAt: string; attachmentCount: number }>;
  protectedItems: Array<{ type: string; id: number; no: string; reason: string; updatedAt: string }>;
  hasCandidates: boolean;
}

interface BackupsResponse {
  entries: BackupIndexEntry[];
  settings: {
    autoBackupDir: string | null;
    dailyKeepCount: number;
    dailyBackupTime: string;
    importMaxUploadBytes: number;
    importMaxTotalBytes: number;
    importMaxEntries: number;
  };
  daily: { lastSuccessDateHk: string | null; lastSuccessAtUtc: string | null; lastError: string | null };
  paths: { rootDir: string; lifecycleDir: string; dailyDir: string; safetyDir: string; manualDir: string };
  migration: { pendingCleanupCount: number };
  scheduler: {
    dailyBackup: { lastSuccessDateHk: string | null; lastSuccessAtUtc: string | null; lastError: string | null; lastAttemptAtUtc: string | null; dueNow: boolean };
    cleanup: { lastRunAtUtc: string | null; lastResult: string | null; intervalMs: number };
  };
}

interface RestorePreview {
  createdAtUtc: string;
  schemaVersion: number;
  migrated: boolean;
  counts: { orders: number; applications: number; attachments: number };
  warnings: string[];
}

const KIND_LABELS: Record<string, string> = {
  daily: '定时备份',
  startup: '启动备份',
  shutdown: '关闭备份',
  manual: '手动',
  'pre-restore': '恢复前安全备份',
  'pre-delete': '删除前安全备份',
  'pre-cleanup': '清理前安全备份',
};

export default function Maintenance({ navigate }: { navigate: (to: string) => void }) {
  const [preview, setPreview] = useState<CleanupPreviewData | null>(null);
  const [backups, setBackups] = useState<BackupsResponse | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [openingFolder, setOpeningFolder] = useState(false);
  const [choosingFolder, setChoosingFolder] = useState(false);
  const [cleanupResult, setCleanupResult] = useState<string | null>(null);
  const [settings, setSettings] = useState({ autoBackupDir: '', dailyKeepCount: '5', dailyBackupTime: '20:00', importMaxUploadMB: '1024', importMaxTotalMB: '2048' });
  const [restoreToken, setRestoreToken] = useState<string | null>(null);
  const [restorePreview, setRestorePreview] = useState<RestorePreview | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const restoreFileRef = useRef<HTMLInputElement>(null);
  const [restoreFileName, setRestoreFileName] = useState('');
  const [selectedBackupId, setSelectedBackupId] = useState('');
  const restorePanelRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      setPreview(await api.get<CleanupPreviewData>('/api/cleanup/preview'));
      const b = await api.get<BackupsResponse>('/api/backups');
      // 按时间倒序；同一毫秒生成时，后登记的备份排在前面。
      b.entries = [...b.entries].reverse().sort((a, b) => b.createdAtUtc.localeCompare(a.createdAtUtc));
      setBackups(b);
      setSettings({
        autoBackupDir: b.settings.autoBackupDir ?? '',
        dailyKeepCount: String(b.settings.dailyKeepCount),
        dailyBackupTime: b.settings.dailyBackupTime,
        importMaxUploadMB: String(Math.round(b.settings.importMaxUploadBytes / 1024 / 1024)),
        importMaxTotalMB: String(Math.round(b.settings.importMaxTotalBytes / 1024 / 1024)),
      });
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runCleanup = async () => {
    try {
      const r = await api.post<{ deletedOrders: number; deletedApplications: number; deletedAttachments: number; failedAttachmentDeletes: number; backupId: string | null; skippedReason: string | null }>('/api/cleanup/run');
      setCleanupResult(
        r.skippedReason ??
          `已删除 ${r.deletedOrders} 个整单、${r.deletedApplications} 条报名、${r.deletedAttachments} 个附件` +
            (r.failedAttachmentDeletes ? `（${r.failedAttachmentDeletes} 个附件删除失败，将在下次重试）` : '') +
            (r.backupId ? `。清理前备份：${r.backupId}` : '（无候选，未生成备份）'),
      );
      await load();
    } catch (e) {
      setError(e);
    }
  };

  const createBackup = async () => {
    if (backingUp || savingSettings) return;
    setBackingUp(true);
    setError(null);
    window.dispatchEvent(new CustomEvent('tam:notice', { detail: '' }));
    try {
      await api.post('/api/backups', { kind: 'manual' });
      window.dispatchEvent(new CustomEvent('tam:notice', { detail: '手动备份完成' }));
      await load();
    } catch (e) {
      setError(e);
    } finally {
      setBackingUp(false);
    }
  };

  const saveSettings = async (confirmMigration = false) => {
    if (savingSettings || backingUp) return;
    setSavingSettings(true);
    setError(null);
    window.dispatchEvent(new CustomEvent('tam:notice', { detail: '' }));
    try {
      const result = await api.patch<BackupsResponse & { migrationResult: { migratedCount: number; skippedMissingCount: number; warnings: string[] } }>('/api/backups/settings', {
        autoBackupDir: settings.autoBackupDir.trim() === '' ? null : settings.autoBackupDir.trim(),
        confirmMigration,
        dailyKeepCount: Number(settings.dailyKeepCount),
        dailyBackupTime: settings.dailyBackupTime,
        importMaxUploadBytes: Number(settings.importMaxUploadMB) * 1024 * 1024,
        importMaxTotalBytes: Number(settings.importMaxTotalMB) * 1024 * 1024,
      });
      const skipped = result.migrationResult.skippedMissingCount;
      window.dispatchEvent(new CustomEvent('tam:notice', { detail: (result.migrationResult.migratedCount ? `设置已保存，已迁移${result.migrationResult.migratedCount}份备份` : '设置已保存') + (skipped ? `，跳过${skipped}条文件已不存在的备份记录` : '') }));
      await load();
      if (result.migrationResult.warnings.length) window.dispatchEvent(new CustomEvent('tam:dialog', { detail: {
        title: result.migration.pendingCleanupCount ? '目录已切换，部分旧文件或空目录未清理' : '设置已保存，部分清理未完成',
        message: result.migrationResult.warnings.join('\n') + (result.migration.pendingCleanupCount ? '\n请点击“重试清理旧目录”。' : '\n请检查文件权限，后续备份会继续执行轮换。'),
      } }));
    } catch (e) {
      setError(e);
    } finally {
      setSavingSettings(false);
    }
  };

  const chooseBackupFolder = async () => {
    if (!window.tutorDesktop || choosingFolder) return;
    setChoosingFolder(true);
    setError(null);
    try {
      const directory = await window.tutorDesktop.chooseBackupFolder();
      if (directory !== null) setSettings(s => ({ ...s, autoBackupDir: directory }));
    } catch (e) {
      setError(e);
    } finally {
      setChoosingFolder(false);
    }
  };

  const openBackupFolder = async () => {
    if (!window.tutorDesktop || openingFolder) return;
    setOpeningFolder(true);
    setError(null);
    try {
      await window.tutorDesktop.openBackupFolder();
    } catch (e) {
      setError(e);
    } finally {
      setOpeningFolder(false);
    }
  };

  const validateRestore = async (source: File | BackupIndexEntry) => {
    setError(null);
    setRestoreToken(null);
    setRestorePreview(null);
    setRestoreBusy(true);
    setRestoreFileName(source instanceof File ? source.name : source.fileName);
    try {
      let r: { token: string; preview: RestorePreview };
      if (source instanceof File) {
        const fd = new FormData(); fd.append('file', source);
        r = await api.postForm('/api/restores/validate', fd);
      } else r = await api.post('/api/restores/validate-existing', { backupId: source.id });
      setRestoreToken(r.token);
      setRestorePreview(r.preview);
      requestAnimationFrame(() => restorePanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    } catch (e) {
      setError(e);
    } finally {
      setRestoreBusy(false);
    }
  };

  const commitRestore = async () => {
    if (!restoreToken) return;
    setRestoreBusy(true);
    setError(null);
    try {
      await api.post('/api/restores/commit', { token: restoreToken });
      await refreshSession();
      window.dispatchEvent(new CustomEvent('tam:dialog', { detail: { title: '恢复完成', message: '数据已切换到备份时点，已返回订单列表。' } }));
      navigate('/');
    } catch (e) {
      setError(e);
    } finally {
      setRestoreBusy(false);
    }
  };

  return (
    <>
      {!backups && !error && <LoadingState label="正在加载备份与设置" compact />}
      <div className="card">
        <h2>90天自动清理</h2>
        <div className="alert info">
          规则：按“最后实际修改”满90天清理（查看/导出/下载不延期）。仅完成/取消订单且全部关联报名到期、费用结清/退清才整单删除；
          失败/退出报名到期且无待退、未被引用可独立删除；在办订单（招募/待试课/试课/待结算/暂停）始终保护。
          每天自动执行一次并在启动时补做；确有可删数据才生成清理前备份，备份失败则暂缓删除。
          服务停止期间不执行定时备份；重新启动会生成启动备份并评估到期清理。
        </div>
        <ErrorAlert error={error} />
        {cleanupResult && <div className="alert ok">{cleanupResult}</div>}
        {preview && (
          <>
            <h3>到期预览（截止线：{formatHkDateTimeCn(preview.cutoffIso)}）</h3>
            {preview.candidates.length === 0 ? (
              <div className="empty">当前没有可清理的数据</div>
            ) : (
              <table className="list">
                <thead>
                  <tr><th>类型</th><th>编号</th><th>原因</th><th>最后修改</th><th>附件</th></tr>
                </thead>
                <tbody>
                  {preview.candidates.map((c) => (
                    <tr key={`${c.type}-${c.id}`}>
                      <td>{c.type === 'order' ? '整单' : '报名'}</td>
                      <td>{c.no}</td>
                      <td>{c.reason}</td>
                      <td><TimeText iso={c.updatedAt} /></td>
                      <td>{c.attachmentCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {preview.protectedItems.length > 0 && (
              <details style={{ marginTop: 10 }}>
                <summary style={{ cursor: 'pointer', color: 'var(--muted)' }}>受保护项（{preview.protectedItems.length}）及原因</summary>
                <table className="list" style={{ marginTop: 8 }}>
                  <thead>
                    <tr><th>类型</th><th>编号</th><th>保护原因</th><th>最后修改</th></tr>
                  </thead>
                  <tbody>
                    {preview.protectedItems.map((p) => (
                      <tr key={`${p.type}-${p.id}`}>
                        <td>{p.type === 'order' ? '整单' : '报名'}</td>
                        <td>{p.no}</td>
                        <td>{p.reason}</td>
                        <td><TimeText iso={p.updatedAt} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </details>
            )}
            <div className="btn-row" style={{ marginTop: 12 }}>
              <ConfirmButton
                label="立即执行清理"
                className="btn danger"
                confirmTitle="执行清理"
                confirmBody={
                  <div>
                    <p>将删除预览列出的 {preview.candidates.length} 项（执行时会重新核验，预览后有变化的数据不会被删）。</p>
                    <p>删除前自动生成清理前安全备份（保留最多5份/30天）；删除不可恢复（备份是唯一恢复点）。</p>
                  </div>
                }
                onConfirm={runCleanup}
              />
              <button type="button" className="btn" onClick={() => void load()}>刷新预览</button>
            </div>
          </>
        )}
      </div>

      <div className="card">
        <h2>备份与恢复</h2>
        <div className="alert info">
          定时备份：每天{backups?.settings.dailyBackupTime ?? '20:00'}（北京时间）运行到设置时间时生成，错过不补做，保留最近5份。启动和正常关闭各备份一次，两者合计保留最近5份。手动备份保留最近5份，新备份成功后清理超出的旧包。
          恢复前/清理前/删除前安全备份合计保留最多5份且不超过30天。
          已下载到其他位置的副本不受保留规则影响。本地备份防误操作和文件损坏；建议定期把导出包另存到其他磁盘/U盘防电脑故障。
          本系统不自动上传云端。
        </div>
        {backups && (
          <>
            <h3>调度状态</h3>
            <dl className="kv" style={{ marginBottom: 12 }}>
              <dt>定时备份最近成功</dt><dd>{backups.scheduler.dailyBackup.lastSuccessAtUtc ? formatHkDateTimeCn(backups.scheduler.dailyBackup.lastSuccessAtUtc) : '尚无'}（{backups.scheduler.dailyBackup.lastSuccessDateHk ?? '—'}）</dd>
              <dt>最近错误</dt><dd style={{ color: backups.daily.lastError ? 'var(--danger)' : undefined }}>{backups.daily.lastError ?? '无'}</dd>
              <dt>上次清理</dt><dd>{backups.scheduler.cleanup.lastRunAtUtc ? formatHkDateTimeCn(backups.scheduler.cleanup.lastRunAtUtc) : '尚未运行'}：{backups.scheduler.cleanup.lastResult ?? '—'}</dd>
            </dl>
            <div className="btn-row" style={{ marginBottom: 12 }}>
              <button type="button" className="btn primary" onClick={createBackup} disabled={backingUp || savingSettings} aria-busy={backingUp}>{backingUp ? '备份中…' : '立即备份'}</button>
              <button type="button" className="btn" onClick={() => void downloadFile('/api/exports/recruiting', 'recruiting.txt')}>导出招募TXT（非备份）</button>
            </div>
            <h3>设置</h3>
            {backups.migration.pendingCleanupCount > 0 && <div className="alert warn">
              目录已切换，仍有{backups.migration.pendingCleanupCount}个旧文件或空目录待清理。
              <button type="button" className="btn small" onClick={async () => {
                try {
                  const result = await api.post<{ warnings: string[] }>('/api/backups/migration/retry-cleanup');
                  await load();
                  if (result.warnings.length) setError(new Error(result.warnings.join('\n')));
                  else window.dispatchEvent(new CustomEvent('tam:notice', { detail: '旧文件和空备份目录已清理' }));
                } catch (e) { setError(e); }
              }}>重试清理旧目录</button>
            </div>}
            <div className="form-grid">
              <Field label="备份目录（留空=默认数据目录内backups；各类备份按子目录保存）" full>
                <div className="backup-directory-field">
                  <input type="text" disabled={savingSettings || backingUp} value={settings.autoBackupDir} onChange={(e) => setSettings((s) => ({ ...s, autoBackupDir: e.target.value }))} placeholder="如 D:\tutor-backups" />
                  <button type="button" className="btn" onClick={chooseBackupFolder} disabled={!window.tutorDesktop || choosingFolder || savingSettings || backingUp}
                    title={!window.tutorDesktop ? '桌面版可直接选择文件夹' : '选择后点击保存设置生效'}>
                    {choosingFolder ? '正在选择…' : '选择文件夹'}
                  </button>
                  <button type="button" className="btn" onClick={openBackupFolder}
                    disabled={!window.tutorDesktop || openingFolder || settings.autoBackupDir.trim() !== (backups.settings.autoBackupDir ?? '')}
                    title={!window.tutorDesktop ? '桌面版可直接打开文件夹' : settings.autoBackupDir.trim() !== (backups.settings.autoBackupDir ?? '') ? '请先保存目录设置' : backups.paths.rootDir}>
                    {openingFolder ? '正在打开…' : '打开备份文件夹'}
                  </button>
                </div>
              </Field>
              <Field label="每日备份时间（北京时间）" hint="默认20:00，可修改；仅在软件运行到设置时间时备份，错过不补做。">
                <input aria-label="每日备份时间（北京时间）" type="time" value={settings.dailyBackupTime} onChange={e => setSettings(s => ({ ...s, dailyBackupTime: e.target.value }))} />
              </Field>
              <Field label="导入上传上限（MB）" hint="上传的备份ZIP文件本身允许的最大大小。">
                <input type="number" min={1} value={settings.importMaxUploadMB} onChange={(e) => setSettings((s) => ({ ...s, importMaxUploadMB: e.target.value }))} />
              </Field>
              <Field label="导入解压总量上限（MB）" hint="ZIP解压后，数据库和全部附件合计允许的最大大小。">
                <input type="number" min={1} value={settings.importMaxTotalMB} onChange={(e) => setSettings((s) => ({ ...s, importMaxTotalMB: e.target.value }))} />
              </Field>
            </div>
            <div className="btn-row">
              {settings.autoBackupDir.trim() !== (backups.settings.autoBackupDir ?? '') ? <ConfirmButton
                label={savingSettings ? '迁移并保存中…' : '保存设置'} disabled={savingSettings || backingUp || choosingFolder}
                confirmTitle="迁移已有备份并切换目录？" confirmLabel="确认迁移并保存"
                confirmBody={`将系统管理的已有备份迁移到新目录，后续备份也保存到这里。复制并校验成功后才删除旧文件。自行下载的副本及其他文件不会移动。`}
                onConfirm={() => saveSettings(true)}
              /> : <button type="button" className="btn" onClick={() => void saveSettings()} disabled={savingSettings || backingUp || choosingFolder} aria-busy={savingSettings}>{savingSettings ? '保存中…' : '保存设置'}</button>}
            </div>
            <h3 style={{ marginTop: 16 }}>备份列表（{backups.entries.length}）</h3>
            {backups.entries.length === 0 && <div className="empty">还没有备份</div>}
            {backups.entries.length > 0 && (
              <table className="list">
                <thead>
                  <tr><th>类型</th><th>文件</th><th>时间</th><th>大小</th><th>操作</th></tr>
                </thead>
                <tbody>
                  {backups.entries.map((e) => (
                    <tr key={e.id}>
                      <td>{KIND_LABELS[e.kind] ?? e.kind}{e.deleteError && <div className="err">{e.deleteError}</div>}</td>
                      <td style={{ wordBreak: 'break-all', fontSize: 12 }}>{e.fileName}</td>
                      <td><TimeText iso={e.createdAtUtc} /></td>
                      <td>{(e.sizeBytes / 1024 / 1024).toFixed(2)}MB</td>
                      <td className="btn-row">
                        <button type="button" className="btn small" onClick={() => void downloadFile(`/api/backups/${e.id}/download`, e.fileName)}>下载</button>
                        <ConfirmButton
                          label="删除"
                          small
                          className="btn small danger"
                          confirmTitle="删除备份包"
                          confirmBody={`确定删除备份文件 ${e.fileName}？删除后不可恢复该备份点。`}
                          onConfirm={async () => {
                            await api.delete(`/api/backups/${e.id}`);
                            await load();
                          }}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </>
        )}
      </div>

      <div className="card" ref={restorePanelRef}>
        <h2>从备份包恢复</h2>
        <div className="alert warn">
          恢复语义：<strong>替换</strong>当前全部订单、报名与附件到备份时点，不合并、不追加。备份之后新增/修改的数据将被替换。
          恢复前系统自动备份当前数据（失败则终止）。恢复后编号从“本机已发编号与备份编号较大值”之后继续，不会复用已发微信群的编号。
        </div>
        <Field label="从已有备份中选择" full>
          <select aria-label="从已有备份中选择" value={selectedBackupId} disabled={restoreBusy} onChange={e => { setSelectedBackupId(e.target.value); setRestoreToken(null); setRestorePreview(null); setRestoreFileName(''); }}>
            <option value="">请选择备份</option>
            {(backups?.entries ?? []).map(e => <option key={e.id} value={e.id}>{KIND_LABELS[e.kind]} · {formatHkDateTimeCn(e.createdAtUtc)} · {e.fileName}</option>)}
          </select>
        </Field>
        <div className="btn-row" style={{ marginBottom: 18 }}><button type="button" className="btn" disabled={restoreBusy || !selectedBackupId} onClick={() => { const entry = backups?.entries.find(e => e.id === selectedBackupId); if (entry) void validateRestore(entry); }}>校验所选备份</button></div>
        <p className="hint">也可以选择电脑上的备份ZIP。两种方式都须先校验，再确认替换当前数据。</p>
        <div className="filter-bar">
          <input
            ref={restoreFileRef}
            type="file"
            disabled={restoreBusy}
            accept=".zip"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) {
                setSelectedBackupId('');
                setRestoreFileName(f.name);
                void validateRestore(f);
              }
            }}
          />
          <button type="button" className="btn" disabled={restoreBusy} onClick={() => restoreFileRef.current?.click()}>选择备份包（ZIP）</button>
          {restoreFileName && <span>已选择：{restoreFileName}</span>}
        </div>
        {restorePreview && restoreToken && (
          <div className="paste-result">
            <h3>校验通过，恢复预览</h3>
            <dl className="kv">
              <dt>备份时间</dt><dd>{formatHkDateTimeCn(restorePreview.createdAtUtc)}</dd>
              <dt>订单 / 报名 / 附件</dt><dd>{restorePreview.counts.orders} / {restorePreview.counts.applications} / {restorePreview.counts.attachments}</dd>
              <dt>schema</dt><dd>v{restorePreview.schemaVersion}{restorePreview.migrated ? '（将在恢复时迁移到当前版本）' : ''}</dd>
            </dl>
            {restorePreview.warnings.length > 0 && (
              <div className="alert warn" style={{ marginTop: 8 }}>
                {restorePreview.warnings.map((w, i) => <div key={i}>{w}</div>)}
              </div>
            )}
            <div className="btn-row" style={{ marginTop: 10 }}>
              <ConfirmButton
                label="确认恢复（替换当前数据）"
                className="btn danger"
                confirmTitle="确认恢复？"
                confirmBody="备份之后新增/修改的订单、报名、附件都将被替换为备份时点内容。恢复前会自动备份当前数据。确定继续？"
                onConfirm={commitRestore}
                disabled={restoreBusy}
                confirmLabel={restoreBusy ? '恢复中…' : '确认恢复'}
              />
              <button type="button" className="btn" onClick={() => { setRestoreToken(null); setRestorePreview(null); setRestoreFileName(''); }}>取消</button>
            </div>
          </div>
        )}
        <TextBlock
          text={[
            '恢复说明：',
            '· 只接受本系统导出的完整备份包（含数据库快照、附件和manifest）。',
            '· 校验失败（损坏/缺附件/校验值不符/外键或业务不变量错误）时当前数据不受影响。',
            '· 恢复在后台进行：自动进入维护状态，切换数据库与附件目录，完成后自动刷新页面。',
            '· 服务关闭期间无法自动恢复；如恢复中断，重启服务后系统会保证“完整新数据代或完整原数据代”。',
            '· 命令行备用方式：先停止服务，运行 npm run restore -- --from <备份ZIP路径> --yes',
          ].join('\n')}
        />
      </div>
    </>
  );
}
