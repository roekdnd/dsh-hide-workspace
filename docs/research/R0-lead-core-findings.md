# R0 — Lead's core findings (verified in extracted asar)

## A. The workspace row "..." menu is HARD-CODED (no extension point)
`dsh-client-ui-workspace/lib/client.js` ~L1951 `ProjectRowItem`:
```js
const workspaceMenuItems = [
  { id:"rename", label:t("rename"), icon:IconEditOutlineRegular },
  { id:"delete", label:t("delete.workspace"), icon:IconTrashOutlineRegular, danger:true },
];
...
onSelect:(id)=>{ setMenuOpen(false);
  /* v8 ignore next */
  if (id !== "rename" && id !== "delete") return;
  if (id === "rename") actions.rename(); else actions.delete();
}
```
`ProjectRowItem` body contains **NO `renderSlot(...)` call**. Every `renderSlot` in the package
is at L2155/2307/2345/2349/2713/3933/4516 — all SESSION-scoped, `directoryFlow`, or `workspace.toast`.
=> You cannot inject a "Hide workspace" row into the existing workspace menu from a plugin.

## B. Slot declaration inventory (client.js ~L5221)
`sidebar.workspaces` declares children:
- `sidebar.workspaces.directoryFlow` (single, root)
- `sidebar.workspaces.session.menu.item` (list, root)
- `sidebar.workspaces.session.row.action` (list, root)
- `sidebar.session.row.leading` (list, root)
- `sidebar.session.row.hover` (list, root)
No workspace-level menu/action slot exists. Full inventory of workspace-ish slot names in pkg:
`sidebar.workspaces`, `sidebar.workspaces.directoryFlow`, `sidebar.workspaces.session.menu.item`,
`sidebar.workspaces.session.row.action`, `conversation.hero.workspace`, `conversation.hero.workspace.directoryFlow`.
=> Cleanest "official" extension point does NOT exist.

## C. THE GOOD NEWS — single choke point for the tree
`groupByWorkspace(list, workspaces, archived, archivedFilter, ungroupedOrder)` at L1027 LOOP:
```js
for (const workspace of workspaces) { ... members ...; groups.push(buildGroup(workspace.workspaceId, ...)) }
```
`buildGroup(key=workspace.workspaceId, ...)`. And `deriveGroups()` (L1091) → `SessionTree` (L3025)
→ `ProjectRowItem` (L3224). `data-row-key = \`workspace:${group.key}\`` = **`workspace:<workspaceId>`**.
So `group.key === workspace.workspaceId` — a stable, predictable DOM key.

`storedWorkspaces = useWorkspaces((state)=>state.items)` (L3517) then
`workspaces = storedWorkspaces.map(...)` (memo). That `workspaces` array is THE filter point.

## D. Two structural obstacles to a "wrapper" plugin
1. `ctx.slots.provideRoot({ hooks:{ workspaces: workspaces.list } })` (ui-workspace L5030) puts the
   workspace hook on the ROOT binding. `provideRoot` contributions are merged by `rebuildRootBinding()`
   → `copyUnique()` which **THROWS** `duplicate root standard hook '<name>'` if two plugins provide the
   same hook. => you CANNOT re-provide `workspaces`; you'd have to REPLACE ui-workspace entirely.
2. `single` slot election (renderer L1173): `const entry = host.entriesOfSlot(slotKey)[0]`.
   `register()` sorts single-slot entries by `priority` ascending ("register at a different priority to
   shadow it (lowest renders)"). So a plugin CAN pre-empt `sidebar.workspaces` at a lower priority —
   but then it must re-implement the whole browser (232 KB bundle: search, drag&drop, rename/delete
   dialogs, directory flow, hover cards, animated rows, archive filter, keyboard shortcuts).
   => practical only by FORKING the package, not by a thin plugin.

## E. Sanctioned plugin mechanics (from the shipped authoring skill)
Source: `asar/dsh/node_modules/@deepseek-ai/dsh-agent-preset/skills/cordis-plugin-development/`
- Bundle = package with `dsh.bundle.patch` -> a `cordis.patch.yml` with `- insert: [{id,name}]`.
- Client half: `package.json` `dsh.client = { platform:'web', immediately:true, inject:[...] }`
  + `exports["./client"]`, and `client.js` is:
  ```js
  window.__ModuleLoader__.load({ id:'<pkg name>', factory(require){ const React=require('react'); ... return { inject:['slots'], apply(ctx){ ctx.slots.inject('<slot>', ()=>ctx.slots.register({name:'<slot>', id:'x', order:n}, C)) } } } })
  ```
- Install: `plugin_manager` `action:install_bundle` with the absolute package dir. **The skill explicitly
  says: do NOT hand-write the profile package.json / cordis.patch.yml and do NOT run pnpm in the profile.**
- Client plugins must NOT `require('@deepseek-ai/dsh-client-ui-primitives')` — must copy markup/CSS and use
  only `--dsw-alias-*` theme tokens.
- `references/ui-plugin.md`: "Do not read another plugin's DOM, stylesheet, or component source to estimate
  placement; choose a slot that already allocates space."

## F. Persistence — clean host-side path exists
`dsh-storage-domain` provides `defineDomain({name,version,tables})` + `ctx.storageDomain.open(spec)`
→ `domain.table('t').put/get/update`, durable (`domain/changed` event). `dsh-storage-json` writes
`<root>/<unit>.json` (default `single` layout) — so a plugin gets its OWN file, e.g.
`~/.dsh/storages/better-sidebar.json`, with NO conflict with upstream `workspace.json`.
Precedent: `workspace.json` = `{unit:{name:'workspace',version:2}, global:{...}, tables:{workspaces:{...}}}`
plus `archivedSessionIds` / `pinnedSessionIds` — i.e. HIDE IS ALREADY A FIRST-CLASS CONCEPT FOR SESSIONS.
`dsh-workspace` README: "Hide a session from the grouping... it disappears from the visible list, while its
session, history, and place in the project stay intact." There is NO workspace equivalent.

## G. Tooling constraint discovered at runtime
`plugin_manager`, `cordis_inspect_query`, `cordis_inspect_list` are named in the skill but are **NOT callable
in this session** ("unknown tool"). So I cannot self-install/verify; installation must be done by the user
(or by a DSH session/profile-launched agent that has those tools).

## H. Version / update risk
`app.asar` is overwritten on app update (electron-updater; version 0.2.1-rc.3). Any approach that PATCHES
shipped files (monkey-patching `lib/client.js`, editing `app.asar`) is destroyed by every update and the
skill forbids reading/patching another plugin's source. CSS-hide hacks depend on hashed class names
(e.g. `wnFoaW_projectRow`) which change per build → high breakage risk. `data-row-key` IS stable.
