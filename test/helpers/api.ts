// Response shapes of the v1 contract, for typing tests. The source of truth is the schemas in src/ops.
import type { DocInfo, RevInfo } from '../../src/ops/types.js';

export type { DocInfo, RevInfo };

export interface WriteResult {
  status: 'committed' | 'proposed';
  doc?: DocInfo;
  unchanged?: boolean;
  warnings?: string[];
  proposal?: Proposal;
}

export interface ReadResult {
  doc: DocInfo;
  revision: RevInfo;
  content?: string;
  encoding: 'utf8' | 'base64';
  truncated: boolean;
  next_offset?: number;
  contributors: { name: string; trust: string; chars: number }[];
  seen_rev?: number;
}

export type ListEntry = { type: 'folder'; path: string; children: number } | ({ type: 'doc' } & DocInfo);
export interface ListResult {
  entries: ListEntry[];
  next_cursor?: string;
}

export interface HistoryResult {
  revisions: RevInfo[];
  next_cursor?: string;
}

export interface SearchResult {
  /** `score` is not exposed externally. */
  results: { doc: DocInfo; snippet: { text: string; highlights: [number, number][] }; matched_in: string[] }[];
  next_cursor?: string;
}

export interface ChangesResult {
  changes: (RevInfo & { doc: { id: string; space: string; path: string; title: string }; seen_rev?: number })[];
  cursor: string;
  has_more: boolean;
}

export interface ActivityResult {
  items: ChangesResult['changes'];
  next_cursor?: string;
}

export interface Proposal {
  id: string;
  status: string;
  [k: string]: unknown;
}

export interface ExportResult {
  export_id: string;
  download_path: string;
  size: number;
  sha256: string;
  expires_at: string;
}

export interface ConflictDetails {
  reason: string;
  current?: {
    rev: number;
    content_hash: string;
    author: { name: string; kind: string; trust: string };
    updated_at: string;
    content?: string;
    content_truncated?: boolean;
  };
  diff?: string;
}
