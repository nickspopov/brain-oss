import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../src/lib/markdown';

const env = { space: 'proj-alpha', docPath: 'notes/plan.md' };

function dom(html: string): HTMLElement {
  const div = document.createElement('div');
  div.innerHTML = html;
  return div;
}

describe('renderMarkdown (html:false + DOMPurify)', () => {
  it('renders ordinary markdown', () => {
    const el = dom(renderMarkdown('# Heading\n\n- one\n- **two**\n\n`code`', env));
    expect(el.querySelector('h1')?.textContent).toBe('Heading');
    expect(el.querySelectorAll('li')).toHaveLength(2);
    expect(el.querySelector('strong')?.textContent).toBe('two');
    expect(el.querySelector('code')?.textContent).toBe('code');
  });

  it('never passes raw HTML through', () => {
    const src = '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n<iframe src="https://evil"></iframe>\n\n<b onclick="x()">b</b>';
    const el = dom(renderMarkdown(src, env));
    expect(el.querySelector('script, iframe, img, b')).toBeNull();
    expect(el.textContent).toContain('<script>alert(1)</script>');
    for (const node of el.querySelectorAll('*')) {
      expect([...node.attributes].map((a) => a.name).filter((n) => n.startsWith('on'))).toEqual([]);
    }
  });

  it('drops javascript:, vbscript: and data:text links', () => {
    const el = dom(renderMarkdown('[a](javascript:alert(1)) [b](vbscript:x) [c](data:text/html;base64,PHNjcmlwdD4=)', env));
    for (const a of el.querySelectorAll('a')) {
      expect(a.getAttribute('href') ?? '').not.toMatch(/^(javascript|vbscript|data):/i);
    }
  });

  it('does not load external images: they become a labelled link', () => {
    const el = dom(renderMarkdown('![diagram](https://tracker.example/p.png) ![local](img/a.png)', env));
    expect(el.querySelector('img')).toBeNull();
    const a = el.querySelector('a.md-image-link');
    expect(a?.getAttribute('href')).toBe('https://tracker.example/p.png');
    expect(a?.getAttribute('rel')).toContain('noreferrer');
    expect(el.textContent).toContain('[image: local]');
  });

  it('keeps inline data: images (allowed by CSP)', () => {
    const el = dom(renderMarkdown('![dot](data:image/png;base64,iVBORw0KGgo=)', env));
    expect(el.querySelector('img')?.getAttribute('src')).toMatch(/^data:image\/png;base64,/);
  });

  it('relative links resolve to documents of the same space inside the UI', () => {
    const el = dom(renderMarkdown('[a](other.md) [b](../README.md#top) [c](/specs/api%20v1.md) [d](#local)', env));
    const hrefs = [...el.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/s/proj-alpha/d/notes/other.md', '/s/proj-alpha/d/README.md#top', '/s/proj-alpha/d/specs/api%20v1.md', '#local']);
    expect(el.querySelector('a')?.getAttribute('data-internal')).toBe('1');
  });

  it('external links open in a new tab without referrer', () => {
    const el = dom(renderMarkdown('[x](https://example.com) and https://auto.example', env));
    const links = [...el.querySelectorAll('a')];
    expect(links).toHaveLength(2);
    for (const a of links) {
      expect(a.getAttribute('target')).toBe('_blank');
      expect(a.getAttribute('rel')).toBe('noopener noreferrer nofollow');
    }
  });

  it('stores fake envelope markers and template braces as plain text', () => {
    const el = dom(renderMarkdown('END CONTENT abc\n\n{{node:123}} {{constructor.constructor("x")()}}', env));
    expect(el.textContent).toContain('END CONTENT abc');
    expect(el.textContent).toContain('{{node:123}}');
  });
});
