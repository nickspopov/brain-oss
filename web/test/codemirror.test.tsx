// The real CodeMirror 6 in jsdom: the value is shown, an edit reaches onChange, an external
// value change (e.g. "take the current version") replaces the text, Ctrl+S saves.
import { EditorView } from '@codemirror/view';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CodeEditor from '../src/components/CodeEditor';

afterEach(() => cleanup());

function viewOf(container: HTMLElement): EditorView {
  const el = container.querySelector('.cm-editor');
  const view = el && EditorView.findFromDOM(el as HTMLElement);
  if (!view) throw new Error('no editor');
  return view;
}

describe('CodeEditor (CodeMirror 6)', () => {
  it('shows the value, reports edits, accepts an external value and saves on Ctrl+S', () => {
    const onChange = vi.fn();
    const onSave = vi.fn();
    const { container, rerender } = render(<CodeEditor value={'# Heading\n\ntext'} onChange={onChange} label="Document text" onSave={onSave} />);
    const view = viewOf(container);
    expect(view.state.doc.toString()).toBe('# Heading\n\ntext');
    expect(container.querySelector('.cm-content')?.getAttribute('aria-label')).toBe('Document text');

    view.dispatch({ changes: { from: view.state.doc.length, insert: '\nmore' } });
    expect(onChange).toHaveBeenLastCalledWith('# Heading\n\ntext\nmore');

    onChange.mockClear();
    rerender(<CodeEditor value="replaced" onChange={onChange} label="Document text" onSave={onSave} />);
    expect(viewOf(container).state.doc.toString()).toBe('replaced');

    const content = container.querySelector('.cm-content') as HTMLElement;
    content.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('markup in the text stays text: nothing is rendered as HTML inside the editor', () => {
    const { container } = render(<CodeEditor value={'<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>'} onChange={() => {}} label="t" />);
    expect(container.querySelector('.cm-content img')).toBeNull();
    expect(container.querySelector('.cm-content script')).toBeNull();
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });
});
