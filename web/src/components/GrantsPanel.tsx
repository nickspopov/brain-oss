// Grants: the list of grants for a space or a subject, changing the role, removal, a new grant on
// a space, folder or document. A narrower level both narrows and widens: this is stated next to it.
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { admin } from '../api/client';
import type { AdminGrant, GrantKey, Role, Scope, Subject } from '../api/types';
import { folderPrefix, GRANT_ROLE_LABEL, subjectKey, targetText } from '../lib/admin';
import { routes } from '../lib/routes';
import { INPUT, RoleSelect, useAdminMutation } from './admin';
import { Select } from './controls';
import { BTN, BTN_PRIMARY, WriteError } from './edit';
import { Badge, ErrorView, Spinner } from './ui';
import { tx } from '../i18n';

export function grantKey(g: AdminGrant): GrantKey {
  return {
    space: g.space,
    scope: g.scope,
    subject: g.subject,
    ...(g.path_prefix !== null ? { path_prefix: g.path_prefix } : {}),
    ...(g.doc_id !== null ? { doc_id: g.doc_id } : {}),
  };
}

export function SubjectLabel({ subject }: { subject: Subject }) {
  return subject.type === 'group' ? (
    <span>
      <span className="text-xs text-zinc-500">{tx.grants.groupPrefix}</span>
      <span className="font-medium">{subject.name}</span>
    </span>
  ) : (
    <Link className="font-medium text-sky-700 hover:underline dark:text-sky-400" to={routes.admin.principal(subject.name)}>
      {subject.name}
    </Link>
  );
}

/** A grant row: the role changes immediately, removal takes a second click. */
export function GrantRow({ g, showSpace, showSubject }: { g: AdminGrant; showSpace?: boolean; showSubject?: boolean }) {
  const set = useAdminMutation((i: GrantKey & { role: Role; request_id: string }) => admin.grantSet(i));
  const remove = useAdminMutation((i: GrantKey & { request_id: string }) => admin.grantRemove(i));
  const [confirm, setConfirm] = useState(false);
  const label = `${showSpace ? `${g.space}: ` : ''}${targetText(g)}${showSubject !== false ? ` — ${subjectKey(g.subject)}` : ''}`;
  return (
    <li className="flex flex-wrap items-center gap-2 py-1.5">
      {showSpace && <span className="font-mono text-sm">{g.space}</span>}
      <span className="text-sm">{targetText(g)}</span>
      {showSubject !== false && <SubjectLabel subject={g.subject} />}
      <RoleSelect label={tx.grants.roleFor(label)} value={g.role} onChange={(r) => r && set.mutate({ ...grantKey(g), role: r })} />
      {g.role === 'none' && <Badge tone="warn">{tx.grants.explicitDeny}</Badge>}
      {confirm ? (
        <button type="button" className={BTN} onClick={() => remove.mutate(grantKey(g))}>
          {tx.grants.remove}
        </button>
      ) : (
        <button type="button" className="text-xs text-zinc-500 hover:underline" onClick={() => setConfirm(true)} aria-label={tx.grants.removeFor(label)}>
          {tx.grants.removeEllipsis}
        </button>
      )}
      {(set.error || remove.error) && <WriteError error={set.error ?? remove.error} />}
    </li>
  );
}

/** Subjects to pick: groups and active people and agents — disabled ones are never offered. */
export function useSubjects() {
  const principals = useQuery({ queryKey: ['admin', 'principals'], queryFn: () => admin.principalList(true) });
  const groups = useQuery({ queryKey: ['admin', 'groups'], queryFn: admin.groupList });
  const subjects: Subject[] = [
    ...(groups.data?.groups ?? []).map((g) => ({ type: 'group' as const, name: g.name })),
    ...(principals.data?.principals ?? []).filter((p) => p.kind !== 'system' && !p.disabled).map((p) => ({ type: 'principal' as const, name: p.name })),
  ];
  return { subjects, pending: principals.isPending || groups.isPending, error: principals.error ?? groups.error };
}

