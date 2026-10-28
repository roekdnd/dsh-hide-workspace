# R3 — Where and how a 3rd-party DSH plugin should durably persist a per-workspace "hidden" flag

Research date: 2026-10-25. Read-only investigation. App was running the whole time (not touched).
DSH version `0.2.1-rc.3`. All paths below are on this machine and were verified by reading the files.

**Bottom line (spoiler):** the correct place is a **new, plugin-owned storage domain** (its own unit file
`~/.dsh/storages/workspaces_hidden.json`), opened through `ctx.storageDomain.open(defineDomain({...}))`
from a **host-half** plugin. Do **not** write extra keys into `workspace.json` (they are silently stripped by
zod — proof in §1.5), and do **not** rely on `localStorage` as the system of record (§3).
A client-only `localStorage` store is acceptable *only* as a cache/mirror, not as the only copy.

---

## 1. The storage unit system (`dsh-storage`, `dsh-storage-domain`, `dsh-storage-json`)

### 1.1 What is a "storage unit" and what is the contract

A **unit** is the durable file-level container. The on-disk document has exactly three top-level keys —
`unit`, `global`, `tables` — and this is literally the shape of the existing `workspace.json`:

`%USERPROFILE%\.dsh\storages\workspace.json` (verified, 5549 bytes):
```json
{
  "unit": { "name": "workspace", "version": 2 },
  "global": { "initialized": true, "workspaceIds": [...], "archivedSessionIds": [...], "pinnedSessionIds": [] },
  "tables": { "workspaces": { "<workspaceId>": { "path": ..., "title": ..., "sessionIds": [...], "createdAt": ..., "updatedAt": ... } } }
}
```

The format is normative, from `dsh-storage-json/README.md:78-86`:

> A `single` document carries the unit identity, global singleton, and all tables:
> ```json
> { "unit": { "name": "workspace", "version": 1 }, "global": null, "tables": { "workspaces": { "<key>": { "path": "/work/demo" } } } }
> ```

Key contract facts:

| Fact | Evidence |
|---|---|
| `kv` is the only data shape a backend offers | `dsh-storage/README.md:79` "`kv` is the only facet"; `:130` "`kv` is the only data shape" |
| Unit/table names must match `UNIT_NAME_RE = /^[a-z][a-z0-9_]*$/` | `dsh-storage/lib/index.js:80` — so `workspaces-hidden` and `WorkspacesHidden` are **illegal**; `workspaces_hidden` is legal |
| Record keys are arbitrary strings and never reach file paths | `dsh-storage/README.md:79` (matters: workspace ids are UUIDs — safe) |
| A unit has exactly one live handle | `dsh-storage-json/lib/index.js:564` `unit '${descriptor.name}' is already open; a unit has exactly one live handle` |
| `null` global is the "never written" sentinel | `dsh-storage-domain/lib/index.js:74` `global schema must not accept null` |

### 1.2 How a HOST-side plugin declares and reads/writes its OWN unit — exact API

There is **no** `ctx.storage.unit({name, version})`. The API is a two-step: **declare a domain** with
`defineDomain()`, then **open** it with `ctx.storageDomain.open(spec)`.

From `dsh-storage-domain/README.md:36-56` (the normative example):

```text
// Owning package, once:
const workspaceSpec = defineDomain({
  name: 'workspace',
  version: 1,
  tables: { workspaces: domainTable(workspaceRecordSchema) },
})
```
```text
const domain = await ctx.storageDomain.open(workspaceSpec)
await domain.table('workspaces').put(id, { path: '/work/demo' })
const record = domain.table('workspaces').get(id) // synchronous, from memory
domain.table('workspaces').update(id, (r) => ({ ...r, path: newPath }))
```

The live, shipped implementation of exactly this is `dsh-workspace`
(`dsh-workspace/lib/index.js:255-265` declares the spec, `:379-382` opens it):

```js
const workspaceDomainSpec = defineDomain({
    name: 'workspace',
    version: 2,
    global: { schema: workspaceDomainState, initial: { initialized: false, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] } },
    tables: { workspaces: domainTable(workspaceRecord) },
});
```
```js
var WorkspaceRegistry = class extends Service {
	static inject = ["storageDomain", "sessionPersistence"];
	async [Service.init]() {
		const domain = await this.ctx.storageDomain.open(workspaceDomainSpec);
		this.ctx.effect(() => () => domain.close(), "workspace.domainClose");
		this.table = domain.table("workspaces");
		this.global = domain.global;
		this.state = domain.global.get();
```

Service surface a plugin gets (all verified in `dsh-storage-domain/lib/index.js`):

| API | Line | Notes |
|---|---|---|
| `domain.table(name)` | `:187` | throws on an undeclared table |
| `.get(key)` / `.put(key, v)` / `.delete(key)` / `.update(key, fn)` / `.size` / `.keys()` / `.entries()` | `:242-298` | reads synchronous from memory; writes return a Promise |
| `domain.global.get()` / `.set(value)` | `:156-174` | the singleton slot |
| `domain.close()` | `:198` | **caller owns the lifecycle** — do it in a `ctx.effect` disposer |
| `ctx.on('domain/changed', change)` | emitted at `:216` | payload `{domain, table, key, operation, value}` |

