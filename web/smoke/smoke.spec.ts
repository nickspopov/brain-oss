// Playwright smoke on desktop and phone (390): login, tree, reading,
// search, editing with a conflict, history and revert, issuing a token, the "needs attention" feed,
// a proposal with a decision, export with download; an axe-core accessibility check (the
// Lighthouse rules) with no critical findings.
import fs from 'node:fs';
import path from 'node:path';
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

const ALICE_PASSWORD = 'correct-horse-battery-staple';

function state(): { origin: string; tokens: Record<string, string> } {
  const p = process.env.SMOKE_STATE;
  if (!p) throw new Error('SMOKE_STATE is not set');
  return JSON.parse(fs.readFileSync(p, 'utf8')) as { origin: string; tokens: Record<string, string> };
}

const isPhone = (info: TestInfo) => info.project.name === 'phone';

// CSP without 'unsafe-inline': no screen may violate it in any way (e.g. the editor's <style>).
// Violations are only visible in the browser console, so they are collected on every test.
const cspViolations = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const seen: string[] = [];
  cspViolations.set(page, seen);
  page.on('console', (m) => {
    if (/Content Security Policy/i.test(m.text())) seen.push(`${page.url()}: ${m.text()}`);
  });
});
test.afterEach(({ page }) => {
  expect(cspViolations.get(page) ?? [], 'CSP violations').toEqual([]);
});

async function login(page: Page, next = '/'): Promise<void> {
  await page.goto(next);
  await expect(page).toHaveURL(/\/login\?next=/);
  await page.getByLabel('Name').fill('alice');
  await page.getByLabel('Password').fill(ALICE_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: /^Account menu/ })).toBeVisible();
}

/** No critical accessibility findings (axe-core is the accessibility engine behind Lighthouse). */
async function a11y(page: Page, where: string): Promise<void> {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
  const critical = r.violations.filter((v) => v.impact === 'critical' || v.impact === 'serious');
  const text = critical.map((v) => `${v.impact} ${v.id}: ${v.help} — ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(', ')}`).join('\n');
  const minor = r.violations.filter((v) => v.impact !== 'critical' && v.impact !== 'serious').map((v) => `${v.impact} ${v.id}`);
  console.log(`a11y ${test.info().project.name} ${where}: ${r.passes.length} rules pass, critical/serious ${critical.length}${minor.length ? `, other: ${minor.join(', ')}` : ''}`);
  expect(text, `a11y at ${where}`).toBe('');
  // Phone (390): the page is no wider than the screen; wide tables and diffs scroll within themselves.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, `horizontal overflow at ${where}`).toBeLessThanOrEqual(0);
}

/** Writes "as the agent" via REST with a token (the conflict and seeding don't depend on the UI). */
async function agentWrite(page: Page, path: string, content: string): Promise<number> {
  const s = state();
  const auth = { Authorization: `Bearer ${s.tokens['alice-assistant']}` };
  const meta = await page.request.post(`${s.origin}/api/v1/ops/read`, { headers: auth, data: { space: 'shared', path, format: 'meta' } });
  const rev = ((await meta.json()) as { result: { doc: { rev: number } } }).result.doc.rev;
  const res = await page.request.post(`${s.origin}/api/v1/ops/write`, { headers: auth, data: { space: 'shared', path, content, expected_rev: rev, message: 'concurrent agent edit' } });
  expect(res.status()).toBe(200);
  return ((await res.json()) as { result: { doc: { rev: number } } }).result.doc.rev;
}

// The UI is always English. The built bundle carries no Cyrillic except third-party data that is
// not UI text (linkify-it's list of top-level domains has the Russian TLD `\u0440\u0444`); a page without user data shows none.
const BUNDLE_ALLOWED = new Set(['\u0440\u0444']);
test('the built bundle and a page without user data have no Cyrillic', async ({ page }, info) => {
  test.skip(isPhone(info), 'one check of the bundle is enough');
  const dist = path.resolve(import.meta.dirname, '../dist');
  const files = [path.join(dist, 'index.html'), ...fs.readdirSync(path.join(dist, 'assets')).map((f) => path.join(dist, 'assets', f))];
  expect(files.some((f) => f.endsWith('.js'))).toBe(true);
  const found: string[] = [];
  for (const f of files) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/[\u0400-\u04FF]+/g)) if (!BUNDLE_ALLOWED.has(m[0])) found.push(`${path.basename(f)}: ${m[0]}`);
  }
  expect(found).toEqual([]);
  expect(fs.readFileSync(path.join(dist, 'index.html'), 'utf8')).toContain('<html lang="en">');
  await page.goto('/login');
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible();
  expect(await page.locator('body').innerText()).not.toMatch(/[\u0400-\u04FF]/);
});

