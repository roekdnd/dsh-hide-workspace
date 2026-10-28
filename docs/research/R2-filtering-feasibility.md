# R2 — Can a third-party browser-side DSH plugin hide/filter WORKSPACES in the sidebar session tree?

Read-only feasibility research. All evidence is from the extracted app bundle at
`<ASAR>\dsh\node_modules\@deepseek-ai\` (305 packages, DSH 0.2.1-rc.3).
Nothing outside `notes/` was modified; the running app was not touched.

Abbreviations used below:

| Short | Full path (under `...\asar\dsh\node_modules\@deepseek-ai\`) |
|---|---|
| `WS` | `dsh-client-ui-workspace/lib/client.js` (5355 lines, 232 KB) |
| `SIDEBAR` | `dsh-client-ui-sidebar/lib/client.js` (36 KB) |
| `CTRL` | `dsh-api-workspace-controller/lib/client.js` (530 lines, 20 KB) |
| `RENDERER` | `dsh-client-ui-renderer/lib/client.js` |
| `RUNNER` | `dsh-cordis-client-runner/lib/client.js` (generated Slot + Service catalog) |
| `GATEWAY` | `dsh-api-gateway/lib/client.browser.js` |
| `CORDIS` | `cordis/lib/index.js` |
| `DIST` | `dsh-web-frontend/dist/assets/index-BXV-oxvX.js` (the compiled bundle that actually ships `SlotCore`) |

---

## Q1 — How the workspace/session tree is derived

### 1.1 The pipeline, in order

The whole sidebar browser is **one function**: `WorkspaceBrowser` at `WS:3510`. It reads state, then hands
plain arrays to two pure derivation functions.

```
useSessions / useWorkspaces / useSessionStatus   (standard root hooks, injected props)
        │
        ├─ storedWorkspaces = useWorkspaces((state) => state.items)          WS:3517
        ├─ archivedSessionIds = useWorkspaces((state) => state.archivedSessionIds)   WS:3525
        ├─ pinnedSessionIds  = useWorkspaces((state) => state.pinnedSessionIds)      WS:3526
        └─ list              = useSessions((state) => state)                 WS:3516
        │
   orderedWorkspaces                                                     WS:3559-3573
     workspaceDisplayTitle(...) + per-workspace session order (pinCurrentBlank / reconcileManualOrder)
        │
        ├── SessionTree  (groupBy "workspace" | "workspace-tree")          WS:3025
        │        └─ deriveGroups(list, workspaces, rowState, statuses, view)   WS:3066 → WS:1091
        │              └─ groupByWorkspace(...)                            WS:1027
        │                    └─ sessionVisible(...)                        WS:964
        │
        ├── FlatList     (groupBy "flat")   WS:3356 → deriveFlat           WS:1146
        └── SearchResults (non-blank query)  → deriveSearchResults         WS:1169
```

`deriveGroups` is the exact "snapshot → rows/groups" function you asked for (`WS:1091`):

```js
// WS:1091
function deriveGroups(list, workspaces, rowState, statuses, view) {
  const archived = new Set(rowState.archivedSessionIds);
  const pinned   = new Set(rowState.pinnedSessionIds);
  ...
  for (const g of groupByWorkspace(list, workspaces, archived, rowState.archivedFilter, view.ungroupedOrder)) {
    groups.push({ key: g.key, workspaceId: g.workspaceId, cwd: g.cwd, createdAt: g.createdAt,
                  label: g.label, sessionCount: g.sessions.length, expanded,
                  containsCurrent: g.key === currentGroup,
                  sessions: … });
  }
  return groups;
}
```

`groupByWorkspace` is where **workspaces become groups** (`WS:1027`):

```js
// WS:1027
function groupByWorkspace(list, workspaces, archived, archivedFilter, ungroupedOrder) {
  const current = mainSessionId(list);
  const groups = [];
  const accounted = new Set();
  for (const workspace of workspaces) {                       // ← one pass over the workspace array
    const members = [];
    for (const id of workspace.sessionIds) {
      const summary = list.byId[id];
      if (summary === void 0) continue;
      accounted.add(id);
      if (!sessionVisible(summary, current, archived, archivedFilter)) continue;
      members.push(summary);
    }
    if (archivedFilter === "only" && members.length === 0) continue;
    groups.push(buildGroup(workspace.workspaceId, workspace.workspaceId, workspace.path,
                           Date.parse(workspace.createdAt), workspace.title, members));
  }
  const stray = list.ids.map((id) => list.byId[id])
    .filter((s) => s !== void 0 && !accounted.has(s.id) && sessionVisible(s, current, archived, archivedFilter));
  if (stray.length > 0) groups.push(buildGroup("", void 0, void 0, void 0, "", orderedUngrouped(stray, ungroupedOrder, list.byId)));
  return groups;
}
```

`ungroupedSessionIds` is *not* derived here — it is computed in `WorkspaceBrowser` (`WS:3543`):

```js
// WS:3543
const ungroupedMemberIds = useMemo(() => {
  const accounted = new Set(workspaces.flatMap((workspace) => workspace.sessionIds));
  return list.ids.filter((id) => list.byId[id] !== void 0 && !accounted.has(id));
}, [list, workspaces]);
```

Note the coupling: **any workspace you remove from `workspaces` automatically re-classifies its sessions
as "Ungrouped"**, because `accounted` is built from the same array. Dropping a workspace from the array
does not hide its sessions — they reappear in the `""` Ungrouped group. That is the single most
important derivation fact for this feature.

### 1.2 Where filtering actually happens — the complete list of filter sites

| # | Site | Code | What it hides |
|---|---|---|---|
| 1 | `WS:965` | `if (session.origin === "subagent") return false;` | subagent-origin sessions |
| 2 | `WS:966` | `if (session.blank && session.id !== current) return false;` | every blank session except the selected one |
| 3 | `WS:967-971` | `switch (archivedFilter) { case "default": return !archived.has(session.id); … }` | archived sessions (three-way filter) |
| 4 | `WS:1040` | `if (archivedFilter === "only" && members.length === 0) continue;` | **workspaces with no visible session** — only in Archived-only mode |
| 5 | `WS:1029-1041` | loop over `workspaces`, no other `continue` | — |
| 6 | `WS:1129` / `WS:1146` / `WS:1185` | `sessionVisible(...)` reused by `visibleSessionIds`, `deriveFlat`, `deriveSearchResults` | same rules in flat + search views |

`sessionVisible` in full (`WS:964`):

```js
function sessionVisible(session, current, archived, archivedFilter) {
  if (session.origin === "subagent") return false;
  if (session.blank && session.id !== current) return false;
  switch (archivedFilter) {
    case "default": return !archived.has(session.id);
    case "show":    return true;
    case "only":    return archived.has(session.id);
  }
}
```

**There is no workspace-level predicate anywhere.** The only `continue` that drops a *workspace* is #4,
and it is gated on `archivedFilter === "only"` — i.e. the shipped code already contains a "drop this
workspace row" branch, but it is reachable only through one of three hardcoded radio values.

### 1.3 Is there a single choke point where a plugin could drop a workspace from the rows?

**Yes for derivation, no for interception.** `groupByWorkspace` is a *single* point that consumes the
workspace array exactly once, and everything (grouped tree, ungrouped bucket, session→workspace
ownership) flows through it. A **fork** would add one line there.

But from *outside* the module there is no seam: `deriveGroups`, `groupByWorkspace` and `sessionVisible`
are module-local functions inside the `factory(require)` closure of `WS` — not exported. The module's
entire export surface is (`WS:5350-5354`):

```js
exports.apply = apply;
exports.inject = inject;
```

The only data that reaches them is the `workspaces` array, which comes from
`useWorkspaces((state) => state.items)` — a *standard root hook* owned by the workspace-controller
plugin, not by `ui-workspace`. So the choke point is real but is **at the data**, not at the render.

---

## Q2 — The state source: `ClientWorkspaceModel` / `ctx.remote.workspace.follow()`

### 2.1 The three layers

```
Host registry (ctx.workspaceRegistry, workspace.json on disk)
      │  domain/changed
      ▼
