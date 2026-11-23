// CodeMirror 6 editor: markdown, line wrapping, edit history, search.
// Loaded lazily (React.lazy) so that reading doesn't pull in the editor code. CodeMirror's styles
// are attached via adoptedStyleSheets, which CSP `default-src 'self'` doesn't forbid. In the document
// style-mod would insert a <style> itself, which CSP blocks; the plugin in vite.config.ts fixes that.
import { markdown } from '@codemirror/lang-markdown';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import { useEffect, useRef } from 'react';

export interface CodeEditorProps {
  value: string;
  onChange: (value: string) => void;
  label: string;
  /** Ctrl/Cmd+S. */
  onSave?: () => void;
}

const theme = EditorView.theme({
  '&': { fontSize: '0.875rem', height: '100%' },
  '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', lineHeight: '1.5' },
  '.cm-content': { padding: '0.5rem 0' },
});

export default function CodeEditor({ value, onChange, label, onSave }: CodeEditorProps) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // Latest callbacks without recreating the editor.
  const cb = useRef({ onChange, onSave });
  cb.current = { onChange, onSave };

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          markdown(),
          EditorView.lineWrapping,
          theme,
          EditorView.contentAttributes.of({ 'aria-label': label, 'aria-multiline': 'true' }),
          EditorView.domEventHandlers({
            keydown: (e) => {
              if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && cb.current.onSave) {
                e.preventDefault();
                cb.current.onSave();
                return true;
              }
              return false;
            },
          }),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cb.current.onChange(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // The editor is created once; external value changes are handled in the effect below.
  }, []);

  // The value was changed from outside (e.g. "take the current version" after a conflict).
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div ref={host} data-testid="code-editor" className="cm-host min-h-[50vh] overflow-hidden rounded-md border border-zinc-300 dark:border-zinc-700" />;
}
