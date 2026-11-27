'use client';
import { useEffect, useMemo, useState } from 'react';
import { PERMISSIONS, PERMISSION_GROUPS, PERMISSION_REQUIRES, withRequirements, type Permission } from '@pf/shared';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

type Builtin = { key: string; label: string; permissions: Permission[] };
type Custom = { id: string; name: string; description: string | null; permissions: Permission[]; userCount: number };
type Sel = { kind: 'builtin'; key: string } | { kind: 'custom'; id: string } | { kind: 'new' };
const ASSIGNABLE = PERMISSION_GROUPS.flatMap((g) => g.items.map((i) => i.perm));

export default function RolesPage() {
  const { can } = useSession();
  const [data, setData] = useState<{ builtin: Builtin[]; custom: Custom[] } | null>(null);
  const [sel, setSel] = useState<Sel>({ kind: 'new' });
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [perms, setPerms] = useState<Set<Permission>>(new Set());
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const load = () => api<{ builtin: Builtin[]; custom: Custom[] }>('GET', '/roles').then(setData).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const current = useMemo(() => {
    if (!data) return null;
    if (sel.kind === 'builtin') return data.builtin.find((b) => b.key === sel.key) ?? null;
    if (sel.kind === 'custom') return data.custom.find((c) => c.id === sel.id) ?? null;
    return null;
  }, [data, sel]);

  const select = (s: Sel, from?: { name?: string; description?: string | null; permissions: readonly Permission[] }) => {
    setSel(s); setError(''); setNotice('');
    setName(from?.name ?? ''); setDescription(from?.description ?? '');
    setPerms(new Set(from?.permissions.filter((p) => ASSIGNABLE.includes(p)) ?? []));
  };

  const readOnly = sel.kind === 'builtin';
  const toggle = (p: Permission, on: boolean) => {
    if (readOnly) return;
    setNotice('');
    setPerms((prev) => {
      const next = new Set(prev);
      if (on) { for (const x of withRequirements([p])) next.add(x); }
      else { next.delete(p); for (const [dep, reqs] of Object.entries(PERMISSION_REQUIRES)) if (reqs!.includes(p)) next.delete(dep as Permission); } // без просмотра раздела действия в нём теряют смысл
      return next;
    });
  };
  const toggleGroup = (items: Permission[], on: boolean) => { if (!readOnly) items.forEach((p) => toggle(p, on)); };

  const save = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const body = { name, description: description || null, permissions: PERMISSIONS.filter((p) => perms.has(p)) };
      if (sel.kind === 'custom') { await api('PATCH', `/roles/${sel.id}`, body); setNotice('Сохранено. Новые права действуют сразу, повторный вход не нужен.'); }
      else { const r = await api<Custom>('POST', '/roles', body); setSel({ kind: 'custom', id: r.id }); setNotice('Роль создана. Теперь её можно назначать на странице «Пользователи».'); }
      await load();
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (sel.kind !== 'custom' || !confirm(`Удалить роль «${name}»?`)) return;
    setBusy(true); setError('');
    try { await api('DELETE', `/roles/${sel.id}`); select({ kind: 'new' }); await load(); setNotice('Роль удалена.'); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  if (!can('roles.manage')) return <p role="alert" className="b-err">Недостаточно прав: управлять ролями может только SUPER_ADMIN.</p>;
  const total = ASSIGNABLE.length;

  return (
    <div className="space-y-4 max-w-6xl">
      <div><h1 className="text-xl font-semibold">Роли и права</h1>
        <p className="muted">Создайте роль, отметьте права и назначьте её пользователям. Изменения прав действуют сразу. Встроенные роли изменить нельзя, но их можно взять за основу.</p></div>
      {error && <p role="alert" className="b-err">{error}</p>}
      {notice && <p role="status" className="b-ok">{notice}</p>}

      <div className="grid md:grid-cols-[260px_1fr] gap-4 items-start">
        <aside className="panel p-3 space-y-3" aria-label="Список ролей">
          <button className="btn btn-primary w-full" onClick={() => select({ kind: 'new' })}>+ Новая роль</button>
          <div>
            <div className="muted text-xs font-medium uppercase tracking-wide mb-1 px-1">Настраиваемые</div>
            {data?.custom.length ? data.custom.map((r) => (
              <button key={r.id} onClick={() => select({ kind: 'custom', id: r.id }, r)} className="nav-link w-full text-left" aria-current={sel.kind === 'custom' && sel.id === r.id ? 'page' : undefined}>
                <span className="truncate flex-1">{r.name}</span><span className="muted text-xs">{r.userCount}</span>
              </button>)) : <p className="muted text-sm px-1">Пока нет. Создайте первую.</p>}
          </div>
          <div>
            <div className="muted text-xs font-medium uppercase tracking-wide mb-1 px-1">Встроенные</div>
            {data?.builtin.map((r) => (
              <button key={r.key} onClick={() => select({ kind: 'builtin', key: r.key }, { name: r.label, permissions: r.permissions })} className="nav-link w-full text-left" aria-current={sel.kind === 'builtin' && sel.key === r.key ? 'page' : undefined}>
                <span className="truncate flex-1">{r.label}</span><span className="muted text-xs">{r.key === 'SUPER_ADMIN' ? 'все' : r.permissions.length}</span>
              </button>))}
          </div>
        </aside>

        <section className="space-y-3">
          <div className="panel p-4 space-y-3">
            <div className="flex items-start justify-between gap-3 flex-wrap">
              <h2 className="font-semibold">{sel.kind === 'new' ? 'Новая роль' : readOnly ? `Встроенная роль: ${current ? (current as Builtin).label : ''}` : 'Редактирование роли'}</h2>
              {readOnly && <button className="btn" onClick={() => select({ kind: 'new' }, { name: `${(current as Builtin).label} (копия)`, permissions: [...perms] })}>Создать роль на основе этой</button>}
            </div>
            <div className="grid sm:grid-cols-2 gap-3">
              <label className="block space-y-1"><span className="muted text-xs font-medium">Название</span>
                <input className="input w-full" value={name} onChange={(e) => setName(e.target.value)} disabled={readOnly} maxLength={60} placeholder="Например, Бухгалтер" /></label>
              <label className="block space-y-1"><span className="muted text-xs font-medium">Описание (необязательно)</span>
                <input className="input w-full" value={description} onChange={(e) => setDescription(e.target.value)} disabled={readOnly} maxLength={200} placeholder="Для чего эта роль" /></label>
            </div>
            <p className="muted text-sm">Выбрано прав: <b>{[...perms].filter((p) => ASSIGNABLE.includes(p)).length}</b> из {total}{readOnly && ' · только просмотр'}</p>
          </div>

          <div className="grid lg:grid-cols-2 gap-3">
            {PERMISSION_GROUPS.map((g) => {
              const items = g.items.map((i) => i.perm);
              const checked = items.filter((p) => perms.has(p)).length;
              return (
                <fieldset key={g.key} className="panel p-4" disabled={readOnly}>
                  <legend className="sr-only">{g.title}</legend>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-semibold">{g.title}</h3>
                    {!readOnly && <button type="button" className="text-xs" style={{ color: 'var(--accent)' }} onClick={() => toggleGroup(items, checked !== items.length)}>{checked === items.length ? 'Снять все' : 'Выбрать все'}</button>}
                  </div>
                  <div className="space-y-1.5">
                    {g.items.map((i) => (
                      <label key={i.perm} className="flex items-start gap-2.5 cursor-pointer">
                        <input type="checkbox" className="mt-1" style={{ accentColor: 'var(--accent)', width: 16, height: 16 }} checked={perms.has(i.perm)} onChange={(e) => toggle(i.perm, e.target.checked)} />
                        <span>{i.label}{i.hint && <span className="muted block text-xs">{i.hint}</span>}</span>
                      </label>))}
                  </div>
                </fieldset>);
            })}
          </div>

          {!readOnly && (
            <div className="flex gap-2 items-center flex-wrap">
              <button className="btn btn-primary" onClick={save} disabled={busy || name.trim().length < 2 || perms.size === 0}>{sel.kind === 'custom' ? 'Сохранить изменения' : 'Создать роль'}</button>
              {sel.kind === 'custom' && <button className="btn" onClick={remove} disabled={busy}>Удалить роль</button>}
              {sel.kind === 'custom' && current && <span className="muted text-sm">Назначена пользователям: {(current as Custom).userCount}</span>}
            </div>)}
        </section>
      </div>
    </div>
  );
}