Your plugin must inject `['storageDomain']` (see `dsh-workspace/lib/index.js:355`
`static inject = ["storageDomain", "sessionPersistence"]`). The `domain/changed` event is how an existing
consumer listens — `dsh-api-workspace-controller/lib/index.js:54-56`:
```js
ctx.on("domain/changed", (change) => {
    this.changed(change);
});
```

### 1.3 Where unit files live on disk — the `~/.dsh/storages/` convention CONFIRMED

The backend root is set once, in the base bundle, and every domain routed to `json` lands there.
`dsh-base/cordis.patch.yml:179-189`:

```yaml
    - id: storage
      name: '@deepseek-ai/dsh-storage'

    - id: storage-json
      name: '@deepseek-ai/dsh-storage-json'
      config:
        root: !!js dshHomePath('storages')

    - id: storage-domain
      name: '@deepseek-ai/dsh-storage-domain'
      config:
        backend: json
```

`dshHomePath('storages')` = `$DSH_HOME/storages`, defaulting to `~/.dsh/storages`
(`dsh-home-paths/lib/index.js:11` `const DSH_HOME_DIR_NAME = ".dsh"`; `README.md:34`).

The file name is derived mechanically: `<root>/<unit-name>.json`.
`dsh-storage-json/lib/index.js:178-179`:
```js
async function openSingleUnit(descriptor, root, onClose) {
	const path = join(root, `${descriptor.name}.json`);
```

⇒ a domain named `workspaces_hidden` produces exactly
`%USERPROFILE%\.dsh\storages\workspaces_hidden.json`, sitting next to `workspace.json`.
Confirmed by the sibling consumer: `%USERPROFILE%\.dsh\storages\` currently holds `workspace.json` and a
`session_projcache/` directory (the per-record-layout unit of `dsh-session-projection-cache`).

> Note — **Windows-specific caveat** (from `dsh-storage-json/README.md:142`):
> "**Windows rename without explicit write-through** — durability relies on libuv's `rename()`
> (`MoveFileExW` with replacement)". Writes are atomic but not explicitly fsync'd on Windows. Acceptable
> for a UI preference; do not build anything that must survive an OS power-loss.

### 1.4 Migration / versioning — there is NO automatic migration

This is the sharpest constraint in the whole report.

`dsh-storage-domain/README.md:148`:
> **No data migration** — a domain whose stored version differs from its spec rejects at open
> (`version-mismatch`); changing a schema requires migrating the stored data by hand.

The rejection is implemented in the JSON backend, `dsh-storage-json/lib/index.js:102`:
```js
if (version !== descriptor.version) throw new StorageError("version-mismatch", `unit '${descriptor.name}': stored version ${version} != expected ${descriptor.version}`);
```

So if you ship `version: 1` and later bump to `version: 2`, **every existing user's plugin fails to open
on startup** until the file is hand-fixed. There *is* a mitigation: `defineDomain` accepts
`compatibleVersions` (`dsh-storage-domain/lib/index.js:64, 89`; honoured by the `per-record` layout,
`dsh-storage-json/README.md:56-58`).

**Recommendation:** start at `version: 1`, and if you must add a field later, prefer an *optional* field
(zod `.optional()` / `.default()`) at the **same** version — that needs no migration at all. The in-repo
precedent is exactly this: `dsh-workspace/lib/types/spec.js:44` explains `archivedSessionIds` and
`pinnedSessionIds` are `default([])` "so records written before the fields parse unchanged".
Only bump `version` for a truly breaking change, and then declare `compatibleVersions: [1]`.

Also note: `single` layout keeps **memory authoritative** and rewrites the whole file on every write
(`dsh-storage-json/lib/index.js:161-167`, `:265-266` `publish()` → `writeAtomic(this.path, serialize(...))`).
Hand-editing `workspaces_hidden.json` while the app runs will be **silently overwritten**.
Use `layout: 'per-record'` if you want per-record files and hand-inspection safety.

### 1.5 `workspace.json` is exclusively owned by `dsh-workspace` — a 3rd party CANNOT add keys to it

**Owner:** `@deepseek-ai/dsh-workspace` (service `ctx.workspaceRegistry`). It is the *only* package that
calls `defineDomain({ name: 'workspace' })` — `dsh-workspace/lib/types/spec.js:61-69`, re-exported from
`dsh-workspace/lib/index.js:953`. The controller (`dsh-api-workspace-controller`) only *consumes* it.

Three independent mechanisms each block a third party from adding a `hidden` key:

1. **Unit-name exclusivity.** Two opens of the same domain name throw.
   `dsh-storage-domain/lib/index.js:356`:
   ```js
   if (this.reserved.has(spec.name)) throw new DomainError("already-open", `domain '${spec.name}' is already open`);
   ```
   and the backend repeats it (`dsh-storage-json/lib/index.js:564` "a unit has exactly one live handle").
   You cannot open a second handle on `workspace`.

2. **There is no "read the workspace unit, write it back" seam.** Your plugin can *subscribe* to
   `domain/changed` (`:216`) but gets no mutate path into `dsh-workspace`'s handle. The `Workspace` entity
   exposes only `setTitle`, `status`, `attachSession`, session ordering
   (`dsh-workspace/lib/types/entity.js:54-154`); there is **no** arbitrary-field mutator.

3. **Even if you hand-edited the JSON, the schema strips your key.** `workspaceRecord` is a plain zod
   `z.object()` — *strip* semantics, not strict, not passthrough — `dsh-workspace/lib/types/spec.js:18-24`:
   ```js
   export const workspaceRecord = z.object({
       path: z.string(), title: z.string(), sessionIds: z.array(sessionId),
       createdAt: z.string(), updatedAt: z.string(),
   });
   ```
   and it is enforced at every open, `dsh-storage-domain/lib/index.js:371`:
   ```js
   parsed = parseRecord(spec.name, table, key, () => tableSpec.valueSchema.parse(raw));
   ```

   **Verified empirically** against the app's own bundled `zod` (`asar/dsh/node_modules/zod`), using the
   exact schema shape:
   ```
   in : {"path":...,"title":"T","sessionIds":[],"createdAt":"a","updatedAt":"b","hidden":true,"hiddenAt":"2026-01-01"}
   out: {"path":...,"title":"T","sessionIds":[],"createdAt":"a","updatedAt":"b"}
   hidden survived? false
   ```
   The key is **dropped silently, with no error** — the record parses fine, so you get no warning.
   Then the very next write from `dsh-workspace` (a rename, a session attach, or its whole-unit
   `publish()`) rewrites `workspace.json` from *its* in-memory copy, which never had your key.

   (The global state `workspaceDomainState` is also a plain `z.object()` — `spec.js:46-54` — so adding
   `hiddenWorkspaceIds` to the `global` block is stripped the same way.)

**Conclusion:** `workspace.json` is off-limits. Any upstream `dsh-workspace` update could also freely
change the record shape, and your data would vanish with no error.

### 1.6 schemastery (`@deepseek-ai/schemastery`) — where it is and is not used

Stated explicitly in `dsh-storage-domain/README.md:87`:
> "Record schemas are zod, so `z.infer` avoids duplicating consumer types; **plugin `Config` stays schemastery**."

| Layer | Validator | Evidence |
|---|---|---|
| **Unit/record payloads** (your data) | **zod** (`zod@4.4.3`) | `dsh-workspace/package.json` `"zod": "4.4.3"`; `dsh-storage-domain/package.json` deps `"zod": "4.4.3"` |
| **Plugin `Config`** (your YAML row options) | **schemastery** | `dsh-storage-domain/lib/index.js:1,312-315`: `import z from "@deepseek-ai/schemastery"; const Config = z.object({ backend: z.string().required(), routes: z.dict(z.string()).default({}) })` |
| Backend `root` config | schemastery | `dsh-storage-json/lib/index.js:551`: `const Config = z.object({ root: z.string().required() });` |

So: **zod for the stored data, schemastery for the config row.** Your plugin follows the same split — and
that is what the reference third-party plugin does (`dsh-our-free-model/package.json` peerDependency
`"@deepseek-ai/schemastery": "^3.18.4"`).

---

## 2. Workspace registry (`dsh-workspace`)

### 2.1 The record shape, and whether the schema is strict

Package: **`@deepseek-ai/dsh-workspace`**, "Workspace entity registry (`ctx.workspaceRegistry`)"
(`package.json` description). Mounted in `dsh-web-app/cordis.patch.yml:91-92`:
```yaml
    - id: workspace
      name: '@deepseek-ai/dsh-workspace'
