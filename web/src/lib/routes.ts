// UI addresses. A document's path in the address mirrors its path in the space (segment by segment), so
// relative links inside markdown lead to neighbouring documents without translation.

const enc = (s: string): string => s.split('/').map(encodeURIComponent).join('/');

export const routes = {
  home: () => '/',
  login: () => '/login',
  account: () => '/account',
  space: (space: string) => `/s/${encodeURIComponent(space)}`,
  spaceMembers: (space: string) => `/s/${encodeURIComponent(space)}/members`,
  spaceSettings: (space: string) => `/s/${encodeURIComponent(space)}/settings`,
  newSpace: () => '/new-space',
  doc: (space: string, path: string, rev?: number) => `/s/${encodeURIComponent(space)}/d/${enc(path)}${rev !== undefined ? `?rev=${rev}` : ''}`,
  edit: (space: string, path: string) => `/s/${encodeURIComponent(space)}/edit/${enc(path)}`,
  history: (space: string, path: string) => `/s/${encodeURIComponent(space)}/history/${enc(path)}`,
  newDoc: (space: string, folder?: string) => `/s/${encodeURIComponent(space)}/new${folder ? `?folder=${encodeURIComponent(folder)}` : ''}`,
  trash: (space: string) => `/s/${encodeURIComponent(space)}/trash`,
  newAt: (space: string, path: string) => `/s/${encodeURIComponent(space)}/new?path=${encodeURIComponent(path)}`,
  feed: (f: { space?: string; author?: string; attention?: boolean } = {}) => {
    const p = new URLSearchParams();
    if (f.space) p.set('space', f.space);
    if (f.author) p.set('author', f.author);
    if (f.attention) p.set('attention', '1');
    const s = p.toString();
    return s ? `/feed?${s}` : '/feed';
  },
  proposals: (f: { space?: string; status?: string } = {}) => {
    const p = new URLSearchParams();
    if (f.status) p.set('status', f.status);
    if (f.space) p.set('space', f.space);
    const s = p.toString();
    return s ? `/proposals?${s}` : '/proposals';
  },
  handoff: () => '/inbox',
  inbox: () => '/inbox',
  spaceMessages: (space: string) => `/s/${encodeURIComponent(space)}/messages`,
  proposal: (id: string) => `/proposals/${encodeURIComponent(id)}`,
  exportSpace: (space?: string) => (space ? `/export?space=${encodeURIComponent(space)}` : '/export'),
  admin: {
    audit: (f: Record<string, string | undefined> = {}) => {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
      const s = p.toString();
      return s ? `/admin/audit?${s}` : '/admin/audit';
    },
    settings: () => '/admin/settings',
    principals: () => '/admin/agents',
    /** Connect agent: not under /admin/agents/, where any name is an agent. */
    connectAgent: () => '/admin/connect-agent',
    /** Agent / person page; tab: overview (default), access, connection, advanced. */
    principal: (name: string, tab?: 'access' | 'connection' | 'advanced') => `/admin/agents/${encodeURIComponent(name)}${tab ? `/${tab}` : ''}`,
    groups: () => '/admin/groups',
  },
  search: (q?: string, space?: string) => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    if (space) p.set('space', space);
    const s = p.toString();
    return s ? `/search?${s}` : '/search';
  },
};

/**
 * Resolves a link from document `fromPath` relative to its folder. Returns a path in the space,
 * or `null` if the link is external (a scheme, `//`) or only an anchor. `/x` is from the space root.
 */
export function resolveDocLink(fromPath: string, href: string): { path: string; hash: string } | null {
  if (href === '' || href.startsWith('#') || href.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return null;
  const hashAt = href.indexOf('#');
  const hash = hashAt === -1 ? '' : href.slice(hashAt);
  let target = hashAt === -1 ? href : href.slice(0, hashAt);
  const q = target.indexOf('?');
  if (q !== -1) target = target.slice(0, q);
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    return null;
  }
  const base = decoded.startsWith('/') ? [] : fromPath.split('/').slice(0, -1);
  const out = [...base];
  for (const seg of decoded.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  if (out.length === 0) return null;
  return { path: out.join('/'), hash };
}