/** The new-grant form. `space` or `subject` may be fixed by the page. */
export function GrantForm({ space, subject, spaces }: { space?: string; subject?: Subject; spaces?: string[] }) {
  const { subjects } = useSubjects();
  const [spaceSel, setSpace] = useState(space ?? '');
  const [subj, setSubj] = useState(subject ? subjectKey(subject) : '');
  const [scope, setScope] = useState<Scope>('space');
  const [target, setTarget] = useState('');
  const [role, setRole] = useState<Role | ''>('read');
  const [problem, setProblem] = useState<string | null>(null);
  const set = useAdminMutation(
    (i: GrantKey & { role: Role; request_id: string }) => admin.grantSet(i),
    () => setTarget(''),
  );

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    const sp = space ?? spaceSel;
    const s = subject ?? subjects.find((x) => subjectKey(x) === subj);
    if (!sp) return setProblem(tx.grants.chooseSpace);
    if (!s) return setProblem(tx.grants.chooseSubject);
    if (!role) return setProblem(tx.grants.chooseRole);
    const key: GrantKey = { space: sp, scope, subject: s };
    if (scope === 'path') {
      const p = folderPrefix(target);
      if (!p) return setProblem(tx.grants.enterFolder);
      key.path_prefix = p;
    } else if (scope === 'doc') {
      if (!target.trim()) return setProblem(tx.grants.enterDocId);
      key.doc_id = target.trim();
    }
    set.mutate({ ...key, role });
  };
  const idp = `grant-${space ?? ''}-${subject ? subjectKey(subject) : ''}`;
  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2" aria-label={tx.grants.grantForm}>
      {!space && (
        <Select aria-label={tx.common.space} value={spaceSel} onChange={(e) => setSpace(e.target.value)}>
          <option value="">{tx.grants.spacePlaceholder}</option>
          {(spaces ?? []).map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      )}
      {!subject && (
        <Select aria-label={tx.grants.subject} value={subj} onChange={(e) => setSubj(e.target.value)}>
          <option value="">{tx.grants.subjectPlaceholder}</option>
          {subjects.map((s) => (
            <option key={subjectKey(s)} value={subjectKey(s)}>
              {s.type === 'group' ? tx.grants.group(s.name) : s.name}
            </option>
          ))}
        </Select>
      )}
      <Select aria-label={tx.grants.level} value={scope} onChange={(e) => setScope(e.target.value as Scope)}>
        <option value="space">{tx.grants.wholeSpace}</option>
        <option value="path">{tx.grants.folder}</option>
        <option value="doc">{tx.grants.docById}</option>
      </Select>
      {scope !== 'space' && (
        <input
          id={`${idp}-target`}
          aria-label={scope === 'path' ? tx.grants.folderLabel : tx.grants.docId}
          className={`${INPUT} w-48 font-mono`}
          value={target}
          placeholder={scope === 'path' ? 'drafts' : '01…'}
          onChange={(e) => setTarget(e.target.value)}
        />
      )}
      <RoleSelect label={tx.grants.role} value={role} onChange={setRole} />
      <button type="submit" className={BTN_PRIMARY} disabled={set.isPending}>
        {tx.grants.grant}
      </button>
      {problem && (
        <p role="alert" className="w-full text-sm text-red-700 dark:text-red-400">
          {problem}
        </p>
      )}
      {set.error && (
        <div className="w-full">
          <WriteError error={set.error} />
        </div>
      )}
      {set.isSuccess && !problem && (
        <p role="status" className="w-full text-sm text-emerald-700 dark:text-emerald-400">
          {tx.grants.granted(GRANT_ROLE_LABEL[set.data.grant.role], targetText(set.data.grant), subjectKey(set.data.grant.subject))}
        </p>
      )}
    </form>
  );
}

/** Grants of one space or one subject, with an add form. */
export function GrantsPanel({ space, subject, spaces }: { space?: string; subject?: Subject; spaces?: string[] }) {
  const q = useQuery({
    queryKey: ['admin', 'grants', space ?? null, subject ? subjectKey(subject) : null],
    queryFn: () => admin.grantList({ ...(space ? { space } : {}), ...(subject ? { subject } : {}) }),
  });
  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-500">
        {tx.grants.howItWorks}
      </p>
      {q.isPending && <Spinner />}
      {q.isError && <ErrorView error={q.error} />}
      {q.data && q.data.grants.length === 0 && <p className="text-sm text-zinc-500">{tx.grants.noGrants(Boolean(space))}</p>}
      {q.data && q.data.grants.length > 0 && (
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800" aria-label={tx.grants.list}>
          {q.data.grants.map((g) => (
            <GrantRow key={g.id} g={g} showSpace={!space} showSubject={!subject} />
          ))}
        </ul>
      )}
      <GrantForm {...(space ? { space } : {})} {...(subject ? { subject } : {})} {...(spaces ? { spaces } : {})} />
    </div>
  );
}
