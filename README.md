# dsh-hide-workspace

Put workspaces you do not need right now out of the DeepSeek Harness sidebar,
and bring them back at any time. Nothing is deleted, archived or rewritten.

Language: **English** | [中文](README.zh.md)

---

## What it does

| Entry point | Behaviour |
|---|---|
| Workspace row `...` menu → **Hide workspace** | The whole group (child workspaces and their sessions included) leaves the sidebar |
| Same menu on a hidden workspace → **Unhide workspace** | Puts it back; the label switches on its own |
| View options → **Filter workspaces** (three states) | Hide hidden / show all / only hidden |
| **Ctrl + H** | Nothing hidden → hides the workspace of the current session; something hidden → **restores everything** |
| Undo in the toast | Takes the last hide back immediately |

A hidden workspace **can still be found with search** (search rows are unaffected).
That is a deliberate escape hatch.

---

## Install

This plugin is a **bundle**: it ships `cordis.patch.yml` and a `dsh.bundle.patch`
declaration, so it appears in Settings → Plugins with a card, a toggle and an uninstall.

### From GitHub (recommended)

```sh
dsh plugin --profile desktop add github:roekdnd/dsh-hide-workspace
```

Restart DSH afterwards.

### From a local checkout

```sh
dsh plugin --profile desktop add <absolute path to this repository>
```

Restart DSH (a new package needs a restart to resolve). After that, editing
`client.js` only needs a page refresh — there is no build step, `client.js` *is* the artifact.

### Why not edit the profile by hand

Adding `link:` to the profile and running pnpm yourself also works, but:

- Let the package manager create the link. Junctions (`mklink /J`) do satisfy
  `isSymbolicLink() === true` in Node and work fine, but `pnpm add link:` also records
  the dependency in the lockfile.
- Plugins added that way do **not** show up in the Plugins panel (it only manages bundles).
- The DSH docs ask you not to hand-write the profile `package.json` / `cordis.patch.yml`,
  or to run pnpm against the profile yourself.

---

## Where state lives

```
%USERPROFILE%\.dsh\...           (not touched)
browser localStorage:
  dsh.hide-workspace.hidden.v1   ← ids of hidden workspaces
  dsh.hide-workspace.filter.v1   ← the selected filter state
```

**`workspace.json` is deliberately left alone.** It is the storage unit owned by
`dsh-workspace`, and its record schema is zod **strip mode** — an extra field is dropped
silently, with no error. localStorage also matches where DSH itself puts layout
preferences: `ui-workspace` keeps its own expansion state and session order there.

Trade-off: **no cross-device sync.** Using DSH on the web and on the desktop keeps one
set each.

---

## What happens when DSH updates

The sidebar is not a stable API. The plugin only depends on **explicit string anchors**,
never on hashed class names:

| Dependency | Stability |
|---|---|
| `data-row-key="workspace:<uuid>"` | High (a literal in the source, not a hash) |
| `role="menuitem"` / `aria-selected` | High |
| Hashed class names (e.g. `XXXXXX_groupSection`) | **Not used at all** |

### Self-healing

Every 1.2 s the plugin checks the structure: **if ids are hidden but not a single
workspace row renders** (four times in a row), it concludes the sidebar changed and then:

1. **clears the hidden set, so everything is visible again** — it never leaves workspaces
   hidden with no way back;
2. shows a notice: “The sidebar layout changed, so hiding is unavailable. All workspaces
   were shown again.”

The worst case is therefore **a broken feature plus a visible reason**, never
**workspaces silently gone**.

### If that notice appears