WorkspaceFeed  (dsh-api-workspace-controller/lib/types/feed.js, feed.js:78  async *follow)
      │  baseline | upsert | remove | order | archived | pinned
      ▼
WorkspaceController.follow()  host Remote method   (CTRL index.js:963)  ← access filtering lives HERE
      │  @Remote({mode:'stream'})  (typert.host.js:440, 797)
      ▼  wire
ctx.remote.workspace.follow(signal)   ← generated Remote namespace service `remote.workspace`
      │
      ▼
createWorkspaceStateStream(remote, …)  (CTRL client.js:473)
      │  RemoteSnapshotStream; isSnapshot = frame.type === "baseline" (CTRL:481)
      ▼
ClientWorkspaceModel  (CTRL client.js:15)   ← the state source
      │  getSnapshot() / subscribe()  (CTRL:245, 255)
      ▼
WorkspaceController extends cordis.Service, super(ctx, "workspaces")  (CTRL:381-392)
      │  this.model = model;  this.list = model;
      ▼
ctx.get("workspaces")  →  workspaces.list   →  ctx.slots.provideRoot({ hooks: { workspaces: workspaces.list } })
      │                                          (WS:5040-5043)
      ▼
useWorkspaces  ← the standard root hook every consumer reads
```

Instantiation is at `CTRL:450-466`:

```js
function apply(ctx) {
  const model = new ClientWorkspaceModel(ctx.remote.workspace);
  new WorkspaceController(ctx, model);
  const control = createWorkspaceStateStream(ctx.remote, { accept: model, … });
  control.start();
  …
}
```

and the follow stream (`CTRL:473-490`, `CTRL:476`):

```js
return new RemoteSnapshotStream(remote.$stream({
  name: "Workspace state stream",
  open: (signal) => remote.workspace.follow(signal),
  …
}), { isSnapshot: (frame) => frame.type === "baseline", replace: …, update: … });
```

`ClientWorkspaceModel` itself is plain, framework-free, and holds exactly the fields the tree reads
(`CTRL:15-45`): `items`, `archivedSessionIds`, `pinnedSessionIds`, `state`, `phase`, `error`, plus
`subscribe()` / `getSnapshot()` (`CTRL:245`, `CTRL:255`) — i.e. a `useSyncExternalStore` source.

### 2.2 How React subscribes

**Not** through a hand-written hook: `ui-workspace` publishes the model as a *standard root hook* and the
renderer synthesises `useWorkspaces` from it (`WS:5040`):

```js
ctx.slots.provideRoot({
  hooks: { workspaces: workspaces.list },
  keyedHooks: { workspaceAccess: (id, action) => … }
});
```

`RENDERER:1671` turns each `hooks` entry into `use<Name>` via `standardHookPropName` (name → `use` + PascalCase;
`DIST: function kI(e){return \`use${e[0]?.toUpperCase()??""}${e.slice(1)}\`}`), and `RENDERER:155-161`
binds it as a `useSyncExternalStoreWithSelector` selector hook:

```js
function bindSnapshotSelector(w) {
  const subscribe = (fn) => w.subscribe(fn);
  const getSnapshot = () => w.getSnapshot();
  return function useSelector(sel, eq) {
    return useSyncExternalStoreWithSelector(subscribe, getSnapshot, void 0, sel, eq);
  };
}
```

Consumers of `useWorkspaces` in the whole installation are only three packages:

* `WS:3517,3523,3524,3525,3526` (the browser itself)
* `WS:2571` (the hero workspace picker flow)
* `dsh-client-ui-schedule/lib/client.js:4190` and `dsh-client-ui-conversation/lib/client.js:17817`

`ctx.get("workspaces")` (the imperative service, not the hook) has only **two** consumers:
`WS:5024` (ui-workspace) and `dsh-client-ui-schedule/lib/client.js:7443`.

### 2.3 Can a third-party plugin provide a DECORATED/replacement workspace model service?

This is the crux, and the answer differs sharply by *which* of the two service names you attack.

