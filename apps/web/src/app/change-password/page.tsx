'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { Icon } from '@/lib/icons';
import { useSession } from '@/lib/session';

export default function ChangePasswordPage() {
  const router = useRouter();
  const { me, refresh } = useSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault(); setError('');
    if (next !== again) return setError('Новые пароли не совпадают');
    setBusy(true);
    try { await api('POST', '/auth/change-password', { current, next }); await refresh(); router.replace('/dashboard'); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <main className="min-h-screen grid place-items-center p-4" style={{ background: 'radial-gradient(900px 480px at 50% -10%, var(--accent-soft), transparent 70%), var(--bg)' }}>
      <form onSubmit={submit} className="panel w-full max-w-sm p-7 space-y-4" style={{ boxShadow: 'var(--shadow-md)' }}>
        <div className="flex items-center gap-3">
          <span className="brand-mark" style={{ width: 40, height: 40, borderRadius: 12 }}><Icon name="key" size={20} /></span>
          <div><h1 className="text-lg font-semibold">Смена пароля</h1><p className="muted text-sm">Не менее 4 символов.</p></div>
        </div>
        <input className="input w-full" type="password" autoComplete="current-password" placeholder="Текущий пароль" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        <input className="input w-full" type="password" autoComplete="new-password" placeholder="Новый пароль" required minLength={4} value={next} onChange={(e) => setNext(e.target.value)} />
        <input className="input w-full" type="password" autoComplete="new-password" placeholder="Повторите новый пароль" required minLength={4} value={again} onChange={(e) => setAgain(e.target.value)} />
        {error && <p role="alert" className="b-err text-sm">{error}</p>}
        <button className="btn btn-primary w-full" style={{ padding: '10px 14px' }} disabled={busy}>Сменить пароль</button>
        {me && !me.mustChangePassword && <Link href="/dashboard" className="btn w-full">Отмена</Link>}
      </form>
    </main>
  );
}
