'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { ROLES } from '@pf/shared';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

const ROLE_RU: Record<string, string> = { SUPER_ADMIN: 'Суперадмин', ADMIN: 'Администратор', FINANCE: 'Финансы', MANAGER: 'Менеджер', VIEWER: 'Просмотр' };

export default function UsersPage() {
  const { me, can } = useSession();
  const [users, setUsers] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const [f, setF] = useState({ email: '', name: '', role: 'VIEWER', password: '' });
  const load = () => api<any[]>('GET', '/users').then(setUsers).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const act = async (fn: () => Promise<any>) => { setError(''); try { await fn(); await load(); } catch (e) { setError((e as Error).message); } };
  const manage = can('users.manage');
  const roles = ROLES.filter((r) => r !== 'SUPER_ADMIN' || me?.role === 'SUPER_ADMIN');

  return (
    <div className="space-y-4 max-w-5xl">
      <div><h1 className="text-xl font-semibold">Пользователи</h1><p className="muted">Новый пользователь обязан сменить пароль при первом входе. Все изменения пишутся в журнал аудита.</p></div>
      {error && <p role="alert" className="b-err">{error}</p>}
      <div className="panel overflow-x-auto"><table className="tbl"><thead><tr><th>Имя</th><th>Email</th><th>Роль</th><th>Статус</th><th></th></tr></thead>
        <tbody>{users?.map((u) => (
          <tr key={u.id}><td>{u.name}</td><td>{u.email}</td>
            <td>{manage && u.id !== me?.id && (u.role !== 'SUPER_ADMIN' || me?.role === 'SUPER_ADMIN')
              ? <select className="input" value={u.role} onChange={(e) => act(() => api('PATCH', `/users/${u.id}`, { role: e.target.value }))}>{roles.map((r) => <option key={r} value={r}>{ROLE_RU[r]}</option>)}</select> : ROLE_RU[u.role]}</td>
            <td><span className={`badge ${u.isActive ? 'b-ok' : 'b-mute'}`}>{u.isActive ? 'Активен' : 'Отключён'}</span>{u.mustChangePassword && <span className="badge b-warn ml-1">смена пароля</span>}</td>
            <td>{manage && u.id !== me?.id && <button className="btn" onClick={() => act(() => api('PATCH', `/users/${u.id}`, { isActive: !u.isActive }))}>{u.isActive ? 'Отключить' : 'Включить'}</button>}</td></tr>))}</tbody></table></div>
      {manage && (
        <form className="panel p-4 grid sm:grid-cols-2 md:grid-cols-5 gap-3 items-end" onSubmit={(e: FormEvent) => { e.preventDefault(); act(async () => { await api('POST', '/users', f); setF({ email: '', name: '', role: 'VIEWER', password: '' }); }); }}>
          <input className="input" placeholder="Имя" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <input className="input" type="email" placeholder="Email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          <select className="input" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>{roles.map((r) => <option key={r} value={r}>{ROLE_RU[r]}</option>)}</select>
          <input className="input" type="password" autoComplete="new-password" placeholder="Временный пароль (12+)" required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
          <button className="btn btn-primary">Создать</button>
        </form>)}
    </div>
  );
}
