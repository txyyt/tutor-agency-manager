import { useState } from 'react';
import { api } from '../api';
import { ConfirmButton } from './ui';
export default function DeleteRecord({ kind, id, version, no, counts, onDeleted }: { kind: 'orders' | 'applications'; id: number; version: number; no: string; counts?: string; onDeleted: () => void }) {
  const [confirmation, setConfirmation] = useState('');
  return <ConfirmButton label={kind === 'orders' ? '删除订单' : '删除报名'} className="btn danger" confirmTitle={kind === 'orders' ? '删除订单及全部报名' : '删除本次老师报名'} confirmBody={<><p>将删除 {no} {counts}及对应简历附件。系统会先生成可恢复的完整备份；未结清款项必须先处理。</p><p>如有收费历史或已成交，请输入编号再次确认：</p><input aria-label="删除确认编号" value={confirmation} onChange={e => setConfirmation(e.target.value)} placeholder={no} /></>} confirmLabel="确认删除" onConfirm={async () => { await api.delete(`/api/${kind}/${id}?version=${version}&confirmHistory=${encodeURIComponent(confirmation)}`); window.dispatchEvent(new CustomEvent('tam:notice', { detail: '记录已删除，删除前安全备份已生成' })); onDeleted(); }} />;
}
