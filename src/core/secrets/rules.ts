// Secret scanner rules. Written from scratch along gitleaks categories; its configuration is not
// copied. No expression has nested quantifiers, and the whole pass is linear in text length: a rule
// whose value runs to the end of a "word" ([A-Za-z0-9_-]) gives an unbounded body plus `maxLen`
// (see below), and JWT is found by its own pass (findJwt).
// Placeholders (`xoxb-XXXX`, `sk-...`, `<YOUR_API_KEY>`) do not match: rules require a realistic length, alphabet and (where needed) entropy of the value.

export interface SecretRule {
  id: string;
  description: string;
  /** The `g` flag is required: the scanner walks all matches. */
  re: RegExp;
  /** Index of the group holding the secret value (for the entropy check); 0 = the whole match. */
  group?: number;
  /** Minimum Shannon entropy of the value (bits per character). */
  minEntropy?: number;
  /** The value must contain both a letter and a digit (generic pattern: rules out paths and words). */
  mixed?: boolean;
  /**
   * Maximum match length. For rules of the form `prefix[W]{min,}`, where W is the same class as in
   * END: the greedy body always reaches the end of the word, so this is the same as `[W]{min,max}END`
   * but without backtracking. A longer match means a suitable start can only be closer to the end of
   * the word: the search resumes at (end − maxLen), and each word is read at most twice. With
   * `{min,max}END` backtracking started from every prefix inside a long word: `"-sk-"×128K` took
   * 0.3 s.
   */
  maxLen?: number;
  /** Custom linear search instead of `re` (JWT). */
  find?: (text: string) => Iterable<{ index: number; value: string }>;
}

const W = '[A-Za-z0-9_-]';
/** No letter/digit/`_`/`-` after the match: the key is not cut in the middle. */
const END = '(?![A-Za-z0-9_-])';

/**
 * JWT: `eyJ<seg>.eyJ<seg>.<seg>` (like `\beyJ[W]{10,2000}\.eyJ[W]{4,8000}\.[W]{20,2000}END`).
 * As a single regex it backtracked from every `eyJ` inside a long word for up to 2000 characters:
 * `"-eyJ"×128K` (512 KB) took 2–3 s per write inside the transaction. Here the first segment is
 * matched greedily to the end of the word (the dot is not in the class, so all starts inside one
 * word end at the same place and share the same fate); the tail is checked once per word.
 */
function* findJwt(text: string): Iterable<{ index: number; value: string }> {
  const head = new RegExp(`\\beyJ${W}{10,}`, 'g');
  const tail = new RegExp(`\\.eyJ${W}{4,8000}\\.${W}{20,2000}${END}`, 'y');
  const MAX_HEAD = 3 + 2000;
  for (let m = head.exec(text); m !== null; m = head.exec(text)) {
    const end = m.index + m[0].length;
    if (m[0].length > MAX_HEAD) {
      head.lastIndex = end - MAX_HEAD;
      continue;
    }
    head.lastIndex = end;
    tail.lastIndex = end;
    const t = tail.exec(text);
    if (t) {
      yield { index: m.index, value: m[0] + t[0] };
      head.lastIndex = end + t[0].length;
    }
  }
}

export const SECRET_RULES: readonly SecretRule[] = [
  {
    id: 'slack_token',
    description: 'Slack token (xoxb, xoxp, xoxa, xoxr, xoxs)',
    re: /\bxox[baprs]-[0-9A-Za-z-]{20,250}/g,
    minEntropy: 3,
  },
  {
    id: 'anthropic_api_key',
    description: 'Anthropic API key',
    re: new RegExp(`\\bsk-ant-${W}{32,}`, 'g'),
    maxLen: 7 + 250,
    minEntropy: 3,
  },
  {
    id: 'openai_api_key',
    description: 'OpenAI API key (sk-, sk-proj-)',
    re: new RegExp(`\\bsk-(?!ant-)${W}{32,}`, 'g'),
    maxLen: 3 + 250,
    minEntropy: 3,
  },
  {
    id: 'github_token',
    description: 'GitHub token (ghp_, gho_, ghs_, ghu_, ghr_)',
    re: new RegExp(`\\bgh[pousr]_[A-Za-z0-9]{36,255}${END}`, 'g'),
    minEntropy: 3,
  },
  {
    id: 'github_fine_grained_pat',
    description: 'GitHub fine-grained personal access token',
    re: new RegExp(`\\bgithub_pat_[A-Za-z0-9_]{50,255}${END}`, 'g'),
    minEntropy: 3,
  },
  {
    id: 'aws_access_key_id',
    description: 'AWS access key id',
    re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    minEntropy: 2.5,
  },
  {
    id: 'aws_secret_access_key',
    description: 'AWS secret access key next to its name',
    re: /aws[_ .-]{0,2}secret[_ .-]{0,2}(?:access[_ .-]{0,2})?key["']?\s{0,5}[:=]\s{0,5}["']?([A-Za-z0-9/+]{40})(?![A-Za-z0-9/+=])/gi,
    group: 1,
    minEntropy: 3.5,
  },
  {
    id: 'google_api_key',
    description: 'Google API key',
    re: new RegExp(`\\bAIza[0-9A-Za-z_-]{35}${END}`, 'g'),
    minEntropy: 3,
  },
  {
    id: 'stripe_live_key',
    description: 'Stripe live secret or restricted key',
    re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,250}\b/g,
    minEntropy: 3,
  },
  {
    id: 'telegram_bot_token',
    description: 'Telegram bot token',
    re: new RegExp(`\\b\\d{8,10}:AA[0-9A-Za-z_-]{33}${END}`, 'g'),
    minEntropy: 3,
  },
  {
    id: 'private_key_block',
    description: 'PEM private key block',
    // Header and first body line: a block added as a whole touches the new lines.
    re: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----(?:\r?\n[A-Za-z0-9+/=]{1,100})?/g,
  },
  {
    id: 'jwt',
    description: 'JSON Web Token',
    re: /(?!)/g,
    find: findJwt,
    minEntropy: 3,
  },
  {
    id: 'brain_token',
    description: 'Brain access token',
    re: new RegExp(`\\bbrn_[A-Za-z0-9_-]{43}${END}`, 'g'),
    minEntropy: 3,
  },
  {
    id: 'generic_secret_assignment',
    description: 'password / secret / token / api_key assigned a long high-entropy value',
    re: /(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret)[A-Za-z0-9_.-]{0,30}["']?\s{0,5}[:=]\s{0,5}["']?([A-Za-z0-9+/_.=~-]{20,500})/gi,
    group: 1,
    minEntropy: 3.5,
    mixed: true,
  },
];

/** Shannon entropy of a string, in bits per character. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}
