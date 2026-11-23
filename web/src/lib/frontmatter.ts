// Frontmatter is shown as is, separately from the body; the UI neither parses nor executes it.

export function splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(content);
  if (!m) return { frontmatter: null, body: content };
  return { frontmatter: m[1] ?? '', body: content.slice(m[0].length) };
}