It means the sidebar DOM changed and the selectors need recalibration. Please open an
[issue](https://github.com/roekdnd/dsh-hide-workspace/issues) with the notice text and
your DSH version. The likely candidates are:

- is the workspace row still `data-row-key="workspace:<id>"`?
- is the session row still `aria-selected="true"`?
- is the `...` menu still `role="menu"` + `role="menuitem"`?

---

## Known limitations

1. **No separate management panel.** Unhiding goes through the `...` menu, `Ctrl+H` or
   the view-options filter.
2. **No right-click on a workspace row.** DSH has no workspace-level menu slot, so there
   is no injection point for a context menu.
3. **Drag-to-reorder is inaccurate while hiding.** Hidden groups still take part in
   drop-target maths, so dropping next to an invisible sibling commits an invisible
   reorder. Avoid reordering while workspaces are hidden.
4. **Search still finds hidden workspaces** — the escape hatch, on purpose.
5. **“Only archived” plus “only hidden” can both be empty.** Under “only archived” DSH
   does not render workspaces without archived sessions at all, so the list can be empty;
   the plugin then shows “No workspaces match this filter” with a **Show all workspaces**
   button.
6. **Tree mode**: hiding a parent workspace hides its children too (child rows render
   inside the parent block).
7. **Clearing site data** (localStorage) drops the hidden list and every workspace becomes
   visible again.

---

## Tests

```sh
node test/check-logic.mjs
```

47 assertions, zero dependencies (no jsdom, no Chrome), well under a second:

- `blockOf` / `selectedWorkspaceId` resolve correctly on a realistic node tree, including
  workspaces with sessions, **empty workspaces**, several workspaces side by side, and
  session ownership.
- **Loop-safety checks**: every per-pass write must be value-checked, selection is driven
  by a state attribute, and a row rebuild must be triggered by a count mismatch.
- **Behavioural filter tests** execute `applyHidden` against a fake DOM and assert what
  each of the three filter modes actually leaves visible.
- **Migration tests** cover the `dsh.better-sidebar.*` → `dsh.hide-workspace.*` key move.

Current result: **47 passed, 0 failed.**

The full defect list with failure scenarios is in **`AUDIT.md`**.

---

## Why the DOM and not the data layer

DSH exposes no workspace-level extension point. Findings from `docs/research/`:

### There is no usable slot

`sidebar.workspaces` declares only **Session-scoped** child slots:

```
sidebar.workspaces
sidebar.workspaces.directoryFlow
sidebar.workspaces.session.menu.item      ← Session
sidebar.workspaces.session.row.action     ← Session
```

The workspace row `...` menu and the View options menu are both **hardcoded closed
arrays** with no injection point, so both of this plugin’s entry points are DOM-injected.

### Filtering in the data layer is not possible

`groupByWorkspace()` builds its `accounted` set from the `workspaces` array it is given,
then trails every unaccounted session into an “Ungrouped” bucket. Dropping a workspace
from that list therefore **dumps its sessions into “Ungrouped”** as ownerless rows.

### Approaches that were tried and do not work

| Approach | Result |
|---|---|
| Shadow `sidebar.workspaces` with `priority: -100` | Throws `slot "<key>" is already declared`. Omitting its five child slots kills session menus, hover actions and the add-workspace flow. Doing it properly means forking ~4100 lines |
| `provideRoot({hooks:{workspaces}})` | Throws `duplicate root standard hook`; `workspaces` is a Cordis Service and duplicate registration throws |
| Put a custom field into `workspace.json` | The record schema is zod **strip mode**, so extra keys are dropped **silently and without error** (reproduce with `tools/scratch/zod-strip-proof.mjs`) |

### Where state lives, and why

The hidden set is a **device-local view preference** in `localStorage`, matching how
`ui-workspace` persists its own expansion state and session ordering.

> Upgrading from the old `dsh-better-sidebar` name migrates the old `dsh.better-sidebar.*`
> keys once, so already-hidden workspaces are not lost.

---

## File layout

```
dsh-hide-workspace/
├─ package.json         dsh.bundle.patch + dsh.client declarations
├─ cordis.patch.yml     the bundle mount row
├─ index.js             host half (intentionally empty: pure UI plugin)
├─ client.js            all of the logic
├─ icon.svg
├─ locale/{zh,en}.json  plugin card copy
├─ test/check-logic.mjs self-test (not published)
├─ docs/                research and design notes
│   ├─ research/        DSH source analysis: packaging, filtering, persistence
│   └─ design/          design discussion
└─ tools/               scripts that re-extract DSH (the asar itself is not committed)
```

`files` in `package.json` publishes only the runtime paths: `index.js`, `client.js`,
`cordis.patch.yml`, `locale/*.json`, `icon.svg`. `docs/`, `tools/` and `test/` stay in the
repository for reading and never enter the installed package.

---

## License

MIT
