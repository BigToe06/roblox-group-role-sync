// Tiny JSON state store: which memberships were already processed, and failure counters.
// Written atomically (temp file + rename) so a crash can't leave a half-written file.
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export const emptyState = () => ({ version: 1, processed: {}, failures: {}, lastRun: null });

export async function loadState(file) {
  try {
    const s = JSON.parse(await readFile(file, 'utf8'));
    if (s?.version !== 1 || typeof s.processed !== 'object' || typeof s.failures !== 'object') throw new Error('bad shape');
    return s;
  } catch (e) {
    if (e.code !== 'ENOENT') console.warn(`state file unreadable (${e.message}); starting fresh`);
    return emptyState();
  }
}

export async function saveState(file, state) {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2));
  await rename(tmp, file);
}
