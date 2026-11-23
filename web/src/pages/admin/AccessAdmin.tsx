// Groups (a tab of People & agents). The Access matrix and "Through an agent's eyes" were removed:
// their jobs are the space's Members tab and the agent's Access tab.
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { admin } from '../../api/client';
import type { AdminGroup, AdminPrincipal } from '../../api/types';
import { AdminFrame, CARD, Field, INPUT, useAdminMutation } from '../../components/admin';
import { PeopleTabs } from './PrincipalsAdmin';
import { BTN, BTN_DANGER, BTN_PRIMARY, WriteError } from '../../components/edit';
import { Badge, ErrorView, Spinner } from '../../components/ui';
import { routes } from '../../lib/routes';
import { tx } from '../../i18n';

// ---------------------------------------------------------------- groups

const NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function GroupsAdminPage() {
  const groups = useQuery({ queryKey: ['admin', 'groups'], queryFn: admin.groupList });
  const principals = useQuery({ queryKey: ['admin', 'principals'], queryFn: () => admin.principalList(true) });
  return (
    <AdminFrame title={tx.principals.title} tabs={<PeopleTabs active="groups" />}>
      <p className="text-sm text-zinc-500">{tx.access.groupsIntro}</p>
      <CreateGroup />
      {(groups.isPending || principals.isPending) && <Spinner />}
      {groups.isError && <ErrorView error={groups.error} />}
      {groups.data && principals.data && (
        <ul className="space-y-3" aria-label={tx.access.groupsTitle}>
          {groups.data.groups.map((g) => (
            <GroupCard key={g.id} g={g} principals={principals.data.principals.filter((p) => p.kind !== 'system')} />
          ))}
        </ul>
      )}
    </AdminFrame>
  );
}

function CreateGroup() {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const create = useAdminMutation(
    (i: { name: string; description?: string; request_id: string }) => admin.groupCreate(i),
    () => {
      setName('');
      setDescription('');
    },
  );
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setProblem(null);
    if (!NAME_RE.test(name.trim())) return setProblem(tx.access.groupNameRule);
    create.mutate({ name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}) });
  };
  return (
    <form onSubmit={submit} className={`${CARD} flex flex-wrap items-end gap-2`} aria-label={tx.access.newGroup}>
      <Field id="ng-name" label={tx.access.newGroup}>
        <input id="ng-name" className={`${INPUT} w-48 font-mono`} placeholder="curators" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field id="ng-desc" label={tx.common.description}>
        <input id="ng-desc" className={`${INPUT} w-64`} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <button type="submit" className={BTN_PRIMARY} disabled={create.isPending}>
        {tx.access.createGroup}
      </button>
      {problem && (
        <p role="alert" className="w-full text-sm text-red-700 dark:text-red-400">
          {problem}
        </p>
      )}
      {create.error && (
        <div className="w-full">
          <WriteError error={create.error} />
        </div>
      )}
    </form>
  );
}

