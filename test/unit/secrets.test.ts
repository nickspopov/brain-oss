// Secret scanner: rules, placeholders, added lines, positions, linearity.
import { describe, expect, it } from 'vitest';
import { SECRET_RULES, shannonEntropy } from '../../src/core/secrets/rules.js';
import { addedLines, fileAsText, matchesOf, scanText, scanWrite } from '../../src/core/secrets/scan.js';
import { ALNUM, rand, secretSamples } from '../helpers/secrets.js';

/** Which rule must catch the sample (the generic pattern may fire as well). */
const EXPECTED_RULE: Record<string, string> = {
  slack_bot: 'slack_token',
  slack_user: 'slack_token',
  slack_app: 'slack_token',
  slack_refresh: 'slack_token',
  slack_session: 'slack_token',
  openai: 'openai_api_key',
  openai_project: 'openai_api_key',
  anthropic: 'anthropic_api_key',
  github_pat_classic: 'github_token',
  github_oauth: 'github_token',
  github_server: 'github_token',
  github_user: 'github_token',
  github_fine_grained: 'github_fine_grained_pat',
  aws_access_key: 'aws_access_key_id',
  aws_secret_nearby: 'aws_secret_access_key',
  google_api: 'google_api_key',
  stripe_secret: 'stripe_live_key',
  stripe_restricted: 'stripe_live_key',
  telegram_bot: 'telegram_bot_token',
  pem_private_key: 'private_key_block',
  jwt: 'jwt',
  brain_token: 'brain_token',
  generic_assignment: 'generic_secret_assignment',
};

const PLACEHOLDERS = [
  'Slack token looks like xoxb-XXXX',
  'xoxb-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX',
  'OpenAI key: sk-...',
  'Anthropic key: sk-ant-...',
  'export GITHUB_TOKEN=ghp_<your-token>',
  'password = "changeme"',
  'api_key: <YOUR_API_KEY>',
  'token: ${BRAIN_TOKEN}',
  'AWS key id format: AKIA followed by 16 characters',
  'secret_file = /etc/brain/secrets/password.txt',
  'The token_count = 12345678901234567890 is fine',
  'See https://example.com/docs/api-keys for details',
  'commit 4b349f4a9c1d2e3f4b349f4a9c1d2e3f4b349f4a',
];

