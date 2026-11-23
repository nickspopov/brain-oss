import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { api, ApiError } from '../api/client';
import { SESSION_KEY } from '../session';
import { tx } from '../i18n';

/** Where to return after login: only our own path (not an open redirect). */
export function safeNext(next: string | null): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') && !next.startsWith('/login') ? next : '/';
}

export function LoginPage() {
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.login(name.trim(), password);
      qc.clear();
      qc.setQueryData(SESSION_KEY, r.principal);
      navigate(safeNext(params.get('next')), { replace: true });
    } catch (err) {
      setPassword('');
      if (err instanceof ApiError && err.code === 'rate_limited') setError(tx.login.rateLimited);
      else if (err instanceof ApiError && (err.code === 'unauthenticated' || err.code === 'invalid_input')) setError(tx.login.invalid);
      else setError(tx.login.unavailable);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-lg border border-zinc-200 p-6 shadow-sm dark:border-zinc-800" aria-labelledby="login-title">
        <h1 id="login-title" className="text-xl font-semibold">
          Brain
        </h1>
        <div className="space-y-1">
          <label htmlFor="login-name" className="block text-sm font-medium">
            {tx.login.name}
          </label>
          <input
            id="login-name"
            autoComplete="username"
            autoCapitalize="none"
            required
            maxLength={63}
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30 dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="login-password" className="block text-sm font-medium">
            {tx.login.password}
          </label>
          <input
            id="login-password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={1024}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30 dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {error}
          </p>
        )}
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-md bg-sky-700 px-3 py-2 font-medium text-white hover:bg-sky-800 disabled:opacity-60 dark:bg-sky-600 dark:hover:bg-sky-500"
        >
          {busy ? tx.login.signingIn : tx.login.signIn}
        </button>
      </form>
    </main>
  );
}
