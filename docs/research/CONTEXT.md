# DSH "Better Sidebar" plugin research — shared context

## Goal (user request, Chinese)
Create a DSH plugin that improves the left sidebar, built on top of the current sidebar.
Specifically: currently a workspace can only be RENAMED or DELETED. User wants to
TEMPORARILY HIDE workspaces they don't currently need (reversible, non-destructive).
This is a DISCUSSION phase — we need feasibility analysis and design options, not a full build yet.

## Machine / install facts (verified)
- DSH desktop app installed at: `<DSH_INSTALL>` (Electron; `DeepSeek Harness.exe`)
- App bundle: `<DSH_INSTALL>\resources\app.asar` (182 MB)
- We EXTRACTED the asar to: `<ASAR>`
  - Unpacked npm packages live in `asar/dsh/node_modules/@deepseek-ai/` (305 packages)
- User profile: `%USERPROFILE%\.dsh\profiles\desktop`
  - `package.json` has `dsh.profile.bundles` (list of bundle names)
  - `cordis.patch.yml` = user patch layer (config overrides / inserts)
  - `node_modules/@dsh-local/anchored-standard` -> symlink to `%USERPROFILE%\.dsh\anchored-standard-bundle`
    (this proves LOCAL plugins are installed via `link:` deps)
  - `node_modules/dsh-our-free-model` = a real 3rd-party plugin w/ both host (`index.js`) and client (`client.js`) halves
- Durable workspace state: `%USERPROFILE%\.dsh\storages\workspace.json`
  (schema: `unit:{name:'workspace',version:2}`, `global:{workspaceIds[],archivedSessionIds[],pinnedSessionIds[]}`,
   `tables.workspaces[id] = {path,title,sessionIds[],createdAt,updatedAt}`)
- DSH version: 0.2.1-rc.3
- Versions: node v24.22.1, npm 11.19.1, pnpm 11.22.0, python 3.11.0
- NOTE: the app is currently RUNNING (port 62722 instance registered). Don't kill it.

## Key packages
- `@deepseek-ai/dsh-client-ui-sidebar`  — sidebar SHELL. Owns seats `sidebar.workspaces`, `sidebar.settings`,
  `sidebar.panellist`, `sidebar.panellist.actions`, `sidebar.brand.mark`, `sidebar.toggle.badge`.
- `@deepseek-ai/dsh-client-ui-workspace` — the ACTUAL workspace/session tree browser, registered into
  `sidebar.workspaces` hole. `lib/client.js` is 232 KB (bundled React, minified-ish).
- `@deepseek-ai/dsh-api-workspace-controller` — host `ctx.workspaceController` + client `ctx.remote.workspace`.
  Methods: create, rename, remove, reorder workspaces; reorder sessions; archive/unarchive sessions; `follow()` stream.
- `@deepseek-ai/dsh-client-ui-slots` — the slot system.
- `@deepseek-ai/dsh-storage*` (`dsh-storage`, `dsh-storage-domain`, `dsh-storage-json`) — durable host storage units.

## CRITICAL finding #1 — workspace context menu is HARDCODED
In `asar/dsh/node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js` around line 1957,
component `ProjectRowItem` builds:
```js
const workspaceMenuItems = [
  { id: "rename", label: t("rename"), icon: IconEditOutlineRegular },
  { id: "delete", label: t("delete.workspace"), icon: IconTrashOutlineRegular, danger: true },
];
```
and `onSelect` explicitly ignores any other id. So there is NO hook to add a 3rd menu row here.

## CRITICAL finding #2 — slot declarations (client.js ~line 5221)
```js
ctx.slots.inject("sidebar.workspaces", () => ctx.slots.register({
  name: "sidebar.workspaces",
  children: {
    "sidebar.workspaces.directoryFlow":      { kind: "single", scope: "root" },
    "sidebar.workspaces.session.menu.item":  { kind: "list",   scope: "root", inject: {...} },
    "sidebar.workspaces.session.row.action": { kind: "list",   scope: "root" },
    "sidebar.session.row.leading":           { kind: "list",   scope: "root" },
    "sidebar.session.row.hover":             { kind: "list",   scope: "root" },
  },
  store: viewStore,
  inject: browserInjected,
  locale: NS
}, WorkspaceBrowser));
```
=> Only SESSION-level action slots exist. There is **no `sidebar.workspaces.menu.item`** or workspace-row action slot.
So a "Hide workspace" row cannot be injected into the existing workspace "..." menu through a slot.

## Existing analogous primitive: Session ARCHIVE
Sessions CAN be archived (`archivedSessionIds` in workspace.json) and unarchived;
archived rows are filtered out of navigation but stay recoverable ("archived" view filter).
There is NO equivalent for workspaces. This is the closest existing design precedent
for what the user wants ("hide temporarily, reversible").

## Open questions to answer
1. Can a 3rd-party client plugin filter/replace the workspace list without forking `ui-workspace`?
   (options: replace the `sidebar.workspaces` single slot registration; decorate the client
   workspace model; shim `ctx.remote.workspace`; CSS/DOM hack; upstream patch)
2. Where should the "hidden" flag durably live? (host storage unit via a host-half plugin;
   extending workspace.json schema; or pure client-side localStorage in the browser profile)
3. How is a local 3rd-party plugin packaged + installed into the desktop profile so DSH loads it?
