// Search token pipeline: Russian and English word forms, mixed text, query parsing,
// safety of the MATCH expression, snippets.
import { describe, expect, it } from 'vitest';
import { buildSnippet, indexTerm } from '../../src/core/search/query.js';
import { countTerm, matchExpr, parseQuery, stems, stemWord, tokenize } from '../../src/core/search/tokenize.js';

describe('tokenize', () => {
  it('Russian word forms share a stem', () => {
    const groups = [
      ['рецепт', 'рецепты', 'рецептов', 'рецептами', 'рецепте'],
      ['настройка', 'настройки', 'настройку', 'настройкой'],
      ['бэкап', 'бэкапы', 'бэкапа', 'бэкапов'],
      ['сервер', 'сервера', 'серверов', 'серверами'],
      ['документ', 'документы', 'документов', 'документами'],
      ['ключ', 'ключи', 'ключей'],
    ];
    for (const g of groups) expect(new Set(g.map((w) => stemWord(w))), g.join(',')).toHaveProperty('size', 1);
  });

  it('English word forms share a stem', () => {
    const groups = [
      ['deploy', 'deploys', 'deployed', 'deploying'],
      ['connect', 'connection', 'connections', 'connected'],
      ['run', 'running', 'runs'],
      ['token', 'tokens'],
    ];
    for (const g of groups) expect(new Set(g.map((w) => stemWord(w))), g.join(',')).toHaveProperty('size', 1);
  });

  it('lower case, ё → е, NFC', () => {
    expect(stemWord('ЁЛКА')).toBe(stemWord('елка'));
    expect(stemWord('Café')).toBe(stemWord('café'));
    expect(stemWord('DEPLOY')).toBe('deploy');
  });

  it('tokens are runs of letters and digits; punctuation splits', () => {
    expect(stems('gmail.py')).toEqual(['gmail', 'py']);
    expect(stems('harness-open')).toEqual([stemWord('harness'), stemWord('open')]);
    expect(stems('v2_final, 2024-11-14')).toEqual(['v2', 'final', '2024', '11', '14']);
  });

  it('single letters are dropped, single digits kept, long tokens cut to 64', () => {
    expect(stems('a b c 1 2 x')).toEqual(['1', '2']);
    const long = 'z'.repeat(100);
    expect(stems(long)[0]!.length).toBeLessThanOrEqual(64);
  });

  it('mixed-script and numeric tokens are kept as is', () => {
    expect(stemWord('vpnсервер')).toBe('vpnсервер');
    expect(stemWord('42')).toBe('42');
    expect(stems('Админ deploys сервера')).toEqual([stemWord('админ'), 'deploy', stemWord('сервер')]);
  });

  it('positions point at the source words', () => {
    const text = 'Привет,  мир! Hello';
    for (const t of tokenize(text)) expect(stemWord(text.slice(t.start, t.end))).toBe(t.stem);
  });
});

describe('parseQuery', () => {
  it('words, quoted phrases, punctuated fragments; prefix on the last word ≥ 3', () => {
    const q = parseQuery('рецепты "launch code" gmail.py depl');
    expect(q).toEqual([
      { stems: [stemWord('рецепты')], prefix: false },
      { stems: ['launch', 'code'], prefix: false },
      { stems: ['gmail', 'py'], prefix: false },
      { stems: [stemWord('depl')], prefix: true },
    ]);
    expect(parseQuery('ab')[0]!.prefix).toBe(false);
    expect(parseQuery('"exact"')[0]!.prefix).toBe(false);
    expect(parseQuery('!!! ... ---')).toEqual([]);
  });

  it('duplicates are merged', () => {
    expect(parseQuery('рецепт рецепты')).toHaveLength(1);
  });

  it('FTS5 syntax in the query never reaches MATCH as syntax', () => {
    const hostile = 'NEAR(a b) OR title:x AND NOT "y" * ^z {col} ) ( "';
    const expr = matchExpr(parseQuery(hostile), 'AND');
    // Only quoted stems separated by AND, with an optional asterisk after the closing quote.
    expect(expr).toMatch(/^("[\p{L}\p{N} ]+"\*?)( AND "[\p{L}\p{N} ]+"\*?)*$/u);
  });

  it('countTerm counts words, phrases and prefixes', () => {
    const seq = ['launch', 'code', 'word', 'launch', 'codex'];
    expect(countTerm(seq, { stems: ['launch'], prefix: false })).toBe(2);
    expect(countTerm(seq, { stems: ['launch', 'code'], prefix: false })).toBe(1);
    expect(countTerm(seq, { stems: ['launch', 'code'], prefix: true })).toBe(2);
    expect(countTerm(seq, { stems: ['cod'], prefix: true })).toBe(2);
  });
});

describe('snippet', () => {
  it('window with the most distinct matches, highlights on source words', () => {
    const filler = 'lorem ipsum dolor sit amet '.repeat(30);
    const text = `${filler}Бэкапы делаются ночью.\n\nКлюч шифрования лежит в сейфе. ${filler}`;
    const s = buildSnippet(text, parseQuery('бэкап ключ'));
    expect(s.text.length).toBeLessThanOrEqual(240);
    const marked = s.highlights.map(([a, b]) => s.text.slice(a, b));
    expect(marked).toEqual(['Бэкапы', 'Ключ']);
    expect(s.text).not.toMatch(/\n/);
  });

  it('no match in the body → the beginning; empty text → empty snippet', () => {
    expect(buildSnippet('First line.\nSecond.', parseQuery('absent')).text).toBe('First line. Second.');
    expect(buildSnippet('', parseQuery('x y'))).toEqual({ text: '', highlights: [] });
  });

  it('does not split surrogate pairs', () => {
    const text = '🧠'.repeat(300) + ' мозг ' + '🧠'.repeat(300);
    const s = buildSnippet(text, parseQuery('мозг'));
    expect(s.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
    expect(s.highlights.map(([a, b]) => s.text.slice(a, b))).toEqual(['мозг']);
  });
});

describe('indexTerm (stem → term of the FTS5 vocabulary)', () => {
  it('drops Latin diacritics like unicode61, keeps Cyrillic', () => {
    expect(indexTerm('café')).toBe('cafe');
    expect(indexTerm('naïv')).toBe('naiv');
    expect(indexTerm('мой')).toBe('мой');
    expect(indexTerm('brain2')).toBe('brain2');
  });
});
