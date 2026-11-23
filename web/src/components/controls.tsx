// One component per control type: Select (content width, chevron
// inside), Menu (the ⋯ and avatar menus), Combobox (picking people and agents), Page (one layout).
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';

const FIELD =
  'rounded-md border border-zinc-300 bg-white text-sm outline-none focus:border-sky-500 focus:ring-2 focus:ring-sky-500/30 disabled:opacity-60 dark:border-zinc-700 dark:bg-zinc-900';

/**
 * The select: a native `<select>` (keyboard, screen readers and phones for free) without the native
 * arrow. Width follows the content between 120 and 280 px; the chevron sits 8 px inside the right edge.
 */
export function Select({ className = '', children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className={`relative inline-flex max-w-[280px] min-w-[120px] align-middle ${className}`}>
      <select {...props} className={`${FIELD} w-full min-w-[120px] max-w-[280px] cursor-pointer appearance-none truncate py-1.5 pr-7 pl-2.5`}>
        {children}
      </select>
      <svg aria-hidden viewBox="0 0 12 12" className="pointer-events-none absolute top-1/2 right-2 h-3 w-3 -translate-y-1/2 text-zinc-500">
        <path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

/** Closes on Escape and on a click outside `ref`. */
function useDismiss(open: boolean, close: () => void, ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close, ref]);
}

export const MENU_ITEM = 'block w-full rounded px-3 py-1.5 text-left text-sm hover:bg-zinc-100 focus:bg-zinc-100 focus:outline-none dark:hover:bg-zinc-800 dark:focus:bg-zinc-800';

/**
 * A button that opens a small menu. `children` gets `close` so an item can close the menu after acting.
 * Items are ordinary links and buttons with role="menuitem".
 */
export function Menu({
  label,
  button,
  buttonClass,
  align = 'right',
  named = false,
  children,
}: {
  label: string;
  button: ReactNode;
  /** The button content already names it (visible text must be part of the name, WCAG 2.5.3): no aria-label. */
  named?: boolean;
  buttonClass?: string;
  align?: 'left' | 'right';
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const close = useRef(() => setOpen(false)).current;
  useDismiss(open, close, ref);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-label={named ? undefined : label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen((v) => !v)}
        className={
          buttonClass ??
          'rounded-md border border-zinc-300 px-2.5 py-1 text-sm hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-800'
        }
      >
        {button}
      </button>
      {open && (
        <div
          id={id}
          role="menu"
          aria-label={label}
          className={`absolute z-40 mt-1 min-w-44 rounded-md border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-900 ${
            align === 'right' ? 'right-0' : 'left-0'
          }`}
        >
          {children(close)}
        </div>
      )}
    </div>
  );
}

export interface ComboOption {
  value: string;
  /** Main text of the row (display name). */
  label: string;
  /** Secondary text after the label: handle, "managed by …". */
  detail?: string;
  badge?: ReactNode;
  /** A second, muted line: the profile's "what I do". */
  hint?: string;
}

/**
 * Pick one of a known set by typing (WAI-ARIA combobox with a listbox popup). Only `options` can be
 * chosen: free text that matches none is not a value (`onChange('')`).
 */
export function Combobox({
  id,
  label,
  options,
  value,
  onChange,
  placeholder,
  empty,
  autoFocus,
}: {
  id: string;
  label: string;
  options: ComboOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Shown when nothing matches. */
  empty: string;
  autoFocus?: boolean;
}) {
  const chosen = options.find((o) => o.value === value);
  const [text, setText] = useState(chosen?.label ?? '');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const listId = `${id}-list`;
  useDismiss(open, () => setOpen(false), ref);
  useEffect(() => {
    if (chosen) setText(chosen.label);
  }, [chosen]);

  const q = text.trim().toLowerCase();
  const shown = chosen && chosen.label === text ? options : options.filter((o) => !q || `${o.label} ${o.value} ${o.detail ?? ''}`.toLowerCase().includes(q));
  const pick = (o: ComboOption) => {
    onChange(o.value);
    setText(o.label);
    setOpen(false);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, shown.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter' && open && shown[active]) {
      e.preventDefault();
      pick(shown[active]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };
  return (
    <div ref={ref} className="relative w-full max-w-md">
      <input
        id={id}
        role="combobox"
        aria-label={label}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && shown[active] ? `${id}-opt-${active}` : undefined}
        autoComplete="off"
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={text}
        className={`${FIELD} w-full px-2.5 py-1.5`}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onKeyDown={onKey}
        onChange={(e) => {
          setText(e.target.value);
          setOpen(true);
          setActive(0);
          const exact = options.find((o) => o.value === e.target.value.trim().toLowerCase());
          onChange(exact ? exact.value : '');
        }}
      />
      {open && (
        <ul id={listId} role="listbox" aria-label={label} className="absolute z-40 mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-800 dark:bg-zinc-900">
          {shown.length === 0 && <li className="px-3 py-1.5 text-sm text-zinc-500">{empty}</li>}
          {shown.map((o, i) => (
            <li
              key={o.value}
              id={`${id}-opt-${i}`}
              role="option"
              aria-selected={o.value === value}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setActive(i)}
              onClick={() => pick(o)}
              className={`flex cursor-pointer flex-wrap items-center gap-x-1.5 rounded px-3 py-1.5 text-sm ${i === active ? 'bg-zinc-100 dark:bg-zinc-800' : ''}`}
            >
              <span className="font-medium">{o.label}</span>
              {o.detail && <span className="text-zinc-500">{o.detail}</span>}
              {o.badge}
              {o.hint && <span className="basis-full text-xs text-zinc-500">{o.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * The one content layout: left-aligned, 24 px gutters, max 960 px for lists and
 * 720 px for documents and forms.
 */
export function Page({ width = 'list', className = '', children }: { width?: 'list' | 'doc'; className?: string; children: ReactNode }) {
  return <div className={`${width === 'doc' ? 'max-w-[720px]' : 'max-w-[960px]'} space-y-4 px-6 py-6 ${className}`}>{children}</div>;
}
