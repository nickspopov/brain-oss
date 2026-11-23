// Global setup of the screenshot tour: a clean output directory (old PNGs, INDEX.md, tour state).
import fs from 'node:fs';
import path from 'node:path';

export default function setup(): void {
  const out = process.env.SHOTS_OUT;
  if (!out) throw new Error('SHOTS_OUT is not set');
  fs.mkdirSync(out, { recursive: true });
  for (const f of fs.readdirSync(out)) if (f.endsWith('.png') || f === 'INDEX.md' || f === '.tour.json') fs.rmSync(path.join(out, f));
}