**(a) `workspaces` — the Cordis service. Not replaceable, and re-registration throws.**

`CTRL:381-392`:

```js
var WorkspaceController = class extends _deepseek_ai_cordis.Service {
  model;
  list;
  constructor(ctx, model) {
    super(ctx, "workspaces");      // ← registers service name "workspaces"
    this.model = model;
    this.list = model;
  }
```

`CORDIS:1770-1784` — `Service`'s constructor calls `self.ctx.reflect.provide(name, self, …)`, and
`CORDIS:800-823` `provide()` throws on a duplicate:

```js
if (this.store[key]) throw new Error(`service "${name}" has been registered at <${this.store[key].fiber.name}>`);
```

`CORDIS:783-794` `set()` likewise refuses a foreign write:
`if (impl.fiber !== this.ctx.fiber) throw new Error(\`cannot set property "${name}" in multiple fibers\`)`.
So a plugin **cannot** re-provide `workspaces`, and cannot `ctx.set("workspaces", …)`.
`isolate`/`intercept` are Loader-row options (see (c)), not something a page plugin can apply to a
shipped row it does not own.

**(b) `useWorkspaces` — the standard root hook. Replaceable in principle, but the merge throws.**

`RENDERER:1681-1702` merges every `provideRoot` contribution with `copyUnique`, which is
first-writer-wins **and throws** on a duplicate (`RENDERER:1804-1812`):

```js
function copyUnique(kind, target, values, finalProps, propNameOf) {
  for (const [name, value] of Object.entries(values)) {
    const propName = propNameOf(name);
    if (finalProps.has(propName)) throw new Error(`duplicate root standard ${kind} '${name}' at prop '${propName}'`);
    …
  }
}
```

`hooks.workspaces` materialises as prop `useWorkspaces`, so a second
`ctx.slots.provideRoot({ hooks: { workspaces: myFilteredSource } })` **throws at mount**. The shipped
`ui-workspace` registration wins because it is already there. (The only way to win is for `ui-workspace`
to be absent from the composition — which means the browser is absent too.)

**(c) `remote.workspace` — a *separate* Cordis service, created per namespace. Also not replaceable.**

`GATEWAY:1745-1750` creates one plugin per Remote namespace, and
`GATEWAY:2074-2076`:

```js
function remoteServiceKey(namespace) { return `remote.${namespace}`; }
```

`RemoteNamespaceService` is a `cordis.Service` on that key (`GATEWAY:1953-1964`), so `remote.workspace`
is a real service. But `validateContribution` explicitly refuses a second contributor to a live
namespace (`GATEWAY:1735`):

```js
if (this.ownerCtx.reflect.props[serviceKey]?.type === "accessor" ||
    this.ownerCtx.get(serviceKey) !== void 0)
  throw new Error(`client api: namespace ${JSON.stringify(namespace)} conflicts with an existing Remote namespace`);
```

and per-method: `RemoteNamespaceService.assertMethodAvailable` → `client api: method "workspace/follow" conflicts with its namespace service`.
And `reflect.provide` would throw anyway (see (a)). So you cannot wrap `follow()`.

**(d) The last, sneaky option: mutate the live model in place.** `ClientWorkspaceModel` instances are
ordinary objects; `ctx.get("workspaces").list` is the instance, and
`replaceBaseline` / `installViews` / `remove` are plain prototype methods (`CTRL:183`, `CTRL:307`, `CTRL:296`).
A plugin *could* hold a reference and shadow `items` — e.g. define an own property
`items = items.filter(...)`, or monkey-patch `getSnapshot`. This is not an extension point, is not
sanctioned, and is fragile (see Q4e for the real hazards). It also does not help, because
`ui-workspace` also reads `archivedSessionIds`/`pinnedSessionIds` from the same object and the
derivation re-derives `ungroupedMemberIds` from `items`.

### 2.4 What the *host* already does — the one sanctioned filter precedent

The Host `follow()` already filters workspaces **per peer**, and it is documented as an ordinary
`replace` frame (`CTRL` index.js:963-1040):

```js
// index.js:963
async *follow(signal) {
  const access = this.ctx.remoteAccess;
  const visible = (workspaceId) => access.allows({ kind: "workspace", id: workspaceId });
  const sessions = (sessionIds) => sessionIds.filter((id) => access.allows({ kind: "session", id }));
  const filtered = (value) => {
    const items = value.items.filter((item) => visible(item.workspaceId));
    …
  };
```

That machinery is reached only via `dsh-api-remote-access` policies for a **non-owner principal**
(`RemoteAccessService.registerPolicy(kind, policy)`; see `dsh-api-remote-access/README.md`
"Host service: `RemoteAccessService`"). For the desktop app, the local user **is the owner**, and
`allows()` "True for the owner and outside a Remote call" — so this path is inert here. It is still the
single best proof that "hide a whole workspace from the Client model" is a first-class Host concept;
it is simply not exposed to owner-side, workspace-scoped plugin policy.

---

## Q3 — Slot replacement feasibility for `sidebar.workspaces`

### 3.1 The slot system lives in the shipped bundle, not in an installed package

There is **no** `dsh-client-ui-slots` directory on disk. `dsh-client-ui-slots` is a *declared* dev
dependency (`WS/package.json`, `SIDEBAR/package.json` both pin `"@deepseek-ai/dsh-client-ui-slots": "0.2.1-rc.3"`)
that is **compiled into the web bundle**: `DIST`'s module table
(`function OZ(){return{react:…,"@deepseek-ai/dsh-client-ui-slots":jI,…}}`) binds the seed word to the
compiled `SlotCore` (`SI`), `SlotOwnershipError`, `StaleAuthorizationError`, `resolveSlotLabel`,
`standardHookPropName`. So its README is not on disk; the authoritative contract is
`dsh-cordis-client-runner`'s generated Slot catalog (which is generated *from* those `slots.ts` sources
and names them, e.g. `source: "packages/client/ui-workspace/src/client/contract/slots.ts:171"`).

### 3.2 Can another plugin register into the same `single` slot and REPLACE the shipped one? — YES

Two independent proofs.

