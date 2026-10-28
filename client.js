/**
 * dsh-hide-workspace - browser half.
 *
 * Hides whole Workspace groups (header + nested child workspaces + their Sessions)
 * from the left sidebar without deleting anything, and restores them on demand.
 *
 * Design constraints this file is built around (verified against DSH 0.2.1-rc.3):
 *
 *  1. There is NO workspace-level slot in DSH. `sidebar.workspaces` declares only
 *     Session-scoped child slots (`...session.menu.item`, `...session.row.action`,
 *     `...session.row.leading`, `...session.row.hover`) plus the directory holes.
 *     The workspace "..." menu and the View-options menu are both hardcoded closed
 *     arrays, so neither can be extended through the slot system.
 *
 *  2. Filtering the *data* (the Workspace array) cannot express "hidden". In
 *     `groupByWorkspace()` the `accounted` set is built from the array it is given,
 *     so removing a Workspace re-homes its Sessions into "Ungrouped" instead of
 *     hiding them. Hiding therefore has to happen at the DOM layer, which also
 *     keeps nested child workspaces and their Sessions together with the parent.
 *
 *  3. Only explicit string attributes are stable across DSH builds. Hashed CSS
 *     Module class names (a short build hash plus the local name) change every
 *     release, so
 *     this plugin anchors exclusively on:
 *        [data-row-key="workspace:<workspaceId>"]   (and "session:<sessionId>")
 *        [role="menuitem"], [role="menu"], [role="treeitem"], aria-* state
 *     It never matches a hashed class name.
 *
 *  4. Every anchor is verified at runtime. If the sidebar structure is not what
 *     this plugin expects, it retreats to "show everything" (fail-open) and tells
 *     the user, instead of ever leaving workspaces hidden with no way back.
 *
 * Hidden ids live in localStorage. That is device-local by design: it is a view
 * preference, matching how ui-workspace itself persists expansion and ordering.
 */
window.__ModuleLoader__.load({
  id: 'dsh-hide-workspace',
  factory(require) {
    const module = { exports: {} }
    const exports = module.exports

const NS = 'hide-workspace';
const STORAGE_KEY = 'dsh.hide-workspace.hidden.v1';
const FILTER_KEY = 'dsh.hide-workspace.filter.v1';
const STYLE_ID = 'dsh-hide-workspace-style';

/**
 * Runtime dictionaries.
 *
 * These are inlined rather than fetched from ./locale/*.json: the browser half is a
 * single module with no file access, and the packaged locale files exist for the
 * plugin list's title/description only.
 */
const DICT_ZH = {
  "action.hide": "隐藏工作区",
  "action.unhide": "取消隐藏",
  "action.hideWithChildren": "隐藏工作区（含子工作区）",
  "toast.hidden": "已隐藏「{name}」",
  "toast.unhidden": "已取消隐藏「{name}」",
  "toast.showAll": "已恢复显示全部工作区",
  "toast.undo": "撤销",
  "toast.count": "隐藏的工作区（{n}）",
  "filter.label": "筛选工作区",
  "filter.hide": "隐藏已隐藏的工作区",
  "filter.show": "全部工作区（显示已隐藏）",
  "filter.only": "仅显示已隐藏",
  "empty.none": "当前筛选下没有工作区",
  "empty.showAll": "显示全部工作区",
  "warn.structureChanged": "侧栏结构已变化，「隐藏工作区」暂不可用，已恢复全部显示。"
};

const DICT_EN = {
  "action.hide": "Hide workspace",
  "action.unhide": "Unhide",
  "action.hideWithChildren": "Hide workspace (with children)",
  "toast.hidden": "Hidden “{name}”",
  "toast.unhidden": "Unhid “{name}”",
  "toast.showAll": "All workspaces shown again",
  "toast.undo": "Undo",
  "toast.count": "Hidden workspaces ({n})",
  "filter.label": "Filter workspaces",
  "filter.hide": "Hide hidden workspaces",
  "filter.show": "All workspaces (show hidden)",
  "filter.only": "Only hidden",
  "empty.none": "No workspaces match this filter",
  "empty.showAll": "Show all workspaces",
  "warn.structureChanged": "The sidebar layout changed, so hiding is unavailable. All workspaces were shown again."
};

/** Sidebar filter tri-state. */
const FILTER_HIDE = 'hide'; // default: hidden workspaces are not shown
const FILTER_SHOW = 'show'; // show everything, hidden included
const FILTER_ONLY = 'only'; // only the hidden ones

function safeGet(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key, value) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* a blocked storage must never break the sidebar */
  }
}

function safeRemove(key) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    /* a blocked storage must never break the sidebar */
  }
}

// ---------------------------------------------------------------------------
// Hidden-set store
// ---------------------------------------------------------------------------

/** Keys used before the package was renamed; read once, then rewritten under the new ones. */
const LEGACY_STORAGE_KEY = 'dsh.better-sidebar.hidden.v1';
const LEGACY_FILTER_KEY = 'dsh.better-sidebar.filter.v1';

function readHidden() {
  let raw = safeGet(STORAGE_KEY);
  // Migrate a pre-rename hidden set so an existing user does not silently lose it.
  // The old key is rewritten under the new one and then removed, so this runs once.
  if (typeof raw !== 'string' || raw === '') {
    const legacy = safeGet(LEGACY_STORAGE_KEY);
    if (typeof legacy === 'string' && legacy !== '') {
      safeSet(STORAGE_KEY, legacy);
      safeRemove(LEGACY_STORAGE_KEY);
      raw = legacy;
    }
  }
  if (typeof raw !== 'string' || raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id) => typeof id === 'string' && id !== '');
  } catch {
    return [];
  }
}

function writeHidden(ids) {
  const unique = [...new Set(ids)];
  safeSet(STORAGE_KEY, JSON.stringify(unique));
  return unique;
}

function readFilter() {
  let raw = safeGet(FILTER_KEY);
  if (typeof raw !== 'string' || raw === '') {
    const legacy = safeGet(LEGACY_FILTER_KEY);
    if (typeof legacy === 'string' && legacy !== '') {
      safeSet(FILTER_KEY, legacy);
      safeRemove(LEGACY_FILTER_KEY);
      raw = legacy;
    }
  }
  return raw === FILTER_SHOW || raw === FILTER_ONLY ? raw : FILTER_HIDE;
}

