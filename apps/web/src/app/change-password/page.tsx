'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';

export default function ChangePasswordPage() {
  const router = useRouter();
  const { refresh } = useSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault(); setError('');
    if (next !== again) return setError('Новые пароли не совпадают');
    setBusy(true);
    try { await api('POST', '/auth/change-password', { current, next }); await refresh(); router.replace('/imports'); }
    catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <main className="min-h-screen grid place-items-center p-4">
      <form onSubmit={submit} className="panel w-full max-w-sm p-6 space-y-4">
        <div><h1 className="text-lg font-semibold">Смена пароля</h1><p className="muted text-sm">Не менее 12 символов, буквы и цифры.</p></div>
        <input className="input w-full" type="password" autoComplete="current-password" placeholder="Текущий пароль" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        <input className="input w-full" type="password" autoComplete="new-password" placeholder="Новый пароль" required value={next} onChange={(e) => setNext(e.target.value)} />
        <input className="input w-full" type="password" autoComplete="new-password" placeholder="Повторите новый пароль" required value={again} onChange={(e) => setAgain(e.target.value)} />
        {error && <p role="alert" className="b-err text-sm">{error}</p>}
        <button className="btn btn-primary w-full" disabled={busy}>Сменить пароль</button>
      </form>
    </main>
  );
}
