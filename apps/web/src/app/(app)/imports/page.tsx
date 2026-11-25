'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

const STATUS: Record<string, [string, string]> = {
  UPLOADED: ['Загружен', 'b-mute'], ANALYZED: ['Ожидает подтверждения', 'b-warn'], COMMITTING: ['Сохраняется…', 'b-info'], COMMITTED: ['Сохранён', 'b-ok'], FAILED: ['Ошибка', 'b-err'],
};

export default function ImportsPage() {
  const { can } = useSession();
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [items, setItems] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => api<any[]>('GET', '/imports').then(setItems).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  async function upload(file: File) {
    setBusy(true); setError('');
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await api<{ id: string }>('POST', '/imports', fd);
      router.push(`/imports/${r.id}`);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); if (fileRef.current) fileRef.current.value = ''; }
  }

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div><h1 className="text-xl font-semibold">Импорт реестра</h1><p className="muted">Загрузка Excel (XLSX) или CSV с проверкой перед сохранением</p></div>
        {can('import.run') && (<>
          <input ref={fileRef} type="file" accept=".xlsx,.xlsm,.csv" hidden onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
          <button className="btn btn-primary" disabled={busy} onClick={() => fileRef.current?.click()}>{busy ? 'Загрузка…' : 'Загрузить файл'}</button>
        </>)}
      </div>
      {error && <p role="alert" className="b-err">{error}</p>}
      <div className="panel overflow-x-auto">
        <table className="tbl">
          <thead><tr><th>Файл</th><th>Лист</th><th>Статус</th><th className="num">Строк данных</th><th className="num">К импорту</th><th className="num">Заблокировано</th><th>Загружен</th></tr></thead>
          <tbody>
            {items?.map((b) => { const s = STATUS[b.status] ?? [b.status, 'b-mute']; return (
              <tr key={b.id}>
                <td><Link className="underline" href={`/imports/${b.id}`}>{b.filename}</Link></td>
                <td>{b.sheetName ?? '—'}</td>
                <td><span className={`badge ${s[1]}`}>{s[0]}</span></td>
                <td className="num">{b.summary?.dataRows ?? '—'}</td><td className="num">{b.summary?.importable ?? '—'}</td>
                <td className="num">{b.summary?.blocked ? <span className="b-err">{b.summary.blocked}</span> : (b.summary ? 0 : '—')}</td>
                <td>{new Date(b.createdAt).toLocaleString('ru-RU')}</td>
              </tr>); })}
            {items?.length === 0 && <tr><td colSpan={7} className="muted">Импортов пока нет</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
