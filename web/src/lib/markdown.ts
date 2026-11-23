// Markdown preview: markdown-it with `html: false`, then DOMPurify.
// External images are not loaded (CSP `img-src 'self' data:`; here they are replaced with a link),
// external links (after DOMPurify) open in a new tab without a referrer, relative ones lead to documents
// of the same space inside the UI.
import DOMPurify from 'dompurify';
import MarkdownIt from 'markdown-it';
import { resolveDocLink, routes } from './routes';
import { tx } from '../i18n';

export interface RenderEnv {
  [key: string]: unknown;
  space: string;
  /** Path of the current document: relative links are resolved from it. */
  docPath: string;
}

const md = new MarkdownIt({ html: false, linkify: true, typographer: false, breaks: false });

const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const defaultLinkOpen = md.renderer.rules.link_open ?? ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options));

md.renderer.rules.link_open = (tokens, idx, options, rawEnv, self) => {
  const env = rawEnv as RenderEnv | undefined;
  const token = tokens[idx]!;
  const href = String(token.attrGet('href') ?? '');
  const local = env?.space ? resolveDocLink(env.docPath, href) : null;
  if (env && local) {
    token.attrSet('href', routes.doc(env.space, local.path) + local.hash);
    token.attrSet('data-internal', '1');
  }
  return defaultLinkOpen(tokens, idx, options, rawEnv, self);
};

md.renderer.rules.image = (tokens, idx, options, env, self) => {
  const token = tokens[idx]!;
  const src = String(token.attrGet('src') ?? '');
  const alt = self.renderInlineAsText(token.children ?? [], options, env);
  if (/^data:image\/(png|gif|jpeg|webp);/i.test(src)) {
    return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">`;
  }
  // The image is not loaded; a caption takes its place (and a link, if the address is external).
  const label = tx.markdown.image(alt ? escapeHtml(alt) : '');
  if (/^https?:\/\//i.test(src)) {
    return `<a href="${escapeHtml(src)}" class="md-image-link">${label}</a>`;
  }
  return `<span class="md-image-link">${label}</span>`;
};

// DOMPurify strips target/rel; external links are marked after sanitising (the hook below).
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName !== 'A') return;
  const href = node.getAttribute('href') ?? '';
  if (/^(https?:)?\/\//i.test(href) || /^mailto:/i.test(href)) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer nofollow');
  } else {
    node.removeAttribute('target');
  }
});

const PURIFY = {
  ADD_ATTR: ['data-internal'],
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'iframe', 'object', 'embed', 'svg', 'math'],
  FORBID_ATTR: ['style'],
  ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|\/|#|data:image\/(?:png|gif|jpeg|webp);)/i,
};

/** Safe preview HTML. */
export function renderMarkdown(src: string, env: RenderEnv): string {
  const html = md.render(src, { ...env });
  return DOMPurify.sanitize(html, PURIFY) as unknown as string;
}
