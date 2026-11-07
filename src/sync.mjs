// Core sync logic for the external membership monitor.
//
// Roblox has no "member joined group" webhook, so this polls the official
// Open Cloud List Group Memberships endpoint and, for every member that does
// not yet hold the configured "Players" role, ADDS it with the additive
// :assignRole endpoint (it never removes or replaces other roles).
//
// Endpoints (https://create.roblox.com/docs/cloud/reference/features/groups):
//   GET  /cloud/v2/groups/{groupId}/roles                         (group:read)
//   GET  /cloud/v2/groups/{groupId}/memberships                   (group:read)
//   POST /cloud/v2/groups/{groupId}/memberships/{id}:assignRole   (group:write)
// Rate limit for each: 300 requests/minute per API key owner.

export const API_BASE = 'https://apis.roblox.com/cloud/v2';

export class ApiError extends Error {
  constructor(message, status, retryable) {
    super(message);
    this.status = status;
    this.retryable = retryable;
  }
}

const roleIdOf = (path) => {
  const m = typeof path === 'string' ? path.match(/\/roles\/(\d+)$/) : null;
  return m ? m[1] : null;
};
const membershipIdOf = (path) => {
  const m = typeof path === 'string' ? path.match(/\/memberships\/([^/]+)$/) : null;
  return m ? m[1] : null;
};

/** Spaces requests out so we stay under maxPerMinute (client side). */
export class RateLimiter {
  constructor(maxPerMinute, { now = Date.now, sleep } = {}) {
    this.interval = 60000 / Math.max(1, maxPerMinute);
    this.next = 0;
    this.now = now;
    this.sleep = sleep;
  }
  async acquire() {
    const t = this.now();
    const wait = this.next - t;
    this.next = Math.max(t, this.next) + this.interval;
    if (wait > 0) await this.sleep(wait);
  }
}

