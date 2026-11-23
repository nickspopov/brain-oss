// The space's Members tab: a table — name · People/Agent · role · ⋯ —
// with the ladder Guest · Viewer · Editor · Admin, an "Add member" picker of active people, agents and
// groups, and one line "Only these N can see this space". Folder/document access lives under "Advanced
// access". The role shown is the engine's (admin_space_members); changing it sets the member's own
// space-level access rule, nothing else.
import { useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { admin } from '../../api/client';
import type { GrantKey, Role, SpaceMember, SpaceMembersOut } from '../../api/types';
import { useAdminMutation } from '../../components/admin';
import { Combobox, Menu, MENU_ITEM, Select, type ComboOption } from '../../components/controls';
import { BTN, BTN_PRIMARY, WriteError } from '../../components/edit';
import { GrantsPanel } from '../../components/GrantsPanel';
import { Badge, ErrorView, Spinner } from '../../components/ui';
import { accessWords, ENGINE_ROLE, LADDER_LABEL, ladderOptions, requiresApproval } from '../../lib/roles';
import { routes } from '../../lib/routes';
import { tx } from '../../i18n';

const t = tx.members;
type Option = ReturnType<typeof ladderOptions>[number];

export function SpaceMembers({ space }: { space: string }) {
  const q = useQuery({ queryKey: ['admin', 'members', space], queryFn: () => admin.spaceMembers(space) });
  const [showDisabled, setShowDisabled] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <ErrorView error={q.error} />;
  const d = q.data;
  const disabled = d.members.filter((m) => m.disabled).length;
  const rows = d.members.filter((m) => showDisabled || !m.disabled);
  return (
    <div className="space-y-4">
      <p className="text-sm">{t.canSee(d.can_see)}</p>
      <AddMember d={d} />
      {disabled > 0 && (
        <label className="flex items-center gap-1.5 text-sm text-zinc-600 dark:text-zinc-400">
          <input type="checkbox" checked={showDisabled} onChange={(e) => setShowDisabled(e.target.checked)} />
          {t.showDisabled(disabled)}
        </label>
      )}
      <table className="w-full border-collapse text-sm" aria-label={t.title}>
        <thead>
          <tr className="border-b border-zinc-200 text-left text-xs text-zinc-500 dark:border-zinc-800">
            <th scope="col" className="py-1.5 pr-3 font-medium">
              {t.name}
            </th>
            <th scope="col" className="py-1.5 pr-3 font-medium">
              {t.type}
            </th>
            <th scope="col" className="py-1.5 pr-3 font-medium">
              {t.role}
            </th>
            <th scope="col" className="w-10 py-1.5">
              <span className="sr-only">{tx.spacePage.more}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {rows.map((m) => (
            <MemberRow key={m.name} m={m} d={d} onCustom={() => setAdvanced(true)} />
          ))}
        </tbody>
      </table>
      {!requiresApproval(d.space) && <p className="text-xs text-zinc-500">{t.proposerHint}</p>}
      <details open={advanced} onToggle={(e) => setAdvanced((e.target as HTMLDetailsElement).open)} className="rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
        <summary className="cursor-pointer font-medium">{t.advanced}</summary>
        <p className="mt-1 text-xs text-zinc-500">{t.advancedHint}</p>
        {advanced && (
          <div className="mt-3">
            <GrantsPanel space={space} />
          </div>
        )}
      </details>
    </div>
  );
}

function kindLabel(kind: SpaceMember['kind']): string {
  return kind === 'human' ? t.person : t.agent;
}

/** One member: name (and what it does), People/Agent, role select, ⋯ remove. */
function MemberRow({ m, d, onCustom }: { m: SpaceMember; d: SpaceMembersOut; onCustom: () => void }) {
  const a = m.access;
  const w = accessWords(a);
  const key: GrantKey = { space: d.space.slug, scope: 'space', subject: { type: 'principal', name: m.name } };
  const set = useAdminMutation((i: GrantKey & { role: Role; request_id: string }) => admin.grantSet(i));
  const remove = useAdminMutation((i: GrantKey & { request_id: string }) => admin.grantRemove(i));
  const [confirm, setConfirm] = useState(false);
  // The role can be changed where the member's own space-level rule (or a group) decides it.
  const editable = !a.superadmin && !a.external_as_guest && a.role !== 'none';
  const groupOnly = a.personal === null && a.groups.length > 0;
  const options = ladderOptions({ messages: d.space.inbox, approval: requiresApproval(d.space), current: a.role });
  return (
    <tr className={m.disabled ? 'text-zinc-400 dark:text-zinc-500' : ''}>
      <td className="py-2 pr-3 align-top">
        <Link to={routes.admin.principal(m.name)} className="font-medium text-sky-700 hover:underline dark:text-sky-400">
          {m.display_name || m.name}
        </Link>
        {m.display_name !== m.name && <span className="ml-1.5 text-zinc-500">{m.name}</span>}
        {m.external && (
          <span className="ml-1.5">
            <Badge tone="warn">{tx.principals.externalBadge}</Badge>
          </span>
        )}
        {m.disabled && (
          <span className="ml-1.5">
            <Badge tone="danger">{t.disabled}</Badge>
          </span>
        )}
        {m.what_i_do && <p className="text-xs text-zinc-500">{m.what_i_do}</p>}
      </td>
      <td className="py-2 pr-3 align-top text-zinc-600 dark:text-zinc-400">{kindLabel(m.kind)}</td>
      <td className="py-2 pr-3 align-top">
        <div className="flex flex-wrap items-center gap-1.5">
          {editable ? (
            <Select
              aria-label={t.roleFor(m.name)}
              value={a.role}
              disabled={set.isPending}
              onChange={(e) => {
                const next = e.target.value as Option;
                if (next !== a.role) set.mutate({ ...key, role: ENGINE_ROLE[next] });
              }}
            >
              {options.map((o) => (
                <option key={o} value={o}>
                  {LADDER_LABEL[o]}
                </option>
              ))}
            </Select>
          ) : (
            <span>{a.superadmin ? t.superadminRow : w.role}</span>
          )}
          {a.messages_only && <span className="text-xs text-zinc-500">{w.note}</span>}
          {a.custom && (
            <button type="button" onClick={onCustom} className="text-xs" title={tx.members.advancedHint}>
              <Badge tone="warn">{tx.roles.custom}</Badge>
            </button>
          )}
          {w.via && !a.superadmin && <span className="text-xs text-zinc-500">{w.via}</span>}
        </div>
        {a.external_as_guest && <p className="text-xs text-zinc-500">{t.externalGuestRow}</p>}
        {(set.error || remove.error) && <WriteError error={set.error ?? remove.error} />}
      </td>
      <td className="py-2 align-top">
        {!a.superadmin && (
          <Menu label={t.more(m.name)} button="⋯" buttonClass="rounded px-2 py-0.5 text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800">
            {(close) =>
              a.personal === null ? (
                <p className="px-3 py-1.5 text-sm text-zinc-500">{groupOnly ? t.viaGroupOnly(a.groups.map((g) => g.name).join(', ')) : tx.members.advancedHint}</p>
              ) : confirm ? (
                <button
                  role="menuitem"
                  type="button"
                  className={`${MENU_ITEM} text-red-700 dark:text-red-400`}
                  onClick={() => {
                    remove.mutate(key);
                    setConfirm(false);
                    close();
                  }}
                >
                  {t.removeConfirm(m.display_name || m.name)}
                </button>
              ) : (
                <button role="menuitem" type="button" className={MENU_ITEM} onClick={() => setConfirm(true)}>
                  {t.remove}…
                </button>
              )
            }
          </Menu>
        )}
      </td>
    </tr>
  );
}

/** "Add member": active people, agents and groups (all-agents never where it gives nothing), with a role. */
function AddMember({ d }: { d: SpaceMembersOut }) {
  const [pick, setPick] = useState('');
  const [role, setRole] = useState<Option>('viewer');
  const [done, setDone] = useState<string | null>(null);
  const add = useAdminMutation(
    (i: GrantKey & { role: Role; request_id: string }) => admin.grantSet(i),
    (_o, i) => {
      setDone(t.added(i.subject.name));
      setPick('');
    },
  );
  const options: ComboOption[] = d.candidates.map((c) => ({
    value: `${c.type}:${c.name}`,
    label: c.display_name || c.name,
    detail: `· ${c.display_name !== c.name ? `${c.name} · ` : ''}${c.kind === 'group' ? t.group : c.kind === 'human' ? t.person : t.agent}`,
    ...(c.external ? { badge: <Badge tone="warn">{tx.principals.externalBadge}</Badge> } : {}),
  }));
  const chosen = d.candidates.find((c) => `${c.type}:${c.name}` === pick);
  const roles = ladderOptions({ messages: d.space.inbox, approval: requiresApproval(d.space), group: chosen?.type === 'group' });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!chosen) return;
    setDone(null);
    const r = roles.includes(role) ? role : 'viewer';
    add.mutate({ space: d.space.slug, scope: 'space', subject: { type: chosen.type, name: chosen.name }, role: ENGINE_ROLE[r] });
  };
  return (
    <form onSubmit={submit} className="flex flex-wrap items-center gap-2" aria-label={t.add}>
      <div className="min-w-64 flex-1">
        <Combobox id={`add-member-${d.space.slug}`} label={t.addPicker} options={options} value={pick} onChange={setPick} placeholder={t.addPlaceholder} empty={t.nobody} />
      </div>
      <Select aria-label={t.addRole} value={role} onChange={(e) => setRole(e.target.value as Option)}>
        {roles.map((o) => (
          <option key={o} value={o}>
            {LADDER_LABEL[o]}
          </option>
        ))}
      </Select>
      <button type="submit" className={pick ? BTN_PRIMARY : BTN} disabled={!chosen || add.isPending}>
        {t.add}
      </button>
      {done && (
        <p role="status" className="w-full text-sm text-emerald-700 dark:text-emerald-400">
          {done}
        </p>
      )}
      {add.error && (
        <div className="w-full">
          <WriteError error={add.error} />
        </div>
      )}
    </form>
  );
}
