// Live Yjs body: one Y.Text per document.
// The Y.Doc is created for the duration of a write and is not cached. Per-character authorship and a
// stable client id per author were cut from v1: Yjs internal structures are not walked here.
import * as Y from 'yjs';

const FIELD = 'body';

function load(state: Uint8Array | null): { doc: Y.Doc; text: Y.Text } {
  const doc = new Y.Doc({ gc: true });
  if (state) Y.applyUpdate(doc, state);
  return { doc, text: doc.getText(FIELD) };
}

/** Text of a Yjs body. */
export function yText(state: Uint8Array): string {
  const { doc, text } = load(state);
  const s = text.toString();
  doc.destroy();
  return s;
}

/**
 * Applies an edit to the Yjs body to reach `next`: the common prefix and suffix are dropped, the
 * middle is replaced with one delete + insert. A line diff is not needed here (per-character
 * authorship was cut) and was quadratic on large replacements: this edit is linear.
 * Checks the result (otherwise throws, and the write transaction rolls back) and returns the
 * new state.
 */
export function applyText(state: Uint8Array | null, next: string): Uint8Array {
  const { doc, text } = load(state);
  try {
    const prev = text.toString();
    if (prev !== next) {
      doc.transact(() => {
        let p = 0;
        const max = Math.min(prev.length, next.length);
        while (p < max && prev.charCodeAt(p) === next.charCodeAt(p)) p++;
        let s = 0;
        while (s < max - p && prev.charCodeAt(prev.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++;
        // Do not split a surrogate pair at the boundaries.
        if (p > 0 && isHigh(prev.charCodeAt(p - 1))) p--;
        if (s > 0 && isLow(prev.charCodeAt(prev.length - s))) s--;
        const oldLen = prev.length - s - p;
        const newMid = next.slice(p, next.length - s);
        if (oldLen > 0) text.delete(p, oldLen);
        if (newMid.length > 0) text.insert(p, newMid);
      });
    }
    if (text.toString() !== next) throw new Error('Yjs body does not match the new text');
    return Y.encodeStateAsUpdate(doc);
  } finally {
    doc.destroy();
  }
}

const isHigh = (c: number): boolean => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number): boolean => c >= 0xdc00 && c <= 0xdfff;