function GroupCard({ g, principals }: { g: AdminGroup; principals: AdminPrincipal[] }) {
  const [editing, setEditing] = useState(false);
  const [members, setMembers] = useState<string[]>(g.members);
  const [description, setDescription] = useState(g.description);
  const [newName, setNewName] = useState(g.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const setM = useAdminMutation((i: { name: string; members: string[]; request_id: string }) => admin.groupMembersSet(i), () => setEditing(false));
  const update = useAdminMutation((i: { name: string; new_name?: string; description?: string; request_id: string }) => admin.groupUpdate(i), () => setEditing(false));
  const del = useAdminMutation((i: { name: string; request_id: string }) => admin.groupDelete(i));
  const disabled = new Set(principals.filter((p) => p.disabled).map((p) => p.name));
  // Only active people and agents can be added (owner pain 1b.2); disabled members stay listed, greyed, to remove.
  const active = principals.filter((p) => !p.disabled);
  const save = () => {
    const changedMeta = description !== g.description || newName.trim() !== g.name;
    if (changedMeta) update.mutate({ name: g.name, ...(newName.trim() !== g.name ? { new_name: newName.trim() } : {}), ...(description !== g.description ? { description } : {}) });
    const sorted = (a: string[]) => [...a].sort().join(',');
    if (!g.system && sorted(members) !== sorted(g.members)) setM.mutate({ name: changedMeta && newName.trim() !== g.name ? newName.trim() : g.name, members });
    if (!changedMeta && sorted(members) === sorted(g.members)) setEditing(false);
  };
  const error = setM.error ?? update.error ?? del.error;
  const toggle = (n: string, on: boolean) => setMembers((m) => (on ? [...m, n] : m.filter((x) => x !== n)));
  const pickers: [string, AdminPrincipal[]][] = [
    [tx.principals.agents, active.filter((p) => p.kind === 'agent')],
    [tx.principals.people, active.filter((p) => p.kind === 'human')],
  ];
  const disabledMembers = members.filter((n) => disabled.has(n));
  return (
    <li className={`${CARD} space-y-2`} aria-label={tx.access.group(g.name)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{g.name}</span>
        {g.system && <Badge>{tx.access.system}</Badge>}
        {g.description && <span className="text-sm text-zinc-500">{g.description}</span>}
      </div>
      <p className="text-sm">
        <span className="text-zinc-500">{tx.access.membersPrefix}</span>
        {g.members.length === 0
          ? tx.common.none
          : g.members.map((n, i) => (
              <span key={n}>
                {i > 0 && ', '}
                {disabled.has(n) ? <span className="text-zinc-400 line-through dark:text-zinc-500" title={tx.access.disabledMember}>{n}</span> : n}
              </span>
            ))}
      </p>
      {!editing && !g.system && (
        <div className="flex gap-2">
          <button type="button" className={BTN} onClick={() => setEditing(true)}>
            {tx.access.edit}
          </button>
          {confirmDelete ? (
            <button type="button" className={BTN_DANGER} onClick={() => del.mutate({ name: g.name })}>
              {tx.access.deleteGroup}
            </button>
          ) : (
            <button type="button" className={BTN} onClick={() => setConfirmDelete(true)}>
              {tx.access.deleteEllipsis}
            </button>
          )}
        </div>
      )}
      {editing && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <Field id={`g-name-${g.id}`} label={tx.common.name}>
              <input id={`g-name-${g.id}`} className={`${INPUT} w-48`} value={newName} onChange={(e) => setNewName(e.target.value)} />
            </Field>
            <Field id={`g-desc-${g.id}`} label={tx.common.description}>
              <input id={`g-desc-${g.id}`} className={`${INPUT} w-64`} value={description} onChange={(e) => setDescription(e.target.value)} />
            </Field>
          </div>
          {pickers.map(([title, list]) => (
            <fieldset key={title} className="space-y-1">
              <legend className="text-sm font-medium">{tx.access.membersOf(title)}</legend>
              <div className="flex flex-wrap gap-x-4 gap-y-1">
                {[...list]
                  .sort((a, b) => a.name.localeCompare(b.name))
                  .map((p) => (
                    <label key={p.id} className="flex items-center gap-1.5 text-sm">
                      <input type="checkbox" checked={members.includes(p.name)} onChange={(e) => toggle(p.name, e.target.checked)} />
                      {p.name}
                    </label>
                  ))}
                {list.length === 0 && <span className="text-sm text-zinc-500">{tx.common.none}</span>}
              </div>
            </fieldset>
          ))}
          {disabledMembers.length > 0 && (
            <ul className="space-y-1" aria-label={tx.access.disabledMembers}>
              {disabledMembers.map((n) => (
                <li key={n} className="flex items-center gap-2 text-sm text-zinc-400 dark:text-zinc-500">
                  <span>{n}</span>
                  <button type="button" className="text-xs hover:underline" onClick={() => toggle(n, false)} aria-label={tx.access.removeDisabled(n)}>
                    {tx.access.disabledRemove}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <button type="button" className={BTN_PRIMARY} onClick={save} disabled={setM.isPending || update.isPending}>
              {tx.access.saveGroup}
            </button>
            <button type="button" className={BTN} onClick={() => setEditing(false)}>
              {tx.common.cancel}
            </button>
          </div>
        </div>
      )}
      {error && <WriteError error={error} />}
    </li>
  );
}

// The Access matrix and "Through an agent's eyes" are gone from the UI:
// a space's Members tab and an agent's Access tab do their job. Old links land there.

/** `/admin/explain?principal=x` → that principal's Access tab; without one → People & agents. */
export function ExplainRedirect() {
  const [params] = useSearchParams();
  const p = params.get('principal');
  return <Navigate to={p ? routes.admin.principal(p, 'access') : routes.admin.principals()} replace />;
}