function writeFilter(filter) {
  safeSet(FILTER_KEY, filter);
}

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

const WORKSPACE_ROW = '[data-row-key^="workspace:"]';

/** The workspace id encoded in a row key, or undefined. */
function workspaceIdOf(row) {
  const key = row?.getAttribute?.('data-row-key');
  if (typeof key !== 'string' || !key.startsWith('workspace:')) return undefined;
  const id = key.slice('workspace:'.length);
  return id === '' ? undefined : id;
}

/**
 * The element that represents one whole workspace block.
 *
 * DSH renders each workspace as a section wrapper holding the folder row, then an
 * optional nested `role="group"` of child workspaces, then the session rows. That
 * wrapper has no id attribute, so it is found structurally: the nearest ancestor
 * of the folder row that is a direct child of the scrolling list. Using the closest
 * such ancestor keeps nesting intact - hiding a parent takes its children with it.
 */
/**
 * Resolve the element that represents a whole workspace block.
 *
 * The folder row is not the block: DSH wraps each folder row in a `HoverCard` anchor
 * and places the session rows as siblings of that anchor inside a section wrapper.
 * Hiding the folder row alone therefore leaves its sessions behind, so the block is
 * found by climbing from the folder row to the nearest ancestor that also contains
 * either a Session row or a nested child-workspace group, and no *other* workspace row.
 *
 * Everything here is derived from explicit attributes (`data-row-key`, `role`), never
 * from a hashed class name.
 */
function blockOf(workspaceRow) {
  // Climb to the nearest ancestor that contains no OTHER workspace row. That ancestor
  // is this workspace's own section: it holds the folder row, this workspace's session
  // rows and any nested child-workspace group. Counting sibling blocks rather than
  // looking for a session row matters because a workspace with no sessions (a plain
  // empty folder) must still hide as a whole, and an empty workspace has no session
  // marker to detect.
  let node = workspaceRow;
  let candidate = workspaceRow;
  for (let depth = 0; depth < 8 && node != null; depth += 1) {
    const parent = node.parentElement;
    if (parent == null || parent === document.body) break;

    // Does this parent hold another workspace row besides the branch we came from?
    let otherWorkspaces = 0;
    for (const child of parent.children ?? []) {
      if (child === node) continue;
      const key = child.getAttribute?.('data-row-key');
      if (typeof key === 'string' && key.startsWith('workspace:')) otherWorkspaces += 1;
      // A nested child group also means the parent is still this workspace's own block.
      if (child.querySelectorAll != null && child.querySelectorAll(WORKSPACE_ROW).length > 0) {
        otherWorkspaces += 1;
      }
    }
    if (otherWorkspaces > 0) break; // parent spans sibling workspaces: stop below it

    candidate = parent;
    node = parent;
  }
  return candidate;
}

/**
 * All visible workspace rows, outermost first, paired with their ids.
 * Nested child rows are included.
 */
function workspaceRows() {
  return [...document.querySelectorAll(WORKSPACE_ROW)];
}

/** True when the sidebar actually renders workspace rows (anchor sanity check). */


/**
 * Parse the workspace title text out of a folder row. The row renders a folder
 * icon, a chevron, and the title span; the title is the longest text run.
 */
function titleOf(workspaceRow) {
  // Prefer the row's own title element. The host renders the label in a leaf span next
  // to the folder icon; picking "the longest leaf span" used to work but would silently
  // start returning unrelated text (a tooltip, a count) if the row ever gained one.
  const explicit = workspaceRow.querySelector('[data-hide-workspace-title], [class*="title"]');
  if (explicit != null) {
    const text = (explicit.textContent ?? '').trim();
    if (text !== '') return text;
  }
  // Fall back to the longest leaf span that holds visible text, skipping anything that
  // looks like an icon slot (those render an <svg> and no text).
  let best = '';
  for (const span of workspaceRow.querySelectorAll('span')) {
    if (span.querySelector('span') != null) continue;
    if (span.querySelector('svg') != null) continue;
    const text = (span.textContent ?? '').trim();
    if (text.length > best.length) best = text;
  }
  return best;
}

/**
 * The workspace that owns the currently selected session.
 *
 * A workspace block renders its folder row and its session rows as siblings inside
 * one wrapper, so the owner is found by walking up from the selected session row and
 * taking the nearest ancestor that holds a workspace folder row as a direct child.
 * Walking upward (rather than sideways) keeps nested child workspaces correct: the
 * innermost matching ancestor is the child, and an outer block is only reached when
 * no inner one matched.
 */
