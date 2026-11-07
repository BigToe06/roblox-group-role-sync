# The Office Game Devs: automatic "Players" role

This project has two parts that work together:

| Part | Where it runs | What it does |
|---|---|---|
| **External monitor** (this folder) | GitHub Actions, every 10 min | Scans the whole community and gives the **Players** role to every member who doesn't have it. It doesn't matter how they joined (website, app or game), and it runs with 0 players online. |
| **In-game backup** (`ServerScriptService.GroupRoleSync`) | Your Roblox game servers | When a Base-Member-only group member joins the game, it gives them Players right away. |

Your IDs were read from Open Cloud on 2026-11-06:

| | ID | Rank |
|---|---|---|
| Group "The Office Game Devs" | `438861227` | |
| Admin | `906704097` | 255 (protected) |
| Assistant Manager | `906422107` | 254 (protected) |
| **Players** | **`906684075`** | 1 |

"Player" and "Guest" were not returned as assignable roles, so neither part references them.

---

## What Roblox supports (verified)

* **New members get the hidden *Base Member* role.** The membership's `roles` list is `[]`. Groups made under the new multi-role system never auto-assign a custom role.
* **Roblox has no group-joined webhook.** Polling List Group Memberships is the only supported way to see joins made outside the game.
* Endpoints ([Groups reference](https://create.roblox.com/docs/cloud/reference/features/groups)). Each is limited to **300 requests/min per API key owner**:
  * `GET /cloud/v2/groups/{groupId}/roles` (`group:read`)
  * `GET /cloud/v2/groups/{groupId}/memberships?maxPageSize=100&pageToken=…&filter=user == 'users/{id}'` (`group:read`)
  * `POST /cloud/v2/groups/{groupId}/memberships/{membershipId}:assignRole` with body `{"role":"groups/{groupId}/roles/{roleId}"}` (`group:write`). This call is **additive**: it never removes other roles. The external monitor uses it.
  * `PATCH /cloud/v2/groups/{groupId}/memberships/{membershipId}` (`group:write`). It is deprecated and can replace roles. It is the only *write* endpoint game servers are allowed to call ([HttpService allow-list](https://create.roblox.com/docs/cloud-services/http-service)). The in-game backup therefore only uses it on members whose `roles` list is **empty**.
  * "A user ID can be used in place of a membership ID."
* The key's owner must be allowed to assign the role: the requester has to be able to assign roles *below their highest role*. Create the keys while logged in as the **group owner** account.

## Safety rules (both parts)

1. Members who already have Players are skipped.
2. Members holding Admin, Assistant Manager, any role ranked above Players, or a role the key can't see are **never touched**.
3. Non-members are never touched. The in-game part checks membership through Roblox first and then through Open Cloud.
4. No code path ever calls `unassignRole`. The external monitor never calls PATCH.
5. Once a membership has been processed, it is not processed again. If you manually remove Players from someone, it is **not** re-added. If someone leaves and rejoins, they are treated as a new member.

---

## Setup

### Step 1: Create the API keys (Creator Hub)

Use **two keys**, one for the game and one for GitHub, so either can be revoked on its own.

1. Log in as the **group owner** account.
2. Go to <https://create.roblox.com/dashboard/credentials?activeTab=ApiKeysTab> and click **Create API Key**.
3. **Name:** `group-role-sync-game` (repeat the steps for a second key named `group-role-sync-github`).
4. **Access Permissions:** add the **Groups** API, then select **Read** and **Write** operations (`group:read`, `group:write`). If it asks for a group, pick *The Office Game Devs*.
5. **Security / IP restrictions:** leave them **off**. Roblox says not to use IP restrictions for keys used by Roblox servers, and GitHub runners have changing IPs.
6. **Expiration:** optional. Keys unused for 60 days expire automatically, but both of these are used constantly.
7. Click **Save & Generate key** and copy the key. It is shown only once. **Never paste it into any script, chat or commit.**

### Step 2: Store the game key in the experience Secrets Store

1. Open Creator Dashboard, then **Build A House Tycoon – BETA**, then **Secrets**, then **Create Secret**.
2. **Name:** `GroupRoleApiKey` (must match `Config.SecretName`).
3. **Secret:** the `group-role-sync-game` key.
4. **Domain:** `apis.roblox.com`
5. Only server scripts can read the key, using `HttpService:GetSecret`. Clients get an error. `print()` on a Secret shows only `Secret(GroupRoleApiKey)`.

**Allow HTTP Requests** is already turned on in your place (it was off, and nothing else in your game uses it). **Publish the place** (File, then Publish to Roblox) so live servers get both the setting and the new scripts.

Optional Studio testing: File, then Experience Settings, then Security, then **Local Secrets**. Add `GroupRoleApiKey` there. Without it, a Studio playtest prints one warning, and the in-game sync stays off for that session. That is expected.

### Step 3: Set up the external monitor on GitHub

1. Create a GitHub repository. A **public** repo is free, and nothing secret lives in the code.
2. Upload everything in this folder, keeping the `.github/workflows/group-role-sync.yml` path.
3. Go to **Settings**, then **Secrets and variables**, then **Actions**, then **New repository secret**. Name it `ROBLOX_API_KEY` and paste the `group-role-sync-github` key.
4. (Optional) Under the **Variables** tab you can override `GROUP_ID`, `PLAYERS_ROLE_ID`, `PROTECTED_ROLE_IDS` and `DRY_RUN`. The defaults are already your real IDs.
5. Go to **Actions**, then **Group role sync**, then **Run workflow**, with *Dry run* checked. Read the log. You should see `done: scanned=N … wouldAssign=…` and `skip users/…: holds protected role …` for staff.
6. Run it once more with *Dry run* unchecked. After that it runs by itself every 10 minutes.

**Changing the polling interval:** edit the `cron:` line, for example `"7-59/15 * * * *"` for every 15 minutes. GitHub's minimum is 5 minutes, and scheduled runs can start a few minutes late when GitHub is busy.

### Costs

* **Public repo:** standard GitHub-hosted runners are **free**. Note that GitHub automatically **disables scheduled workflows in public repos after 60 days with no repository activity**. GitHub emails you first. Re-enable it in the Actions tab, or push any commit.
* **Private repo:** each run is billed as at least 1 minute (rounded up). Every 10 minutes is about 4,300 min/month. That is more than GitHub Free's included usage ($12/month, about 2,000 Linux minutes at $0.006/min). Use every 30 minutes (`"4-59/30 * * * *"`, about 1,440 min) to stay free, or expect roughly $14/month for the overage at 10 minutes.
* **Roblox:** Open Cloud and the Secrets Store cost nothing.
* **Alternative host:** run `MODE=loop POLL_INTERVAL_SECONDS=300 node src/index.mjs` on any always-on machine or VPS with Node 20+. State is saved to `STATE_FILE`.

### Rate-limit budget

The groups endpoints allow 300 requests/min **per key owner**. Both keys belong to the same owner, so the game servers and the monitor share that budget. The defaults leave headroom: the monitor caps itself at 120/min and each game server at 30/min. A full scan costs 1 request per 100 members plus 1 for roles. At about 60 members, that is 2 requests per run.

---

## Files

* `src/sync.mjs`: core logic (roles, paginated scan, decision rules, assignRole, retries with backoff, Retry-After support, redaction)
* `src/state.mjs`: processed-membership store (atomic JSON writes)
* `src/index.mjs`: env config, `once`/`loop` modes
* `test/sync.test.mjs`: 11 tests against a fake Open Cloud (`npm test`)
* `.github/workflows/group-role-sync.yml`: the schedule

In Roblox Studio (`ServerScriptService.GroupRoleSync`):

* `Config`: IDs, secret name, cooldowns, rate limits (server-only)
* `GroupRoleService`: the logic (testable; dependencies injected)
* `Main`: hooks PlayerAdded and PlayerRemoving, the existing Group Bonus join (`GroupBonusClaimed`), and a `RequestCheck` BindableEvent for other server scripts. It uses MemoryStore cooldowns so rejoining or server-hopping doesn't repeat API calls.

## Troubleshooting

| Message | Meaning |
|---|---|
| `Secret 'GroupRoleApiKey' is not available` | The secret is missing, or this is a Studio playtest without a Local Secret. |
| `HTTP 401` | The key is wrong, revoked or expired. |
| `HTTP 403` / run stops early | The key lacks `group:write`, or its owner can't assign the Players role. |
| `HttpService is not allowed to access that Roblox resource` | Either the URL is malformed or the endpoint isn't on the game-server allow-list. The in-game code only uses allow-listed endpoints. |
| `Configured PLAYERS_ROLE_ID … was not found` | The role was deleted or recreated. Put the new ID in Config and the repo variables. |
| `HTTP 429` | Rate limited. The request is retried automatically with backoff. |

If a key ever leaks: revoke it in Creator Hub immediately, create a new one, and update the secret.
