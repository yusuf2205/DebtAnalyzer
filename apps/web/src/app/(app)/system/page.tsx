'use client';
import { useCallback, useEffect, useState } from 'react';
import { api } from '@/lib/api';

const LEVEL: Record<string, [string, string]> = { ok: ['OK', 'b-ok'], warn: ['Внимание', 'b-warn'], error: ['Проблема', 'b-err'] };

export default function SystemPage() {
  const [s, setS] = useState<any>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => api('GET', '/system/status').then((r) => { setS(r); setError(''); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); const t = setInterval(load, 30000); return () => clearInterval(t); }, [load]);

  const up = s ? `${Math.floor(s.uptimeSec / 3600)} ч ${Math.floor((s.uptimeSec % 3600) / 60)} мин` : '';
  return (
    <div className="space-y-4 max-w-4xl">
      <div><h1 className="text-xl font-semibold">Состояние системы</h1><p className="muted">Проверки, которые стоит просматривать после каждого обновления и раз в неделю. Страница обновляется сама.</p></div>
      {error && <p role="alert" className="b-err">{error}</p>}
      {s && (<>
        <div className="panel p-4 flex items-center gap-3 flex-wrap" style={{ borderColor: `var(--${s.status === 'ok' ? 'paid' : s.status === 'warn' ? 'pending' : 'debt'})` }}>
          <span className={`badge ${LEVEL[s.status][1]}`}>{LEVEL[s.status][0]}</span>
          <span>{s.status === 'ok' ? 'Все проверки пройдены' : s.status === 'warn' ? 'Есть предупреждения' : 'Есть проблемы, требующие внимания'}</span>
          <span className="muted text-xs ml-auto">работает {up} · Node {s.node} · {s.env}</span>
        </div>
        <div className="panel overflow-x-auto"><table className="tbl"><thead><tr><th>Проверка</th><th>Статус</th><th>Подробности</th></tr></thead>
          <tbody>{s.checks.map((c: any) => <tr key={c.id}><td className="whitespace-nowrap">{c.title}</td><td><span className={`badge ${LEVEL[c.status][1]}`}>{LEVEL[c.status][0]}</span></td><td className="text-sm">{c.detail}</td></tr>)}</tbody></table></div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[['Активных пользователей', s.counters.activeUsers], ['Активных сессий', s.counters.activeSessions], ['Открытых сверок', s.counters.openReconciliations], ['Платежей на подтверждении', s.counters.pendingPayments]].map(([l, v]) => (
            <div key={l as string} className="panel p-3"><div className="muted text-xs">{l}</div><div className="text-lg font-semibold">{v}</div></div>))}
        </div>
        <p className="muted text-xs">Мониторинг извне: направьте Uptime Kuma (или аналог) на <code>/api/health</code> — ответ 200 при исправной базе данных, 503 при её недоступности.</p>
      </>)}
    </div>
  );
}
