// Import boundaries are actually caught by the linter.
import path from 'node:path';
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const eslint = new ESLint({ cwd: ROOT });

async function violations(file: string, code: string): Promise<string[]> {
  const [res] = await eslint.lintText(code, { filePath: path.join(ROOT, file) });
  return (res?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-imports').map((m) => m.message);
}

describe('import boundaries', () => {
  it('ops/ cannot import store/ or db/', async () => {
    expect(await violations('src/ops/agent/x.ts', "export { getSpaceBySlug } from '../../store/spaces.js';\n")).toHaveLength(1);
    expect(await violations('src/ops/agent/x.ts', "import type { Db } from '../../db/open.js';\nexport type X = Db;\n")).toHaveLength(1);
    expect(await violations('src/ops/agent/x.ts', "export { visibleSpaces } from '../../core/guard.js';\n")).toHaveLength(0);
  });

  it('adapters/ can import only ops/registry|execute|errors and core/tokens|sessions|ratelimit', async () => {
    const f = 'src/adapters/http/x.ts';
    expect(await violations(f, "export { createExecutor } from '../../ops/execute.js';\n")).toHaveLength(0);
    expect(await violations(f, "export { authenticateToken } from '../../core/tokens.js';\n")).toHaveLength(0);
    expect(await violations(f, "export { contextFor } from '../../core/guard.js';\n")).toHaveLength(1);
    expect(await violations(f, "export { whoami } from '../../ops/agent/whoami.js';\n")).toHaveLength(1);
    expect(await violations(f, "export { insertAudit } from '../../store/audit.js';\n")).toHaveLength(1);
    expect(await violations(f, "export { openDb } from '../../db/open.js';\n")).toHaveLength(1);
  });

  it('store/ cannot import core/ or ops/', async () => {
    expect(await violations('src/store/x.ts', "export { newId } from '../core/ids.js';\n")).toHaveLength(1);
  });

  it('core/ cannot import ops/ or adapters/', async () => {
    expect(await violations('src/core/x.ts', "export { listOps } from '../ops/registry.js';\n")).toHaveLength(1);
  });
});
