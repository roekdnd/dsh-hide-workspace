# R2 (partial, verified by lead) — Complete workspace-level slot inventory

R2 did not return in time. The lead verified its single most important question directly.
Method: `grep -rh 'slots.inject("' --include=client.js */lib/*.js` across all 305 packages,
plus a full scan of every slot identifier containing `workspace`.

## The complete list of `sidebar.*` / `workspace.*` slot targets in the whole installation

```
sidebar                                    sidebar.panellist
sidebar.brand.mark                         sidebar.panellist.actions
sidebar.brand.name                         sidebar.right.pane.tab
sidebar.chat.conversation                  sidebar.right.pane.tab.title
sidebar.footer.action                      sidebar.right.tab.document
sidebar.right.tab.document.action          sidebar.right.tab.files.actions
sidebar.right.tab.document.actions         sidebar.right.tab.guide.actions
sidebar.right.tab.document.office.pdf      sidebar.right.tab.guide.entry
sidebar.right.tab.document.unpreviewable   sidebar.session.row.hover
sidebar.settings                           sidebar.session.row.leading
sidebar.toggle.badge                       sidebar.workspaces
sidebar.workspaces.directoryFlow
sidebar.workspaces.session.menu.item       workspace.toast
sidebar.workspaces.session.row.action
```

## ANSWER: There is NO workspace-level action or menu slot. Anywhere.

Every `sidebar.*` slot that can host an **action** is scoped to a **Session** (`*.session.menu.item`,
`*.session.row.action`, `*.session.row.leading`, `*.session.row.hover`) or is a **panel**
(`sidebar.panellist`, `sidebar.panellist.actions`, `sidebar.right.*`) or a **shell decoration**
(`sidebar.brand.*`, `sidebar.toggle.badge`, `sidebar.footer.action`, `sidebar.settings`).

The full set of slot identifiers containing `workspace` is exactly:
```
conversation.hero.workspace                  (the picker hole in the empty-state hero)
conversation.hero.workspace.directoryFlow    (single: the picking interaction)
sidebar.workspaces                           (single: the whole browser -> the shadow target)
sidebar.workspaces.directoryFlow             (single: the picking interaction)
sidebar.workspaces.session.menu.item         (list: SESSION menu rows)
sidebar.workspaces.session.row.action        (list: SESSION hover buttons)
workspace.toast                              (chain/factory: archive notice presentation)
```
Not one of these is a workspace-row menu or workspace-row action.

## Consequences (these are the load-bearing conclusions)

1. **A clean thin plugin that "adds one menu row" is impossible.** Not a matter of finding the right
   API — the slot does not exist in any of the 305 packages.
2. **The only sanctioned override of the whole browser is shadowing the `single` `sidebar.workspaces`
   entry at a lower `priority`** (verified: renderer takes `entriesOfSlot(key)[0]`, entries sort
   ascending by priority, and `register()` throws on a same-priority duplicate with the message
   "register at a different priority to shadow it (lowest renders)").
   Practical consequence: a full re-implementation of a 232 KB browser, i.e. a fork.
3. **`sidebar.panellist` is the only clean, no-fork way to add workspace UI** — but it adds a *panel*,
   it does not remove rows from the existing list. It does not satisfy "hide workspaces in place".
4. The **filter choke point stays the recommendation**: `groupByWorkspace()` iterates the `workspaces`
   array once (`for (const workspace of workspaces)`) and is fed solely by
   `storedWorkspaces = useWorkspaces((s) => s.items)`. Any fork-side filter belongs exactly there.
5. **Do not attempt to re-provide the root `workspaces` hook**: `ctx.slots.provideRoot({hooks:{workspaces}})`
   is merged by `rebuildRootBinding()` → `copyUnique()`, which **throws**
   `duplicate root standard hook '<name>'`. So the hook cannot be wrapped, only the whole slot replaced.