```

Record fields (`dsh-workspace/lib/types/spec.js:18-24`): `path`, `title`, `sessionIds[]`,
`createdAt`, `updatedAt`. Registry-global state (`spec.js:46-54`): `initialized`, `defaultWorkspaceId?`,
`workspaceIds[]`, `archivedSessionIds[]`, `pinnedSessionIds[]`, `pendingMutation?`.

**Is it strict?** Not `.strict()` — it is **strip** mode. Extra fields are **dropped, not rejected**
(proved experimentally in §1.5). Practically that is *worse* than rejection for a plugin: silent data loss
with no error surface. There is no `passthrough()` anywhere in the schema.

`dsh-workspace/README.md:117` documents the durable shape:
> The registry opens the `workspace` domain (version 2): a `workspaces` table keyed by `WorkspaceId` plus
> one global state holding `workspaceIds` (the authoritative display order), `archivedSessionIds`,
> `pinnedSessionIds`, the optional `defaultWorkspaceId` ... Archive and pin sets contain Session id strings,
> default to empty, and carry no per-entry objects or timestamps.

### 2.2 Hooks/events a third party can subscribe to

| Surface | Type | Evidence |
|---|---|---|
| `ctx.on('domain/changed', change)` | in-process Cordis event; fires after every durable write to **any** domain, including `workspace` | emit: `dsh-storage-domain/lib/index.js:216`; real consumer: `dsh-api-workspace-controller/lib/index.js:54` |
| `workspace/session-activity` | **waterfall** — *you can answer it* | `dsh-workspace/lib/index.js:531` `await this.ctx.waterfall("workspace/session-activity", { sessionId }, () => Promise.resolve([]))` |
| `workspace/session-stop` | **parallel** — *you can answer it* | `dsh-workspace/lib/index.js:623` `await this.ctx.parallel("workspace/session-stop", { sessionId })` |

`dsh-workspace/README.md:103` confirms both are a **public capability seam**:
> Archive admission is a capability seam over two Host events this package declares and dispatches:
> `workspace/session-activity` (waterfall) asks the composed providers what still runs for a Session, and
> `workspace/session-stop` (parallel) asks them to stop it.

⚠ **There is no `workspace/changed` / `workspace/created` / `workspace/removed` event.** A plugin that
mirrors hidden-workspace ids must listen to `domain/changed` and filter on `change.domain === 'workspace'`
(payload carries `{domain, table, key, operation, value}` — verified at
`dsh-storage-domain/lib/index.js:169-174`, `:273`, `:290-296`), or simply re-validate its own set against
`ctx.workspaceRegistry.list()` on read.

### 2.3 Is there a `ctx.workspace` / `workspaceRegistry` service a plugin can inject?

**Yes** — `ctx.workspaceRegistry`. Proof: the service is constructed with that exact name at
`dsh-workspace/lib/index.js:376` `super(ctx, "workspaceRegistry");`.

Public read surface useful to a "hidden" feature:

| Member | Line | Use |
|---|---|---|
| `list()` → ordered `Workspace[]` | `:454` | the authoritative display order; **filter this** |
| `get(id)` | `:446` | single lookup |
| `archivedSessionIds` (getter) | `:506` | precedent: a registry-global set of hidden ids |
| `pinnedSessionIds` (getter) | `:568` | same shape |
| `archiveSession(id, {stopActivity})` / `unarchiveSession(id)` | `:526` / `:553` | session analogue |
| `create(path, title)` / `delete(id)` / `initializeDefault(fn)` | `:409` / `:470` / `:426` | mutations |

The workspace object itself (`dsh-workspace/lib/types/entity.js`): `setTitle()` `:54`, `status()` `:114`,
`sessionIds` — and **no** generic field setter. So "hidden" cannot be stored on the entity.

Also relevant: the **controller** service `ctx.workspaceController` (`dsh-api-workspace-controller`,
README:11) is the RPC-facing mutation surface, and its `follow()` stream is what the client already uses
(`follow` emits `upsert`, `remove`, `order`, `archived`, `pinned` increments — README:25). A client-side
"hidden" filter must run *downstream* of that stream.

---

## 3. Client-side persistence options

### 3.1 How `ui-workspace` persists expansion/order state — it is **localStorage**, not host storage

`dsh-client-ui-workspace/lib/client.js:1250-1275`, `createWorkspaceViewStore()`:

```js
function createWorkspaceViewStore() {
    return (0, _deepseek_ai_dsh_client_store.defineStore)({
        init: () => ({
            groupBy: "workspace",
            orderBy: "updated",
            groupExpansion: {},
            sessionOrderByAccount: {},
            archivedFilter: "default"
        }),
        persist: "dsh.workspace.view.v5",
        actions: {
            setGroupBy: ..., setOrderBy: ...,
            setGroupExpanded: (d, key, expanded) => { d.groupExpansion[key] = expanded; }, ...
```

That single string `persist: "dsh.workspace.view.v5"` is the entire persistence mechanism — the
`@deepseek-ai/dsh-client-store` `defineStore` / `createSnapshotStore` helper writes it to **`window.localStorage`**.

Sibling keys in the same family, read from the live profile's LevelDB:
`dsh.workspace.view.v5`, `dsh.sessions.current`, `dsh.sidebar-right.v1.<sessionId>`,
`dsh.conversation.session-<uuid>`, `dsh.keybindings.v1`, `dsh.trajectory.duration`,
`dsh.user-questions.drafts.v1`, `dsh.open-in-app.choice`, `dsh.plugin-manager.install-registry`,
`dsh.sidebar-browser.v1`, `dsh.conversation.contentWidth`.

Located at
`%USERPROFILE%\AppData\Roaming\@deepseek-ai\dsh-desktop\Local Storage\leveldb\000019.log`
(mtime 2026-10-25 15:42) — `dsh.workspace.view.v5` is present there **right now**, i.e. this is the live
browser-side store of the running app.

> Caveat on source location: `@deepseek-ai/dsh-client-store` is a **devDependency**
> (`dsh-client-ui-layout/package.json:48`, `dsh-api-workspace-controller/package.json:90`, and 50 more,
> all pinned `"0.2.1-rc.3"`) resolved at runtime from the app's shared module table, so its own source is not
> in the extracted per-package tree. Its *behaviour* is unambiguous from the call sites plus the LevelDB contents.

### 3.2 The README "View state" section — browser-persisted, confirmed

`dsh-client-ui-workspace/README.md:177-179`:
> ### View state
> Once the Workspace baseline is ready, **browser-persisted** expansion and Session-order records retain only
> current Workspace ids plus Ungrouped and the flat-list account.

Two more corroborating lines in the same README:
- `:44` — "Grouping and expansion are saved in the current browser; switching modes preserves each Workspace's expansion preference"
- `:40` — "Session display orders for real Workspaces, Ungrouped, and the flat list are **browser-local**; **Workspace group drag order remains Host-durable**."

That last line is the design distinction the app itself draws:
**workspace ordering → host-durable; per-browser view preferences → localStorage.**

### 3.3 Is localStorage acceptable as the system of record? — No (but fine as a cache)

Where it actually lives, verified on this machine:
- Desktop: `%USERPROFILE%\AppData\Roaming\@deepseek-ai\dsh-desktop\Local Storage\leveldb\` (populated, ~36 KB log)
- Per-launch instance root: `%USERPROFILE%\AppData\Local\EACLauncher\instances\6990bdfd-…\home\desktop-user-data\Local Storage\leveldb\` (bare, 30 bytes)

**Good news — the origin is stable.** I extracted the Electron main process
(`app.asar!/lib/main.js`, 516 716 bytes) and confirmed the window loads a **custom privileged scheme**,
not `http://127.0.0.1:<random-port>`:
- `main_extract.js:7010` — `const SCHEME = "dsh-app";`
- `main_extract.js:11881-11891` — `protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true } }])`
- `main_extract.js:12135` — ``const applicationUrl = `${SCHEME}://app/`;``
- `main_extract.js:12407-12415` — `protocol.handle(SCHEME, …)`: `dsh-app://app/*` serves the SPA from
  `dsh-web-frontend/dist` and proxies API calls to the loopback Host.

So desktop localStorage is keyed to the constant origin `dsh-app://app` — **it does not reset when the
Host's ephemeral port changes** (this instance runs on 62722; `--port` is otherwise configurable,
`dsh-web-app/README.md:51`). That removes the biggest risk I expected to find, and is why the app can
safely use localStorage for view state.

**But it is still the wrong system of record**, for four independent reasons:

| Risk | Evidence |
|---|---|
| **Not shared across clients.** "Web uses origin-local `dsh.keybindings.v1` storage; Desktop uses Electron's device-local `userData/keybindings.json`, **independently of Harness home and workspace settings**." | `dsh-client-shortcuts/README.md:34` — the app's own canonical statement that browser storage does not sync |
| **Per browser profile / per browser.** Another Chromium profile, a second install, or the `dsh --profile web` surface = a separate copy. | `dsh-client-ui-workspace/README.md:44` "saved in the current browser" |
| **The app has repeatedly deprecated its own localStorage state.** "Plugin reload resets pin choices, and **legacy localStorage values are ignored**." — said by three separate packages. | `dsh-client-ui-conversation/README.md:75`, `dsh-client-ui-sidebar/README.md:40`, `dsh-client-ui-sidebar-right/README.md:117` |
| **Flush-on-quit is not guaranteed.** Chromium LevelDB writes are batched; a hard kill can drop the tail, and a hidden-set that silently un-hides is a bad bug. | (general Chromium LevelDB behaviour; no fsync contract) |
| **No error surface.** Clearing site data, or a corrupt value, silently resets to "nothing hidden". | `dsh-client-ui-schedule/README.md:34` shows the defensive `try { JSON.parse } catch { return empty }` pattern |

The honest counterpoint comes from the app itself:
`dsh-client-ui-sidebar-right/README.md:143` — "**Browser-local layout.** Layout does not synchronize between
devices; provider-specific state requires its provider's recovery support." The app accepts browser-local
state *for pure layout*, and that is exactly the boundary: **layout = local, data = host.**

### 3.4 Can a plugin know WHICH browser profile / user-data dir?

**Not from the browser side — and you should not need to.** Findings:
- `dsh-home-paths` exposes only `resolveDshHome`, `dshHomePath`, `dshCachePath`, `resolveAgentsHome`,
  `expandHomePath` and display helpers (`dsh-home-paths/lib/index.js:168` export list). The internal
  `resolveRoot()` (`:83`) and `rootDisplay()` (`:95`) helpers are **not exported** — there is no public
  `userDataPath()`.
- Electron's `app.getPath('userData')` is read in the main process only for `keybindings.json`
  (`main_extract.js:11193-11194`, `join(userData, "keybindings.json")`) and `desktop/settings.json`
  (`main_extract.js:10284-10285`, `join(userData, "desktop")`). Neither is exposed to renderer plugins.
- `dsh-desktop-host` ships only `lib/cli.js` + `lib/index.js` with no README — no documented seam.
- The web surface's profile is unknowable to a plugin by design: `dsh-web-app/README.md:65-67` — every launch
  prints a **tokenized URL**, and the session cookie is minted per listener.

⇒ A plugin **cannot** reliably locate or label "the browser profile". This alone disqualifies localStorage
as a durable store for a user preference that is meant to be a property of the *workspace*, not the device.
(There *is* a device-local precedent — `keybindings.json` in Electron `userData` — but it is a
**Desktop-main-process** responsibility with no plugin API, so it is not available to us either.)

---

## 4. Recommendation

### 4.1 Verdict

**Persist "hidden workspaces" in a new host-side storage domain owned by your plugin.** It is the only
option that satisfies every requirement at once:

| Requirement | Own domain unit | Extra keys in `workspace.json` | `localStorage` |
|---|---|---|---|
| Survives app restart | ✅ | ❌ (stripped by zod) | ⚠️ usually, not guaranteed |
| Survives app update | ✅ (sibling file, own schema) | ❌ (upstream owns the schema) | ✅ |
| No schema conflict with upstream | ✅ (separate `name`) | ❌ (§1.5) | ✅ |
| Syncs web ⇄ desktop (same `$DSH_HOME`) | ✅ | ✅ | ❌ (§3.3) |
| Recovers from corruption | ✅ (`invalidRecords: 'backup-and-skip'`) | ❌ | ❌ (silent reset) |
| Code size | ~120 lines (1 spec + 1 service + RPC) | n/a | smallest |

The decisive arguments: `localStorage` is device-scoped (so the flag loses meaning if the user opens the web
surface — §3.3), and `workspace.json` cannot hold the field at all (§1.5, tested). A separate domain is the
**only** place that is both durable and ours to own. `dsh-workspace` itself is the reference implementation
of the pattern (§1.2) — we follow it exactly.

### 4.2 Recommended data shape and location

Unit `name: 'workspaces_hidden'` (satisfies `UNIT_NAME_RE`, §1.1) → file
**`%USERPROFILE%\.dsh\storages\workspaces_hidden.json`**, `version: 1`, `layout: 'per-record'`.

Two viable shapes; **Shape A is recommended**:

**Shape A (recommended)** — one record, a map keyed by workspace id:

```jsonc
{
  "unit": { "name": "workspaces_hidden", "version": 1 },
  "global": null,
  "tables": {
    "hidden": {
      "state": {
        "hidden": {
          "a21731e1-5674-4623-a8ac-8069b4567e71": { "hiddenAt": "2026-10-25T12:34:56.789Z" },
          "e50d6f7f-3cd5-4dd2-b967-edcc1465d815": { "hiddenAt": "2026-10-25T12:40:00.000Z" }
        }
      }
    }
  }
}
```

**Shape B** — closer to the `archivedSessionIds` precedent (a bare id array, no timestamps):

```jsonc
{ "unit": { "name": "workspaces_hidden", "version": 1 }, "global": null,
  "tables": { "hidden": { "state": { "hiddenWorkspaceIds": ["<uuid>", "<uuid>"] } } } }
```

**Pick Shape A.** Rationale, mirroring the reasons `dsh-workspace` gives for its own choices
(`README.md:117`): a **map keyed by workspace id** makes unhide a `delete` rather than a filter-and-rewrite
(no lost-update race, and idempotent — hiding twice is a no-op overwrite); an **object per entry** lets you
add fields later with no `version` bump (§1.4 — an optional field at the same version needs no migration);
and `hiddenAt` gives sort order for a "Hidden (3)" section plus a future auto-unhide-after-N-days.

Suggested zod spec (zod for data, schemastery for config — §1.6):

```js
import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

const hiddenEntry = z.object({ hiddenAt: z.string() })
const hiddenState = z.object({ hidden: z.record(z.string(), hiddenEntry).default({}) })

export const hiddenWorkspacesSpec = defineDomain({
  name: 'workspaces_hidden',          // -> ~/.dsh/storages/workspaces_hidden.json
  version: 1,
  layout: 'per-record',               // one doc per record; hand-editable, no whole-unit rewrite
  invalidRecords: 'backup-and-skip',  // a corrupt record is moved aside, not fatal
  tables: { hidden: domainTable(hiddenState) },
})
```

Why `invalidRecords: 'backup-and-skip'`: per `dsh-storage-domain/README.md:73`, without it a single bad
record throws `invalid-record` and **your whole domain fails to open**; with it the record is backed up,
logged, and treated as absent (`dsh-storage-domain/lib/index.js:44-47`). For a cosmetic preference,
fail-open beats fail-closed: a corrupt hide-list must not break the sidebar.

Persistence sketch (host half, ≈120 lines total, mirrors `dsh-workspace/lib/index.js:354-382`):

```js
export const name = 'workspaces-hidden'
export const inject = ['storageDomain']
// Config stayed schemastery if you add row options: const Config = zs.object({})

export function apply(ctx, config) {
  ctx.effect(() => {
    let domain, table
    const ready = ctx.storageDomain.open(hiddenWorkspacesSpec).then((d) => {
      domain = d
      table = d.table('hidden')
      const read = () => table.get('state') ?? { hidden: {} }   // absent file = empty unit
      ctx.provide('workspacesHidden', {
        isHidden: (id) => read().hidden[id] !== undefined,
        ids:      () => Object.keys(read().hidden),
        hide: (id) => table.update('state', (s) => ({
          hidden: { ...s.hidden, [id]: { hiddenAt: new Date().toISOString() } } })),
        unhide: (id) => table.update('state', (s) => {
          const { [id]: _gone, ...rest } = s.hidden
          return { hidden: rest } }),
      })
    })
    return () => { ready.finally(() => domain?.close()) }   // caller owns the handle (§1.2)
  }, 'workspaces-hidden.domain')
}
```

Then surface it to the browser through the ordinary RPC seam (`ctx.typert` contribution +
`ctx.remote`, per `dsh-typert-registry/README.md:31-38` and `dsh-api-workspace-controller/README.md:11`)
so the client plugin calls `ctx.remote.workspacesHidden.*` — exactly how `ctx.remote.workspace` works today.
The client half then filters the `follow()` baseline / `ctx.workspaceRegistry.list()` by that set
(see `CONTEXT.md` finding #2 for why the filter cannot be a slot).

Operational details worth designing in from day one:

- **First run:** a missing file opens as an empty unit (`dsh-storage-json/README.md:56`), so `table.get('state')`
  is `undefined`. Treat that as `{ hidden: {} }` and **do not write** until the user actually hides something —
  users who never use the feature get no stray file.
- **Orphan pruning:** deleting a workspace should drop its hidden entry. Do **not** try to hook deletion
  (no event exists — §2.2). Prune lazily: on open and on each `domain/changed` where
  `change.domain === 'workspace'`, drop ids not in `new Set(ctx.workspaceRegistry.list().map(w => w.id))`.
  Cheap, race-free, and self-heals against a pre-existing `workspace.json`.
- **Never touch `workspaceIds` or `tables.workspaces`** — hidden is sidecar metadata only (§5.2, lesson 1).

### 4.3 What NOT to do

- ❌ Do **not** add `hidden` / `hiddenWorkspaceIds` to `workspace.json` — silently stripped (§1.5, tested).
- ❌ Do **not** re-open or `defineDomain({name:'workspace'})` yourself — `already-open` / "exactly one live handle".
- ❌ Do **not** bump your domain `version` for an additive change — `version-mismatch` bricks startup (§1.4).
- ❌ Do **not** use `localStorage` as the only copy — device-scoped, no cross-client sync, and the app
  repeatedly ignores its own legacy localStorage keys (§3.3).
- ❌ Do **not** hand-edit a `single`-layout unit while the app runs — memory is authoritative and will
  re-publish over you (§1.4). Use `layout: 'per-record'`.

---

## 5. Existing "hide / snooze / mute" UX precedent

### 5.1 There is NO snooze or mute concept anywhere in the product

Exhaustive greps across all 305 package READMEs and the bundled JS:

- **`snooze`** — zero product hits. The only occurrences in the whole asar are inside the bundled
  **Chrome DevTools frontend** string blob (`dsh-experimental-inspector/lib/devtools/chunks/*`:
  `starter-badge-last-snoozed-timestamp`, `starter-badge-snooze-count`) — third-party DevTools UI strings,
  entirely unrelated to DSH.
- **`mute` / `muted`** — only colour/prose usage ("muted monospace text" in `dsh-client-ui-deliverables/README.md:45`,
  "a muted compass" in `dsh-client-ui-sidebar-right/README.md:123`), never a user-facing feature.

⇒ Do **not** name it "snooze" or "mute". There is no precedent to mirror, and it would read as new vocabulary.

### 5.2 The precedent to mirror is **Archive** — "hide from navigation without deleting"

This is the exact semantic twin of what the user wants, and the app documents it thoroughly.
`dsh-workspace/README.md:77`:
> **Hide** a session from the grouping when it should stop appearing there: it disappears from the visible
> list, while its session, history, and place in the project stay intact. … **Restore** a hidden session
> when it should appear again: it returns to its recorded position under its project.

Vocabulary to copy, with sources:

| Concept | Shipped name | Where |
|---|---|---|
| The action | **Archive** / **Unarchive** | `dsh-client-ui-workspace/README.md:56,58` |
| The state noun | `archivedSessionIds` | `workspace.json`; `dsh-workspace/README.md:117` |
| The filter | **Hide archived** (default) / **All conversations (show archived)** / **Archived only** | `dsh-client-ui-workspace/README.md:58` |
| Undo affordance | a notice **with an undo action** | same line |
| Guard rail | refuse and name the blockers; offer stop-then-archive | `dsh-workspace/README.md:77,103` |
| Collapse vocabulary (**different meaning — keep separate**) | "Folding a Workspace", `groupExpansion`, "saved collapsed state" | `dsh-client-ui-workspace/README.md:30,44` |

Three deliberate design lessons from Archive to copy verbatim:

1. **The hidden thing keeps its recorded position.** `dsh-workspace/README.md:117`:
   > an archived session keeps its `sessionIds` slot (unarchiving must restore the position), so the set
   > never participates in the one-owner accounting invariant.

   ⇒ Our hidden set must be **sidecar metadata only** — never touch `workspaceIds` order, never touch
   `tables.workspaces`. Hiding must be invisible to `dsh-workspace` entirely.

2. **A reversible action gets an undo toast, not a confirmation dialog.**
   `dsh-client-ui-workspace/README.md:58`:
   > Archive commits **without a confirmation dialog** for a quiet Session … A successful archive shows a
   > notice with an undo action.

   ⇒ "Hide workspace" should commit immediately and raise an undo notice. Reserve a dialog for the one case
   Archive reserves it for: when something is actively running.

3. **Give the hidden set a visible, named home** — the "Archived only" filter analogue, e.g. a
   "Show hidden workspaces" / "Hidden only" view option, extending the existing three-way `archivedFilter`
   (`dsh-client-ui-workspace/lib/client.js:1274` `archivedFilter: "default"`). Do **not** invent a fourth
   orthogonal toggle if it can fold into the existing **View options** menu.
   Also copy the emptiness affordance: "No archived sessions yet" + a "View other sessions" action
   (`dsh-client-ui-workspace/README.md:58`) ⇒ "No hidden workspaces" + "Show all".

### 5.3 Naming proposal

| Thing | Name | Why |
|---|---|---|
| User-facing verb | **Hide** / **Unhide** | matches `dsh-workspace`'s own "Hide a session … Restore a hidden session"; honest about reversibility, and distinct from destructive "Delete" |
| UI grouping | under **View options** as *Show hidden workspaces* | mirrors *Hide archived / All conversations (show archived)* |
| Storage unit | `workspaces_hidden` | `UNIT_NAME_RE`-legal (§1.1) |
| Durable field | `hidden: { [workspaceId]: { hiddenAt } }` | matches the `archivedSessionIds` sidecar precedent, plus a timestamp |
| Host service | `ctx.workspacesHidden` | mirrors `ctx.workspaceRegistry` |
| Client namespace | `ctx.remote.workspacesHidden` | mirrors `ctx.remote.workspace` |

---

## Evidence index (files read)

| Path | What it proved |
|---|---|
| `%USERPROFILE%\.dsh\storages\workspace.json` | real `unit`/`global`/`tables` shape, v2 |
| `…/dsh-storage/README.md:79,130` | hub contract, `kv` is the only facet |
| `…/dsh-storage/lib/index.js:80,104-137` | `UNIT_NAME_RE`, `Storage` service, `form-not-mounted` |
| `…/dsh-storage-domain/README.md:36-56,87,146-148` | `defineDomain` + `open` API, zod-vs-schemastery, **no migration** |
| `…/dsh-storage-domain/lib/index.js:61-91,187,216,312-315,356,371,564` | spec validation, handles, event emit, Config=schemastery, `already-open`, schema enforcement at open |
| `…/dsh-storage-json/README.md:56,78-88,142` | file formats, `version-mismatch`, **Windows rename caveat** |
| `…/dsh-storage-json/lib/index.js:72,102,178-179,265-266,551,564` | `serialize`, version reject, `<unit>.json` path, whole-unit publish, Config, one-handle rule |
| `…/dsh-workspace/README.md:77,103,117` | hide/restore semantics, activity seams, durable shape |
| `…/dsh-workspace/lib/types/spec.js:18-24,44,46-54,61-69` | `z.object` strip-mode record + global, defaults precedent, `version: 2` |
| `…/dsh-workspace/lib/index.js:255-265,355-382,446-470,506,526-568,953` | spec declaration, `inject`, open, `list`/`get`, archive/pin getters, exports |
| `…/dsh-workspace/lib/types/entity.js:54-154` | entity API (no generic mutator), single `mutate` write path |
| `…/dsh-api-workspace-controller/README.md:11,25,29` | `ctx.workspaceController`, `follow()` increments |
| `…/dsh-api-workspace-controller/lib/index.js:45-70` | live `ctx.on("domain/changed")` consumer |
| `…/dsh-home-paths/lib/index.js:11,83,95,168` + `README.md:34` | `.dsh` home resolution, `dshHomePath`, no exported userData helper |
| `…/dsh-base/cordis.patch.yml:179-189` | `root: dshHomePath('storages')`, `backend: json` |
| `…/dsh-web-app/cordis.patch.yml:91-92`; `README.md:51,65-67` | `dsh-workspace` mount row, `--port`, tokenized URL |
| `…/dsh-client-ui-workspace/lib/client.js:1250-1275` | `defineStore({persist:"dsh.workspace.view.v5"})` |
| `…/dsh-client-ui-workspace/README.md:30,40,44,56,58,177-179` | "browser-persisted", "browser-local", archive UX, View state |
| `…/dsh-client-shortcuts/README.md:34` | canonical web-local-vs-desktop-local statement |
| `…/dsh-client-ui-sidebar/README.md:40`, `…-conversation/README.md:75`, `…-sidebar-right/README.md:117,143` | "legacy localStorage values are ignored" ×3; browser-local layout limit |
| `…/dsh-typert-registry/README.md:31-38` | plugin contribution / RPC registration seam |
| `…/dsh-client-modules/README.md:34` | `dsh.client` bundle declaration for the browser half |
| `%USERPROFILE%\.dsh\profiles\desktop\package.json`; `…/node_modules/dsh-our-free-model/{package.json,cordis.patch.yml,index.js}` | real 3rd-party plugin: `dsh.bundle.patch`, `dsh.client`, `resolveDshHome()` reference impl |
| `<DSH_INSTALL>\resources\app.asar` → extracted `lib/main.js:7010,10284,11193,11881,12135,12407` | desktop origin is the constant `dsh-app://app`, not a port |
| `%USERPROFILE%\AppData\Roaming\@deepseek-ai\dsh-desktop\Local Storage\leveldb\000019.log` | live `dsh.workspace.view.v5`, `dsh.sessions.current`, … |
| `%USERPROFILE%\AppData\Local\EACLauncher\instances\6990bdfd-…\home\` | instance home = `$DSH_HOME` (`storages/`, `profiles/`, `.credentials.yaml`) alongside a separate near-empty `desktop-user-data` |
| `…/asar/dsh/node_modules/zod` (empirical test) | extra keys are **stripped**, not rejected |
