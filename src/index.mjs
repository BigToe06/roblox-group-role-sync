#!/usr/bin/env node
// Entry point. Configuration comes from environment variables (never hard-code the key).
//
//   ROBLOX_API_KEY           required  Open Cloud API key (Groups: read + write)
//   GROUP_ID                 default   438861227
//   PLAYERS_ROLE_ID          default   906684075
//   PROTECTED_ROLE_IDS       default   906704097,906422107   (Admin, Assistant Manager)
//   MODE                     default   once   ("once" for cron/GitHub Actions, "loop" for an always-on server)
//   POLL_INTERVAL_SECONDS    default   300    (loop mode only)
//   STATE_FILE               default   ./state/state.json
//   DRY_RUN                  default   false  ("true" = log what would happen, change nothing)
//   MAX_REQUESTS_PER_MINUTE  default   120    (API allows 300/min per key owner; leave headroom for game servers)
//   MAX_ASSIGNMENTS_PER_RUN  default   200
//   MAX_FAILURES_PER_MEMBER  default   5

import { createClient, RateLimiter, runSync } from './sync.mjs';
import { loadState, saveState } from './state.mjs';

const env = process.env;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = () => new Date().toISOString();
const log = {
  info: (m) => console.log(`${ts()} INFO  ${m}`),
  warn: (m) => console.warn(`${ts()} WARN  ${m}`),
  error: (m) => console.error(`${ts()} ERROR ${m}`),
};

function intEnv(name, def, min) {
  const v = env[name] === undefined || env[name] === '' ? def : Number(env[name]);
  if (!Number.isInteger(v) || v < min) throw new Error(`${name} must be an integer >= ${min}`);
  return v;
}

const apiKey = (env.ROBLOX_API_KEY || '').trim();
if (!apiKey) {
  log.error('ROBLOX_API_KEY is not set. Configure it as a secret (see README).');
  process.exit(2);
}

const config = {
  groupId: String(env.GROUP_ID || '438861227'),
  playersRoleId: String(env.PLAYERS_ROLE_ID || '906684075'),
  protectedRoleIds: String(env.PROTECTED_ROLE_IDS ?? '906704097,906422107').split(',').map((s) => s.trim()).filter(Boolean),
  dryRun: String(env.DRY_RUN || 'false').toLowerCase() === 'true',
  maxAssignmentsPerRun: intEnv('MAX_ASSIGNMENTS_PER_RUN', 200, 1),
  maxFailuresPerMember: intEnv('MAX_FAILURES_PER_MEMBER', 5, 1),
};
for (const [k, v] of [['GROUP_ID', config.groupId], ['PLAYERS_ROLE_ID', config.playersRoleId]]) {
  if (!/^\d+$/.test(v)) throw new Error(`${k} must be numeric`);
}
const mode = (env.MODE || 'once').toLowerCase();
const pollSeconds = intEnv('POLL_INTERVAL_SECONDS', 300, 60);
const stateFile = env.STATE_FILE || './state/state.json';

const limiter = new RateLimiter(intEnv('MAX_REQUESTS_PER_MINUTE', 120, 1), { sleep });
const client = createClient({ apiKey, fetchImpl: fetch, limiter, sleep, log });

async function once() {
  const state = await loadState(stateFile);
  try {
    const s = await runSync({ config, client, state, log });
    log.info(`done: scanned=${s.scanned} assigned=${s.assigned} wouldAssign=${s.wouldAssign} alreadyHad=${s.alreadyHad} protected=${s.protected} skippedProcessed=${s.skippedProcessed} failed=${s.failed} gaveUp=${s.gaveUp}${config.dryRun ? ' (DRY RUN)' : ''}`);
    return s.failed === 0;
  } finally {
    await saveState(stateFile, state); // persist progress even if the run aborted midway
  }
}

if (mode === 'loop') {
  let stopping = false;
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; log.info(`${sig} received, stopping after this pass`); });
  log.info(`loop mode: polling every ${pollSeconds}s`);
  while (!stopping) {
    try { await once(); } catch (e) { log.error(`pass failed: ${e.message}`); }
    for (let waited = 0; waited < pollSeconds && !stopping; waited++) await sleep(1000);
  }
} else {
  try {
    const clean = await once();
    process.exitCode = clean ? 0 : 1;
  } catch (e) {
    log.error(e.message);
    process.exitCode = 1;
  }
}