**Proof A — the registry's own error message.** `DIST` `SlotCore.register` (and the identical JS in
`RUNNER`'s docs) for `kind === "single"`:

```js
n = e.priority ?? 0;
s = (h) => `at priority ${n}${h.registrant !== void 0 ? ` (registered by ${h.registrant})` : ""}` +
          ` — register at a different priority to shadow it (lowest renders)`;
case "single": {
  const h = r.entries.find((p) => (p.options.priority ?? 0) === n);
  if (h) throw new Error(`single slot "${e.name}" already has a registration ${s(h)}`);
  break;
}
```

Same-priority duplicates throw; **a different priority is accepted and shadows**.

**Proof B — the render path.** `RENDERER:1173-1177`:

```js
if (spec.kind === "single") {
  const entry = host.entriesOfSlot(slotKey)[0];
  if (!entry) return entries.length > 0 ? deadCell() : <Fragment>{opts?.fallback ?? null}</Fragment>;
  return guarded(entry, entryKeyOf(entry));
}
```

`entriesOfSlot` (`DIST`) is "the first live (non-abdicated) entry of each cell in priority order", and
`register` sorts ascending (`u.sort(i.kind==="list" ? (a,b)=>priority||order : (a,b)=>priority)`).
**Lowest priority wins.** `RENDERER:1545-1550` documents it as "Shadowing winners per cell for a key:
the first live (non-abdicated) entry of each cell in priority order".

So: `sidebar.workspaces` can be shadowed by registering at any priority < the shipped one. The shipped
`ui-workspace` registration passes **no** `priority` (`WS:5221-5252`), i.e. it sits at **0**.

### 3.3 Does the list-slot shadowing rule (`id` reuse at another priority) also apply to `single`?

**Yes — it is the same mechanism, and for `single` it is *simpler*: you do not even need to reuse an id.**
The id-keyed "cell" language is a *list/keyed* concept (`entriesOfSlot` de-dupes by
`options.key` for keyed and `options.id` for list; for `single` the cell key is `undefined`, so there is
exactly one cell for the whole slot). The ui-workspace README's sentence —

> "reusing a shipped id at another `priority` shadows that action" (`WS/README.md:104`)

— is the list-slot expression of the general rule stated in the catalog docs for every `id`-bearing slot:

> "Your cell key. Use an id of your own: a fresh id is added beside the shipped entries, while reusing a
> shipped id puts you in THAT cell and replaces it." (`RUNNER:2493`, `sidebar.workspaces.session.menu.item`)

For `sidebar.workspaces` the catalog's own guidance is blunter (`RUNNER:6603-6634`):

> `kind: "single"` … `declaredBy: "an entry in 'sidebar' (client-ui-sidebar), so it exists while that
> entry is mounted"`, `occupants: ["client-ui-workspace WorkspaceBrowser"]`,
> `replaceRisk: "shadows-shipped-ui"`

The same `replaceRisk: "shadows-shipped-ui"` flags every `single` slot including `root` itself, and the
`root` entry's doc spells out the consequence most explicitly (`RUNNER:4912`):

> "DO NOT register here. This is a single slot, so a second entry does not sit beside the frame — it
> shadows it, and a dynamically registered entry is assigned a lower priority than the shipped one,
> which makes it the winner: the page would render your component alone, with every seat the frame
> declares gone."

**One catch that makes shadowing `sidebar.workspaces` worse than shadowing a leaf:** `SlotCore.register`
refuses to redeclare an already-declared child (`DIST`):

```js
if (e.children) for (const h of Object.keys(e.children)) {
  const p = this.records.get(h);
  if (p?.spec) throw new Error(`slot "${h}" is already declared (by ${p.declaredBy ?? "an unknown entry"})`);
}
```

`sidebar.workspaces`'s declaration owns five children (`WS:5223-5248`): `…directoryFlow`,
`…session.menu.item`, `…session.row.action`, `sidebar.session.row.leading`, `sidebar.session.row.hover`.
A shadowing registration therefore has two choices, both bad:

* **Omit `children`** → the five child slots are released (`releaseChildren` clears `spec`), so the
  shipped Session menu items, hover buttons, the leading status seat, the hover card seat, and the
  directory-picker hole **all disappear** — including the archive/pin rows and the "Add workspace" flow
  (`flowSource("sidebar.workspaces.directoryFlow")`, `WS:5055`, gates the Add workspace action).
* **Declare the same children** → `slot "…" is already declared` throws, unless the shipped entry is
  already disposed at that instant (a race you cannot win in practice).

### 3.4 If a plugin replaced `sidebar.workspaces`, what would it have to re-implement?

Everything. `WorkspaceBrowser`'s props (`WS:3510`) are the whole browser's contract:

```js
function WorkspaceBrowser({ wide, usePanelInfo, expandSidebar, useSessions, useSessionStatus,
  useWorkspaces, useStore, actions, startSession, open, requestSessionRename, notifyArchivedNotOpenable,
  renameWorkspace, deleteWorkspace, insertWorkspaceBefore, unarchiveSession, createWorkspace,
  searchSessions, searchResultLimit, useDirectoryFlow, useHostInfo, useShortcuts, useWorkspaceShortcuts,
  requestSearch, requestAddWorkspace, closeAddWorkspace, setDirectoryBusy, renderSlot, t })
```

Counting what a fork inherits from `WS` (region markers at `WS:1247` → `WS:4994`):