describe('secret scanner rules', () => {
  it('every sample is caught by its rule, at the right line and column', () => {
    const samples = secretSamples();
    expect(Object.keys(EXPECTED_RULE).sort()).toEqual(Object.keys(samples).sort());
    for (const [name, secret] of Object.entries(samples)) {
      const text = `# Title\n\nsome text\n  value: ${secret}\n`;
      const findings = scanText(text, 'content');
      const rules = findings.map((f) => f.rule);
      expect(rules, name).toContain(EXPECTED_RULE[name]);
      const f = findings.find((x) => x.rule === EXPECTED_RULE[name])!;
      expect(f.line, name).toBe(4);
      expect(f.column, name).toBeGreaterThanOrEqual(10);
      expect(JSON.stringify(findings), name).not.toContain(secret.slice(-16));
    }
  });

  it('placeholders and ordinary text do not fire', () => {
    for (const text of PLACEHOLDERS) expect(scanText(text, 'content'), text).toEqual([]);
  });

  it('every rule has a unique id, the g flag, and no nested quantifiers', () => {
    const ids = SECRET_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of SECRET_RULES) {
      expect(r.re.flags, r.id).toContain('g');
      // A quantifier right after a group containing a quantifier is a sign of catastrophic backtracking.
      expect(/\([^)]*[+*}][^)]*\)[+*{]/.test(r.re.source.replace(/\(\?[:!=]/g, '(')), r.id).toBe(false);
    }
  });

  it('pathological inputs scan in linear time', () => {
    const inputs = [
      'xoxb-'.repeat(100_000),
      'a'.repeat(500_000),
      'password'.repeat(60_000),
      'eyJ'.repeat(150_000),
      `eyJ${'a'.repeat(200_000)}.eyJ${'a'.repeat(200_000)}`,
      'aws_secret_key = '.repeat(30_000),
      `${'-'.repeat(200_000)}BEGIN `,
      '1234567890:AA'.repeat(40_000),
      'sk-'.repeat(150_000),
      'token=' + 'A1'.repeat(250_000),
    ];
    for (const text of inputs) {
      const t0 = performance.now();
      scanText(text, 'content');
      expect(performance.now() - t0, text.slice(0, 20)).toBeLessThan(1500);
    }
  });

  it('512 KB of repeated rule prefixes after a non-word character scan fast', () => {
    const N = 512 * 1024;
    const fill = (u: string) => u.repeat(Math.ceil(N / u.length)).slice(0, N);
    // "-eyJ"×128K took 2.0–2.7 s before the fix (the jwt rule backtracking from every eyJ); "-sk-" took 0.3 s.
    const units = ['-eyJ', '-sk-', '-sk-ant-', '-xoxb-', '-ghp_', '-github_pat_', '-AIza', '-brn_', '-sk_live_', 'eyJaaaaaaaaaaaa.', '-eyJaaaaaaaaaaaa.eyJbbbb.'];
    let total = 0;
    for (const u of units) {
      const text = fill(u);
      const t0 = performance.now();
      scanText(text, 'content');
      const ms = performance.now() - t0;
      total += ms;
      expect(ms, u).toBeLessThan(500);
    }
    expect(total).toBeLessThan(2000);
  });

  it('the linear rules match exactly what the original bounded regexes matched', () => {
    const W = '[A-Za-z0-9_-]';
    const END = '(?![A-Za-z0-9_-])';
    const reference: Record<string, RegExp> = {
      jwt: new RegExp(`\\beyJ${W}{10,2000}\\.eyJ${W}{4,8000}\\.${W}{20,2000}${END}`, 'g'),
      openai_api_key: new RegExp(`\\bsk-(?!ant-)${W}{32,250}${END}`, 'g'),
      anthropic_api_key: new RegExp(`\\bsk-ant-${W}{32,250}${END}`, 'g'),
    };
    const ref = (re: RegExp, text: string) => [...text.matchAll(re)].map((m) => [m.index, m[0].length]);
    const mine = (id: string, text: string) => [...matchesOf(SECRET_RULES.find((r) => r.id === id)!, text)].map((m) => [m.index, m.length]);
    const pieces = ['-', '.', ' ', 'eyJ', 'sk-', 'sk-ant-', 'a', 'Z', '7', '_', 'x'.repeat(30), 'Q'.repeat(240), '\n'];
    let seed = 42;
    const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const texts: string[] = [];
    for (let i = 0; i < 400; i++) {
      let t = '';
      const n = 1 + Math.floor(next() * 40);
      for (let j = 0; j < n; j++) t += pieces[Math.floor(next() * pieces.length)];
      texts.push(t);
    }
    // At the length boundaries: segments of length around 250, 2000 and 8000, and a long word before the key.
    const k = (n: number) => 'k'.repeat(n);
    for (const n of [31, 32, 249, 250, 251, 400]) texts.push(`x sk-${k(n)} y`, `-sk-ant-${k(n)}.`, `${k(300)}-sk-${k(n)}`, `-sk-${k(300)}-sk-${k(n)}`);
    for (const n of [9, 10, 1999, 2000, 2001, 3000]) texts.push(`-eyJ${k(n)}.eyJ${k(10)}.${k(30)} `, `${k(100)}-eyJ${k(5)}-eyJ${k(n)}.eyJabcd.${k(25)}`);
    for (const n of [3, 4, 7999, 8000, 8001]) texts.push(` eyJ${k(20)}.eyJ${k(n)}.${k(20)}`);
    for (const n of [19, 20, 2000, 2001]) texts.push(` eyJ${k(20)}.eyJ${k(20)}.${k(n)}`, ` eyJ${k(20)}.eyJ${k(20)}.${k(n)}.more`);
    let hits = 0;
    for (const text of texts) {
      for (const [id, re] of Object.entries(reference)) {
        const want = ref(re, text);
        hits += want.length;
        expect(mine(id, text), `${id}: ${JSON.stringify(text.slice(0, 80))}`).toEqual(want);
      }
    }
    expect(hits).toBeGreaterThan(20);
  });

  it('entropy: random keys are high, repeated characters are low', () => {
    expect(shannonEntropy(rand(ALNUM, 40))).toBeGreaterThan(4);
    expect(shannonEntropy('X'.repeat(40))).toBe(0);
    expect(shannonEntropy('')).toBe(0);
  });
});

describe('scanWrite', () => {
  it('checks only the lines added relative to the previous body', () => {
    const secret = secretSamples().github_pat_classic!;
    const before = `# Old\n\nkey ${secret}\n`;
    // The secret was already in the head (e.g. written before the scanner existed): editing a neighbouring line passes.
    expect(scanWrite({ content: `${before}more\n`, previous: before })).toEqual([]);
    // A new secret on a new line is a finding.
    const other = secretSamples().github_pat_classic!;
    const found = scanWrite({ content: `${before}and ${other}\n`, previous: before });
    expect(found).toEqual([{ rule: 'github_token', field: 'content', line: 4, column: 5 }]);
    // Without a previous body, everything is checked.
    expect(scanWrite({ content: before }).map((f) => f.rule)).toEqual(['github_token']);
  });

  it('a multi-line match counts when any of its lines is new', () => {
    const pem = secretSamples().pem_private_key!;
    const lines = pem.split('\n');
    const before = `${lines[0]}\nold\n`;
    expect(scanWrite({ content: `${pem}\n`, previous: before }).map((f) => f.rule)).toContain('private_key_block');
  });

  it('path and message are checked and reported with their field', () => {
    const s = secretSamples();
    const found = scanWrite({ path: `keys/${s.google_api}.md`, message: `add ${s.stripe_secret}`, content: 'x\n' });
    expect(found).toEqual(
      expect.arrayContaining([
        { rule: 'google_api_key', field: 'path', line: 1, column: 6 },
        { rule: 'stripe_live_key', field: 'message', line: 1, column: 5 },
      ]),
    );
  });

  it('addedLines and fileAsText', () => {
    expect([...addedLines('a\nb\n', 'a\nc\nb\n')]).toEqual([1]);
    expect([...addedLines(undefined, 'a\nb')]).toEqual([0, 1]);
    expect(fileAsText(Buffer.from('plain text'))).toBe('plain text');
    expect(fileAsText(Buffer.from([0x89, 0x50, 0x00, 0x01]))).toBeUndefined();
    expect(fileAsText(Buffer.from([0xff, 0xfe, 0xfd]))).toBeUndefined();
  });
});
