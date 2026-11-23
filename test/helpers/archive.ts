// Archives for export and import tests: unpacking tar.gz and building an archive in the
// export format (head mode) from a set of files.
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import { tarPack, tarUnpack } from '../../src/core/export/tar.js';

/** Archive files (directories skipped) as UTF-8 text. */
export async function untar(archive: Uint8Array): Promise<Record<string, string>> {
  const files = untarBytes(archive);
  return Object.fromEntries([...files].map(([k, v]) => [k, v.toString('utf8')]));
}

export function untarBytes(archive: Uint8Array): Map<string, Buffer> {
  const tar = zlib.gunzipSync(archive);
  return tarUnpack(tar, { maxEntries: 1_000_000, maxTotalBytes: 2 ** 31 });
}

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/**
 * A head-mode export archive, as if `alice` had exported it from space `space`: one document
 * per file, with fixed author and time.
 */
export async function plainArchive(files: Record<string, string>, space = 'imported'): Promise<Uint8Array> {
  const created = '2026-11-01T10:00:00.000Z';
  const ids = ['01JAAAAAAAAAAAAAAAAAAAAAA0', '01JAAAAAAAAAAAAAAAAAAAAAA1', '01JAAAAAAAAAAAAAAAAAAAAAA2', '01JAAAAAAAAAAAAAAAAAAAAAA3'];
  const documents = Object.entries(files).map(([path, text], i) => {
    const body = Buffer.from(text, 'utf8');
    return {
      id: ids[i] ?? `01JAAAAAAAAAAAAAAAAAAAAB${String(i).padStart(2, '0')}`,
      path,
      kind: 'text',
      mime: 'text/markdown',
      head_rev: 1,
      deleted: false,
      revisions: [
        {
          rev: 1,
          kind: 'create',
          path,
          prev_path: null,
          author: 'alice',
          author_trust: 'admin',
          approved_by: null,
          via: 'rest',
          message: 'create',
          created_at: created,
          content_hash: sha(body),
          size: body.length,
          ref_rev: null,
          purged: false,
          attention: false,
        },
      ],
    };
  });
  const manifest = {
    format: 'brain-export',
    format_version: 1,
    contract_version: '1.0',
    exported_at: created,
    mode: 'head',
    space: {
      slug: space,
      name: space,
      description: '',
      review_mode: 'off',
      executable: false,
      ttl_days: null,
      trash_retention_days: null,
      quota_bytes: 524288000,
      max_doc_bytes: null,
      protected_paths: [],
    },
    documents,
    principals: [{ name: 'alice', kind: 'human', trust: 'admin' }],
  };
  const entries = [
    { name: 'brain-export/manifest.json', data: Buffer.from(JSON.stringify(manifest)), mtime: 0 },
    ...Object.entries(files).map(([path, text]) => ({ name: `brain-export/tree/${path}`, data: Buffer.from(text, 'utf8'), mtime: 0 })),
  ];
  return zlib.gzipSync(tarPack(entries));
}
