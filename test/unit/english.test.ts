// Every string a person or an agent can see is English. Comments are not checked, but
// string literals in the server and in the UI must be English. User data (documents, names) never lives in code.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CYRILLIC = /[\u0400-\u04FF]/;

/** Literals that are data about the language, not text for a reader: `ё` → `е` folding in the tokenizer. */
const ALLOWED: Record<string, string[]> = {
  'src/core/search/tokenize.ts': ["'ё'", "'е'"],
};

function files(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...files(rel, ext));
    else if (ext.test(e.name)) out.push(rel);
  }
  return out;
}

const LITERAL = new Set([
  ts.SyntaxKind.StringLiteral,
  ts.SyntaxKind.NoSubstitutionTemplateLiteral,
  ts.SyntaxKind.TemplateHead,
  ts.SyntaxKind.TemplateMiddle,
  ts.SyntaxKind.TemplateTail,
  ts.SyntaxKind.JsxText,
  ts.SyntaxKind.RegularExpressionLiteral,
]);

/** Cyrillic string literals and JSX text of a file (comments are not literals). */
function cyrillicLiterals(file: string, text = fs.readFileSync(path.join(ROOT, file), 'utf8')): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const visit = (n: ts.Node): void => {
    if (LITERAL.has(n.kind)) {
      const lit = n.getText(sf).trim();
      if (CYRILLIC.test(lit) && !(ALLOWED[file] ?? []).includes(lit)) {
        found.push(`${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}: ${lit.slice(0, 80)}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

describe('English only', () => {
  it('the server has no Cyrillic string literals: errors, tool descriptions, discovery, CLI', () => {
    const found = files('src', /\.ts$/).flatMap((f) => cyrillicLiterals(f));
    expect(found).toEqual([]);
  });

  it('the web UI has no Cyrillic string literals or JSX text: all text comes from web/src/i18n', () => {
    const found = files('web/src', /\.tsx?$/).flatMap((f) => cyrillicLiterals(f));
    expect(found).toEqual([]);
  });

  it('the scanner does catch Cyrillic in literals and JSX text, but not in comments', () => {
    const code = "// \u0436\nexport const a = '\u0436\u0436';\nexport const b = <p>\u0436</p>;\nexport const c = 'ok';\n";
    expect(cyrillicLiterals('web/src/x.tsx', code)).toHaveLength(2);
  });

  it('the UI page is declared English', () => {
    expect(fs.readFileSync(path.join(ROOT, 'web/index.html'), 'utf8')).toMatch(/<html lang="en">/);
  });
});
