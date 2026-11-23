// Server key (data/secret.key, 0600): cursor encryption. Created on first start.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function ensureSecretKey(dataDir: string): Buffer {
  const file = path.join(dataDir, 'secret.key');
  if (!fs.existsSync(file)) {
    fs.writeFileSync(file, randomBytes(32).toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
  }
  const key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  if (key.length !== 32) throw new Error('data/secret.key must contain 32 bytes in base64');
  return key;
}
