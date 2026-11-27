'use client';
import Link from 'next/link';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { ROLE_LABELS, type Role } from '@pf/shared';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

type RolesList = { builtin: { key: Role; label: string }[]; custom: { id: string; name: string; permissions: string[] }[] };
/** Значение выпадающего списка: встроенная роль — её ключ; настраиваемая — «custom:<id>». */
const roleBody = (v: string) => (v.startsWith('custom:') ? { customRoleId: v.slice(7) } : { role: v });
const roleValue = (u: any) => (u.customRoleId ? `custom:${u.customRoleId}` : u.role);
const roleName = (u: any) => u.customRole?.name ?? ROLE_LABELS[u.role as Role] ?? u.role;

export default function UsersPage() {
  const { me, can } = useSession();
  const [users, setUsers] = useState<any[] | null>(null);
  const [rolesList, setRolesList] = useState<RolesList | null>(null);
  const [error, setError] = useState('');
  const [f, setF] = useState({ email: '', name: '', role: 'VIEWER', password: '' });
  const load = () => Promise.all([api<any[]>('GET', '/users'), api<RolesList>('GET', '/roles')]).then(([u, r]) => { setUsers(u); setRolesList(r); }).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);
  const act = async (fn: () => Promise<any>) => { setError(''); try { await fn(); await load(); } catch (e) { setError((e as Error).message); } };
  const manage = can('users.manage');
  const isSuper = me?.role === 'SUPER_ADMIN';

  // Варианты ролей: SUPER_ADMIN — только для SUPER_ADMIN; настраиваемую роль можно назначить, если все её права есть у вас (сервер проверяет то же самое).
  const options = useMemo(() => {
    const mine = new Set(me?.permissions ?? []);
    return [
      ...(rolesList?.builtin ?? []).filter((r) => r.key !== 'SUPER_ADMIN' || isSuper).map((r) => ({ value: r.key as string, label: r.label, group: 'Встроенные' })),
      ...(rolesList?.custom ?? []).filter((r) => isSuper || r.permissions.every((p) => mine.has(p))).map((r) => ({ value: `custom:${r.id}`, label: r.name, group: 'Настраиваемые' })),
    ];
  }, [rolesList, me, isSuper]);
  const roleSelect = (value: string, onChange: (v: string) => void) => (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value)}>
      {['Встроенные', 'Настраиваемые'].map((g) => { const items = options.filter((o) => o.group === g); return items.length ? <optgroup key={g} label={g}>{items.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</optgroup> : null; })}
    </select>
  );

  return (
    <div className="space-y-4 max-w-5xl">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div><h1 className="text-xl font-semibold">Пользователи</h1><p className="muted">Новый пользователь обязан сменить пароль при первом входе. Все изменения пишутся в журнал аудита.</p></div>
        {can('roles.manage') && <Link href="/roles" className="btn">Настроить роли и права</Link>}
      </div>
      {error && <p role="alert" className="b-err">{error}</p>}
      <div className="panel overflow-x-auto"><table className="tbl"><thead><tr><th>Имя</th><th>Email</th><th>Роль</th><th>Статус</th><th></th></tr></thead>
        <tbody>{users?.map((u) => (
          <tr key={u.id}><td>{u.name}</td><td>{u.email}</td>
            <td>{manage && u.id !== me?.id && (u.role !== 'SUPER_ADMIN' || isSuper)
              ? roleSelect(roleValue(u), (v) => act(() => api('PATCH', `/users/${u.id}`, roleBody(v)))) : roleName(u)}
              {u.customRole && <span className="badge b-info ml-2">своя роль</span>}</td>
            <td><span className={`badge ${u.isActive ? 'b-ok' : 'b-mute'}`}>{u.isActive ? 'Активен' : 'Отключён'}</span>{u.mustChangePassword && <span className="badge b-warn ml-1">смена пароля</span>}</td>
            <td>{manage && u.id !== me?.id && <button className="btn" onClick={() => act(() => api('PATCH', `/users/${u.id}`, { isActive: !u.isActive }))}>{u.isActive ? 'Отключить' : 'Включить'}</button>}</td></tr>))}</tbody></table></div>
      {manage && (
        <form className="panel p-4 grid sm:grid-cols-2 md:grid-cols-5 gap-3 items-end" onSubmit={(e: FormEvent) => { e.preventDefault(); act(async () => { await api('POST', '/users', { email: f.email, name: f.name, password: f.password, ...roleBody(f.role) }); setF({ email: '', name: '', role: 'VIEWER', password: '' }); }); }}>
          <input className="input" placeholder="Имя" required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <input className="input" type="email" placeholder="Email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          {roleSelect(f.role, (v) => setF({ ...f, role: v }))}
          <input className="input" type="password" autoComplete="new-password" placeholder="Временный пароль (от 4 символов)" required minLength={4} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
          <button className="btn btn-primary">Создать</button>
        </form>)}
    </div>
  );
}
