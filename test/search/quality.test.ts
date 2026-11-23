// 20 questions → the right document in the top 3 on a synthetic Russian/English corpus (see corpus/README.md).
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { toAuthenticated } from '../../src/core/tokens.js';
import type { SearchResult } from '../helpers/api.js';
import { buildWorld, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

const DIR = import.meta.dirname;
const CORPUS = path.join(DIR, 'corpus');
const QUESTIONS = parse(fs.readFileSync(path.join(DIR, 'questions.yaml'), 'utf8')) as { q: string; expect: string }[];

function corpusFiles(dir: string, base = ''): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (rel === 'README.md') return []; // describes the corpus, not part of it
    return e.isDirectory() ? corpusFiles(path.join(dir, e.name), rel) : [rel];
  });
}

describe('search quality (synthetic corpus)', () => {
  let h: Harness;
  let w: World;

  beforeAll(async () => {
    h = await startHarness();
    w = buildWorld(h);
    const caller = { principal: toAuthenticated(w.principals['alice-assistant']), via: 'rest' as const, ip: null };
    for (const rel of corpusFiles(CORPUS)) {
      const content = fs.readFileSync(path.join(CORPUS, rel), 'utf8');
      const r = await h.app.executor.execute('write', { space: 'shared', path: rel, content, message: 'corpus' }, caller);
      if (!r.ok) throw new Error(`corpus write failed: ${rel}`);
    }
  });
  afterAll(async () => {
    await h.close();
  });

  it('has 20 questions over a 20–30 document corpus', () => {
    expect(QUESTIONS).toHaveLength(20);
    const n = corpusFiles(CORPUS).length;
    expect(n).toBeGreaterThanOrEqual(20);
    expect(n).toBeLessThanOrEqual(30);
    for (const q of QUESTIONS) expect(fs.existsSync(path.join(CORPUS, q.expect)), q.expect).toBe(true);
  });

  it.each(QUESTIONS)('$q → $expect in top 3', async ({ q, expect: want }) => {
    const r = await w.client('alice-assistant').call<SearchResult>('search', { query: q, limit: 3 });
    expect(r.results.map((x) => x.doc.path)).toContain(want);
  });
});
