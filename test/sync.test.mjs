import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, RateLimiter, runSync, decide } from '../src/sync.mjs';
import { emptyState } from '../src/state.mjs';

const G = '438861227';
const PLAYERS = '906684075', ADMIN = '906704097', AM = '906422107', BASE = '12884901889';
const KEY = 'TEST_KEY_DO_NOT_LEAK';
const rp = (id) => `groups/${G}/roles/${id}`;
const silent = { info() {}, warn() {}, error() {} };
const capture = () => { const lines = []; return { lines, info: (m) => lines.push(m), warn: (m) => lines.push(m), error: (m) => lines.push(m) }; };

const ROLES = [
  { id: ADMIN, displayName: 'Admin', rank: 255 },
  { id: AM, displayName: 'Assistant Manager', rank: 254 },
  { id: PLAYERS, displayName: 'Players', rank: 1 },
];
const mem = (uid, roles, created = '2026-11-06T00:00:00Z') => ({
  path: `groups/${G}/memberships/${Buffer.from(String(uid)).toString('base64').replace(/=+$/, '')}`,
  user: `users/${uid}`, createTime: created,
  role: roles.length ? rp(roles[0]) : rp(BASE), roles: roles.map(rp),
});

/** Fake Open Cloud. `members` is mutable; assignRole adds the role (additive, like the real API). */
function fakeApi({ members, pageSize = 2, failAssign = {}, rateLimitOnce = false }) {
  const calls = [];
  let limited = !rateLimitOnce;
  const json = (status, body, headers = {}) => ({ ok: status < 300, status, headers: new Headers(headers), text: async () => JSON.stringify(body) });
  const fetchImpl = async (url, opts) => {
    const u = new URL(url);
    calls.push({ method: opts.method, path: u.pathname, search: u.search, body: opts.body, headers: opts.headers });
    assert.equal(opts.headers['x-api-key'], KEY);
    if (!limited) { limited = true; return json(429, { message: 'Too many requests' }, { 'retry-after': '1' }); }
    if (u.pathname === `/cloud/v2/groups/${G}/roles`) return json(200, { groupRoles: ROLES, nextPageToken: '' });
    if (u.pathname === `/cloud/v2/groups/${G}/memberships`) {
      const start = Number(u.searchParams.get('pageToken') || 0);
      const page = members.slice(start, start + pageSize);
      const next = start + pageSize < members.length ? String(start + pageSize) : '';
      return json(200, { groupMemberships: page, nextPageToken: next });
    }
    const m = u.pathname.match(/memberships\/([^/]+):assignRole$/);
    if (opts.method === 'POST' && m) {
      const id = decodeURIComponent(m[1]);
      if (failAssign[id]) return json(failAssign[id], { message: `fail with ${KEY}` });
      const target = members.find((x) => x.path.endsWith(`/${id}`));
      const role = JSON.parse(opts.body).role;
      if (!target.roles.includes(role)) target.roles.push(role);
      return json(200, target);
    }
    return json(404, {});
  };
  return { fetchImpl, calls };
}

const cfg = (o = {}) => ({ groupId: G, playersRoleId: PLAYERS, protectedRoleIds: [ADMIN, AM], dryRun: false, maxAssignmentsPerRun: 200, maxFailuresPerMember: 3, ...o });
const mkClient = (fetchImpl, log = silent) =>
  createClient({ apiKey: KEY, fetchImpl, limiter: new RateLimiter(100000, { sleep: async () => {} }), sleep: async () => {}, log, baseBackoffMs: 1 });

test('assigns Players only to Base-Member-only members; staff untouched; paginates', async () => {
  const members = [mem(119115246, [ADMIN]), mem(99081610, [AM]), mem(1039353588, [PLAYERS]), mem(11692369548, []), mem(555, [])];
  const api = fakeApi({ members });
  const state = emptyState();
  const s = await runSync({ config: cfg(), client: mkClient(api.fetchImpl), state, log: silent });
  assert.equal(s.scanned, 5);
  assert.equal(s.assigned, 2);
  assert.equal(s.protected, 2);
  assert.equal(s.alreadyHad, 1);
  const posts = api.calls.filter((c) => c.method === 'POST');
  assert.equal(posts.length, 2);
  for (const p of posts) {
    assert.match(p.path, /:assignRole$/);
    assert.deepEqual(JSON.parse(p.body), { role: rp(PLAYERS) });
  }
  // No PATCH and no unassignRole ever.
  assert.ok(!api.calls.some((c) => c.method === 'PATCH' || c.path.includes('unassignRole')));
  assert.deepEqual(members[0].roles, [rp(ADMIN)]);
  assert.deepEqual(members[1].roles, [rp(AM)]);
  assert.ok(api.calls.filter((c) => c.path.endsWith('/memberships')).length >= 3, 'should paginate');
});

test('second run makes no write calls (dedupe via state)', async () => {
  const members = [mem(1, []), mem(2, [PLAYERS])];
  const api = fakeApi({ members });
  const state = emptyState();
  await runSync({ config: cfg(), client: mkClient(api.fetchImpl), state, log: silent });
  const before = api.calls.length;
  const s2 = await runSync({ config: cfg(), client: mkClient(api.fetchImpl), state, log: silent });
  assert.equal(s2.assigned, 0);
  assert.equal(s2.skippedProcessed, 2);
  assert.ok(!api.calls.slice(before).some((c) => c.method === 'POST'));
});