export function createClient({ apiKey, fetchImpl, limiter, sleep, log, maxAttempts = 5, baseBackoffMs = 2000 }) {
  const redact = (s) => String(s).split(apiKey).join('[REDACTED]');

  async function request(method, url, body) {
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      await limiter.acquire();
      let res;
      try {
        res = await fetchImpl(url, {
          method,
          headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (e) {
        lastErr = new ApiError(`network error: ${redact(e?.message ?? e)}`, 0, true);
      }
      if (res) {
        if (res.ok) {
          const text = await res.text();
          return text ? JSON.parse(text) : {};
        }
        const snippet = redact((await res.text().catch(() => '')).slice(0, 200));
        const retryable = res.status === 429 || res.status >= 500;
        lastErr = new ApiError(`${method} ${new URL(url).pathname} -> HTTP ${res.status} ${snippet}`, res.status, retryable);
        if (!retryable) throw lastErr;
        const retryAfter = Number(res.headers?.get?.('retry-after'));
        if (attempt < maxAttempts && Number.isFinite(retryAfter) && retryAfter > 0) {
          log.warn(`HTTP ${res.status}; server asked to retry after ${retryAfter}s (attempt ${attempt}/${maxAttempts})`);
          await sleep(retryAfter * 1000);
          continue;
        }
      }
      if (attempt < maxAttempts) {
        const backoff = baseBackoffMs * 2 ** (attempt - 1);
        log.warn(`${lastErr.message} (attempt ${attempt}/${maxAttempts}); retrying in ${Math.round(backoff / 1000)}s`);
        await sleep(backoff + Math.random() * backoff * 0.25);
      }
    }
    throw lastErr;
  }
  return { request };
}

async function listAll(client, url, field) {
  const out = [];
  let pageToken = '';
  let pages = 0;
  do {
    const sep = url.includes('?') ? '&' : '?';
    const pageUrl = pageToken ? `${url}${sep}pageToken=${encodeURIComponent(pageToken)}` : url;
    const data = await client.request('GET', pageUrl);
    out.push(...(data[field] ?? []));
    pageToken = data.nextPageToken || '';
    if (++pages > 10000) throw new Error('pagination safety limit reached');
  } while (pageToken);
  return out;
}

/**
 * Decide what to do with one membership. Pure function (unit-tested).
 * Returns one of: 'already_has_role' | 'protected' | 'assign'
 */
export function decide(membership, { playersRoleId, playersRank, roleRanks, protectedRoleIds }) {
  const roleIds = (membership.roles ?? []).map(roleIdOf).filter(Boolean);
  if (roleIds.includes(playersRoleId)) return { action: 'already_has_role' };
  const highest = roleIdOf(membership.role);
  for (const id of new Set([...roleIds, ...(highest && roleIds.length ? [highest] : [])])) {
    if (protectedRoleIds.has(id)) return { action: 'protected', reason: `holds protected role ${id}` };
    if (!roleRanks.has(id)) return { action: 'protected', reason: `holds unknown/private role ${id}` };
    if (roleRanks.get(id) > playersRank) return { action: 'protected', reason: `holds higher role ${id} (rank ${roleRanks.get(id)})` };
  }
  return { action: 'assign' };
}

/**
 * One full polling pass. Mutates `state` (persist it afterwards).
 * state = { version, processed: {path: {createTime, outcome, at}}, failures: {path: {createTime, attempts, lastError}} }
 */
export async function runSync({ config, client, state, log, now = () => new Date() }) {
  const { groupId, playersRoleId } = config;
  const summary = { scanned: 0, alreadyHad: 0, protected: 0, assigned: 0, wouldAssign: 0, failed: 0, skippedProcessed: 0, gaveUp: 0 };

  // 1) Roles -> ranks (validates the configured Players role ID really exists).
  const roles = await listAll(client, `${API_BASE}/groups/${groupId}/roles?maxPageSize=20`, 'groupRoles');
  const roleRanks = new Map(roles.map((r) => [String(r.id), Number(r.rank)]));
  if (!roleRanks.has(playersRoleId)) {
    throw new Error(`Configured PLAYERS_ROLE_ID ${playersRoleId} was not found in group ${groupId}. Aborting without changes.`);
  }
  const ctx = {
    playersRoleId,
    playersRank: roleRanks.get(playersRoleId),
    roleRanks,
    protectedRoleIds: new Set(config.protectedRoleIds),
  };

  // 2) All memberships (pagination: 100 per page, the documented maximum).
  const memberships = await listAll(client, `${API_BASE}/groups/${groupId}/memberships?maxPageSize=100`, 'groupMemberships');
  summary.scanned = memberships.length;
  const seen = new Set(memberships.map((m) => m.path).filter(Boolean));

  for (const m of memberships) {
    const key = m.path;
    if (!key) continue;

    // Already handled this exact membership (same createTime => not a leave+rejoin)? Never touch it again.
    // This also respects manual changes: if an admin later removes Players from someone, we don't re-add it.
    const prev = state.processed[key];
    if (prev && prev.createTime === m.createTime) {
      summary.skippedProcessed++;
      continue;
    }

    const d = decide(m, ctx);
    if (d.action === 'already_has_role') {
      summary.alreadyHad++;
      state.processed[key] = { createTime: m.createTime, outcome: 'already_has_role', at: now().toISOString() };
      delete state.failures[key];
      continue;
    }
    if (d.action === 'protected') {
      summary.protected++;
      log.info(`skip ${m.user}: ${d.reason}`);
      state.processed[key] = { createTime: m.createTime, outcome: 'protected', at: now().toISOString() };
      continue;
    }

    // d.action === 'assign'
    if (config.dryRun) {
      summary.wouldAssign++;
      log.info(`[DRY RUN] would assign Players to ${m.user}`);
      continue;
    }
    if (summary.assigned >= config.maxAssignmentsPerRun) {
      log.warn(`reached MAX_ASSIGNMENTS_PER_RUN=${config.maxAssignmentsPerRun}; remaining members will be handled next run`);
      break;
    }

    const fail = state.failures[key]?.createTime === m.createTime ? state.failures[key] : { createTime: m.createTime, attempts: 0 };
    const membershipId = membershipIdOf(key) ?? (m.user ?? '').replace('users/', '');
    try {
      const updated = await client.request(
        'POST',
        `${API_BASE}/groups/${groupId}/memberships/${encodeURIComponent(membershipId)}:assignRole`,
        { role: `groups/${groupId}/roles/${playersRoleId}` },
      );
      const ok = (updated.roles ?? []).map(roleIdOf).includes(playersRoleId) || roleIdOf(updated.role) === playersRoleId;
      if (!ok) log.warn(`assignRole for ${m.user} returned 200 but Players is not in the returned roles`);
      summary.assigned++;
      log.info(`assigned Players to ${m.user}`);
      state.processed[key] = { createTime: m.createTime, outcome: 'assigned', at: now().toISOString() };
      delete state.failures[key];
    } catch (e) {
      fail.attempts++;
      fail.lastError = String(e.message).slice(0, 300);
      summary.failed++;
      log.error(`assign failed for ${m.user} (failure ${fail.attempts}/${config.maxFailuresPerMember}): ${fail.lastError}`);
      if (fail.attempts >= config.maxFailuresPerMember) {
        summary.gaveUp++;
        state.processed[key] = { createTime: m.createTime, outcome: 'gave_up', at: now().toISOString(), lastError: fail.lastError };
        delete state.failures[key];
      } else {
        state.failures[key] = fail;
      }
      // Auth/permission problems will fail for everyone - stop early instead of hammering the API.
      if (e.status === 401 || e.status === 403) {
        log.error('stopping this run: API key is invalid or lacks group:write / permission to assign this role');
        break;
      }
    }
  }

  // 3) Forget members who have left (keeps state small; a rejoin is then treated as new).
  for (const key of Object.keys(state.processed)) if (!seen.has(key)) delete state.processed[key];
  for (const key of Object.keys(state.failures)) if (!seen.has(key)) delete state.failures[key];
  state.lastRun = { at: now().toISOString(), ...summary };
  return summary;
}
