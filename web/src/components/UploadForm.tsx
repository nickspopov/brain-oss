// File upload: `PUT /api/v1/files/{space}/{path…}` with the bytes as the body. A new
// path uses `expected_rev: 0`; an existing document is replaced only explicitly, with a new revision
// at the current head's `expected_rev` (no blind overwrite).
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { Link } from 'react-router';
import { api } from '../api/client';
import { asConflict, invalidateSpace, joinPath, pathProblem, requestIdFor } from '../lib/edit';
import { formatSize } from '../lib/format';
import { routes } from '../lib/routes';
import { BTN, BTN_PRIMARY, ProposedNote, WriteError } from './edit';
import { tx } from '../i18n';

interface UploadFormProps {
  space: string;
  /** Folder for the new file (the form inside a space). */
  folder?: string;
  /** Replacing an existing document: the path and the revision the human sees. */
  replace?: { path: string; rev: number };
}

export function UploadForm({ space, folder = '', replace }: UploadFormProps) {
  const qc = useQueryClient();
  const [file, setFile] = useState<File | null>(null);
  const [path, setPath] = useState(replace?.path ?? '');
  const [message, setMessage] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  /** The revision the human agreed to replace (after `already_exists` or from the document card). */
  const [replaceRev, setReplaceRev] = useState<number | undefined>(replace?.rev);
  const idFor = useMemo(() => requestIdFor(), []);

  const upload = useMutation({
    mutationFn: (input: { path: string; file: File; expected_rev: number; message: string }) =>
      idFor.run({ ...input, file: [input.file.name, input.file.size, input.file.lastModified] }, (request_id) =>
        api.upload({ space, ...input, request_id }),
      ),
    onSuccess: () => invalidateSpace(qc, space),
  });
  const conflict = asConflict(upload.error);

  const submit = (expected: number) => {
    if (!file) return setProblem(tx.upload.chooseFile);
    const target = replace ? replace.path : path;
    const p = pathProblem(target);
    setProblem(p);
    if (p) return;
    upload.mutate({ path: target, file, expected_rev: expected, message: message.trim() || tx.upload.message(file.name) });
  };

  const done = upload.data;
  return (
    <form
      aria-label={replace ? tx.upload.uploadNewVersion : tx.upload.uploadFile}
      className="space-y-2 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        submit(replaceRev ?? 0);
      }}
    >
      <label className="block space-y-1">
        <span className="text-zinc-600 dark:text-zinc-400">{tx.upload.file}</span>
        <input
          type="file"
          aria-label={tx.upload.file}
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setFile(f);
            upload.reset();
            if (f && !replace) {
              setPath(joinPath(folder, f.name));
              setReplaceRev(undefined);
            }
          }}
          className="block w-full text-sm file:mr-2 file:rounded-md file:border file:border-zinc-300 file:bg-transparent file:px-2 file:py-1 dark:file:border-zinc-700"
        />
      </label>
      {file && (
        <p className="text-zinc-500">
          {file.name}, {formatSize(file.size)}
        </p>
      )}
      {!replace && (
        <label className="block space-y-1">
          <span className="text-zinc-600 dark:text-zinc-400">{tx.upload.pathInSpace}</span>
          <input
            aria-label={tx.upload.filePath}
            value={path}
            onChange={(e) => {
              setPath(e.target.value);
              setReplaceRev(undefined);
            }}
            placeholder={tx.upload.pathPlaceholder}
            className="w-full rounded-md border border-zinc-300 bg-transparent px-2 py-1 font-mono dark:border-zinc-700"
          />
        </label>
      )}
      <label className="block space-y-1">
        <span className="text-zinc-600 dark:text-zinc-400">{tx.upload.revisionMessage}</span>
        <input
          aria-label={tx.upload.uploadMessage}
          value={message}
          maxLength={500}
          onChange={(e) => setMessage(e.target.value)}
          className="w-full rounded-md border border-zinc-300 bg-transparent px-2 py-1 dark:border-zinc-700"
        />
      </label>
      {problem && (
        <p role="alert" className="text-red-700 dark:text-red-400">
          {problem}
        </p>
      )}
      {upload.isError && <WriteError error={upload.error} />}
      {conflict?.current && (conflict.reason === 'already_exists' || conflict.reason === 'stale') && (
        <button
          type="button"
          className={BTN}
          onClick={() => {
            setReplaceRev(conflict.current!.rev);
            submit(conflict.current!.rev);
          }}
        >
          {tx.upload.replace(conflict.current.rev)}
        </button>
      )}
      {done?.status === 'proposed' && done.proposal && <ProposedNote proposal={done.proposal} />}
      {done?.status === 'committed' && done.doc && (
        <p role="status" className="text-emerald-800 dark:text-emerald-300">
          {done.unchanged ? tx.upload.unchanged : tx.upload.uploaded(done.doc.rev)}{' '}
          <Link className="underline" to={routes.doc(space, done.doc.path)}>
            {done.doc.path}
          </Link>
        </p>
      )}
      <button type="submit" className={BTN_PRIMARY} disabled={upload.isPending}>
        {upload.isPending ? tx.upload.uploading : replace ? tx.upload.uploadNewVersion : tx.upload.upload}
      </button>
    </form>
  );
}
