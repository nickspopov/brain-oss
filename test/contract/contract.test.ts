// v1 contract: the registry matches the snapshot; the compatibility check catches breakages.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSnapshot, contractBreaks, type ContractSnapshot } from '../../scripts/contract-lib.js';

const FILE = path.join(import.meta.dirname, 'v1.snapshot.json');

describe('contract v1', () => {
  it('registry matches test/contract/v1.snapshot.json (update with `npm run contract-check -- --update`)', () => {
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8')) as ContractSnapshot;
    expect(buildSnapshot()).toEqual(saved);
  });

  it('the current registry is compatible with the snapshot', () => {
    const saved = JSON.parse(fs.readFileSync(FILE, 'utf8')) as ContractSnapshot;
    expect(contractBreaks(saved, buildSnapshot())).toEqual([]);
  });

  describe('compatibility rules', () => {
    const base = (): ContractSnapshot => ({
      contract_version: '1.0',
      operations: {
        read: {
          effect: 'read',
          requires: 'any',
          expose: ['mcp', 'rest'],
          idempotent: false,
          input: {
            type: 'object',
            properties: { id: { type: 'string' }, mode: { type: 'string', enum: ['a', 'b'] } },
            required: ['id'],
          },
          output: {
            type: 'object',
            properties: { doc: { type: 'object', properties: { rev: { type: 'integer' } }, required: ['rev'] } },
            required: ['doc'],
          },
        },
      },
    });

    it('allows a new operation, a new optional input field and a new output field', () => {
      const next = base();
      next.operations.search = { ...next.operations.read! };
      (next.operations.read!.input.properties as Record<string, unknown>).limit = { type: 'integer' };
      (next.operations.read!.output.properties as Record<string, unknown>).extra = { type: 'string' };
      expect(contractBreaks(base(), next)).toEqual([]);
    });

    it('rejects removed operations, removed or retyped fields, new required input, optional output', () => {
      const removedOp = base();
      delete removedOp.operations.read;
      expect(contractBreaks(base(), removedOp)).toEqual(['read: operation removed']);

      const retyped = base();
      (retyped.operations.read!.input.properties as Record<string, { type: string }>).id!.type = 'integer';
      expect(contractBreaks(base(), retyped)).toEqual(['read.input.id: type changed "string" → "integer"']);

      const removedField = base();
      delete (removedField.operations.read!.output.properties as Record<string, unknown>).doc;
      expect(contractBreaks(base(), removedField)).toContain('read.output.doc: field removed');

      const required = base();
      required.operations.read!.input.required = ['id', 'mode'];
      expect(contractBreaks(base(), required)).toEqual(['read.input.mode: input field became required']);

      const optional = base();
      (optional.operations.read!.output.properties as Record<string, { required: string[] }>).doc!.required = [];
      expect(contractBreaks(base(), optional)).toEqual(['read.output.doc.rev: output field became optional']);

      const enumCut = base();
      (enumCut.operations.read!.input.properties as Record<string, { enum: string[] }>).mode!.enum = ['a'];
      expect(contractBreaks(base(), enumCut)).toEqual(['read.input.mode: enum values removed ["b"]']);
    });
  });
});
