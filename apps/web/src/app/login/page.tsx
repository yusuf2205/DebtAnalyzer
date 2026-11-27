'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { api, setCsrf, type Me } from '@/lib/api';
import { Logo } from '@/lib/logo';

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      const r = await api<{ user: Me }>('POST', '/auth/login', { email, password });
      setCsrf(r.user.csrfToken);
      router.replace(r.user.mustChangePassword ? '/change-password' : '/dashboard');
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <main className="min-h-screen grid place-items-center p-4" style={{ background: 'radial-gradient(900px 480px at 50% -10%, var(--accent-soft), transparent 70%), var(--bg)' }}>
      <form onSubmit={submit} className="panel w-full max-w-sm p-7 space-y-5" style={{ boxShadow: 'var(--shadow-md)' }}>
        <div className="flex items-center gap-3">
          <Logo size={48} variant="intro" />
          <div>
            <h1 className="text-lg font-semibold">Procurement Finance</h1>
            <p className="muted text-sm">Вход в систему</p>
          </div>
        </div>
        <label className="block space-y-1.5"><span className="muted text-xs font-medium">Email</span>
          <input className="input w-full" type="email" autoComplete="username" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label className="block space-y-1.5"><span className="muted text-xs font-medium">Пароль</span>
          <input className="input w-full" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <p role="alert" className="b-err text-sm">{error}</p>}
        <button className="btn btn-primary w-full" style={{ padding: '10px 14px' }} disabled={busy}>{busy ? 'Вход…' : 'Войти'}</button>
      </form>
    </main>
  );
}
