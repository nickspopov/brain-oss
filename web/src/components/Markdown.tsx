// Markdown preview: the HTML is already sanitised (lib/markdown). Internal links go through the router, without a reload.
import { useMemo, type MouseEvent } from 'react';
import { useNavigate } from 'react-router';
import { renderMarkdown, type RenderEnv } from '../lib/markdown';

export function Markdown({ source, env }: { source: string; env: RenderEnv }) {
  const navigate = useNavigate();
  const html = useMemo(() => renderMarkdown(source, env), [source, env.space, env.docPath]);
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = (e.target as HTMLElement).closest('a[data-internal]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href) return;
    e.preventDefault();
    navigate(href);
  };
  return <div className="md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
