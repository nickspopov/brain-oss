// Content, frontmatter and the Yjs body.
import { describe, expect, it } from 'vitest';
import { normalizeText, sliceUtf8, sniffMime, textMime, decodeBase64 } from '../../src/core/content.js';
import { headingsOf, parseText } from '../../src/core/frontmatter.js';
import { applyText, yText } from '../../src/core/ydoc/body.js';
import { OpError } from '../../src/core/errors.js';

describe('content', () => {
  it('normalizes line endings and keeps everything else byte for byte', () => {
    expect(normalizeText('a\r\nb\rc\n')).toBe('a\nb\nc\n');
    const odd = 'tabs\tand ‮rtl‬ zero​width 🧠 {{x}} <script>\n';
    expect(normalizeText(odd)).toBe(odd);
  });

  it('rejects NUL and lone surrogates without echoing the input', () => {
    for (const bad of ['a\u0000b', 'x\ud800y', '\udc00']) {
      try {
        normalizeText(bad);
        throw new Error('expected a failure');
      } catch (e) {
        expect(e).toBeInstanceOf(OpError);
        expect((e as OpError).code).toBe('invalid_input');
        expect(JSON.stringify((e as OpError).details)).not.toContain(bad);
      }
    }
    expect(normalizeText('ok 🧠')).toBe('ok 🧠');
  });

  it('slices UTF-8 by bytes without splitting a character', () => {
    const text = 'αβ🧠γ';
    const all: string[] = [];
    let offset: number | undefined = 0;
    while (offset !== undefined) {
      const part: { text: string; next?: number } = sliceUtf8(text, offset, 5);
      all.push(part.text);
      offset = part.next;
    }
    expect(all.join('')).toBe(text);
    for (const p of all) expect(p).not.toContain('�');
  });

  it('detects MIME by signature, not by extension', () => {
    expect(sniffMime(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe('image/png');
    expect(sniffMime(Buffer.from('%PDF-1.7'))).toBe('application/pdf');
    expect(sniffMime(Buffer.from('<html>'))).toBe('application/octet-stream');
    expect(textMime('a/b.md')).toBe('text/markdown');
    expect(textMime('a/b.txt')).toBe('text/plain');
  });

  it('accepts only strict base64', () => {
    expect(decodeBase64('aGVsbG8=').toString()).toBe('hello');
    expect(() => decodeBase64('not base64!')).toThrow(OpError);
  });
});

describe('frontmatter', () => {
  it('reads title, tags and meta; title falls back to # heading, then the file name', () => {
    const p = parseText('---\ntitle: Plan\ntags: [a, b]\nowner: alice\n---\n# Heading\n\ntext\n', 'x/plan.md');
    expect(p.title).toBe('Plan');
    expect(p.tags).toEqual(['a', 'b']);
    expect(p.meta).toMatchObject({ owner: 'alice' });
    expect(p.warnings).toEqual([]);
    expect(parseText('# Heading\n', 'x/plan.md').title).toBe('Heading');
    expect(parseText('no heading\n', 'x/plan.md').title).toBe('plan');
  });

  it('invalid YAML and YAML tags do not block the write: warning, empty meta', () => {
    for (const fm of ['title: [unclosed\n', 'title: !!js/function "f(){}"\n', 'a: !custom x\n', 'a: 1\na: 2\n']) {
      const p = parseText(`---\n${fm}---\n# T\n`, 'x.md');
      expect(p.warnings, fm).toEqual(['frontmatter_invalid']);
      expect(p.meta).toEqual({});
      expect(p.title).toBe('T');
    }
  });

  it('headings outside code fences, with line numbers', () => {
    const h = headingsOf('# A\n\n```\n# not a heading\n```\n## B ##\n');
    expect(h).toEqual([
      { level: 1, text: 'A', line: 1 },
      { level: 2, text: 'B', line: 6 },
    ]);
    const p = parseText('---\ntitle: x\n---\n# A\n', 'x.md');
    expect(p.headings).toEqual([{ level: 1, text: 'A', line: 4 }]);
  });
});

describe('Yjs body', () => {
  it('applies a series of edits and always equals the new text', () => {
    let state: Uint8Array | null = null;
    const versions = ['', 'line one\nline two\n', 'line one\nline TWO\nline three\n', '🧠 start\nline TWO\n', '🧠 start\nline TWO\n🧠', 'x', ''];
    for (const v of versions) {
      state = applyText(state, v);
      expect(yText(state)).toBe(v);
    }
  });

  it('random edits (property): text after every edit matches', () => {
    let seed = 42;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const alphabet = ['a', 'b', '\n', ' ', 'ω', '🧠', '#'];
    let text = '';
    let state: Uint8Array | null = null;
    for (let i = 0; i < 200; i++) {
      const at = rnd(text.length + 1);
      const del = rnd(Math.min(10, text.length - at) + 1);
      const ins = Array.from({ length: rnd(12) }, () => alphabet[rnd(alphabet.length)]).join('');
      text = text.slice(0, at) + ins + text.slice(at + del);
      // Do not leave broken surrogate pairs (normalizeText rejects them).
      text = text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '');
      state = applyText(state, text);
      expect(yText(state)).toBe(text);
    }
  });
});
