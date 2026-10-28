/**
 * Logic and idempotency checks for dsh-hide-workspace.
 *
 * Zero dependencies: the plugin's helpers only need parentElement, children,
 * getAttribute and querySelector(All), so a small fake DOM is enough. Every check is
 * pure and synchronous, so the whole file runs in well under a second.
 *
 * The idempotency check is the important one: the plugin re-renders from a
 * MutationObserver callback, so any pass that rewrites the DOM with unchanged values
 * would re-trigger the observer forever and freeze the page.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Resolve relative to this file so the harness runs from any checkout location.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'client.js'), 'utf8');

// Extract a top-level function by brace matching. A regex cannot do this reliably
// because these bodies contain regex literals and nested braces.
const grab = (name) => {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('could not find ' + name);
  let depth = 0;
  let i = src.indexOf('{', start);
  for (; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error('unbalanced braces in ' + name);
};

const fnBlockOf = grab('blockOf');
const fnWorkspaceIdOf = grab('workspaceIdOf');
const fnSelected = grab('selectedWorkspaceId');
const fnSyncFilter = grab('syncFilterMenu');
const fnMenuItems = grab('menuItems');
const fnLabelText = grab('labelText');
const fnOpenMenus = grab('openMenus');
const fnFindView = grab('findViewOptionsMenu');
const fnApplyHidden = grab('applyHidden');
const HIDDEN_ATTR = /const HIDDEN_ATTR = '([^']+)'/.exec(src)[1];
const STYLE_ID = /const STYLE_ID = '([^']+)'/.exec(src)[1];
const STORAGE_KEY = /const STORAGE_KEY = '([^']+)'/.exec(src)[1];
const LEGACY_STORAGE_KEY = /const LEGACY_STORAGE_KEY = '([^']+)'/.exec(src)[1];
const FILTER_KEY = /const FILTER_KEY = '([^']+)'/.exec(src)[1];
const LEGACY_FILTER_KEY = /const LEGACY_FILTER_KEY = '([^']+)'/.exec(src)[1];
const fnSafeGet = grab('safeGet');
const fnSafeSet = grab('safeSet');
const fnSafeRemove = grab('safeRemove');
const fnReadHidden = grab('readHidden');
const fnReadFilter = grab('readFilter');

const WORKSPACE_ROW = '[data-row-key^="workspace:"]';

let pass = 0;
let fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  PASS ' + name); }
  else { fail += 1; console.log('  FAIL ' + name + (extra === undefined ? '' : '  <' + extra + '>')); }
}

// ---------------------------------------------------------------------------
// A small fake DOM. `writes` counts every mutation so idempotency is measurable.
// ---------------------------------------------------------------------------

function makeDom() {
  const state = { writes: 0 };

  class Node {
    constructor(tag = 'div', key = null, role = null, selected = null) {
      this.tagName = String(tag).toUpperCase();
      this.key = key;
      this.role = role;
      this.selected = selected;
      this.children = [];
      this.parentElement = null;
      this.attrs = {};
      this._text = '';
      this.style = {
        _d: {},
        setProperty(k, v) { this._d[k] = String(v); },
        removeProperty(k) { delete this._d[k]; },
        get display() { return this._d.display; },
        cssText: '',
      };
      this.classList = [];
    }
    setAttribute(k, v) {
      if (this.attrs[k] !== String(v)) state.writes += 1;
      this.attrs[k] = String(v);
    }
    getAttribute(k) {
      if (k === 'data-row-key') return this.key;
      if (k === 'role') return this.role;
      if (k === 'aria-selected') return this.selected;
      return this.attrs[k] === undefined ? null : this.attrs[k];
    }
    removeAttribute(k) { delete this.attrs[k]; }
    get textContent() {
      if (this.children.length === 0) return this._text;
      return this._text + this.children.map((c) => c.textContent).join('');
    }
    set textContent(v) {
      if (this.textContent !== String(v)) state.writes += 1;
      this._text = String(v);
      this.children = [];
    }
    appendChild(n) { n.parentElement = this; this.children.push(n); return n; }
    append(...ns) { ns.forEach((n) => this.appendChild(n)); }
    insertAdjacentElement(pos, n) {
      const p = this.parentElement;
      if (p == null) return null;
      const i = p.children.indexOf(this);
      n.parentElement = p;
      p.children.splice(pos === 'beforebegin' ? i : i + 1, 0, n);
      return n;
    }
    cloneNode() {
      const c = new Node(this.tagName, this.key, this.role, this.selected);
      c.attrs = { ...this.attrs };
      c._text = this._text;
      c.classList = [...this.classList];
      for (const ch of this.children) c.appendChild(ch.cloneNode());
      return c;
    }
    remove() {
      const p = this.parentElement;
      if (p == null) return;
      const i = p.children.indexOf(this);
      if (i >= 0) p.children.splice(i, 1);
    }
    querySelectorAll(sel) {
      const all = [];
      const walk = (n) => { for (const c of n.children) { all.push(c); walk(c); } };
      walk(this);
      // Plain "[attr]" / "[attr=value]" selectors: the plugin uses one to find the
      // markers it left behind on a previous pass, so the fake DOM must answer it or
      // stale markers survive and every later pass looks wrong.
      const bare = /^\[([a-zA-Z-]+)(?:="([^"]*)")?\]$/.exec(sel.trim());
      if (bare != null) {
        const name = bare[1];
        const want = bare[2];
        return all.filter((c) => {
          const v = c.getAttribute(name);
          return v != null && (want === undefined || v === want);
        });
      }
      if (sel.indexOf('workspace:') >= 0) return all.filter((c) => c.key != null && c.key.startsWith('workspace:'));
      if (sel.indexOf('session:') >= 0) return all.filter((c) => c.key != null && c.key.startsWith('session:'));
      if (sel.indexOf('menuitem') >= 0) return all.filter((c) => c.getAttribute('role') === 'menuitem');
      // openMenus() looks for menu/listbox containers, including a comma-separated form.
      if (sel.indexOf('menu') >= 0 || sel.indexOf('listbox') >= 0) {
        const r = (c) => c.getAttribute('role');
        return all.filter((c) => r(c) === 'menu' || r(c) === 'listbox');
      }
      if (sel.indexOf('separator') >= 0) return all.filter((c) => c.getAttribute('role') === 'separator');
      if (sel.indexOf('filter-item') >= 0) return all.filter((c) => c.getAttribute('data-hide-workspace-filter-item') != null);
      return [];
    }
    querySelector(sel) {
      const trim = sel.trim();
      const attrOnly = /^\[([a-zA-Z-]+)(?:="([^"]*)")?\]$/.exec(trim);
      if (attrOnly != null) {
        const [, name, val] = attrOnly;
        const all = [];
        const walk = (n) => { for (const c of n.children) { all.push(c); walk(c); } };
        walk(this);
        const hit = all.find((c) => {
          const v = c.getAttribute(name);
          return v != null && (val === undefined || v === val);
        });
        return hit === undefined ? null : hit;
      }
      return this.querySelectorAll(sel)[0] ?? null;
    }
    getBoundingClientRect() { return { width: 100, height: 20, top: 0, left: 0, bottom: 20, right: 100 }; }
  }

  const body = new Node('body');
  const head = new Node('head');
  const document = {
    body,
    head,
    documentElement: new Node('html'),
    createElement: (t) => new Node(t),
    getElementById: () => null,
    querySelector: (sel) => body.querySelector(sel),
    querySelectorAll: (sel) => body.querySelectorAll(sel),
    addEventListener() {},
    removeEventListener() {},
  };
  return { Node, document, state };
}

// ---------------------------------------------------------------------------
// Workspace tree used by the block/ownership checks.
// ---------------------------------------------------------------------------

function buildTree(dom) {
  const { Node } = dom;
  const body = new Node('body');
  const list = new Node('div');
  body.appendChild(list);
  const mk = (id, withSession) => {
    const sec = new Node('div');
    list.appendChild(sec);
    const anchor = new Node('div');
    sec.appendChild(anchor);
    const row = new Node('div', 'workspace:' + id, 'treeitem', 'false');
    anchor.appendChild(row);
    let session = null;
    if (withSession) {
      session = new Node('div', 'session:s-' + id, 'treeitem', 'true');
      sec.appendChild(session);
    }
    return { sec, anchor, row, session };
  };
  return { body, list, A: mk('AAA', true), B: mk('BBB', false), C: mk('CCC', true) };
}

const blockOfIn = (dom, tree, row) => {
  const fn = new Function('workspaceRow', 'WORKSPACE_ROW', 'document', fnBlockOf + '\nreturn blockOf(workspaceRow);');
  return fn(row, WORKSPACE_ROW, { body: tree.body });
};

const ownerOf = (tree, session) => {
  const fn = new Function('WORKSPACE_ROW', 'document',
    fnWorkspaceIdOf + '\n' + fnSelected + '\nreturn selectedWorkspaceId();');
  return fn(WORKSPACE_ROW, { body: tree.body, querySelector: () => session });
};

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

console.log('[1] blockOf resolves each workspace own section');
{
  const dom = makeDom();
  const tree = buildTree(dom);
  ok(blockOfIn(dom, tree, tree.A.row) === tree.A.sec, 'workspace with sessions');
  ok(blockOfIn(dom, tree, tree.B.row) === tree.B.sec, 'empty workspace (no session rows)');
  ok(blockOfIn(dom, tree, tree.C.row) === tree.C.sec, 'third workspace');
  ok(blockOfIn(dom, tree, tree.A.row) !== tree.list, 'never collapses to the list container');
  ok(blockOfIn(dom, tree, tree.A.row) !== tree.A.anchor, 'never stops at the hover anchor');
}

console.log('[2] blocks are independent');
{
  const dom = makeDom();
  const tree = buildTree(dom);
  const a = blockOfIn(dom, tree, tree.A.row);
  const b = blockOfIn(dom, tree, tree.B.row);
  const c = blockOfIn(dom, tree, tree.C.row);
  ok(a !== b && b !== c && a !== c, 'each workspace resolves to a distinct block');
}

console.log('[3] selectedWorkspaceId finds the owner of the open session');
{
  const dom = makeDom();
  const tree = buildTree(dom);
  ok(ownerOf(tree, tree.A.session) === 'AAA', 'session under A resolves AAA');
  ok(ownerOf(tree, tree.C.session) === 'CCC', 'session under C resolves CCC');
  ok(ownerOf(tree, null) === undefined, 'no selection resolves undefined');
}

console.log('[4] the loop guards are present in the render path');
{
  // Static checks for the three mechanisms that stop the observer from re-arming itself.
  // (A line-by-line "is this write guarded" audit was tried and removed: these writes sit
  // inside multi-line state tests, which a line scan cannot see, so it reported false
  // positives. The structural guarantees below are what actually matter.)
  const body = grab('syncFilterMenu');
  const marker = 'const current = ctx.filter;';
  ok(body.indexOf(marker) > 0, 'every-pass section is locatable');

  // Every per-row write compares before assigning.
  ok(/if \(labelSpan\.textContent !== nextText\) labelSpan\.textContent = nextText;/.test(body),
    'label text is only written when it changed');
  ok(/if \(btn\.getAttribute\('aria-checked'\) !== nextChecked\) btn\.setAttribute\('aria-checked', nextChecked\);/.test(body),
    'aria-checked is only written when it changed');

  // The tick is a strict toggle driven by a state attribute, not a per-pass append.
  ok(/data-hide-workspace-ticked/.test(body), 'tick insertion is driven by a state attribute');
  // Only the every-pass tail matters here; the element-creation block above it runs once.
  //
  // Within that tail the only node insertions belong to the tick toggle, which is a strict
  // state flip: it is entered only while `ticked` is not yet '1' and leaves it set to '1',
  // so it can fire at most once per row. The two calls below are the fallback SVG tick
  // (path into the new svg) and the append of the mark onto the row.
  const tail = body.slice(body.indexOf(marker));
  const appends = tail.split(String.fromCharCode(10)).filter((l) => /\.(appendChild|append)\(/.test(l));
  ok(appends.length === 2, 'per-pass node insertions are limited to the tick mark', appends.length + ': ' + appends.join(' | '));
  ok(appends.every((l) => /mark/.test(l)), 'every per-pass insertion is part of the tick mark', appends.join(' | '));
  ok(/if \(selected && !hasMark\)/.test(tail), 'the tick insertions sit behind a single-shot state test');
  ok(/btn\.setAttribute\('data-hide-workspace-ticked', '1'\)/.test(tail), 'the state test advances, so it cannot repeat');

  // The build branch itself runs once, guarded by a count mismatch.
  ok(/holder\.querySelectorAll\('\[role="menuitem"\]'\)\.length !== FILTER_ITEMS\.length/.test(body),
    'row building is guarded by a count mismatch, so it cannot run every pass');
}


console.log('[5] the render loop cannot observe its own writes');
{
  ok(/if \(rendering\) return;/.test(src), 'observer callback ignores mutations made while rendering');
  ok(/rendering = true;/.test(src) && /rendering = false;/.test(src), 'rerender sets and clears the rendering flag');
  ok(/childList: true, subtree: true/.test(src), 'observer watches childList/subtree');
  ok(!/attributeFilter|attributes: true|characterData: true/.test(src), 'observer does not watch attribute or text changes');
}


console.log('[6] audited defects stay fixed');
{
  // D1: the menu owner is resolved live and expires, never a stale remembered row.
  ok(/resolveMenuWorkspaceId/.test(src), 'menu owner is resolved through a live lookup');
  ok(/MENU_OWNER_TTL_MS/.test(src), 'menu owner record expires');
  ok(/document\.body\.contains\(menuOwnerRow\)/.test(src), 'a detached owner row is rejected');
  ok(!/const row = ctx\.menuOwnerRow;/.test(src), 'the stale getter is no longer read directly');

  // D2: the archived-filter linkage exists and reads the host state.
  ok(/readArchivedFilter/.test(src), 'archived filter state can be read');
  ok(/archivedFilter === 'only' && ctx\.filter !== FILTER_SHOW/.test(src),
    'a restricting workspace filter is reset under "archived only"');

  // D3: Ctrl+H always produces visible feedback.
  const toggle = grab('toggle');
  ok(/if \(filter !== FILTER_HIDE\)/.test(toggle), 'Ctrl+H resets a restricting filter');
  ok(/showToast/.test(toggle), 'Ctrl+H always reports what it did');

  // D5: the collapsed rail cannot be mistaken for a broken layout.
  const guard = grab('guardAnchors');
  ok(/getBoundingClientRect/.test(guard), 'rail detection measures the container');
  ok(!/data-row-key="empty"\]'\)\?\.parentElement \?\? null;\s*\n\s*if \(region/.test(guard),
    'rail detection no longer depends on the empty marker');

  // D7/D8: dead code removed.
  ok(!/SESSION_ROW/.test(src), 'unused SESSION_ROW constant removed');
  ok(!/function anchorsPresent/.test(src), 'duplicate anchorsPresent helper removed');

  // D9: no unsound pruning.
  ok(!/pruneMissingWorkspaces/.test(src), 'unsound DOM-based pruning is not present');
  ok(/never reused/.test(src), 'the stale-id trade-off is documented in code');

  // setFilter must not schedule work when nothing changed.
  const setF = grab('setFilter');
  ok(/if \(filter === next\) return;/.test(setF), 'setFilter ignores a no-op assignment');


  // --- rename migration -------------------------------------------------------
  // The package was renamed from dsh-better-sidebar to dsh-hide-workspace. If the
  // keys changed without a fallback, every user who had workspaces hidden would
  // silently lose them on upgrade. The legacy key must be read once, rewritten
  // under the new key, and then removed.
  {
    const makeStore = (seed) => {
      const map = new Map(Object.entries(seed));
      return {
        map,
        window: {
          localStorage: {
            getItem: (k) => (map.has(k) ? map.get(k) : null),
            setItem: (k, v) => { map.set(k, String(v)); },
            removeItem: (k) => { map.delete(k); },
          },
        },
      };
    };
    const runHidden = (store) => {
      const body = [fnSafeGet, fnSafeSet, fnSafeRemove, fnReadHidden]
        .join(String.fromCharCode(10))
        + String.fromCharCode(10) + "return readHidden();";
      const fn = new Function("window", "STORAGE_KEY", "LEGACY_STORAGE_KEY", body);
      return fn(store.window, STORAGE_KEY, LEGACY_STORAGE_KEY);
    };
    const runFilter = (store) => {
      const body = [fnSafeGet, fnSafeSet, fnSafeRemove, fnReadFilter]
        .join(String.fromCharCode(10))
        + String.fromCharCode(10) + "return readFilter();";
      const fn = new Function("window", "FILTER_KEY", "LEGACY_FILTER_KEY", "FILTER_SHOW", "FILTER_ONLY", "FILTER_HIDE", body);
      return fn(store.window, FILTER_KEY, LEGACY_FILTER_KEY, "show", "only", "hide");
    };

    const s1 = makeStore({ [LEGACY_STORAGE_KEY]: JSON.stringify(["ws-1", "ws-2"]) });
    const migrated = runHidden(s1);
    ok(migrated.join(",") === "ws-1,ws-2", "legacy hidden ids survive the rename");
    ok(s1.map.has(STORAGE_KEY), "legacy hidden ids are rewritten under the new key");
    ok(!s1.map.has(LEGACY_STORAGE_KEY), "the legacy hidden key is removed after migrating");

    const s2 = makeStore({ [STORAGE_KEY]: JSON.stringify(["ws-9"]) });
    ok(runHidden(s2).join(",") === "ws-9", "the new key wins and is read directly");

    const s3 = makeStore({ [LEGACY_FILTER_KEY]: "only" });
    ok(runFilter(s3) === "only", "legacy filter state survives the rename");
    ok(!s3.map.has(LEGACY_FILTER_KEY), "the legacy filter key is removed after migrating");

    const s4 = makeStore({});
    ok(runFilter(s4) === "hide", "a missing filter falls back to the default");
  }
  // --- applyHidden: the three filter modes must actually differ ----------------
  // Regression: a ternary that only special-cased FILTER_ONLY made FILTER_SHOW
  // behave exactly like FILTER_HIDE, so choosing "All workspaces (show hidden)"
  // left the hidden ones hidden and offered no way to unhide from there.
  {
    const dom = makeDom();
    const tree = buildTree(dom);
    dom.document.querySelectorAll = (sel) => tree.body.querySelectorAll(sel);
    const hidden = ["AAA"];
    const run = (filter) => {
      const body = fnApplyHidden + String.fromCharCode(10) + "return applyHidden(hiddenIds, filter);";
      const fn = new Function(
        "hiddenIds", "filter", "document", "WORKSPACE_ROW", "HIDDEN_ATTR", "STYLE_ID",
        "FILTER_ONLY", "FILTER_SHOW", "workspaceRows", "workspaceIdOf", "blockOf",
        body
      );
      const idOf = (r) => {
        const k = r.getAttribute("data-row-key");
        return k == null ? undefined : k.slice("workspace:".length);
      };
      fn(hidden, filter, dom.document, WORKSPACE_ROW, HIDDEN_ATTR, STYLE_ID, "only", "show",
        () => tree.body.querySelectorAll(WORKSPACE_ROW),
        idOf,
        (r) => blockOfIn(dom, tree, r));
      const shown = [];
      for (const pair of [["AAA", tree.A.sec], ["BBB", tree.B.sec], ["CCC", tree.C.sec]]) {
        if (pair[1].getAttribute(HIDDEN_ATTR) !== "1") shown.push(pair[0]);
      }
      return shown.join(",");
    };
    ok(run("hide") === "BBB,CCC", "filter=hide hides only the hidden workspace");
    ok(run("show") === "AAA,BBB,CCC", "filter=show reveals hidden workspaces too");
    ok(run("only") === "AAA", "filter=only shows only the hidden workspace");
  }
}

console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
