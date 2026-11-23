// Ranking by FTS5 index statistics (column lengths from docsize, occurrences from fts5vocab):
// frequency, phrases by position, prefix, column weights, Latin diacritics.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SearchResult } from '../helpers/api.js';
import type { Client } from '../helpers/clients/index.js';
import { buildWorld, type World } from '../helpers/fixtures.js';
import { startHarness, type Harness } from '../helpers/harness.js';

describe('search ranking from index statistics', () => {
  let h: Harness;
  let w: World;
  let hermes: Client;

  beforeEach(async () => {
    h = await startHarness();
    w = buildWorld(h);
    hermes = w.client('alice-helper');
  });
  afterEach(async () => {
    await h.close();
  });

  const write = (path: string, content: string) => hermes.call('write', { space: 'shared', path, content, message: 'w' });
  const top = async (query: string) => (await hermes.call<SearchResult>('search', { query })).results.map((r) => r.doc.path);

  it('more occurrences rank higher; a title match beats the body', async () => {
    const filler = 'lorem ipsum dolor sit amet '.repeat(20);
    await write('once.md', `# Notes\n\nzebra ${filler}\n`);
    await write('thrice.md', `# Notes\n\nzebra zebra zebra ${filler}\n`);
    expect(await top('zebra')).toEqual(['thrice.md', 'once.md']);
    await write('titled.md', `# Zebra\n\n${filler}\n`);
    expect((await top('zebra'))[0]).toBe('titled.md');
  });

  it('phrases count adjacent words only; a last single word is a prefix', async () => {
    await write('apart.md', '# A\n\nlaunch something code launch other code launch xyz code\n');
    await write('phrase.md', '# B\n\nlaunch code here, and launch code there\n');
    expect(await top('"launch code"')).toEqual(['phrase.md']);
    // Without quotes it is two words: apart.md has three of each, so it ranks higher.
    expect(await top('launch code')).toEqual(['apart.md', 'phrase.md']);
    // The last word is a prefix: "laun" finds "launch" and counts its occurrences.
    expect(await top('laun')).toEqual(['apart.md', 'phrase.md']);
  });

  it('Latin diacritics are matched and counted', async () => {
    await write('cafe1.md', '# Menu\n\ncafé crème\n');
    await write('cafe3.md', '# Menu\n\ncafé café café crème\n');
    expect(await top('café')).toEqual(['cafe3.md', 'cafe1.md']);
    expect(await top('cafe')).toEqual(['cafe3.md', 'cafe1.md']);
  });
});
