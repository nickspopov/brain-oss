import { describe, expect, it } from 'vitest';
import { formatUntil } from '../src/lib/format';
import { splitFrontmatter } from '../src/lib/frontmatter';
import { segments } from '../src/lib/highlight';
import { resolveDocLink, routes } from '../src/lib/routes';
import { safeNext } from '../src/pages/LoginPage';

describe('segments (search highlight)', () => {
  it('splits text into marked and plain parts', () => {
    expect(segments('plan handover tasks', [[5, 13]])).toEqual([
      { text: 'plan ', mark: false },
      { text: 'handover', mark: true },
      { text: ' tasks', mark: false },
    ]);
  });
  it('merges overlapping ranges, sorts and clamps out-of-range offsets', () => {
    expect(segments('abcdef', [[4, 99], [0, 2], [1, 3]])).toEqual([
      { text: 'abc', mark: true },
      { text: 'd', mark: false },
      { text: 'ef', mark: true },
    ]);
    expect(segments('abc', [[2, 2], [-5, 0]])).toEqual([{ text: 'abc', mark: false }]);
    expect(segments('', [])).toEqual([]);
  });
  it('keeps markup in the snippet as text', () => {
    const s = segments('<b>x</b>', [[3, 4]]);
    expect(s.map((p) => p.text).join('')).toBe('<b>x</b>');
  });
});

describe('routes and links', () => {
  it('encodes each path segment but keeps slashes', () => {
    expect(routes.doc('proj-alpha', 'café/plan 1.md')).toBe('/s/proj-alpha/d/caf%C3%A9/plan%201.md');
    expect(routes.doc('s', 'a#b?.md', 3)).toBe('/s/s/d/a%23b%3F.md?rev=3');
    expect(routes.search('a b', 'shared')).toBe('/search?q=a+b&space=shared');
  });
  it('resolves relative links against the folder of the document', () => {
    expect(resolveDocLink('a/b/c.md', 'd.md')).toEqual({ path: 'a/b/d.md', hash: '' });
    expect(resolveDocLink('a/b/c.md', '../x/y.md#h')).toEqual({ path: 'a/x/y.md', hash: '#h' });
    expect(resolveDocLink('a/b/c.md', '/root.md?x=1')).toEqual({ path: 'root.md', hash: '' });
    expect(resolveDocLink('c.md', './%C3%A9.md')).toEqual({ path: 'é.md', hash: '' });
  });
  it('external, anchor-only and escaping links are not documents', () => {
    for (const href of ['https://x.y', '//x.y/a', 'mailto:a@b', 'javascript:alert(1)', '#top', '', '../../up.md', '%E0%A4%A']) {
      expect(resolveDocLink('a/c.md', href), href).toBeNull();
    }
  });
});

describe('frontmatter', () => {
  it('is split off the body', () => {
    expect(splitFrontmatter('---\ntags: [a]\n---\n# T\n')).toEqual({ frontmatter: 'tags: [a]', body: '# T\n' });
    expect(splitFrontmatter('# no fm\n---\n')).toEqual({ frontmatter: null, body: '# no fm\n---\n' });
  });
});

describe('formatUntil (TTL)', () => {
  const now = Date.parse('2026-11-14T00:00:00Z');
  it('speaks in hours and days', () => {
    expect(formatUntil('2026-11-14T05:00:00Z', now)).toBe('in 5 hours');
    expect(formatUntil('2026-11-17T00:00:00Z', now)).toBe('in 3 days');
    expect(formatUntil('2026-11-13T00:00:00Z', now)).toBe('expired');
  });
});

describe('login redirect', () => {
  it('returns only to own paths', () => {
    expect(safeNext('/s/x/d/a.md?rev=2')).toBe('/s/x/d/a.md?rev=2');
    for (const bad of [null, 'https://evil.example', '//evil.example', '/\\evil.example', '/login?next=/x', 'javascript:alert(1)']) {
      expect(safeNext(bad)).toBe('/');
    }
  });
});
