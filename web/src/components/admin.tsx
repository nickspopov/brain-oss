// Shared administration elements: form fields, a copy button, mutations with a
// per-intent `request_id` and cache reset, role selection.
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, type ReactNode } from 'react';
import type { Role } from '../api/types';
import { GRANT_ROLE_LABEL, invalidateAdmin, ROLES } from '../lib/admin';
import { newRequestId, requestIdFor } from '../lib/edit';
import { Page, Select } from './controls';
import { tx } from '../i18n';

export const INPUT =
  'w-full rounded-md border border-zinc-300 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30 dark:border-zinc-700 dark:bg-zinc-900';
export const CARD = 'rounded-lg border border-zinc-200 p-3 dark:border-zinc-800';

export function Field({ label, hint, children, id }: { label: string; hint?: ReactNode; children: ReactNode; id: string }) {
  return (
    <div className="space-y-1">
      <label htmlFor={id} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-zinc-500">{hint}</p>}
    </div>
  );
}

/**
 * An admin-operation mutation: one `request_id` per intent (retrying the same input after a network failure
 * won't perform the action twice; after a success the next click gets a new id); after a success it
 * resets the admin cache and the space list.
 * `freshId`: a new id on every click, for issuing a token (a retry would return "already issued",
 * while the human clicks "Issue" again when they want another token).
 */
export function useAdminMutation<I extends { request_id?: string }, O>(
  fn: (input: I) => Promise<O>,
  onSuccess?: (out: O, input: Omit<I, 'request_id'>) => void,
  opts: { freshId?: boolean } = {},
) {
  const qc = useQueryClient();
  const rid = useMemo(() => requestIdFor(), []);
  return useMutation({
    mutationFn: (input: Omit<I, 'request_id'>) =>
      opts.freshId ? fn({ ...input, request_id: newRequestId() } as I) : rid.run(input, (request_id) => fn({ ...input, request_id } as I)),
    onSuccess: async (out, input) => {
      await invalidateAdmin(qc);
      onSuccess?.(out, input);
    },
  });
}

export function CopyButton({ text, label = tx.adminUi.copy }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(true);
    } catch {
      setDone(false);
    }
  };
  return (
    <button type="button" onClick={() => void copy()} className="rounded-md border border-zinc-300 px-2 py-1 text-xs hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800">
      {done ? tx.adminUi.copied : label}
    </button>
  );
}

export function RoleSelect({ value, onChange, label, id, allowEmpty }: { value: Role | ''; onChange: (r: Role | '') => void; label: string; id?: string; allowEmpty?: string }) {
  return (
    <Select id={id} aria-label={label} value={value} onChange={(e) => onChange(e.target.value as Role | '')}>
      {allowEmpty !== undefined && <option value="">{allowEmpty}</option>}
      {ROLES.map((r) => (
        <option key={r} value={r}>
          {GRANT_ROLE_LABEL[r]}
        </option>
      ))}
    </Select>
  );
}

/** Frame of an administration screen. Navigation is the sidebar only; access is checked by the route (App). */
export function AdminFrame({ title, tabs, actions, children }: { title: string; tabs?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <Page>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold">{title}</h1>
        {actions}
      </div>
      {tabs}
      {children}
    </Page>
  );
}

/** Known harnesses (owner pain 1a.2: a select, not a free-text box). Value is what the server stores. */
export const HARNESS_OPTIONS: { value: string; label: string; aliases?: string[] }[] = [
  { value: 'claude-code', label: 'Claude Code' },
  { value: 'codex', label: 'Codex' },
  { value: 'connectome', label: 'Connectome' },
  { value: 'hermes', label: 'Hermes' },
  { value: 'letta', label: 'Letta' },
  { value: 'openclaw', label: 'OpenClaw' },
  { value: 'script', label: 'Script/cron', aliases: ['cron'] },
];
const OTHER = '__other';

/** Option of a stored harness value: a known one (or its alias), else "Other". */
export function harnessChoice(value: string): string {
  if (value === '') return '';
  const v = value.toLowerCase();
  return HARNESS_OPTIONS.find((o) => o.value === v || o.aliases?.includes(v))?.value ?? OTHER;
}

/** Harness: a select of known values; "Other…" opens a text field. `value` is the stored text. */
export function HarnessField({ id, value, onChange, hint }: { id: string; value: string; onChange: (v: string) => void; hint?: string }) {
  const [other, setOther] = useState(() => harnessChoice(value) === OTHER);
  const choice = other ? OTHER : harnessChoice(value);
  return (
    <Field id={id} label={tx.principals.harness} {...(hint ? { hint } : {})}>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          id={id}
          value={choice}
          onChange={(e) => {
            const v = e.target.value;
            setOther(v === OTHER);
            // Keep the stored alias (cron) when its option is re-chosen; "Other" starts empty.
            onChange(v === OTHER ? '' : v === harnessChoice(value) && v !== '' ? value : v);
          }}
        >
          <option value="">{tx.principals.harnessNone}</option>
          {HARNESS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
          <option value={OTHER}>{tx.principals.harnessOther}</option>
        </Select>
        {other && (
          <input
            aria-label={tx.principals.harnessOtherName}
            className={`${INPUT} w-56`}
            maxLength={64}
            value={value}
            autoFocus
            onChange={(e) => onChange(e.target.value)}
          />
        )}
      </div>
    </Field>
  );
}

export function Done({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="rounded-md border border-emerald-300 bg-emerald-50 p-2 text-sm text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
      {children}
    </p>
  );
}