test('manual removal of Players by an admin is respected (not re-added)', async () => {
  const members = [mem(1, [])];
  const api = fakeApi({ members });
  const state = emptyState();
  await runSync({ config: cfg(), client: mkClient(api.fetchImpl), state, log: silent });
  members[0].roles = []; // admin removed it manually
  const s = await runSync({ config: cfg(), client: mkClient(api.fetchImpl), state, log: silent });
  assert.equal(s.assigned, 0);
});

test('leave + rejoin (new createTime) is treated as a new member', async () => {
  const members = [mem(7, [])];
  const api = fakeApi({ members });
  const state = emptyState();
  await runSync({ config: cfg(), client: mkClient(api.fetchImpl), state, log: silent });
  members.length = 0; // left
  await runSync({ config: cfg(), client: mkClient(api.fetchImpl), state, log: silent });
  assert.equal(Object.keys(state.processed).length, 0, 'pruned after leaving');
  members.push(mem(7, [], '2026-11-07T00:00:00Z')); // rejoined
  const s = await runSync({ config: cfg(), client: mkClient(api.fetchImpl), state, log: silent });
  assert.equal(s.assigned, 1);
});

test('dry run changes nothing', async () => {
  const members = [mem(1, []), mem(2, [])];
  const api = fakeApi({ members });
  const state = emptyState();
  const s = await runSync({ config: cfg({ dryRun: true }), client: mkClient(api.fetchImpl), state, log: silent });
  assert.equal(s.wouldAssign, 2);
  assert.ok(!api.calls.some((c) => c.method === 'POST'));
  assert.equal(Object.keys(state.processed).length, 0);
});

test('429 with Retry-After is retried', async () => {
  const members = [mem(1, [])];
  const api = fakeApi({ members, rateLimitOnce: true });
  const s = await runSync({ config: cfg(), client: mkClient(api.fetchImpl), state: emptyState(), log: silent });
  assert.equal(s.assigned, 1);
});

test('500s retried then counted; gives up after maxFailuresPerMember runs', async () => {
  const members = [mem(1, [])];
  const id = members[0].path.split('/').pop();
  const api = fakeApi({ members, failAssign: { [id]: 503 } });
  const state = emptyState();
  for (let i = 0; i < 3; i++) await runSync({ config: cfg(), client: mkClient(api.fetchImpl), state, log: silent });
  assert.equal(state.processed[members[0].path].outcome, 'gave_up');
  const postsBefore = api.calls.filter((c) => c.method === 'POST').length;
  assert.equal(postsBefore, 3 * 5, '5 HTTP attempts per run x 3 runs');
  await runSync({ config: cfg(), client: mkClient(api.fetchImpl), state, log: silent });
  assert.equal(api.calls.filter((c) => c.method === 'POST').length, postsBefore, 'no more attempts after giving up');
});

test('403 stops the run early, is not retried, and never leaks the key in logs', async () => {
  const members = [mem(1, []), mem(2, [])];
  const fail = Object.fromEntries(members.map((m) => [m.path.split('/').pop(), 403]));
  const api = fakeApi({ members, failAssign: fail });
  const log = capture();
  const state = emptyState();
  const s = await runSync({ config: cfg(), client: mkClient(api.fetchImpl, log), state, log });
  assert.equal(api.calls.filter((c) => c.method === 'POST').length, 1);
  assert.equal(s.failed, 1);
  assert.ok(log.lines.length > 0);
  assert.ok(!log.lines.join('\n').includes(KEY), 'key must be redacted');
  assert.ok(state.processed[members[1].path] === undefined && Object.keys(state.processed).length === 0);
  assert.ok(!JSON.stringify(state).includes(KEY));
});

test('aborts with no writes if the Players role ID is wrong', async () => {
  const api = fakeApi({ members: [mem(1, [])] });
  await assert.rejects(runSync({ config: cfg({ playersRoleId: '123' }), client: mkClient(api.fetchImpl), state: emptyState(), log: silent }), /not found/);
  assert.ok(!api.calls.some((c) => c.method === 'POST'));
});

test('decide(): unknown/private role is protected; lower-ranked role gets Players added', () => {
  const ranks = new Map([[ADMIN, 255], [PLAYERS, 1], ['42', 0]]);
  const ctx = { playersRoleId: PLAYERS, playersRank: 1, roleRanks: ranks, protectedRoleIds: new Set([ADMIN]) };
  assert.equal(decide(mem(1, ['999']), ctx).action, 'protected');
  assert.equal(decide(mem(1, ['42']), ctx).action, 'assign');
  assert.equal(decide(mem(1, []), ctx).action, 'assign');
  assert.equal(decide(mem(1, [ADMIN, PLAYERS]), ctx).action, 'already_has_role');
});

test('rate limiter spaces requests', async () => {
  let t = 0; const waits = [];
  const rl = new RateLimiter(60, { now: () => t, sleep: async (ms) => { waits.push(ms); t += ms; } });
  for (let i = 0; i < 4; i++) await rl.acquire();
  assert.deepEqual(waits, [1000, 1000, 1000]);
});
