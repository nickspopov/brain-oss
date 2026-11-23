// Secret samples for a07 and the scanner unit tests. Values are assembled at test time
// from random bytes: the sources contain no literal that looks like a real key.
import { randomBytes } from 'node:crypto';

export const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const UPPER = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
export const DIGITS = '0123456789';
export const B64URL = ALNUM + '-_';

export function rand(alphabet: string, n: number): string {
  const bytes = randomBytes(n);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}
const b64url = (s: string) => Buffer.from(s).toString('base64url');
const join = (...parts: string[]) => parts.join('');

/** One example per scanner rule. */
export function secretSamples(): Record<string, string> {
  return {
    slack_bot: join('xo', 'xb-', rand(DIGITS, 12), '-', rand(DIGITS, 13), '-', rand(ALNUM, 24)),
    slack_user: join('xo', 'xp-', rand(DIGITS, 12), '-', rand(DIGITS, 12), '-', rand(DIGITS, 13), '-', rand('0123456789abcdef', 32)),
    slack_app: join('xo', 'xa-', rand(DIGITS, 1), '-', rand(ALNUM, 40)),
    slack_refresh: join('xo', 'xr-', rand(ALNUM, 40)),
    slack_session: join('xo', 'xs-', rand(DIGITS, 12), '-', rand(ALNUM, 30)),
    openai: join('s', 'k-', rand(ALNUM, 48)),
    openai_project: join('s', 'k-proj-', rand(B64URL, 64)),
    anthropic: join('s', 'k-ant-api03-', rand(B64URL, 93), 'AA'),
    github_pat_classic: join('gh', 'p_', rand(ALNUM, 36)),
    github_oauth: join('gh', 'o_', rand(ALNUM, 36)),
    github_server: join('gh', 's_', rand(ALNUM, 36)),
    github_user: join('gh', 'u_', rand(ALNUM, 36)),
    github_fine_grained: join('github', '_pat_', rand(ALNUM, 22), '_', rand(ALNUM, 59)),
    aws_access_key: join('AK', 'IA', rand(UPPER, 16)),
    aws_secret_nearby: join('aws_secret_access_key = ', rand(ALNUM + '+/', 40)),
    google_api: join('AI', 'za', rand(B64URL, 35)),
    stripe_secret: join('sk', '_live_', rand(ALNUM, 32)),
    stripe_restricted: join('rk', '_live_', rand(ALNUM, 32)),
    telegram_bot: join(rand(DIGITS, 10), ':AA', rand(B64URL, 33)),
    pem_private_key: join('-----BEGIN ', 'RSA PRIVATE KEY-----\n', rand(ALNUM, 64), '\n', rand(ALNUM, 64), '\n-----END ', 'RSA PRIVATE KEY-----'),
    jwt: [b64url('{"alg":"HS256","typ":"JWT"}'), b64url(`{"sub":"${rand(DIGITS, 10)}","name":"x"}`), rand(B64URL, 43)].join('.'),
    brain_token: join('br', 'n_', rand(B64URL, 43)),
    generic_assignment: join('api_key = "', rand(ALNUM + '+/', 40), '"'),
  };
}
