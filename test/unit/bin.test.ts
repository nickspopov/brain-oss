// Every `bin` entry in package.json is built from a source file with a node shebang, so `npm link` works.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(import.meta.dirname, '../..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { bin: Record<string, string> };

describe('package.json bin', () => {
  for (const [name, target] of Object.entries(pkg.bin)) {
    it(`${name} starts with a node shebang`, () => {
      const source = target.replace(/^dist\//, '').replace(/\.js$/, '.ts');
      const first = fs.readFileSync(path.join(root, source), 'utf8').split('\n', 1)[0];
      expect(first).toBe('#!/usr/bin/env node');
    });
  }
});