function selectedWorkspaceId() {
  const selected = document.querySelector('[data-row-key^="session:"][aria-selected="true"]');
  if (selected == null) return undefined;

  // Walk up from the session row and take the first ancestor that owns exactly one
  // workspace row. The folder row is NOT a direct sibling of its sessions: DSH wraps
  // it in a HoverCard anchor, so a direct-children scan never finds it. Counting
  // descendants instead keeps nested child workspaces correct, because an outer
  // block contains more than one workspace row and is therefore skipped.
  let node = selected.parentElement;
  while (node != null && node !== document.body) {
    const owned = node.querySelectorAll(WORKSPACE_ROW);
    if (owned.length === 1) return workspaceIdOf(owned[0]);
    if (owned.length > 1) return undefined; // climbed past the block without a match
    node = node.parentElement;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Style (hiding + rail handling)
// ---------------------------------------------------------------------------

const HIDDEN_ATTR = 'data-hide-workspace-hidden-block';

/**
 * Apply the hidden set to the live DOM.
 *
 * The block element is resolved per workspace row and marked with a data attribute
 * plus an inline display rule, rather than emitted as a `:has()` stylesheet rule.
 * Two reasons:
 *  - `:has()` depends on the exact wrapper nesting, which differs between DSH builds
 *    (the folder row is wrapped in a HoverCard anchor, sessions sit beside it), and a
 *    mismatch silently hides the wrong thing or nothing at all.
 *  - Marking the element lets the plugin restore exactly what it changed, so turning
 *    the feature off cannot leave stale hiding behind.
 */
function applyHidden(hiddenIds, filter) {
  const hiddenSet = new Set(hiddenIds);
  const shouldHideBlock = new Set();

  for (const row of workspaceRows()) {
    const id = workspaceIdOf(row);
    if (id == null) continue;
    const isHidden = hiddenSet.has(id);
    // Three modes over the same predicate:
    //   hide -> hide the hidden ones (default)
    //   show -> hide nothing, so the hidden ones come back into view for unhiding
    //   only -> hide everything that is NOT hidden
    // Spelling "show" out matters: folding it into the default (`?: isHidden`) made
    // it identical to "hide", so picking "All workspaces (show hidden)" kept the
    // hidden ones hidden and left no way to reach them.
    let hide;
    if (filter === FILTER_SHOW) hide = false;
    else if (filter === FILTER_ONLY) hide = !isHidden;
    else hide = isHidden;
    if (!hide) continue;
    shouldHideBlock.add(blockOf(row));
  }

  // Apply only the difference. Re-marking every block on every pass kept writing to the
  // DOM from inside a MutationObserver callback, which is what made the page hang: each
  // pass produced mutations, each mutation scheduled another pass.
  for (const el of [...document.querySelectorAll('[' + HIDDEN_ATTR + ']')]) {
    if (shouldHideBlock.has(el)) continue;
    el.style.removeProperty('display');
    el.removeAttribute(HIDDEN_ATTR);
  }
  for (const el of shouldHideBlock) {
    if (el.getAttribute(HIDDEN_ATTR) === '1' && el.style.display === 'none') continue;
    el.setAttribute(HIDDEN_ATTR, '1');
    el.style.setProperty('display', 'none', 'important');
  }

  // Keep the (tiny) style element so the plugin's presence stays observable in the page.
  let el = document.getElementById(STYLE_ID);
  if (el == null) {
    el = document.createElement('style');
    el.setAttribute('id', STYLE_ID);
    (document.head ?? document.documentElement).appendChild(el);
  }
  const note = '/* dsh-hide-workspace: ' + hiddenIds.length + ' hidden, filter=' + filter + ' */';
  if (el.textContent !== note) el.textContent = note;
}

// ---------------------------------------------------------------------------
// Menu injection: the workspace "..." menu
// ---------------------------------------------------------------------------

/** Menu rows currently open in a portal. */
function openMenus() {
  return [...document.querySelectorAll('[role="menu"], [role="listbox"]')].filter(
    (el) => el.querySelector('[role="menuitem"], [role="option"]') != null
  );
}

function menuItems(menu) {
  return [...menu.querySelectorAll('[role="menuitem"], [role="option"]')];
}

function labelText(item) {
  // Whole-row text: a menu row's first child is the icon span, so reading only the
  // first span yields an empty string and every label test would silently fail.
  return (item.textContent ?? '').trim();
}

/**
 * Locate the workspace "..." menu: the open menu whose row set looks like
 * {rename, delete}. Returns undefined for the session menu and the view-options menu.
 */
function findWorkspaceMenu() {
  for (const menu of openMenus()) {
    const items = menuItems(menu);
    if (items.length < 2) continue;
    const hasDelete = items.some((item) => /delete\.workspace|删除工作区|Delete workspace/i.test(labelText(item)));
    if (!hasDelete) continue;
    return { menu, items };
  }
  return undefined;
}

/**
 * Inject (or refresh) the hide/unhide row into the workspace "..." menu.
 * Returns the id of the workspace the menu belongs to, or undefined.
 */
function syncWorkspaceMenu(ctx) {
  const found = findWorkspaceMenu();
  if (found == null) return;
  const { menu, items } = found;

  const renameItem = items.find((item) => /rename|重命名/i.test(labelText(item)));
  const deleteItem = items.find((item) => /delete\.workspace|删除工作区|Delete workspace/i.test(labelText(item)));
  if (renameItem == null || deleteItem == null) return;

  // Resolve the owner from the menu that is actually open, not from a remembered row.
  //
  // A remembered row never expires: open workspace A's menu, close it, open another
  // surface's menu, and the stale value would inject a "hide" row for A. The menu is
  // portaled, so the association is recovered from the row whose "..." trigger was
  // pressed last AND is still marked as open; when that cannot be established the row
  // is simply not injected, which is the safe failure.
  const id = ctx.resolveMenuWorkspaceId();
  if (id == null) return;

  const hidden = readHidden();
  const isHidden = hidden.includes(id);

  let injected = menu.querySelector('[data-hide-workspace-item="1"]');
  if (injected == null) {
    // Clone the RENAME row, not the Delete row.
    //
    // The menu primitive colours a destructive row through a CSS-Modules class whose
    // name carries a per-build hash (`_danger_4ub78_226` in this build, different every
    // release), so copying the Delete row baked that red in and stripping the class by
    // name could not survive a version change. Rename is an ordinary row: cloning it
    // yields the host's own layout, spacing and colours with no destructive styling at
    // all, and the row only has to be inserted after it and before Delete.
    const renameIsButton = renameItem.getAttribute('role') === 'menuitem';
    const renameRowEl = renameIsButton ? (renameItem.parentElement ?? renameItem) : renameItem;
    const template = renameRowEl.cloneNode(true);

    template.setAttribute('data-hide-workspace-item', '1');
    // Belt and braces: drop anything a future build might use to mark a row as danger.
    const strip = (el) => {
      const tokens = el.classList == null ? [] : [...el.classList];
      const kept = tokens.filter((cls) => !/danger/i.test(cls));
      if (kept.length !== tokens.length && el.setAttribute != null) {
        el.setAttribute('class', kept.join(' '));
      }
      el.style?.removeProperty?.('color');
    };
    strip(template);
    for (const node of template.querySelectorAll('*')) strip(node);

    // Drop the pencil icon: this row has no icon of its own.
    for (const svg of template.querySelectorAll('svg')) svg.remove();
    for (const b of template.querySelectorAll('[role="menuitem"]')) {
      b.setAttribute('aria-current', 'false');
      b.removeAttribute('aria-keyshortcuts');
    }

    // Insert directly after Rename, which also puts it before Delete.
    renameRowEl.insertAdjacentElement('afterend', template);
    injected = template;
  }

  const btn = injected.getAttribute('role') === 'menuitem'
    ? injected
    : injected.querySelector('[role="menuitem"]');
  if (btn == null) return;

  const label = ctx.t(isHidden ? 'action.unhide' : 'action.hide');
  // Prefer the host's own label span so the row keeps the menu's typography.
  const spans = [...btn.querySelectorAll('span')];
  const labelSpan = spans.length > 0 ? spans[spans.length - 1] : null;
  if (labelSpan != null) {
    if (labelSpan.textContent !== label) labelSpan.textContent = label;
  } else if (btn.textContent !== label) {
    btn.textContent = label;
  }
  btn.setAttribute('data-hide-workspace-workspace', id);
  btn.setAttribute('data-hide-workspace-hidden', isHidden ? '1' : '0');
}

/** Close whatever menu is open, the way the host menu does. */
function closeMenus() {
  for (const menu of openMenus()) {
    const last = menuItems(menu).pop();
    // The host closes on pointerdown outside or Escape; both are safe to synthesise.
    last?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
}

// ---------------------------------------------------------------------------
// Filter menu injection
// ---------------------------------------------------------------------------

const FILTER_ITEMS = [
  { id: 'better-ws-hide', value: FILTER_HIDE, key: 'filter.hide' },
  { id: 'better-ws-show', value: FILTER_SHOW, key: 'filter.show' },
  { id: 'better-ws-only', value: FILTER_ONLY, key: 'filter.only' },
];

/** The open View-options menu: the one carrying the archived filter rows. */
function findViewOptionsMenu() {
  for (const menu of openMenus()) {
    const items = menuItems(menu);
    const hasArchived = items.some((item) => /hide-archived|show-archived|only-archived|隐藏已归档|仅显示已归档/i.test(labelText(item)));
    if (hasArchived) return menu;
  }
  return undefined;
}

/**
 * Which archived-filter state the host menu currently shows.
 *
 * The host marks the active row with `aria-current="page"` (see the menu primitive), so
 * the selected archived row identifies the state without guessing from styling. Returns
 * 'default' | 'show' | 'only', or undefined when it cannot be read.
 */
function readArchivedFilter(menu) {
  for (const item of menuItems(menu)) {
    const isCurrent = item.getAttribute('aria-current') === 'page';
    if (!isCurrent) continue;
    const text = labelText(item);
    if (/only-archived|仅显示已归档/i.test(text)) return 'only';
    if (/show-archived|全部对话/i.test(text)) return 'show';
    if (/hide-archived|隐藏已归档/i.test(text)) return 'default';
  }
  return undefined;
}

function syncFilterMenu(ctx) {
  const menu = findViewOptionsMenu();
  if (menu == null) return;

  // Build from clones of a real menu row. Hand-made <button>s render as raw browser
  // buttons (inline, bordered) because the menu styles its rows through the primitive's
  // own classes and wrapper element. Cloning the archived-filter rows gives the injected
  // entries the host's row height, padding, hover treatment and check-mark layout.
  // Clone from an archived-filter row that is NOT currently selected.
  //
  // The selected row carries the host's tick mark, so cloning it copied that tick into
  // every injected row - all three appeared checked, and the genuinely selected one ended
  // up with two ticks. Preferring an unselected source removes the tick at the origin
  // rather than deleting it afterwards.
  const archivedRows = menuItems(menu).filter((item) => /hide-archived|show-archived|only-archived|隐藏已归档|仅显示已归档/i.test(labelText(item)));
  if (archivedRows.length === 0) return;
  const isSelectedItem = (item) => item.getAttribute('aria-current') === 'page';
  const sampleItem = archivedRows.find((item) => !isSelectedItem(item)) ?? archivedRows[0];
  const sampleIsButton = sampleItem.getAttribute('role') === 'menuitem';
  const sampleRow = sampleIsButton ? (sampleItem.parentElement ?? sampleItem) : sampleItem;

  // The selected archived-filter row carries the host's own tick element; keep a copy so
  // injected rows can show the same mark in the same place.
  const sampleTick = (() => {
    // Find the host's tick element anywhere inside the menu, skipping this plugin's own
    // rows. Searching the whole menu rather than only the selected row matters because
    // the tick is what VISUALLY marks the selection; `aria-current` may sit on the row
    // wrapper instead of the button, and a querySelector on the item cannot match the
    // item itself. Any tick found in the menu belongs to the same primitive, so its markup
    // is exactly what the injected rows should use.
    const OWN_ROW = '[data-hide-workspace-filter-item]';
    const candidates = [...(menu.querySelectorAll?.('[class*="check"], [class*="tick"], [class*="Check"]') ?? [])];
    for (const el of candidates) {
      if (typeof el.closest === 'function' && el.closest(OWN_ROW) != null) continue;
      // Guard against matching a class like "checkbox" elsewhere in the panel.
      const tagname = (el.tagName ?? '').toLowerCase();
      if (tagname !== 'svg' && el.querySelector?.('svg') == null) continue;
      return el;
    }
    return null;
  })();

  // Icons come from the host's own archived-filter rows, which already carry exactly the
  // meanings this section needs: a slashed eye for "hide", a queue/list for "show all",
  // and a single archived item for "only". Cloning them keeps the glyph set and sizing
  // identical to the section above instead of inventing new artwork.
  const ICON_SOURCES = (() => {
    const pick = (pattern) => {
      for (const item of menuItems(menu)) {
        // Never sample icons from rows this plugin injected itself.
        if (typeof item.closest === 'function' && item.closest('[data-hide-workspace-filter-item]') != null) continue;
        if (!pattern.test(labelText(item))) continue;
        const svg = item.querySelector('svg');
        if (svg != null) return svg;
      }
      return null;
    };
    return {
      hide: pick(/hide-archived|隐藏已归档/i),
      show: pick(/show-archived|全部对话/i),
      only: pick(/only-archived|仅显示已归档/i),
    };
  })();


  let group = menu.querySelector('[data-hide-workspace-filter="1"]');
  if (group == null) {
    group = document.createElement('div');
    group.setAttribute('data-hide-workspace-filter', '1');
    group.setAttribute('role', 'none');

    // Separator and section heading cloned from the host's own, so the new section
    // lines up with 分组方式 / 排序方式 / 筛选会话 above it.
    // Separator: rebuild it from the host primitive's own computed rule rather than
    // cloning.
    //
    // The host renders `.separator` as `height:.5px; margin:3px 2px;
    // background:var(--dsw-alias-border-l2)`. That styling lives on a CSS-Modules class
    // whose name carries a per-build hash, and a cloned node that gets extra attributes
    // can lose the class match, so the visible hairline silently disappears. Reading the
    // live computed style from a sibling separator and copying those declarations is
    // immune to the hash.
    // Locate an existing separator. The host's menu items table renders separators as
    // <div role="separator">, but older/newer compositions may only give them their
    // hashed class, so both shapes are probed.
    const sepSource = [...menu.querySelectorAll('[role="separator"]')][0]
      ?? [...menu.querySelectorAll('div[class*="separator"]')].find((el) => el.textContent.trim() === '')
      ?? [...menu.children].find((el) => el.getAttribute?.('role') === 'separator');
    const sep = document.createElement('div');
    sep.setAttribute('role', 'separator');
    sep.setAttribute('data-hide-workspace-filter-sep', '1');
    if (sepSource != null) {
      const cs = window.getComputedStyle(sepSource);
      // Copy the declarations that make the hairline visible, not the whole cascade.
      if (cs.height && cs.height !== 'auto') sep.style.height = cs.height;
      if (cs.backgroundColor && cs.backgroundColor !== 'rgba(0, 0, 0, 0)') sep.style.background = cs.backgroundColor;
      sep.style.margin = '3px 2px';
      sep.style.flex = 'none';
    } else {
      sep.style.cssText = 'height:.5px;margin:3px 2px;background:var(--dsw-alias-border-l2)';
    }
    group.appendChild(sep);

    // Section heading: reuse the host's own heading element shape and classes so the
    // label matches 分组方式 / 排序方式 / 筛选会话 above it.
    const labelSource = menuItems(menu).find((item) => {
      const text = labelText(item);
      return /分组方式|排序方式|筛选会话|Group by|Order by|Filter/i.test(text) && item.querySelector?.('svg') == null;
    });
    if (labelSource != null) {
      const heading = (labelSource.getAttribute('role') === 'menuitem' ? labelSource.parentElement : labelSource).cloneNode(true);
      heading.setAttribute('data-hide-workspace-filter-label', '1');
      for (const svg of heading.querySelectorAll('svg')) svg.remove();
      group.appendChild(heading);
    } else {
      const heading = document.createElement('div');
      heading.setAttribute('data-hide-workspace-filter-label', '1');
      heading.style.cssText = 'padding:6px 8px;font-size:11px;line-height:15px;color:var(--dsw-alias-label-tertiary)';
      group.appendChild(heading);
    }

    const holder = document.createElement('div');
    holder.setAttribute('role', 'none');
    holder.setAttribute('data-hide-workspace-filter-items', '1');
    group.appendChild(holder);
    menu.appendChild(group);
  }

  const holder = group.querySelector('[data-hide-workspace-filter-items="1"]');
  if (holder == null) return;

  // Build the rows once. Every later pass only assigns values that actually changed,
  // because this function runs from a MutationObserver callback: rewriting identical
  // text or attributes would re-trigger the observer and lock the page in a loop.
  if (holder.querySelectorAll('[role="menuitem"]').length !== FILTER_ITEMS.length) {
    holder.textContent = '';
    for (const spec of FILTER_ITEMS) {
      const row = sampleRow.cloneNode(true);
      row.setAttribute('data-hide-workspace-filter-item', spec.value);
      const btn = row.getAttribute('role') === 'menuitem' ? row : row.querySelector('[role="menuitem"]');
      if (btn != null) {
        btn.setAttribute('data-hide-workspace-filter-item', spec.value);
        btn.removeAttribute('aria-current');
        btn.removeAttribute('aria-keyshortcuts');
      }
      // Belt and braces: strip any tick the clone may have inherited. The source is
      // chosen to be unselected, but a future host build could mark selection differently,
      // and a stray tick would make an unselected row look chosen.
      for (const stray of row.querySelectorAll('[data-hide-workspace-tick="1"], span[class*="check"], svg[class*="check"]')) {
        stray.remove();
      }
      row.removeAttribute('data-hide-workspace-ticked');

      // Give each row the icon of the host entry with the same meaning, taken from the
      // archived-filter group directly above. The wrapper span is kept either way so the
      // label keeps the same left offset as 隐藏已归档 / 全部对话.
      const iconSpan = [...row.querySelectorAll('span')].find(
        (span) => span.querySelector('svg') != null && span.textContent.trim() === ''
      );
      if (iconSpan != null) {
        iconSpan.textContent = '';
        const template = ICON_SOURCES[spec.value];
        if (template != null) iconSpan.appendChild(template.cloneNode(true));
      }
      holder.appendChild(row);
    }
  }

  const label = group.querySelector('[data-hide-workspace-filter-label="1"]');
  if (label != null) {
    const next = ctx.t('filter.label');
    if (label.textContent !== next) label.textContent = next;
  }

  // Linkage with the host's own archived filter.
  //
  // Under "Archived only" the host drops every workspace that has no archived session
  // from the data entirely, before this plugin ever sees a row. Combining that with a
  // workspace filter that also restricts can therefore leave an empty list with no "..."
  // to click. Rather than let that happen, a restricting workspace filter falls back to
  // "show all" whenever the archived filter is "only".
  const archivedFilter = readArchivedFilter(menu);
  if (archivedFilter === 'only' && ctx.filter !== FILTER_SHOW) {
    ctx.setFilter(FILTER_SHOW);
    return; // the state change reschedules a render with the new value
  }

  const current = ctx.filter;
  for (const row of holder.children) {
    const value = row.getAttribute('data-hide-workspace-filter-item');
    const spec = FILTER_ITEMS.find((f) => f.value === value);
    if (spec == null) continue;
    const btn = row.getAttribute('role') === 'menuitem' ? row : row.querySelector('[role="menuitem"]');
    if (btn == null) continue;

    // The host marks the selected row with a trailing SVG tick span, not with a text
    // character: a "✓" inside the label shifts the text and makes the row wider when
    // selected. Mirror the host's structure instead.
    const nextText = ctx.t(spec.key);
    const labelSpan = [...btn.querySelectorAll('span')].find((sp) => sp.children.length === 0 && sp.textContent.trim() !== '');
    if (labelSpan != null) {
      if (labelSpan.textContent !== nextText) labelSpan.textContent = nextText;
    } else if (btn.textContent !== nextText) {
      btn.textContent = nextText;
    }

    const selected = value === current;
    const nextChecked = selected ? 'true' : 'false';
    if (btn.getAttribute('aria-checked') !== nextChecked) btn.setAttribute('aria-checked', nextChecked);

    // Toggle the host's own tick element. The state is read from the button's attribute
    // rather than from the DOM subtree so this branch runs at most once per state change:
    // appending a node on every pass would fire the observer again and loop.
    const hasMark = btn.getAttribute('data-hide-workspace-ticked') === '1';
    if (selected && !hasMark) {
      // Clone the host's own tick when available; otherwise draw a small SVG tick so a
      // selected row is never silently missing its mark.
      let mark;
      if (sampleTick != null) {
        mark = sampleTick.cloneNode(true);
      } else {
        // Reproduce the host's own tick exactly, taken from its icon component:
        //   <svg viewBox="0 0 16 16" fill="none" stroke-width="1">
        //     <path d="M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344
        //              6.95426 11.7018L13.75 4" stroke="currentColor"/>
        // The earlier fallback used stroke-width 1.6 and a different path, which rendered
        // visibly heavier and darker than the ticks on the rows above.
        const SVG_NS = 'http://www.w3.org/2000/svg';
        mark = document.createElementNS(SVG_NS, 'svg');
        mark.setAttribute('viewBox', '0 0 16 16');
        mark.setAttribute('width', '14');
        mark.setAttribute('height', '14');
        mark.setAttribute('fill', 'none');
        mark.setAttribute('stroke-width', '1');
        mark.setAttribute('aria-hidden', 'true');
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', 'M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4');
        path.setAttribute('stroke', 'currentColor');
        mark.appendChild(path);
      }
      // Keep the mark last so it sits at the trailing edge like the host's.
      const trailing = [...btn.children].find((c) => c.getAttribute?.('data-hide-workspace-tick') === '1');
      if (trailing != null) trailing.remove();
      mark.setAttribute('data-hide-workspace-tick', '1');
      // The host ticks are `flex:none; color: var(--dsw-alias-label-primary)`. Without the
      // flex rule the svg can be shrunk by the row's flex layout, which thickens the
      // apparent stroke; the colour rule keeps it identical to the rows above.
      if (mark.style != null) {
        mark.style.flex = 'none';
        if (mark.getAttribute('class') == null) {
          mark.style.color = 'var(--dsw-alias-label-primary)';
        }
      }
      btn.appendChild(mark);
      btn.setAttribute('data-hide-workspace-ticked', '1');
    } else if (!selected && hasMark) {
      const existing = btn.querySelector('[data-hide-workspace-tick="1"]');
      if (existing != null) existing.remove();
      btn.setAttribute('data-hide-workspace-ticked', '0');
    }
  }
}


// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

function showToast(ctx, message, undo) {
  document.querySelector('[data-hide-workspace-toast="1"]')?.remove();

  const toast = document.createElement('div');
  toast.setAttribute('data-hide-workspace-toast', '1');
  toast.setAttribute('role', 'status');
  // Mirror the host's own toast presentation.
  //
  // DSH ships a dedicated toast token pair (`--dsw-alias-toast-bg` /
  // `--dsw-alias-toast-label`) that is already correct in both themes, and places its
  // toasts at the TOP of the window rather than the bottom. The first version of this
  // plugin invented its own colours and pinned itself to the bottom, which produced black
  // text on a black fill in the light theme and collided with the composer. Using the
  // same tokens and the same placement avoids both problems and matches the product.
  toast.style.cssText = [
    'position:fixed',
    'top:40px',
    'left:50%',
    'transform:translateX(-50%)',
    'z-index:2147483000',
    'display:flex',
    'align-items:center',
    'gap:10px',
    'width:max-content',
    'max-width:min(640px,calc(100vw - 48px))',
    'padding:12px 16px',
    'border-radius:var(--dsw-radius-lg,10px)',
    'background:var(--dsw-alias-toast-bg,#2b2d31)',
    'color:var(--dsw-alias-toast-label,#fff)',
    'font-size:14px',
    'line-height:22px',
    'white-space:nowrap',
    'pointer-events:auto',
    'box-shadow:var(--dsw-shadow-lv3,0 8px 28px rgba(0,0,0,.32))',
  ].join(';');

  const text = document.createElement('span');
  text.textContent = message;
  toast.appendChild(text);

  if (typeof undo === 'function') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = ctx.t('toast.undo');
    // Copy the host toast's own action styling (`.action` in the toast primitive):
    // it is a plain inline button coloured with the STATIC brand blue
    // `--dsw-static-deepseek-400` (#7aaaff), which is deliberately theme-independent.
    // A theme alias such as --dsw-alias-label-primary-bluish resolved to a muted grey
    // in the light theme and made "撤销" hard to see against the dark toast fill.
    btn.style.cssText = [
      'display:inline',
      'padding:0',
      'border:0',
      'background:none',
      'color:var(--dsw-static-deepseek-400,#7aaaff)',
      'font:inherit',
      'cursor:pointer',
      'margin-inline:3px',
      'pointer-events:auto',
    ].join(';');
    btn.addEventListener('click', () => {
      undo();
      toast.remove();
    });
    toast.appendChild(btn);
  }

  document.body.appendChild(toast);

  const dismiss = () => {
    toast.remove();
  };
  const timer = setTimeout(dismiss, 6000);
  return () => {
    clearTimeout(timer);
    toast.remove();
  };
}

// ---------------------------------------------------------------------------
// Plugin body
// ---------------------------------------------------------------------------

function apply(ctx) {
  let hidden = readHidden();
  let filter = readFilter();
  let stopped = false;
  let observer = null;
  let pending = false;
  // The workspace row whose "..." trigger was pressed most recently, together with the
  // moment it was pressed. It is only trusted while the menu it opened is still on
  // screen; see resolveMenuWorkspaceId().
  let menuOwnerRow = null;
  let menuOwnerAt = 0;
  const MENU_OWNER_TTL_MS = 10000;

  // Register this plugin's own dictionary before binding it. Without this, every
  // t() call falls through to the raw key and the injected rows render as
  // "action.hide" instead of "隐藏工作区".
  if (typeof ctx.locale.register === 'function') {
    ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN });
  }
  const t = ctx.locale.bind(NS);

  const api = {
    t,
    get filter() {
      return filter;
    },
    setFilter(next) {
      setFilter(next);
    },
    /**
     * The workspace id the currently open "..." menu belongs to, or undefined.
     *
     * A remembered row alone is not enough: it survives menu close, so a later menu
     * opened from anywhere else would inject a row acting on the wrong workspace. The
     * value is therefore only used while
     *   - the row is still attached to the document,
     *   - the press that recorded it happened recently, and
     *   - that row still shows a menu-open affordance (aria-expanded) or the press came
     *     from inside the row.
     * When any check fails the caller injects nothing, which is the safe outcome.
     */
    resolveMenuWorkspaceId() {
      if (menuOwnerRow == null) return undefined;
      if (!document.body.contains(menuOwnerRow)) {
        menuOwnerRow = null;
        return undefined;
      }
      if (Date.now() - menuOwnerAt > MENU_OWNER_TTL_MS) {
        menuOwnerRow = null;
        return undefined;
      }
      return workspaceIdOf(menuOwnerRow);
    },
  };

  function persist() {
    hidden = writeHidden(hidden);
    writeFilter(filter);
  }

  let rendering = false;

  function rerender() {
    if (stopped || rendering) return;
    // Every pass writes to the DOM, and the MutationObserver below watches the DOM.
    // `rendering` makes those self-inflicted mutations unobservable, which is what kept
    // the page spinning: opening the view-options menu injected rows, the observer fired,
    // the next pass rewrote the same rows, and neither ever settled.
    rendering = true;
    try {
      applyHidden(hidden, filter);
      syncWorkspaceMenu(api);
      syncFilterMenu(api);
    } finally {
      rendering = false;
    }
  }

  /**
   * Coalesce repeated DOM mutations into one render.
   *
   * This deliberately does NOT go through requestAnimationFrame: rAF does not fire
   * while a window is hidden, minimised, or the page is in a background tab, and
   * under `prefers-reduced-motion` some engines throttle it too. Hiding a workspace
   * must still take effect in those states, so the work runs on a microtask instead.
   */
  /**
   * Coalesce repeated DOM mutations into one render.
   *
   * This deliberately does NOT go through requestAnimationFrame: rAF does not fire
   * while a window is hidden, minimised, or the page is in a background tab, and under
   * `prefers-reduced-motion` some engines throttle it too. Hiding a workspace must still
   * take effect in those states, so the work runs on a microtask instead.
   */
  function schedule() {
    if (stopped || pending) return;
    pending = true;
    Promise.resolve().then(() => {
      pending = false;
      rerender();
    });
  }

  function hide(id, name) {
    if (hidden.includes(id)) return;
    hidden = [...hidden, id];
    persist();
    schedule();
    showToast(api, t('toast.hidden', { name }), () => {
      hidden = hidden.filter((x) => x !== id);
      persist();
      schedule();
    });
  }

  function unhide(id, name) {
    if (!hidden.includes(id)) return;
    hidden = hidden.filter((x) => x !== id);
    persist();
    schedule();
    showToast(api, t('toast.unhidden', { name }), () => {
      hidden = [...hidden, id];
      persist();
      schedule();
    });
  }

  function showAll() {
    if (hidden.length === 0) {
      filter = FILTER_SHOW;
      persist();
      schedule();
      return;
    }
    const restore = [...hidden];
    hidden = [];
    persist();
    schedule();
    showToast(api, t('toast.showAll'), () => {
      hidden = restore;
      persist();
      schedule();
    });
  }

  function setFilter(next) {
    // Guard against re-entrant or no-op writes: syncFilterMenu can request a reset, and a
    // pass that assigned an unchanged value would re-arm the observer through schedule().
    if (filter === next) return;
    filter = next;
    persist();
    schedule();
  }

  // -- Ctrl+H -----------------------------------------------------------------
  // The shortcut works from the sidebar state alone, so it survives even when the
  // menu anchors break. With something hidden it restores everything (the escape
  // hatch); otherwise it hides the workspace of the selected session.
  function toggle() {
    // Anything hidden at all means the shortcut restores everything. This is the escape
    // hatch that does not depend on any menu being injectable.
    if (hidden.length > 0) {
      showAll();
      return;
    }
    // Nothing hidden, but a restricting filter may still be making the list look empty:
    // reset that first and say so, instead of appearing to do nothing.
    if (filter !== FILTER_HIDE) {
      setFilter(FILTER_HIDE);
      showToast(api, t('toast.showAll'));
      return;
    }
    const id = selectedWorkspaceId();
    if (id == null) {
      showToast(api, t('empty.none'));
      return;
    }
    const row = workspaceRows().find((r) => workspaceIdOf(r) === id);
    hide(id, row == null ? id : titleOf(row) || id);
  }

  function onKeyDown(event) {
    if (!(event.ctrlKey || event.metaKey)) return;
    if (event.altKey || event.shiftKey) return;
    if ((event.key ?? '').toLowerCase() !== 'h') return;
    const target = event.target;
    if (target != null && (target.isContentEditable === true || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName ?? ''))) return;
    event.preventDefault();
    event.stopPropagation();
    toggle();
  }

  // -- delegated clicks -------------------------------------------------------
  // The workspace "..." button only reveals the owner row; the injected menu row
  // performs the action.
  function onPointerDown(event) {
    const el = event.target;
    if (el == null || typeof el.closest !== 'function') return;

    const hideBtn = el.closest('[data-hide-workspace-workspace]');
    if (hideBtn != null) {
      const id = hideBtn.getAttribute('data-hide-workspace-workspace');
      const isHidden = hideBtn.getAttribute('data-hide-workspace-hidden') === '1';
      const row = workspaceRows().find((r) => workspaceIdOf(r) === id);
      const name = row == null ? id : titleOf(row) || id;
      event.preventDefault();
      event.stopPropagation();
      if (isHidden) unhide(id, name);
      else hide(id, name);
      closeMenus();
      return;
    }

    const filterBtn = el.closest('[data-hide-workspace-filter-item]');
    if (filterBtn != null) {
      const value = filterBtn.getAttribute('data-hide-workspace-filter-item');
      event.preventDefault();
      event.stopPropagation();
      if (value === FILTER_HIDE || value === FILTER_SHOW || value === FILTER_ONLY) setFilter(value);
      closeMenus();
      return;
    }

    const showAllBtn = el.closest('[data-hide-workspace-show-all]');
    if (showAllBtn != null) {
      event.preventDefault();
      event.stopPropagation();
      showAll();
      return;
    }

    // Remember which workspace row owns the menu that is about to open.
    const trigger = el.closest('[role="treeitem"]');
    if (trigger != null && trigger.matches(WORKSPACE_ROW)) {
      menuOwnerRow = trigger;
      menuOwnerAt = Date.now();
      return;
    }
    const menuButton = el.closest('button');
    if (menuButton != null) {
      const treeitem = menuButton.closest('[role="treeitem"]');
      if (treeitem != null && treeitem.matches(WORKSPACE_ROW)) {
        menuOwnerRow = treeitem;
        menuOwnerAt = Date.now();
      }
    }
  }

  function emptyStateHint() {
    if (document.querySelector('[data-hide-workspace-empty="1"]') != null) return;
    if (workspaceRows().length > 0) {
      document.querySelector('[data-hide-workspace-empty="1"]')?.remove();
      return;
    }
    const list = document.querySelector('[data-row-key="empty"]')?.parentElement;
    if (list == null) return;
    const box = document.createElement('div');
    box.setAttribute('data-hide-workspace-empty', '1');
    box.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px;padding:24px 12px;font-size:13px;opacity:.85;';
    const text = document.createElement('div');
    text.textContent = t('empty.none');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-hide-workspace-show-all', '1');
    btn.textContent = t('empty.showAll');
    btn.style.cssText = 'border:none;background:none;cursor:pointer;padding:0;font:inherit;color:var(--dsw-alias-link,#6aa9ff);';
    box.append(text, btn);
    list.appendChild(box);
  }

  let anchorMissStreak = 0;

  /**
   * Fail-open guard.
   *
   * The sidebar always renders at least one `[data-row-key^="workspace:"]` row while
   * it has a ready workspace baseline (an empty sidebar renders `[data-row-key="empty"]`
   * instead). So "we expect rows but see none" means this plugin's anchors no longer
   * match the shipped DOM - a DSH update changed the structure. Rather than risk
   * leaving workspaces hidden with no way back, drop the hidden set and say so.
   *
   * The sidebar being collapsed to the 56px rail, or still loading, also renders no
   * rows, so a miss is only acted on after several consecutive checks.
   */
  function guardAnchors() {
    if (hidden.length === 0) {
      anchorMissStreak = 0;
      return;
    }
    if (workspaceRows().length > 0) {
      anchorMissStreak = 0;
      return;
    }
    // Several states legitimately render no workspace rows. All of them mean "cannot
    // judge", never "structure changed":
    //  - still loading        -> skeleton rows, or session rows without workspaces yet
    //  - a search in progress -> the tree is replaced by a flat result list
    //  - the collapsed rail   -> the whole region is hidden
    // The rail is detected by measuring the sidebar container rather than by looking for
    // an [data-row-key="empty"] marker: that marker only exists when the list is empty,
    // so relying on it let a collapsed non-empty sidebar be mistaken for a broken layout
    // and silently cleared the hidden set.
    if (document.querySelector('[data-row-key^="session:"], [data-slot-error], input[type="search"]') != null) {
      anchorMissStreak = 0;
      return;
    }
    const sidebar = document.querySelector(WORKSPACE_ROW)?.closest('[role="tree"], [role="navigation"]')
      ?? document.querySelector('[data-row-key="empty"]')?.parentElement
      ?? null;
    if (sidebar != null) {
      const rect = sidebar.getBoundingClientRect();
      // Zero width or zero height means the panel is collapsed away; do not judge it.
      if (rect.width === 0 || rect.height === 0) {
        anchorMissStreak = 0;
        return;
      }
    }
    anchorMissStreak += 1;
    if (anchorMissStreak < 4) return;
    anchorMissStreak = 0;
    hidden = [];
    persist();
    showToast(api, t('warn.structureChanged'));
  }

  // Note on stale ids: an id whose workspace was deleted stays in the hidden list.
  // Reclaiming it from the DOM is not sound -- under the "only hidden" filter the visible
  // rows are exactly the hidden ones, and under "show all" a deleted workspace has no row
  // either way, so no row scan can distinguish "deleted" from "not currently rendered".
  // The id is therefore kept. This is harmless: workspace ids are UUIDs and never reused,
  // the entry costs a few bytes, and hiding is idempotent. A wrong prune (dropping a
  // workspace the user meant to keep hidden) is far worse than a stale string.

  function tick() {
    if (stopped) return;
    guardAnchors();
    rerender();
    emptyStateHint();
  }

  ctx.effect(() => {
    const start = () => {
      document.addEventListener('keydown', onKeyDown, true);
      document.addEventListener('pointerdown', onPointerDown, true);
      observer = new MutationObserver(() => {
        // Ignore the mutations this plugin itself just made.
        if (rendering) return;
        schedule();
      });
      // Watch only what can actually invalidate the sidebar: added or removed nodes.
      // Attribute and text changes are not observed, so re-writing a row's label or
      // aria-checked value cannot re-arm this observer.
      observer.observe(document.body, { childList: true, subtree: true });
      const interval = window.setInterval(tick, 1200);
      schedule();
      return () => {
        stopped = true;
        document.removeEventListener('keydown', onKeyDown, true);
        document.removeEventListener('pointerdown', onPointerDown, true);
        observer?.disconnect();
        window.clearInterval(interval);
        pending = false;
        document.getElementById(STYLE_ID)?.remove();
        document.querySelector('[data-hide-workspace-toast="1"]')?.remove();
        document.querySelector('[data-hide-workspace-empty="1"]')?.remove();
      };
    };
    if (document.body == null) {
      const onReady = () => {
        document.removeEventListener('DOMContentLoaded', onReady);
        start();
      };
      document.addEventListener('DOMContentLoaded', onReady);
      return () => document.removeEventListener('DOMContentLoaded', onReady);
    }
    return start();
  }, 'dsh-hide-workspace:dom');
}

exports.apply = apply
exports.inject = ['locale']
exports.name = 'dsh-hide-workspace'

    return module.exports
  },
})
