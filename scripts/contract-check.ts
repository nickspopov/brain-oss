// Compatibility check for the v1 contract. Run: npm run contract-check [-- --update].
// Compares the registry with the committed test/contract/v1.snapshot.json: a removed or changed
// field is an error. `--update` rewrites the snapshot only if the changes are compatible.
import fs from 'node:fs';
import path from 'node:path';
import { buildSnapshot, contractBreaks, type ContractSnapshot } from './contract-lib.js';

const FILE = path.resolve(import.meta.dirname, '../test/contract/v1.snapshot.json');
const update = process.argv.includes('--update');
const current = buildSnapshot();
const text = JSON.stringify(current, null, 2) + '\n';

if (!fs.existsSync(FILE)) {
  if (!update) {
    console.error('contract-check: no snapshot; run `npm run contract-check -- --update`');
    process.exit(1);
  }
  fs.writeFileSync(FILE, text);
  console.log('contract-check: snapshot created');
  process.exit(0);
}

const saved = JSON.parse(fs.readFileSync(FILE, 'utf8')) as ContractSnapshot;
const breaks = contractBreaks(saved, current);
if (breaks.length) {
  console.error('contract-check: incompatible changes to contract v1:');
  for (const b of breaks) console.error(`  - ${b}`);
  process.exit(1);
}
const same = JSON.stringify(saved) === JSON.stringify(current);
if (!same && update) {
  fs.writeFileSync(FILE, text);
  console.log('contract-check: compatible changes; snapshot updated (remember to bump contract_version 1.N)');
} else if (!same) {
  console.error('contract-check: compatible changes not yet in the snapshot; run `npm run contract-check -- --update`');
  process.exit(1);
} else {
  console.log(`contract-check: ok (${Object.keys(current.operations).length} operations, ${current.contract_version})`);
}