| Region | Lines | What you would have to reproduce |
|---|---|---|
| view store (persisted `dsh.workspace.view.v5`) | 1247–1316 | groupBy / orderBy / archivedFilter / groupExpansion / sessionOrderByAccount |
| pin-order + navigation service | 1317–1712 | `UiWorkspaceService`, `openSession`, `startSession`, `restoreSelection`, draft prep |
| CSS (module CSS, hashed classes) | 1741–1788, 2371–2382, 2547–2562, 2720–2777 | ~9 KB of `GAkraW_*` / `wnFoaW_*` / `RsIu1q_*` rules |
| rows (ProjectRowItem, SessionNodeItem, SearchResultItem, hover cards) | 1789–2370 | hover cards, marquee titles, status dots, drag/drop, the workspace "…" menu |
| AnimatedRows | 2383–2546 | FLIP-style row motion keyed on `data-row-key` |
| WorkspacePicker + PickFlow | 2563–2719 | the hero picker |
| WorkspaceBrowser + SessionTree + FlatList + SearchResults + all dialogs | 2778–4122 | ~1345 lines: renames, delete, archive confirm, search, empty states, rail mode |
| session actions (archive/fork/pin/rename/toast/session-id) | 4123–4742 | the shipped list-slot occupants, the dialogs, the toast factory |
| locale dicts | 4743–4993 | ~200 keys × zh/en |
| **apply() + slot declarations + inject faces** | 4994–5354 | everything above |

