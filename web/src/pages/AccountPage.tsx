// Account: any signed-in human sees who they are and changes their own password.
// POST /api/v1/auth/password; other sessions are signed out, this one continues.
import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client';
import type { SessionPrincipal } from '../api/types';
import { BTN_PRIMARY } from '../components/edit';
import { tx } from '../i18n';

/** Same minimum as the server (core/password.ts MIN_PASSWORD_LENGTH). */
export const MIN_PASSWORD_LENGTH = 12;

const INPUT =
  'w-full rounded-md border border-zinc-300 bg-white px-3 py-2 outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30 dark:border-zinc-700 dark:bg-zinc-900';

function changeErrorText(err: unknown): string {
  if (!(err instanceof ApiError)) return tx.errors.generic;
  if (err.code === 'rate_limited') return tx.account.rateLimited;
  if (err.code === 'invalid_input') {
    const issue = (err.details?.issues as { path?: string; message?: string }[] | undefined)?.[0];
    if (issue?.path === 'current_password') return tx.account.wrongCurrent;
    if (issue?.message) return issue.message;
  }
  return err.message || tx.errors.server;
}

export function AccountPage({ principal }: { principal: SessionPrincipal }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [repeat, setRepeat] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setDone(null);
    setError(null);
    if (next.length < MIN_PASSWORD_LENGTH) return setError(tx.account.tooShort(MIN_PASSWORD_LENGTH));
    if (next !== repeat) return setError(tx.account.mismatch);
    if (next === current) return setError(tx.account.same);
    setBusy(true);
    try {
      const r = await api.changePassword(current, next);
      setCurrent('');
      setNext('');
      setRepeat('');
      setDone(tx.account.done(r.revoked_sessions));
    } catch (err) {
      setCurrent('');
      setError(changeErrorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="max-w-[720px] px-6 py-6 space-y-6">
      <h1 className="text-xl font-semibold">{tx.account.title}</h1>
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-zinc-500">{tx.account.name}</dt>
        <dd className="font-mono">{principal.name}</dd>
      </dl>
      {/* One administrator concept: a muted line; superadmin once, on the owner's own account. */}
      {principal.role === 'superadmin' ? (
        <p className="text-sm text-zinc-500">{tx.account.superadmin}</p>
      ) : (
        principal.admin && <p className="text-sm text-zinc-500">{tx.account.administrator}</p>
      )}
      <form onSubmit={submit} className="space-y-4 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800" aria-labelledby="account-password">
        <h2 id="account-password" className="font-semibold">
          {tx.account.changePassword}
        </h2>
        {/* Hidden username helps password managers attach the new password to the right account. */}
        <input type="text" name="username" autoComplete="username" value={principal.name} readOnly hidden />
        <div className="space-y-1">
          <label htmlFor="account-current" className="block text-sm font-medium">
            {tx.account.current}
          </label>
          <input id="account-current" type="password" autoComplete="current-password" required maxLength={1024} value={current} onChange={(e) => setCurrent(e.target.value)} className={INPUT} />
        </div>
        <div className="space-y-1">
          <label htmlFor="account-new" className="block text-sm font-medium">
            {tx.account.next}
          </label>
          <input id="account-new" type="password" autoComplete="new-password" required maxLength={1024} value={next} onChange={(e) => setNext(e.target.value)} className={INPUT} aria-describedby="account-hint" />
          <p id="account-hint" className="text-xs text-zinc-500">
            {tx.account.hint(MIN_PASSWORD_LENGTH)}
          </p>
        </div>
        <div className="space-y-1">
          <label htmlFor="account-repeat" className="block text-sm font-medium">
            {tx.account.repeat}
          </label>
          <input id="account-repeat" type="password" autoComplete="new-password" required maxLength={1024} value={repeat} onChange={(e) => setRepeat(e.target.value)} className={INPUT} />
        </div>
        {error && (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {error}
          </p>
        )}
        {done && (
          <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
            {done}
          </p>
        )}
        <button type="submit" disabled={busy} className={BTN_PRIMARY}>
          {busy ? tx.account.saving : tx.account.save}
        </button>
      </form>
    </div>
  );
}
