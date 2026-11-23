// Names of principals, groups and space slugs.
export const NAME_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}