That is the entire 232 KB file. And you would additionally have to keep the five child slots alive so
other plugins (`directory-picker-native`/`-browse`, `ui-schedule`'s `sidebar.session.row.leading`) keep working.

**Verdict on Q3: technically possible, practically a fork.** The mechanism is legitimate ("shadowing
the single slot" is explicitly documented); the *thing being shadowed* is the whole feature.

---

## Q4 — Alternative non-fork strategies, evaluated

### (a) Wrap / intercept the client `remote.workspace` RPC namespace so `follow()` returns a filtered baseline

**Not feasible.** Four independent walls:

1. `remote.workspace` is a real Cordis service named `remote.workspace` (`GATEWAY:2074`), created once
   per namespace; `validateContribution` throws `conflicts with an existing Remote namespace`
   (`GATEWAY:1735`) and `RemoteNamespaceService.assertMethodAvailable` rejects a second
   `workspace/follow` (`GATEWAY:1958`).
2. Even absent that, `reflect.provide` throws on a duplicate service name (`CORDIS:813`).
3. `follow()` is consumed *inside* `dsh-api-workspace-controller`'s own `apply` (`CTRL:451,476`),
   which runs before any third-party plugin can exist; the stream is opened once from that closure.
4. Filtering frames would not be enough anyway: because the derivation rebuilds `accounted` from
   `items` (`WS:3543`), removing a workspace from the baseline re-homes its sessions into Ungrouped.

There **is** a sanctioned, host-side, per-peer filter of exactly this shape (`CTRL` index.js:963, via
`remoteAccess.allows()`), but it applies only to non-owner principals and only through
`registerPolicy(kind, policy)` — the desktop user is the owner, and `allows()` returns `true` for the
owner unconditionally (`dsh-api-remote-access/README.md`).

### (b) Add a `sidebar.panellist` entry (a whole new main panel) rendering a custom filtered tree

**Feasible, clean, but it does not do what the user asked.** The contract, quoted from
`dsh-client-ui-sidebar/README.md:38`:

> "Plugins add an icon component to the root-scoped `sidebar.panellist` list with an `id`, optional
> `order`, and a string or locale-aware `label`. The same id addresses the component registered in the
> layout's root-scoped `main` keyed slot; selecting a missing main entry throws without changing the
> current selection. The label supplies plain visible text, the accessible name, and the collapsed
> tooltip. Expanded navigation rows have a 2px gap. Each row reads its own selected state through
> `usePanelInfo` … With no panel registrations, neither the list nor spacing for it is rendered."

Mechanics, verified: declaration `sidebar.panellist` kind `list` at `SIDEBAR:627-630`; consumption via
`ctx.slots.entriesOfSlot("sidebar.panellist")` + `syncPanels()` at `SIDEBAR:563-583`; the main panel is a
`keyed` slot `main` (`dsh-client-ui-layout/lib/client.js:631-634`) dispatched by
`renderSlot("main", {}, { entryKey: usePanelInfo(…activePanelId) ?? "conversation" })`
(`layout:118-120`), and `selectPanel` throws for an unregistered key (`layout:468-470`).
The catalog confirms `main` is additive-per-key: *"Your cell key: the entry renders where the owner
dispatches this exact key. Registering an already-occupied key replaces that occupant."* (`RUNNER:4374`)

So a plugin can add e.g. a "Workspaces" panel with its own filtered tree, and it will get the standard
kit (`useWorkspaces`, `useSessions`, `useSessionStatus`, `usePanelInfo`, `useRemoteAccess`, …,
`RUNNER:4378-4388`) with zero forking.

**Why it is not a solution:** it is a *second* tree in the main area. The left sidebar still shows every
workspace. The user's request — "temporarily hide workspaces I don't need, in the sidebar" — is
untouched. It also duplicates the sidebar's own affordances (hover cards, drag reorder, search,
watermark overflow) at real cost: those are exactly the 1300 lines you would be rewriting.

### (c) CSS / DOM hiding via `styles.insert`

**Feasible, and it is the only mechanism that hides rows *in place* without a fork. It is a hack with
several sharp edges.** All facts verified.

`styles.insert(css)` is a first-class verb of the dynamic-plugin surface
(`RUNNER:7053-7054`: *"Package-owned stylesheet insertion cleaned up with the Client run."*;
implementation `RUNNER:74-103` — one `<style data-dyn="<pluginId>">`, removed on unload). A
`bundle`-lane plugin would instead inject its own `<style data-plugin-css=…>` (the pattern every shipped
package uses, e.g. `WS:2723-2728`), or use `ctx.theme.overrideTokens`.

**The row attributes are stable and keyed by identity.** Workspace header row (`WS:1966-1970`):

```js
const ownRow = <div className={clsx(Rows_module_css_default.projectRow, …)}
                   "data-row-key": `workspace:${group.key}`
                   role="treeitem" aria-expanded={row.expanded} …>
```

and `group.key` **is** the workspace id for real workspaces (`buildGroup(workspace.workspaceId, workspace.workspaceId, …)`
at `WS:1041`; the ungrouped bucket is `buildGroup("", void 0, …)` at `WS:1044`). So
`group.key === workspaceId` for real workspaces and `""` for Ungrouped — the CSS selector
`[data-row-key="workspace:<uuid>"]` is exact and stable. (`group.workspaceId` is `undefined` for the
ungrouped bucket, which is how the renderer distinguishes them: `WS:1953`.)

Session rows use `session:${node.id}` (`WS:2276`). A workspace group is a wrapper
`div.groupSection` (`WS:3195-3200`) that contains the header row, its child groups, its session rows
and its `overflow:` button — **the wrapper carries no identity attribute**, so a pure-CSS descendant
rule must key off the header: `div:has(> [data-row-key="workspace:<uuid>"]) { display: none }`.

**What breaks (all verified in code):**

1. **Ungrouped re-homing does not happen.** CSS hides pixels only; the derivation still counts the
   workspace, so its sessions are *hidden with it* rather than surfacing under Ungrouped. Whether that
   is desirable is a product decision — but it is an *emergent* behaviour of the hack, not a designed one.
   (A data-level filter would produce the opposite, surprising behaviour.)
2. **Drag/drop and reorder break.** Workspace drag targets are computed from *rendered* groups
   (`WS:3137-3145`: `const rendered = new Set(groups.map((g) => g.key))`, `childrenByParent`, `rootGroups`);
   a `display:none` group is still in `groups`, so a drop that targets a hidden sibling commits an
   `insertWorkspaceBefore` against an invisible anchor. Session drag commit logic reads
   `activeDrag.accountKey` and `workspaces.find(...)` (`WS:3115`) from the *model*, not the DOM, so
   dragging within a partially hidden list can silently rewrite a hidden account's saved order.
3. **The FLIP animator mis-measures.** `AnimatedRows.readPositions()` (`WS:2489-2496`) reads
   `querySelectorAll("[data-row-key]")` and `getBoundingClientRect()`. A `display:none` row yields a
   zero rect; `intersects(row, viewport)` is then false, so rows *below* the hidden one glide by the wrong
   delta — visible jitter whenever the list re-renders with a hidden workspace in the middle.
4. **Keyboard tree navigation skips nothing.** Rows are `role="treeitem"` in `role="tree"`
   (`WS:2518`, `WS:2277`), with no roving `tabIndex` (only the search input has one, `WS:3872`). Tab order
   is DOM order, so hidden rows are simply unscrollable-into — acceptable — but there is no
   "current workspace" concept that a hidden row could break, because there is none to begin with.
5. **Search results are unaffected in a good way.** `SearchResultItem` rows carry **no** `data-row-key`
   (`WS:2183-2186` only has `role="treeitem"`) and are rendered outside `AnimatedRows`, so a
   `[data-row-key]` selector cannot accidentally hide search hits. Conversely, a hidden workspace's
   sessions remain findable through search — which is arguably the right "temporarily hidden" semantics.
6. **Counts.** `sessionCount` is computed (`WS:1106`) but **never rendered anywhere** (grep: the only
   occurrence in all 305 packages is that assignment). `sessions.count.one/other` exist in the locale
   dicts (`WS:4961-4962`) but are never passed to `t()`. So there is no visible count to corrupt.
7. **Rail mode** (`wide === false`) renders only the two rail buttons (`WS:3947-3964`), so hiding is a
   no-op there; harmless.
8. **Brittleness.** `GAkraW_*`/`wnFoaW_*` class hashes are build artifacts; `data-row-key` is not a
   documented API and appears in the shipped code only as an animator internal
   (`WS:2388-2414`, `WS:2489`). A future release may rename it.

**Verdict:** the cheapest working `hide` today, and honestly reasonable for a *personal* plugin, but it
is a rendering-layer hack: state lives outside the app, drag/reorder semantics silently diverge from
what the user sees, and it will need maintenance whenever the animator or row keys change.

### (d) Upstream / monkey-patch the shipped `lib/client.js` on disk (app.asar or a profile copy)

**Technically possible, but there is no supported per-package override, and it is the least durable
option.** Evidence:

* **No profile-level override for a shipped client bundle.** The profile layer (`~/.dsh/profiles/desktop/package.json`
  + `cordis.patch.yml`) composes Loader *rows*; a row's `name` is a module specifier and a patch may
  replace `config`, `disabled`, `inject`, `intercept`, `isolate` (`cordis-plugin-include/lib/index.js:67-105`,
  and `cordis-composition-reference` SKILL.md: *"A patch with an `id` and no `insert` targets the existing
  row with that id. Supplied fields replace the row's fields; `config` is replaced wholesale"*).
  A patch that names a different package still has to *assert the same name* —
  `if (name && name !== target.name) { warn("patch: name mismatch …"); continue; }` (`include:98-102`).
  So you cannot redirect the `ui-workspace` row at your own package while keeping its id, and you cannot
  shadow it by id. (You *can* `disabled: true` the whole row — that removes the browser entirely.)
* **The client bundle is served from the installed package file**, not from a profile copy:
  `ClientModuleRegistry.resolveMeta` computes `clientPath: join(dirname(pkgPath), clientRel)`
  (`dsh-client-modules/lib/index.js:735-745`) from the Loader-resolved package root, and
  `reconcilePackage` throws if a package resolves from two live sources
  (`client-modules: package X resolves from multiple active Loader sources`).
* **Editing `app.asar` is not signature-guarded but is overwritten.** The asar header parses as
  `{ "files": … }` only — **no `integrity` block** (verified by parsing the header pickle of
  `<DSH_INSTALL>\resources\app.asar`), and the Electron binary contains **no**
  `EnableEmbeddedAsarIntegrityValidation` fuse string. So a patched asar *would* load. But the app runs
  `electron-updater` (`lib/main.js:14-15`, `quitAndInstall` at `main.js:7889`) on a nightly channel
  (`package.json: dshDesktopUpdateChannel: "nightly"`), so any edit is reverted by the next update, and
  the whole install is replaced rather than patched.
* **Patch scope.** Adding one filter means editing `groupByWorkspace` (`WS:1027`) or `deriveGroups`
  (`WS:1091`) inside a 232 KB minified-ish bundle whose region map (`WS:12`…`WS:4994`) is your only map,
  then re-doing it for every release (the file is a build artifact; `dshBuildCommit` pins the source).

**Verdict:** viable as a *last-resort* lever for a single patient user, never as a distributable plugin.

### (e) Bonus option not on the list — in-memory shadow of the live model object

Worth naming because it is the one "data-level" hack that does not require shadowing the slot.
`CTRL:296-312` and `CTRL:183-194` are ordinary prototype methods on a plain class instance; a plugin with
`inject: ["workspaces"]` gets `ctx.get("workspaces").list` and can wrap `getSnapshot`/`subscribe`
(it is a `useSyncExternalStore` source, so React will follow). Assessment:

* **Does not survive re-instantiation** and is not cleaned up by Cordis effects, so unload leaves a
  patched model behind unless you restore it manually.
* **Same Ungrouped re-homing problem** as (a) and the model is also read by `UiWorkspaceService`
  (`startSession` fallback target `recentWorkspace(workspace.items, …)`, `WS:1508`, `1621`), by
  `dsh-client-ui-schedule` and by `dsh-client-ui-conversation`'s hero picker — so filtering `items`
  changes *navigation targets*, not just rows. That is a behaviour change the user did not ask for.
* Listed only for completeness; **not recommended**.

---

## Q5 — Is there ANY officially-sanctioned extension point for workspace-level row actions or filtering?

### 5.1 Method

* All slot identifiers in the installation: `grep -rhoE 'name:\s*"[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+"' --include=client.js`
  across all 305 packages, plus `grep -rhoE '"[A-Za-z0-9_.-]*workspace[A-Za-z0-9_.-]*"\s*:\s*\{'`
  to catch *declared* child keys (which never appear on a `name:` line).
* Cross-checked against the authoritative generated catalog, which lists **every** slot the Client
  actually declares: `RUNNER` `SLOT_API` (`key: "…"` entries, 118 slots total, `RUNNER:2436`–`RUNNER:6957`).
* Cross-checked against every `menu.item` / `row.action` / `.actions` slot anywhere.

### 5.2 Complete inventory — every slot name containing `workspace`

| Slot | Kind | Declared by | Occupants | Workspace-scoped? |
|---|---|---|---|---|
| `sidebar.workspaces` | **single**, root | `client-ui-sidebar` (`SIDEBAR:635-638`) | `ui-workspace` → `WorkspaceBrowser` (`WS:5221`) | the whole region |
| `sidebar.workspaces.directoryFlow` | single, root | `ui-workspace` (`WS:5224`) | `directory-picker-browse`, `directory-picker-native` | no — directory picking only |
| `sidebar.workspaces.session.menu.item` | **list**, root | `ui-workspace` (`WS:5228`) | pin/rename/fork/archive/session-id (`WS:5253-5281`) | **session** rows |
| `sidebar.workspaces.session.row.action` | **list**, root | `ui-workspace` (`WS:5236`) | archive/pin (`WS:5290-5303`) | **session** rows |
| `conversation.hero.workspace` | single, root | `ui-conversation` (`conversation:19946`) | `ui-workspace` → `WorkspacePicker` (`WS:5329`) | the empty-state picker |
| `conversation.hero.workspace.directoryFlow` | single, root | `ui-workspace` (`WS:5331`) | directory pickers | no |
| `workspace.toast` | **keyed**, root | `ui-workspace` (`WS:5297-5300`) | 11 shipped notice kinds | no — notices |
| `workspace.toast.content` | **factory**, root | `ui-workspace` (`WS:4584`) | `WorkspaceToast` | no — notice presentation |

### 5.3 Complete inventory — every `menu.item` / `row.action` / `*.actions` slot in the whole app

```
menu.item  : sidebar.right.tab.menu.item
             sidebar.workspaces.session.menu.item          ← SESSION only
row.action : sidebar.workspaces.session.row.action         ← SESSION only
*.actions  : conversation.session.header.actions
             conversation.session.header.views.actions
             deliverables.file.actions
             deliverables.review.file.actions
             plugins.add.actions
             plugins.detail.actions
             sidebar.panellist.actions
             sidebar.right.tab.document.actions
             sidebar.right.tab.files.actions
             sidebar.right.tab.guide.actions
```

**There is no `sidebar.workspaces.menu.item`. There is no `workspace.menu.item`, no
`workspace.row.action`, no `workspace.group.*`, no `.row.hover` for a workspace.** The only list slots
inside the browser are the four declared at `WS:5228-5247`, and all four are Session-scoped in meaning
(`sidebar.session.row.leading` / `.hover` take "the row's Session identity and nothing else", per
`WS/README.md:97`).

### 5.4 The workspace context menu is hardcoded — confirmed

`ProjectRowItem` builds its menu inline with **no slot** (`WS:1956-1963`):

```js
const workspaceMenuItems = [
  { id: "rename", label: t("rename"), icon: IconEditOutlineRegular },
  { id: "delete", label: t("delete.workspace"), icon: IconTrashOutlineRegular, danger: true },
];
```

and `onSelect` ignores everything else (`WS:2005-2012`):

```js
onSelect: (id) => {
  setMenuOpen(false);
  if (id !== "rename" && id !== "delete") return;   // ← closed set, no hook
  if (id === "rename") actions.rename(); else actions.delete();
},
```

The menu's `actions` prop is likewise closed: only `{ rename, delete }`, and only for real workspaces
(`WS:3216-3227`: `actions: group.workspaceId === void 0 ? void 0 : { rename: …, delete: … }`).

### 5.5 The view-options menu (the natural home for a "hide" toggle) is hardcoded too

`WS:2926-2966` — the "View options" `Menu` is a literal array of `{id, label, icon}` with a closed
`onSelect` (`WS:2951-2960`): `"workspace" | "workspace-tree" | "flat" | "manual" | "updated" |
"hide-archived" | "show-archived" | "only-archived"`, else nothing. No slot, no injection point.

### 5.6 What *does* exist, ranked by cleanliness

| Sanctioned point | Effect on hiding a workspace | Effort |
|---|---|---|
| `main` (keyed) + `sidebar.panellist` (list) | a **new panel** with your own tree; sidebar unchanged | medium, no fork |
| `sidebar.workspaces` (single) at priority < 0 | **replaces** the browser → full fork | very high |
| `workspace.toast` (keyed) / `.content` (factory) | presentation only | low, irrelevant |
| `shell.overlay` (list) | a floating surface (e.g. a "hidden workspaces" manager) | low, useful as a *companion* |
| `styles.insert(css)` | **hides rows in place**, no data change | low, hacky |
| `RemoteAccessService.registerPolicy` | real host-side filter, **non-owner peers only** | n/a for local desktop |
| `intercept` / `isolate` loader-row options | cannot target a row you do not own | n/a |

**Answer to Q5: no. There is no officially-sanctioned extension point for workspace-level row actions or
workspace filtering in DSH 0.2.1-rc.3.** The workspace row is deliberately closed: its menu is a closed
union, its view options are a closed union, and its row is inside a `single` slot whose only sanctioned
override is total replacement.

---

## Final recommendation — ranked cleanest → hackiest

### 1. (Cleanest) A **companion** plugin: `sidebar.panellist` panel + `shell.overlay` affordances — *not* a filter
*What:* register one `sidebar.panellist` row ("Workspace visibility") whose `main` keyed entry lists all
workspaces with toggles, restoring hidden ones. Optionally combine with (2) below for the actual hiding.
*Why:* fully sanctioned, additive, zero forking, survives upgrades, gets the whole standard kit for free
(`useWorkspaces`, `usePanelInfo`, `useRemoteAccess`, `renderSlot`) and the standard `main` dispatch.
*Effort:* ~1 small page. **Risk: low.** *Caveat:* on its own it changes nothing in the sidebar — it is the
supported half of the answer, not the answer.

### 2. (Pragmatic) **CSS/DOM hiding** via an injected stylesheet, keyed on `data-row-key="workspace:<id>"`
*What:* a `hiddenWorkspaceIds` set (persisted browser-locally through the plugin's own snapshot store),
translated to `div:has(> [data-row-key="workspace:<uuid>"]){display:none}` in one owned `<style>` tag,
toggled from a real menu row wherever you can get one (the panel from (1), or `shell.overlay`).
*Why it wins on cost:* it is the only mechanism that hides rows **in place in the left sidebar** without
a fork, it reaches every view (grouped, tree, flat) at once, it leaves search results alone, and
`styles.insert`'s disposal semantics are designed for exactly this (`RUNNER:74-103`, `RUNNER:7053`).
*Effort:* a few hundred lines. **Risk: medium.** Named hazards, all verified above: (i) sessions of a
hidden workspace vanish with it (CSS never reaches the derivation, which re-homes nothing); (ii) the
workspace drag anchor logic works off *rendered* groups (`WS:3137`) so drops against a hidden neighbour
can commit an invisible reorder; (iii) `AnimatedRows` measures hidden rows as zero rects
(`WS:2489`) and glides the wrong delta; (iv) `data-row-key` is an animator internal, not a public API.

### 3. (Design-correct, expensive) **Fork by shadowing `sidebar.workspaces` at priority < 0**
*What:* re-register the single slot at a lower priority with your own `WorkspaceBrowser`.
*Why it is only #3:* the mechanism is fully documented and legitimate (`RUNNER:6603`, `DIST`
"register at a different priority to shadow it (lowest renders)"), but the object being shadowed is the
whole feature — ~4100 lines of rendering, the persisted view store, the navigation service, the five
child slots (which you must either abandon, breaking archive/pin rows, the leading status seat and the
Add-workspace flow, or re-declare, which throws), the ~200 locale keys, and the dialogs.
*Effort:* effectively vendoring and maintaining `ui-workspace`. **Risk: high** (semantic drift every release).
*Only justified* if the feature grows into "a better sidebar" rather than "hide a row".

### 4. (Fragile) **In-memory shadow of `ClientWorkspaceModel`** (`ctx.get("workspaces").list`)
*Why so low:* not an extension point; unfiltered by any lifecycle; and because the model feeds
`UiWorkspaceService.startSession`'s fallback target (`WS:1508,1621`), the hero picker
(`conversation:17817`) and `ui-schedule`, filtering `items` silently redirects **new sessions** away
from where the user expects. Plus the Ungrouped re-homing surprise. **Risk: high, benefit: none over #2.**

### 5. (Last resort) **Patch the installed bundle** (`app.asar`) at `groupByWorkspace` / `deriveGroups`
*Why last:* it works today — the asar carries **no `integrity` block** and the Electron binary has **no
`EnableEmbeddedAsarIntegrityValidation` fuse** — but there is **no supported per-package override**
(loader patches assert the row's `name`, `include:98-102`; the client path is derived from the resolved
package root, `client-modules:735-745`), and the desktop app auto-updates on a **nightly** channel
(`quitAndInstall`, `main.js:7889`), which replaces the whole install. Every release costs a re-patch of a
build artifact. **Risk: highest.**

### 6. (Rejected) Namespace interception — `remote.workspace` / `workspaces` service / `useWorkspaces` hook
All three throw on a second registration (`GATEWAY:1735` + `GATEWAY:1958`; `CORDIS:813` + `CORDIS:791`;
`RENDERER:1808`). No amount of cleverness gets around a duplicate-key throw; do not budget for it.

---

## Two facts that should shape the design conversation

1. **Hiding a workspace at the data layer and hiding it at the render layer are NOT the same product.**
   Removing a workspace from `workspaces` makes `ungroupedMemberIds` (`WS:3543`) re-home its sessions into
   the "Ungrouped" group — i.e. the sessions reappear under a different heading. Removing it from the DOM
   hides the sessions with it. The render-layer approach is the behaviour the user is actually asking for
   ("temporarily out of my way"), and it happens to also be the only one reachable without a fork.

2. **`sessionCount` is dead code.** `deriveGroups` computes it (`WS:1106`) and nothing in the installation
   ever renders it (the only occurrence across all 305 packages). Likewise `sessions.count.one/other`
   exist in the dictionaries (`WS:4961-4962`) with no call site. So the "counts go wrong" worry in the
   CSS approach is unfounded — there are no counts.