test('login, spaces, tree, read, search', async ({ page }, info) => {
  await login(page);
  await expect(page.getByRole('heading', { name: 'Spaces', level: 1 })).toBeVisible();
  await a11y(page, 'spaces');

  if (isPhone(info)) {
    // On the phone, the tree and spaces are in a slide-out panel.
    await page.getByRole('button', { name: 'Menu', exact: true }).click();
    await expect(page.getByRole('complementary', { name: 'Navigation' })).toBeInViewport();
    await page.getByRole('complementary', { name: 'Navigation' }).getByRole('link', { name: 'Shared' }).click();
    await expect(page.getByRole('button', { name: 'Menu', exact: true })).toHaveAttribute('aria-expanded', 'false');
  } else {
    await page.getByRole('complementary', { name: 'Navigation' }).getByRole('link', { name: 'Shared' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Shared', level: 1 })).toBeVisible();
  await expect(page.getByRole('link', { name: 'New document' })).toBeVisible();
  const tree = page.getByRole('main').getByRole('tree');
  await tree.getByRole('link', { name: /welcome/ }).click();
  await expect(page.getByRole('heading', { name: 'Welcome' }).first()).toBeVisible();
  await expect(page.getByText('alice-helper').first()).toBeVisible();
  await a11y(page, 'document');

  await page.getByRole('searchbox', { name: 'Search' }).fill('knowledge');
  await page.getByRole('searchbox', { name: 'Search' }).press('Enter');
  await expect(page.getByRole('main').getByRole('link', { name: /Welcome|welcome/ }).first()).toBeVisible();
});

test('edit with a conflict, then history and one-click revert', async ({ page }, info) => {
  const path = `smoke-${info.project.name}.md`;
  await login(page, `/s/shared/edit/${path}`);
  const editor = page.locator('.cm-content');
  await expect(editor).toBeVisible();
  // CodeMirror's base theme was applied (under CSP: via adoptedStyleSheets in the shadow root).

  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\nMy line from the browser.\n');
  // While the human edits, the agent writes its own version.
  const theirs = await agentWrite(page, path, `# Document ${info.project.name}\n\nAgent version.\n`);
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('heading', { name: 'Conflict: nothing was saved' })).toBeVisible();
  await expect(page.getByLabel('Difference between the current version and mine')).toContainText('My line from the browser.');
  await a11y(page, 'conflict');
  await page.getByRole('button', { name: `Keep editing on top of revision ${theirs}` }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(new RegExp(`/s/shared/d/${path.replace('.', '\\.')}`));
  await expect(page.getByText('My line from the browser.')).toBeVisible();

  await page.goto(`/s/shared/history/${path}`);
  await expect(page.getByRole('heading', { name: /History/ })).toBeVisible();
  await page.getByRole('button', { name: 'Revert to rev 1' }).click();
  await expect(page.getByText(/Reverted: revision \d+\./)).toBeVisible();
  await page.goto(`/s/shared/d/${path}`);
  await expect(page.getByText('First version.')).toBeVisible();
  await expect(page.getByText('My line from the browser.')).toHaveCount(0);
});

test('issue a token shown once', async ({ page }, info) => {
  await login(page, '/admin/agents/alice-helper/connection');
  await page.getByLabel('Label').fill(`smoke ${info.project.name}`);
  await page.getByRole('button', { name: 'Issue token' }).click();
  const token = page.getByLabel('New token');
  await expect(token).toContainText('brn_');
  await a11y(page, 'token');
  await page.getByRole('button', { name: 'I saved the token, hide it' }).click();
  await expect(page.getByLabel('New token')).toHaveCount(0);
  await expect(page.getByRole('list', { name: 'Tokens' })).toContainText(`smoke ${info.project.name}`);
});

test('connect agent: bundle once, Connected only after the agent calls, negative probe', async ({ page }, info) => {
  const s = state();
  await login(page, '/admin/agents');
  await page.getByRole('link', { name: 'Connect agent' }).click();
  await page.getByLabel('Display name').fill(`Smoke ${info.project.name}`);
  await page.getByLabel('Handle').fill(`smoke-connect-${info.project.name}`);
  await page.getByRole('checkbox', { name: /^Shared/ }).check();
  await page.getByRole('button', { name: 'Create and show the config' }).click();
  const token = (await page.getByLabel('Brain token').textContent()) ?? '';
  expect(token).toMatch(/^brn_/);
  await expect(page.getByLabel('Config for claude-code')).toContainText(`claude mcp add --transport http brain ${s.origin}/mcp/v1 --header "Authorization: Bearer ${token}"`);
  await expect(page.getByText(/Waiting for Smoke/)).toBeVisible();
  await a11y(page, 'connect once');
  // The agent's first authenticated call flips it.
  const r = await page.request.post(`${s.origin}/api/v1/ops/whoami`, { headers: { Authorization: `Bearer ${token}` }, data: {} });
  expect(r.status()).toBe(200);
  await expect(page.getByText(/Connected: Smoke .* called Brain/)).toBeVisible();
  await expect(page.getByRole('list', { name: 'Sees' })).toContainText('Viewer');
  await expect(page.getByText('Isolation checked.')).toBeVisible();
});

test('feed with the attention filter', async ({ page }) => {
  await login(page, '/feed');
  await expect(page.getByTestId('feed-item').first()).toBeVisible();
  await page.getByRole('checkbox', { name: 'Needs attention' }).check();
  await expect(page).toHaveURL(/attention=1/);
  const item = page.getByTestId('feed-item').filter({ hasText: 'Soup' });
  await expect(item).toBeVisible();
  await expect(item.getByText('needs attention')).toBeVisible();
  await expect(page.getByTestId('feed-item').filter({ hasText: 'Welcome' })).toHaveCount(0);
  await a11y(page, 'feed');
  // Dark theme (the default theme follows the system): contrast without serious findings too.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.reload();
  await expect(page.locator('html')).toHaveClass(/dark/);
  await expect(page.getByTestId('feed-item').filter({ hasText: 'Soup' })).toBeVisible();
  await a11y(page, 'feed (dark)');
});

test('proposal queue: diff and accept', async ({ page }, info) => {
  await login(page, '/proposals');
  const card = page.getByRole('link', { name: new RegExp(`plan-${info.project.name}\\.md`) });
  await card.click();
  await expect(page.getByLabel('Difference between the current and the proposed version')).toContainText('+step 2');
  await a11y(page, 'proposal');
  const accept = page.getByRole('region', { name: 'Decision' }).getByRole('button', { name: 'Accept' });
  await expect(accept).toBeInViewport();
  await accept.click();
  await expect(page.getByText(/Accepted: revision \d+\./)).toBeVisible();
  await page.goto(`/s/shared/d/plan-${info.project.name}.md`);
  await expect(page.getByText('step 2')).toBeVisible();
});

test('export a space and download the archive', async ({ page }) => {
  await login(page, '/export?space=shared');
  await page.getByRole('button', { name: 'Build archive' }).click();
  const link = page.getByRole('link', { name: 'Download archive' });
  await expect(link).toBeVisible();
  await a11y(page, 'export');
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  const file = await download.path();
  const bytes = fs.readFileSync(file);
  expect(bytes.length).toBeGreaterThan(100);
  expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]); // gzip
});

test('audit under Advanced', async ({ page }) => {
  await login(page, '/admin/audit');
  await expect(page.getByTestId('audit-entry').first()).toBeVisible();
  await page.getByLabel('Operation').fill('write');
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page).toHaveURL(/op=write/);
  await expect(page.getByTestId('audit-entry').first()).toContainText('write');
  await a11y(page, 'audit');
});
