# R1 — Packaging & Installing a Third-Party DSH Plugin (Windows)

Scope: how a **third-party / locally-developed** DSH plugin is packaged and made to load in the
Electron Desktop app's profile (`%USERPROFILE%\.dsh\profiles\desktop`). All paths below are
verified on this machine. Evidence is quoted with file path + line number.

Reference roots used throughout:

- `ASAR` = `<ASAR>\dsh\node_modules\@deepseek-ai\`
- `PROFILE` = `%USERPROFILE%\.dsh\profiles\desktop\`
- `PLUGIN` = `PROFILE\node_modules\dsh-our-free-model\`

---

## TL;DR — the decision-relevant answer

For a locally-developed plugin at `%USERPROFILE%\dsh-better-sidebar`, the **minimum** that makes
the app load it is **two** things (not three):

1. **`PROFILE\cordis.patch.yml` gets an `insert:` row** naming the plugin (this is what actually
   mounts it, and what makes the *browser* half load too).
2. **The package must be resolvable by Node from the profile directory** — i.e. present at
   `PROFILE\node_modules\<name>`, normally via a `link:` dependency in `PROFILE\package.json`
   + `pnpm install`.

`dsh.profile.bundles` + `dsh.bundle.patch` is a **convenience layer**, not a requirement. It is only
needed if you want the plugin to ship its own `cordis.patch.yml` (so the host row is declared inside
the package rather than hand-written in the profile). Both paths work; see §3.

A restart **is** required for a new package to be *resolvable*; see §3.5 for exactly what is and is
not hot.

---

## 1. Plugin manifest contract

### 1.1 What `package.json` must contain

Minimal required fields (from `dsh-app-boot`'s readers and `dsh-client-modules`'s parser):

| Field | Required for | Evidence |
|---|---|---|
| `name` | everything (identity, client-graph row id, bundle resolution) | `ASAR/dsh-package-manifest/README.md`: "`DshPackageManifest` describes the package.json fields used by DSH, with required `name` and `version`" |
| `version` | everything (compat checks key on `name@version`) | same |
| `main` (or `exports["."]`) | **host half** — the module the Loader imports | Loader imports `entry.options.name` → Node resolution; `ASAR/cordis-plugin-loader/README.md`: "`name` | Module specifier imported by the loader." |
| `exports["./client"]` | **browser half** — mandatory *iff* `dsh.client` is declared | `ASAR/dsh-client-modules/lib/index.js:737-738`: `const clientRel = clientExportOf(packageName, pkg.exports); if (clientRel === undefined) throw new Error(\`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle\`)` |

Verified empirically: all **305** packages in the app bundle were scanned — **79** declare
`dsh.client`, and **every one of the 79** also has a resolvable `main`. Zero exceptions.

### 1.2 `dsh.bundle.patch` vs `dsh.client`

These are two **independent, orthogonal** declarations.

**`dsh.bundle.patch` — "this package is a *bundle*: it carries its own loader patch file."**

- Read by `dsh-app-boot` only when the package name appears in `dsh.profile.bundles`.
- `ASAR/dsh-app-boot/lib/index.js:517-521` (`bundlePatchFiles`):
  ```js
  const declared = typeof bundle.patch === "string" ? [bundle.patch] : bundle.patch;
  if (!Array.isArray(declared) || !declared.every((file) => typeof file === "string"))
    throw new Error("dsh.bundle.patch must be a file path or a list of file paths");
  ```
- `ASAR/dsh-app-boot/lib/index.js:529-531` (`bundlePatchPaths`): each entry is `join(packageDir, file)`,
  i.e. relative to the package root.
- Consumed at `ASAR/dsh-app-boot/lib/index.js:1015-1034` (`loadProfileDirectory`): for each name in
  `dsh.profile.bundles`, resolve the dir → read `dsh.bundle` → **hard error if absent**:
  ```js
  if (bundle === void 0) throw new Error(`${binName}: profile bundle ${JSON.stringify(packageName)} declares no dsh.bundle in its package.json`);
  ```
  (that error is caught and the bundle is added to `skippedBundles`, so the profile still boots —
  the bundle just silently does nothing).
- It may be a **list** (ordered). Real example — `ASAR/dsh-web-app/package.json`:
  ```json
  "dsh": { "bundle": { "patch": ["./cordis.patch.yml","./presets/standard.patch.yml","..."] } }
  ```
  applied in order as one layer (`ASAR/dsh-package-manifest/README.md`: "`DshBundleManifest.patch` is one patch file path or an ordered list of them… the launcher applies a list in order as one bundle layer").

**`dsh.client` — "this package also has a *browser* half; serve and boot it in the page."**

- Read by `dsh-client-modules` **per live Loader entry**, not from the bundles list. It scans every
  enabled loader row and, for each, resolves the owner package and reads its `dsh.client`
  (`ASAR/dsh-client-modules/lib/index.js:720-748`, `resolveMeta`):
  ```js
  const decl = parseDshClient(packageName, dsh?.client);
  if (decl === void 0 || decl.platform !== "web") { this.pkgMeta.set(sourceKey, null); return null; }
  ```
- Composition then emits a `window.__DSH_BOOT__` graph row per declaring package
  (`ASAR/dsh-client-modules/lib/index.js:667-700`, `compose()` → `entries`), served over
  `/plugins/<id>/client.js`.

So: `dsh.bundle.patch` decides **whether the package contributes loader rows**;
`dsh.client` decides **whether a row that exists also gets a browser half**.

### 1.3 Meaning of `dsh.client.platform` / `.immediately` / `.inject`

All three are validated in one function — `ASAR/dsh-client-modules/lib/index.js:59-77` and the
browser-safe twin at `lib/client.js:60-75`:

```js
if (typeof decl.platform !== "string") throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`);
const inject   = optionalStringArray(pkgName, "dsh.client.inject",   decl.inject);
const external = optionalStringArray(pkgName, "dsh.client.external", decl.external);
if (decl.immediately !== void 0 && typeof decl.immediately !== "boolean") throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`);
```

**`platform`** — gate on the surface. Only `"web"` produces a bundle:
`lib/index.js:733` → `if (decl === void 0 || decl.platform !== "web") { … return null }`.
Every one of the 79 declaring packages in the app uses `"web"` — **`"web"` is the only value in
existence** on this installation, so treat it as the required literal.
(The field is validated as *any* string, but a non-`"web"` value silently yields no browser half.)

**`immediately`** — controls **only the initial prefetch tier**, not mounting order and not load
semantics. It is the single filter in the shell's prefetch pass —
`ASAR/dsh-web-frontend/dist/assets/index-BXV-oxvX.js` (~offset 921123):
```js
async prefetchImmediateTier(){
  await Promise.all(this.manifest.plugins.filter(e=>e.immediately).map(e=>this.modules.prefetch(e.id).catch(t=>{})))
}
```
This is the **only** consumer of `immediately` anywhere in the shell/module system (verified: the
token appears exactly 4× in `lib/index.js` — 2 validation, 1 pass-through in `graphRow`, 1 in
`resolveMeta` — and 4× in `lib/client.js` — 2 validation, 2 pass-through — plus that one shell site).
Concretely: `immediately: true` means "start downloading/registering this bundle's `client.js`
**before** the plugin tree boots", rather than lazily on first use. It is set on the 11 kernel
packages (`dsh-client-modules`, `dsh-client-ui-renderer`, `dsh-client-connection`,
`dsh-typert-registry`, `dsh-api-gateway`, `dsh-api-remotes`, `dsh-client-hmr`, `dsh-client-locale`,
`dsh-client-file-upload`, `dsh-client-ui-theme`, `dsh-experimental-inspector`) — i.e. things the
UI needs on frame 1. It is **not** required for a normal plugin.

**`inject`** — cross-bundle **module arrival ordering**, *not* Cordis service injection. In
`ASAR/dsh-client-modules/lib/client.js:788-792` (`arriveGraphRow`):
```js
for (const packageName of row.inject) {
  const dependency = this.graphRows.get(packageName);
  if (dependency !== void 0) await this.arriveDependency(row.id, dependency, [], visited);
}
```
i.e. "register these *other bundles' factories* before mine, so my factory's top-level
`require()` of them cannot throw." Two important nuances verified in code:

- It is **not** a hard dependency: unknown names are skipped (`if (dependency !== void 0)`), so a
  typo or a package with no browser half is silently ignored.
- It is **separate from `external`**. `external` additionally creates a *graph edge* used by
  host-side cycle detection and topological ordering (`lib/index.js:413-437`,
  `orderByModuleGraph`) and by the merge/`prune` retention set; `inject` does not
  participate in `orderByModuleGraph` at all. Only 6 packages use `external`, always to name
  `"@deepseek-ai/dsh-api-gateway/client"` (e.g. `ASAR/dsh-api-workspace-controller/package.json`).
- The *real* Cordis-level service dependencies live on the **module's own exported `inject`**
  array, not in `package.json` — e.g. `ASAR/dsh-client-ui-sidebar/lib/client.js:550-556`:
  ```js
  const inject = ["slots","layout","uiWorkspace","locale","shortcuts"];
  ```
  and `dsh-client-modules`' own browser half uses `const inject = ["loader"]`
  (`lib/client.js:995`). Declaring services in `package.json dsh.client.inject` does **nothing**
  for service availability — that is a different mechanism entirely.

> **Not determinable from the shipped artifacts:** whether `dsh.client.inject` is *intended* to be
> the module-arrival list vs. a service list. The code says module arrival; the naming is
> misleading. Both example plugins §4 rely on it being irrelevant (`[]`).

### 1.4 Is a host half required? Can a plugin be browser-only?

**A host half is *technically* required, but it is routinely an empty no-op — which is the
de-facto "client-only plugin" pattern.** A plugin with *no* row at all never reaches the browser,
because the browser graph is derived from loader rows (§1.2).

Evidence:

- The browser graph is built by iterating **Loader entries** —
  `ASAR/dsh-client-modules/lib/index.js:914-920` (`flush`) → `processOne(entryName)` which does
  `for (const entry of this.ctx.loader.entries()) { if (entry.options.name !== entryName || entry.fiber === void 0 || entry.disabled) continue; … }`.
  No loader row ⇒ no browser row. Full stop.
- **50 of the 79** `dsh.client` packages in this installation have a **literally empty**
  `apply()`. Verified programmatically. Example — `ASAR/dsh-client-ui-sidebar/lib/index.js` in full:
  ```js
  //#region lib/types/index.js
  /** Host loader entry for the browser-only sidebar plugin. */
  /** Provides no host-side behavior. */
  function apply() {}
  //#endregion
  export { apply };
  ```
  and `ASAR/dsh-client-ui-workspace/lib/index.js`, which documents the pattern explicitly:
  > "Workspace picker plugin, node half. Pure UI plugin: the empty apply exists **so the plugin
  > appears in the host cordis.yml / Loader** (load and lifecycle follow the host; the browser half
  > ships via `exports["./client"]`, discovered through the package.json `dsh.client` declaration)."
- The other **29** have real host logic (services, routes, `webserver/index-inject`, settings).
  E.g. `dsh-client-ui-theme/lib/index.js` registers a settings namespace and injects boot CSS.
- `dsh-client-ui-*` packages **all** have `lib/index.js` — the scan above confirms 0 packages
  declare `dsh.client` without a working `main`.

**Practical rule:** ship `index.js` with
```js
export function apply() {}
```
(plus optional `export const name` / `export const inject = [...]`) and put all real code in
`client.js`. That is exactly what every shipped UI plugin does.

---

## 2. How the profile resolves plugins (traced end-to-end)

### 2.1 The composition chain

`PROFILE\cordis.yml` is an empty root, and says so —
`PROFILE\cordis.yml:1-4`:
```yaml
# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
```

The layer order is stated three times consistently:

- `PROFILE\cordis.patch.yml:1-2`: "Your patch layer for this dsh profile, **applied after every
  bundle layer**: a top-level YAML array of loader patch entries (id-targeted config overrides,
  disables, and insert lists; `!!js` expressions allowed)."
- `ASAR/dsh/README.md` (Profiles): "The tree composes over an empty root: each bundle's patch in
  `dsh.profile.bundles` order, then the profile's `cordis.patch.yml`, then the home-level
  `$DSH_HOME/cordis.patch.yml`, then `--patch` overlays."
- Code: `ASAR/dsh-app-boot/lib/index.js:490-497` (`loadProfileDirectory` module doc) and
  `:2398-2401` (`prepareProfilePatches` → `[{ insert: rows }]`).

`dsh.profile.bundles` resolution is **installation-first, profile second** —
`ASAR/dsh-app-boot/lib/index.js:995-1003` (`resolveBundleDir`):
```js
for (const anchor of [installAnchor, join(profileDir, "package.json")]) {
    const dir = packageDirFromAnchor(anchor, packageName);
    if (dir !== void 0) return dir;
}
throw new Error(`${binName}: cannot resolve profile bundle ${JSON.stringify(packageName)} …`);
```
This is why a profile can never override a shipped `@deepseek-ai/*` bundle with its own copy.
For a **third-party** name (e.g. `dsh-better-sidebar`) the installation anchor misses (it is not in
the app's own dependency graph) and the profile's `node_modules` wins. That is exactly how both
examples work.

### 2.2 Exact `cordis.patch.yml` syntax to ADD a new plugin

A **top-level YAML array** of patch entries. To add, use a single-key `insert:` object holding a
list of loader entry options.

```yaml
- insert:
    - id: better-sidebar          # stable entry id; used by later id-targeted patches
      name: 'dsh-better-sidebar'  # module specifier, resolved by Node from the profile
      config: {}                  # passed to the plugin's Config schema (optional)
```

Supported entry keys — schema at `ASAR/dsh-app-boot/lib/index.js:3005-3022` (`metadata()`):
`id`, `name`, `config`, `group`, `disabled`, `inject`, `intercept`, `isolate`.
(`id` is the patch target; `name` is the module specifier — `ASAR/dsh-app-boot/lib/index.js:3011`:
"Plugin module specifier. **Inserted relative plugin paths are anchored beside their patch file.**")

The patch semantics — vendored `applyEntryPatches`, `ASAR/dsh-app-boot/lib/index.js:37-109`:
```js
for (const patch of patches) {
    const { id, insert, name, ...overrides } = patch;
    if (insert) {
        if (id) { /* must be an existing GROUP; push into its config array */ }
        else data.push(...insert);           // ← top-level add
        buildMap(insert);                    // ← inserted rows are patchable by later entries
        continue;
    }
    if (!id) { warn("patch: id is required for non-insert patches"); continue; }
    const target = entryMap.get(id);
    if (!target) { warn("patch: entry %C not found", id); continue; }
    if (name && name !== target.name) { warn("patch: name mismatch …"); continue; }
    for (const [key, value] of Object.entries(overrides)) if (key !== "id") target[key] = value;
}
```

Critical consequences, all machine-verified by running the app's own parser (§2.5):

1. **`config` is replaced wholesale, never deep-merged** —
   `ASAR/dsh-app-boot/lib/index.js:3043-3046`: "Other patches replace supplied fields; `config` is
   replaced wholesale, not deep-merged. A truthy `name` **asserts** the existing plugin name rather
   than renaming it." This is why the shipped `PROFILE\cordis.patch.yml` restates entire config
   blocks (e.g. the whole `soul-md` block).
2. A **non-`insert` patch with `id` + `name` + `config` is an OVERRIDE of an existing row**, not an
   add. If no row with that `id` exists you get a *warning*, not a mount.
3. Inside `insert`, `id` means "insert into this **group**" — a plain non-group row will be
   rejected with `"patch insert: entry %C is not a group"`.
4. A patch matching nothing is a **warning only**, never fatal (`:53-56`, and the doc at `:2997-3000`).
5. Inserted rows are indexed as they are added, so a later patch **in the same file** can target
   them.

### 2.3 Why a patch row with a bare `name: "my-plugin"` also loads the BROWSER half

This is the crux. There is **no second declaration** — the browser half rides on the host row.

Chain of evidence:

1. The row creates a **Loader entry** whose `options.name` is the literal specifier
   (`cordis-plugin-loader/README.md`, Entry Options: "`name` | Module specifier imported by the loader.").
2. `dsh-client-modules` subscribes to every fiber lifecycle event and marks the row dirty —
   `ASAR/dsh-client-modules/lib/index.js:543-559`:
   ```js
   ctx.on("internal/plugin", (fiber) => {
       const entryName = fiber.entry?.options.name;
       if (entryName === void 0) return;
       this.dirty.add(entryName);
       …
   });
   for (const entry of ctx.loader.entries()) this.dirty.add(entry.options.name);
   ```
3. On flush it re-resolves that specifier and reads the owner package's `package.json` —
   `ASAR/dsh-client-modules/lib/index.js:720-748` (`resolveMeta`) → `locatePkgJson` (`:763-790`).
   Resolution goes through **the same Loader resolution the host half used**
   (`:753-756`: "The row's module location is authoritative: the specifier resolves through the same
   Loader resolution that imported the row's host half"). Then:
   ```js
   const decl = parseDshClient(packageName, dsh?.client);
   if (decl === void 0 || decl.platform !== "web") { … return null; }
   const clientRel = clientExportOf(packageName, pkg.exports);   // MUST exist
   ```
4. A graph row is emitted keyed by **package name**, not by row id —
   `ASAR/dsh-client-modules/lib/index.js:743-747` and `:404-413` (`graphRow`), and
   `reconcilePackage` sets `this.table.set(packageName, …)` (`:806`).
5. The browser receives that graph and **creates a Loader entry for each plugin row** —
   `ASAR/dsh-client-modules/lib/client.js:486-495`:
   ```js
   async create(loader, id) {
       const options = { name: id };
       const entryId = loader.ensureId(options);
       try { await loader.create(options); } finally { this.managed.set(id, loader.resolve(entryId)); }
   }
   ```
   where `id` is the **package name**. The bundle's `client.js` ends with
   `exports.apply` / `exports.inject`, which the browser-side Loader then mounts. E.g.
   `ASAR/dsh-client-ui-workspace/lib/client.js` tail:
   ```js
   exports.apply = apply;
   exports.inject = inject;
   ```
   and `PLUGIN/client.js` tail: `exports.apply = apply; exports.inject = inject; exports.name = 'our-free-model'`.

**Therefore:**

- The row must be the **bare package name** for the browser half to attach. This is stated
  verbatim in the example plugin's own patch comment —
  `PLUGIN/cordis.patch.yml:3-4`:
  > "一行 insert 即挂载 Host 半身；浏览器半身由 package.json 的 `dsh.client` 声明，并绑定在 name 为**裸包名**的这一行上（子路径行不会携带半身）。"
  > *(EN: one `insert` line mounts the Host half; the browser half is declared by `dsh.client` in
  > package.json and is **bound to the row whose name is the bare package name** — a subpath row
  > does not carry a half.)*
- Confirmed in code: `exactPackageSpecifier` (`ASAR/dsh-client-modules/lib/index.js:81-89`) returns
  `undefined` for subpaths (`a/b`), scoped subpaths (`@s/p/sub`), and any scheme specifier — and
  `locatePkgJson` bails out when it is `undefined` and the name is not path-like (`:765-766`):
  ```js
  const expectedPackageName = pathLike ? void 0 : exactPackageSpecifier(loaderName);
  if (!pathLike && expectedPackageName === void 0) return void 0;
  ```
  So a row like `name: '@dsh-local/anchored-standard/plugins/tool-bootstrap'` gets **no browser half**.
- A row given as an **absolute path or file URL** *does* still work via the `pathLike` branch
  (`:768-771` → `nearestPackage`). But the resulting graph id is the **package.json `name`**
  (`:793-810`), so it must live inside a directory with a `package.json` whose `name` is the
  package name.
- Two rows resolving to the same package name is a **hard error** —
  `ASAR/dsh-client-modules/lib/index.js:800-803`:
  ```
  client-modules: package ${packageName} resolves from multiple active Loader sources: …
  remove one entry
  ```
  So never declare both a subpath row and a bare row for the same package, and never mount the same
  package twice.

### 2.4 Can a bundle ship its own `cordis.patch.yml`?

**Yes — that is precisely what `dsh.bundle.patch` is for.** Two live examples on this machine:

- `PLUGIN/package.json`: `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }` — the file
  `PLUGIN/cordis.patch.yml` is the entire 1-row patch (§4).
- `%USERPROFILE%\.dsh\anchored-standard-bundle\package.json`:
  ```json
  "dsh": { "bundle": { "patch": [ "./cordis.patch.yml" ] } }
  ```
  whose patch is 26 KB of nested `insert:` rows (a whole agent preset).

Requirements for a bundle's own patch to be applied:
`PROFILE\package.json` must list the name in `dsh.profile.bundles` **and** the package must be
resolvable (§2.1). If either fails, `loadProfileDirectory` catches it and pushes to
`skippedBundles` — the app still boots and prints a one-line stderr diagnostic
(`ASAR/dsh-app-boot/lib/index.js:537-540`, `reportSkippedBundles`).

**Note the two-layer gotcha:** a bundle's patch is applied *before* the profile patch. So
`PROFILE\cordis.patch.yml` can override a row the bundle inserted (by id, last write wins), and can
insert additional rows — but it cannot *remove* the bundle's rows except via `disabled: true`.

### 2.5 Empirically verified with the app's own parser

I ran the app's real `loadOverlayPatches` from `ASAR/dsh-app-boot/lib/index.js` against a synthetic
patch (no files outside a scratch dir were touched; scratch was deleted afterwards):

```yaml
- insert:
    - id: better-sidebar
      name: 'dsh-better-sidebar'
      config: { hideKey: hiddenWorkspaces }
    - id: better-sidebar-rel
      name: './local/index.js'
      config: {}
- id: ui-theme
  config:
    preference: dark
```
Parsed result:
```json
[
  { "insert": [
      { "id": "better-sidebar", "name": "dsh-better-sidebar", "config": { "hideKey": "hiddenWorkspaces" } },
      { "id": "better-sidebar-rel", "name": "file:///<RESEARCH>/scratch-linktest/local/index.js", "config": {} }
  ]},
  { "id": "ui-theme", "config": { "preference": "dark" } }
]
```
Two confirmations: (a) relative `./` names are rewritten to **`file://` URLs anchored beside the
patch file** (`anchorInsertedPluginNames`, `ASAR/dsh-app-boot/lib/index.js:3970-3981`); (b) the
id-targeted override keeps only `id` + `config` — no `name` assertion is required, and re-stating
`name` merely asserts.

---

## 3. Install flow for a locally-developed plugin

Target example: `%USERPROFILE%\dsh-better-sidebar`.

### 3.1 Which parts are necessary vs optional

| Step | Necessary? | Why |
|---|---|---|
| Package has `package.json` with `name`, `main`/`exports["."]`, `exports["./client"]` + `dsh.client` | **YES** | §1.1, §1.4 — no `main` ⇒ Loader can't import; no `./client` export ⇒ hard throw at `lib/index.js:738` |
| Package present in `PROFILE\node_modules\<name>` | **YES** | the module specifier must resolve by Node from the profile |
| `dependencies["<name>"] = "link:%USERPROFILE%/dsh-better-sidebar"` in `PROFILE\package.json` + `pnpm install` | **Recommended** (this is what creates the symlink *and* makes it survive later installs) | see §3.3 |
| `insert:` row in `PROFILE\cordis.patch.yml` | **YES** (if you use path A) | that is the mount |
| `dsh.bundle.patch` + bundle's own `cordis.patch.yml` | **Optional** (alternative to the profile insert row) | §2.4 |
| name in `dsh.profile.bundles` | **Only if** you use `dsh.bundle.patch` | §2.4 |
| restart | **YES for first install** | §3.5 |

So the two viable shapes are:

**Path A — profile patch row only (simplest, best for a dev loop).**
```jsonc
// PROFILE\package.json
"dependencies": { "dsh-better-sidebar": "link:%USERPROFILE%/dsh-better-sidebar" }
```
```yaml
# PROFILE\cordis.patch.yml  (append)
- insert:
    - id: better-sidebar
      name: 'dsh-better-sidebar'
      config: {}
```
No `dsh.bundle` in the plugin's `package.json`; no entry in `dsh.profile.bundles`.

**Path B — real bundle (best for shipping/distribution, and for the Plugins UI, §5).**
```jsonc
// plugin package.json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" }, "client": { "platform": "web", "immediately": true, "inject": [] } }
```
```jsonc
// PROFILE\package.json
"dependencies": { "dsh-better-sidebar": "link:%USERPROFILE%/dsh-better-sidebar" },
"dsh": { "profile": { "bundles": [ …existing…, "dsh-better-sidebar" ] } }
```
No hand-written row in `PROFILE\cordis.patch.yml`.

Both are proven: `anchored-standard` is Path A + B combined (it is *both* a `bundles` entry and a
`link:` dep), `dsh-our-free-model` is Path B (a `bundles` entry with its own patch file).

### 3.2 Concrete minimal walkthrough (Path A, Windows)

```powershell
# 1. create the plugin package (all under the user's own folder)
mkdir %USERPROFILE%\dsh-better-sidebar
#    package.json:
#      { "name": "dsh-better-sidebar", "version": "0.1.0", "private": true, "type": "module",
#        "main": "./index.js",
#        "exports": { ".": "./index.js", "./client": "./client.js", "./package.json": "./package.json" },
#        "dsh": { "client": { "platform": "web", "immediately": true, "inject": [] } } }
#    index.js:  export function apply() {}
#    client.js: window.__ModuleLoader__.load({ id: 'dsh-better-sidebar', factory: (require) => { … exports.apply=…; exports.inject=[…]; return module.exports } })

# 2. register the link (run IN the profile dir; pnpm needs its workspace file)
cd %USERPROFILE%\.dsh\profiles\desktop
pnpm add link:%USERPROFILE%/dsh-better-sidebar
#    → package.json dependency  "dsh-better-sidebar": "link:%USERPROFILE%/dsh-better-sidebar"
#    → node_modules\dsh-better-sidebar -> %USERPROFILE%\dsh-better-sidebar   (real symlink)

# 3. mount it
#    append the insert: block above to PROFILE\cordis.patch.yml

# 4. restart the DSH desktop app
```

Notes verified on this machine:

- `pnpm add link:<abs path>` works and records **`link:C:/Users/...` (forward slashes, absolute)** in
  `package.json`; the lockfile gets `version: link:<relative>`. Verified by running pnpm here.
- Without an explicit `link:` prefix, `pnpm add /abs/dir` still records `link:C:/abs/dir`. Also
  verified.
- The `link:` form is exactly what the Plugin Manager itself generates for a dev target —
  `ASAR/dsh-plugin-manager/lib/index.js:933`: `spec: \`link:${directory}\`` and the README: "Source
  Web and development Desktop offer `link:<absolute workspace package directory>` … Prepare the
  checkout with `pnpm install` and `pnpm run build`. Linked packages use that checkout's dependencies
  and peers; rebuilding and restarting remain necessary after code changes."
  **For a hand-written `client.js` (the `dsh-our-free-model` style) there is no build step** — that is
  the fastest loop.

### 3.3 `nodeLinker: hoisted`, and whether `pnpm install` must be re-run

**The profile uses hoisted linking** — `PROFILE\pnpm-workspace.yaml`:
```yaml
packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
allowBuilds:
  node-pty: true
minimumReleaseAgeExclude: [ … 6 entries … ]
```
and `PROFILE\node_modules\.modules.yaml`: `"nodeLinker": "hoisted"`, `"packageManager": "pnpm@11.28.5"`.

With `nodeLinker: hoisted`, dependent packages land **directly** in `PROFILE\node_modules\<name>` as
symlinks (no `.pnpm/<pkg>@<ver>/node_modules/<pkg>` nesting). Verified: `PROFILE\node_modules`
contains exactly `@deepseek-ai`, `@dsh-local`, `@openai`, `@standard-schema`,
`dsh-our-free-model`, `zod` — flat — and `@dsh-local/anchored-standard` is reported as
`isSymbolicLink: true`.

**Must you re-run `pnpm install`?**
- If you use `pnpm add link:…` — no, that *is* the install.
- If you only hand-edit `package.json` — yes, `pnpm install` is what materializes the symlink.
- If you only add `dsh.profile.bundles` / `cordis.patch.yml` changes — **no** pnpm run is needed; the
  files are just read at boot (and watched by HMR, §3.5).

**Empirically checked pitfall — a hand-made symlink is NOT enough for DSH.** I created a link by hand
in a scratch profile and ran `pnpm install`:
- `mklink /J` (**junction**) → `fs.lstatSync().isSymbolicLink() === false` and
  `Dirent.isSymbolicLink() === false` on Windows. DSH enumerates linked roots with
  `entry.isSymbolicLink()` (`ASAR/dsh-app-boot/lib/index.js:648-660`, `symlinksUnder`), so a
  **junction is invisible** to the "linked root" mechanism (peer-aware ancestor lookup in
  `routeLinked`, `:1676-1731`). Use `pnpm add link:` (which creates a real symlink — verified
  `isSymbolicLink: true`) rather than `mklink /J`.
- A hand-placed entry **survived** `pnpm install` when pnpm considered the project up to date, and it
  also survived a subsequent real `pnpm add`. So pnpm does not aggressively prune unknown
  `node_modules` entries in hoisted mode. **But** it is undocumented behaviour, it is not in
  `package.json`/lockfile, and `Plugin Manager` operations rewrite both. Not recommended.

**`minimumReleaseAge`:** the profile's lockfile settings record `"minimumReleaseAge": 1440` (minutes =
24 h) with a 6-entry `minimumReleaseAgeExclude` list — see
`PROFILE\node_modules\.pnpm-workspace-state-v1.json` → `settings.minimumReleaseAge: 1440`.
However `pnpm config get minimumReleaseAge` from the profile dir returns `undefined`, i.e. it is
**recorded in the workspace state, not in a live `.npmrc`/`pnpm-workspace.yaml` key** (there is no
`.npmrc` in the profile dir; the user-level `%USERPROFILE%\.npmrc` only sets
`registry=https://registry.npmmirror.com`). Practical impact:
- It **cannot affect a `link:` install at all** (no registry, no publish date).
- It only bites on **registry** installs, and the failure mode is: pnpm silently installs an **older**
  version than the one `inspect` read. The Plugin Manager explicitly reports this —
  `ASAR/dsh-plugin-manager/lib/typert.host.js:78`: "The installed bundle's manifest version, when
  declared; pnpm's `minimumReleaseAge` can make it older than the newest release", and the UI docs
  describe naming both versions and attributing the difference to `minimumReleaseAge`
  (`ASAR/dsh-client-ui-plugin-manager/README.md`, "Installing a bundle"). Observed for real in
  `PROFILE\.plugin-manager\logs\operation-SBA3Ws\pnpm.log`:
  `Added 6 entries to minimumReleaseAgeExclude in pnpm-workspace.yaml`.
- **Recommendation for a dev plugin: always install by `link:`** — sidesteps `minimumReleaseAge`,
  the registry choice, and the GitHub/proxy path entirely.

**`autoInstallPeers: false`** — the other notable setting. An unmet peer is *not* auto-installed, so
a plugin that `import`s a bare package the installation does not carry will fail to import at
runtime with `ERR_MODULE_NOT_FOUND`. Both working examples avoid this:
- `PLUGIN/index.js` imports **only** `node:*` builtins plus its own relative `./src/*` files
  (verified: 6 bare-looking imports, all `node:`-prefixed; 16 unique non-relative specifiers in
  `src/`+`adapter/`, all `node:*`). It does declare `peerDependencies`
  (`@deepseek-ai/cordis`, `dsh-commands`, `dsh-credentials`, `dsh-llm`, `schemastery`) — those are
  satisfied from the installation's own runtime table and it never imports them at top level.
- `anchored-standard`'s plugin files (`lib/*.mjs`) import **nothing** except `./compaction-epoch.mjs`.
- The browser half is a different story: it may `require()` only the **frozen platform seed table** —
  `ASAR/dsh-web-frontend` `OZ()`: `react`, `react/jsx-runtime`, `react-dom`, `react-dom/client`,
  `@deepseek-ai/cordis`, `zod`, `@tanstack/react-virtual`, `@deepseek-ai/dsh-client-store`,
  `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`,
  `@deepseek-ai/dsh-client-ui-dockkit`. Anything else must either be a graph row named in
  `dsh.client.external`, or it throws ("cannot resolve … not a row in the boot graph").

**Peer/version gate:** `dsh-app-boot` enforces compatibility — `evaluatePluginCompatibility`
(`ASAR/dsh-app-boot/lib/index.js:275-305`): if `engines.dsh` is present it decides **alone**
(`peerDependencies` ignored); otherwise **every** `peerDependencies` entry named
`@deepseek-ai/dsh` or `@deepseek-ai/dsh-*` must match the running `0.2.1-rc.3`.
Mismatch ⇒ bundle skipped (or install refused) unless an exact
`package@version → [runtime versions]` grant exists in `PROFILE\compatibility.json`.
**For a dev plugin, declare neither `engines.dsh` nor `@deepseek-ai/dsh*` peers unless you mean it** —
that is the zero-friction choice. (Note `PLUGIN`'s peers use broad ranges like
`^0.2.0-rc.1` and pass; `anchored-standard` declares none at all.)

### 3.4 Does it need a restart? Any HMR?

**Split answer — three independent mechanisms, only one of which is a restart.**

1. **New package resolvability: restart required.**
   The runtime resolution is computed once at launch and refused if it would change a moved/added
   profile-scoped mapping — `ASAR/dsh-app-boot/lib/index.js:1552-1554`:
   ```js
   const localPackageNames = new Set(successor.localPackageNames);
   for (const name of localPackageNames) if (!this.current.localPackageNames.has(name) && this.current.entries.has(name))
       rejected.push(`profile resolution: overriding ${JSON.stringify(name)} locally requires a process restart`);
   ```
   and `:1541-1546` rejects a profile mapping that moved directories
   (`ResolutionRestartRequired` → `restartReason: "package-moved"`). The README agrees:
   "Installation mappings and local overrides still require a restart"
   (`ASAR/dsh-app-boot/README.md`, Known Limitations).
   Practically: the *first* time you add a `link:`, restart. (Plugin Manager's own install path can
   publish a successor without a restart because it re-computes and re-publishes the resolution;
   a hand-edited `package.json` + external `pnpm add` cannot.)
2. **Config / patch changes: hot, if `dsh-hmr` is enabled.** And on this profile it is —
   `ASAR/dsh-base/cordis.patch.yml:28-32`:
   ```yaml
   - id: hmr
     name: '@deepseek-ai/dsh-hmr'
     disabled: !!js "!ctx.get('profileContext')"
     config: { root: [] }
   ```
   `profileContext` **is** provided by the Desktop host (`ASAR/dsh-desktop-host/lib/index.js:224`
   `loadProfileDirectory` → `runProfile`; and `ASAR/dsh/lib/profile-boot-*.js:302-306`
   `hostCtx.provide("profileContext", profileContext)`), so the row is **enabled**.
   `dsh-hmr` watches the profile manifest and **both user patch files** and recomposes:
   "The enabled `dsh-hmr` plugin watches the profile manifest and both user patch files, re-reads the
   ordered bundle layers, and applies the reload failure policy" (`ASAR/dsh-app-boot/README.md`).
   **So editing `PROFILE\cordis.patch.yml` takes effect live, without restart.**
   Caveat: `root: []` means **no source-module watching**; only explicit config watches are active.
   To also watch plugin source: `- id: hmr \n  config: { root: ["."] }` (README of `dsh-hmr`).
   Importantly `dsh-hmr` *does* re-import linked package files on recomposition:
   "Profile recompositions … also replace plugins whose loaded files below the profile directory
   changed on disk. This covers installed packages below `node_modules` and **the targets of linked
   packages**." (`ASAR/dsh-hmr/README.md`)
3. **Browser bundle: hot, via `dsh-client-hmr`.** `ASAR/dsh-web-app/cordis.patch.yml:218-219`:
   ```yaml
   - id: client-hmr
     name: '@deepseek-ai/dsh-client-hmr'
   ```
   Its node half stat-polls each row's `client.js` every `pollIntervalMs` (default 500 ms) and pushes
   a `rebuilt` frame over SSE `/plugins/events` —
   `ASAR/dsh-client-hmr/lib/index.js:22`, `:46`, `:96-108`. The browser then swaps the module:
   "Each successful reload re-executes the plugin bundle and remounts the plugin with fresh state."
   Revisions come from `mtimeMs`/`ctimeMs`/`size` only (`ASAR/dsh-client-modules/lib/index.js:816-825`,
   `artifactRevision`) — so **rewriting `client.js` on disk is picked up within ~0.5 s with no reload
   and no restart**. React state inside the plugin is lost; session/workspace/connection state survives.
   ⚠️ Caveat that matters for a *new* plugin: `client-hmr` only watches rows that already exist in the
   graph (`syncWatches` iterates `ctx.clientModules.graph().entries`). A brand-new row therefore needs
   the boot that creates it — i.e. restart, or Plugin Manager, or an HMR config recomposition.

**Practical dev loop after the first restart:** edit `client.js` → refreshed in the open window in
<1 s. Edit `index.js` → `dsh-hmr` recomposes (needs `root: ["."]` to catch source writes) or the
profile patch edit triggers recomposition. Add a new package or a new `link:` → restart.

### 3.5 Not determined

- Whether `dsh-hmr`'s recomposition alone (without restart) can make a **brand-new** `node_modules`
  link resolvable. The code path (`computeLatestResolution` at `:3536` and `:3816`) *does* re-read
  the manifest and installed packages and *does* call `publish()`, and `replace()` only rejects
  *changed* retained mappings — a purely **additive** profile mapping is not in `this.current.entries`,
  so it should pass. But `routeLocalPackage` (`:1731-1738`) gates on
  `resolution.localPackageNames.has(name)` and I could not exercise this without touching the live
  profile. **Treat as "likely yes with HMR, definitely yes on restart"** and verify on the real
  machine before relying on it.

---

## 4. Existing working example — `dsh-our-free-model`

### 4.1 Reverse-engineered install checklist (what actually happened)

Reconstructed from `PROFILE\package.json`, `PROFILE\pnpm-lock.yaml`, `PROFILE\node_modules\.modules.yaml`
and `PROFILE\.plugin-manager\logs\`.

- [x] **1. Installed as a profile dependency, by git spec** (not a registry install):
      `PROFILE\package.json`: `"dsh-our-free-model": "github:Ebony-Vinyl/dsh-our-free-model"`.
      Lockfile pins an **immutable tarball + integrity**:
      `PROFILE\pnpm-lock.yaml`:
      ```yaml
      dsh-our-free-model@https://codeload.github.com/Ebony-Vinyl/dsh-our-free-model/tar.gz/7e3a1da5407a4206b2c672f6845ada3244fb300e:
        resolution: {gitHosted: true, integrity: sha512-sGQBiljJt2uF6BxMpoMDz+sjDFKVzpi0VmH6iRx2SFy5q9xPhUG7r9eGr1EajB8is9GrP1LyuLWQyxe71Gn9Ag==, …}
        version: 2.1.0
      ```
      The pnpm run that did it — `PROFILE\.plugin-manager\logs\operation-EkefYn\pnpm.log`:
      `+ dsh-our-free-model git+https://github.com/zouyuxuan122/dsh-our-free-model.git`
      (an earlier install; the source URL was later changed to `Ebony-Vinyl/…`, see
      `operation-xxRW8u\pnpm.log`: `- dsh-our-free-model github:zouyuxuan122/dsh-our-free-model` /
      `Already up to date`).
- [x] **2. Landed at `PROFILE\node_modules\dsh-our-free-model`** as a real directory (hoisted linker).
      `PROFILE\node_modules\.modules.yaml` → `hoistedLocations["dsh-our-free-model@…"]:
      ["node_modules\\dsh-our-free-model"]`.
- [x] **3. Selected as a bundle layer**: `PROFILE\package.json` → `dsh.profile.bundles` contains
      `"dsh-our-free-model"` (between `@dsh-local/anchored-standard` and
      `@deepseek-ai/dsh-experimental-terminal-bundle`).
      ⇒ `loadProfileDirectory` resolves it from the **profile** (not the installation) and applies
      its `dsh.bundle.patch`.
- [x] **4. Package declares both faces** — `PLUGIN/package.json`:
      ```json
      "main": "./index.js",
      "exports": { ".": "./index.js", "./client": "./client.js", "./package.json": "./package.json", "./locale/*.json": "./locale/*.json" },
      "dsh": {
        "bundle": { "patch": "./cordis.patch.yml" },
        "client": { "platform": "web", "immediately": true, "inject": [] }
      }
      ```
- [x] **5. The bundle's patch supplies the host row** — `PLUGIN/cordis.patch.yml` (the whole file):
      ```yaml
      # dsh-our-free-model bundle patch.
      #
      # 一行 insert 即挂载 Host 半身；浏览器半身由 package.json 的 dsh.client 声明，
      # 并绑定在 name 为裸包名的这一行上（子路径行不会携带半身）。
      - insert:
          - id: our-free-model
            name: 'dsh-our-free-model'
            config: {}
      ```
- [x] **6. No entry in `PROFILE\cordis.patch.yml`** — that file targets only `ui-*`, `llm-*`,
      `agent-*` and `soul-md` rows. Confirms the bundle patch alone is sufficient.
- [x] **7. Restart** (there is no record of a live install succeeding end-to-end for the initial add).

**Two lessons:** (a) `dsh.profile.bundles` + own patch file is the *complete* Path-B install — no
profile-patch edit needed; (b) shipping a `main` that imports nothing but `node:*` + relative files
means `autoInstallPeers: false` and `minimumReleaseAge` never matter.

### 4.2 What `immediately: true` and `inject: []` concretely mean here

- **`immediately: true`** ⇒ at page boot, before the Cordis tree mounts, the shell runs
  `manifest.plugins.filter(e => e.immediately).map(e => this.modules.prefetch(e.id))`
  (`ASAR/dsh-web-frontend/…/index-BXV-oxvX.js` ~921123). `prefetch` →
  `arriveGraphRow` → `arrive` → `loadShared(url)`, i.e. it **fetches and executes
  `/plugins/dsh-our-free-model/client.js` during the boot spinner**, registering the factory early.
  The bundle body still stays lazy (only `window.__ModuleLoader__.load({id, factory})` runs); the
  factory's contents materialize on first `require`/`import`.
  **Effect for this plugin: its settings-page React code is already registered by the time the UI
  paints, so opening Settings → Our Free Model never shows a "loading bundle" stall.** Cost: ~450 KB
  of `client.js` is downloaded on every page load even if the user never opens the settings page.
  **A "better sidebar" plugin arguably wants this too** (the sidebar renders on frame 1), but
  `false`/omitted also works — the bundle then downloads on first import.
- **`inject: []`** ⇒ no module-arrival prerequisites are awaited before this bundle registers
  (`ASAR/dsh-client-modules/lib/client.js:788-792` — an empty list means the loop body never runs).
  Concretely: this bundle's factory `require`s **only `react`**, which is a *platform seed* provided
  by the shell itself (see the `OZ()` table), not a graph row — so there is nothing to order against.
  It does **not** mean "this plugin needs no services": its browser half declares
  `const inject = ['slots', 'locale']` **inside `client.js`**, which is the Cordis-level service
  declaration that actually gates activation. And its host half declares
  `export const inject = ['llm']` (`PLUGIN/index.js:127`) — that is the one hard service dependency.
  (Consistent with §1.3: `dsh.client.inject` = module-arrival, module `inject` = services.)

A useful contrast: `dsh-client-ui-sidebar` has `dsh.client.inject` listing **seven** packages
(`@deepseek-ai/dsh-api-workspace-controller`, `-client-ui-renderer`, `-client-ui-layout`,
`-client-ui-session`, `-client-ui-workspace`, `-client-locale`, `-client-shortcuts`);
`dsh-our-free-model` has `[]` precisely because it depends on nothing but `react`.

---

## 5. Plugin Manager UI — can a local/dev plugin be installed from the UI?

**Yes — a local absolute directory path is an explicitly supported install source.** But it is
*package management* (dependency + bundle selection), **not** a way to mount an arbitrary plugin
module.

### 5.1 What the UI offers

Both halves exist and are mounted in this profile:

- Host service: `ASAR/dsh-plugin-manager` — row `plugin-manager` in
  `ASAR/dsh-base/cordis.patch.yml:20-22`, with
  `disabled: !!js "!ctx.get('profileContext')"` (so enabled on Desktop).
- Web page: `ASAR/dsh-client-ui-plugin-manager` — row `ui-plugin-manager` in
  `ASAR/dsh-web-app/cordis.patch.yml:318-319`.
- Discover tab (optional bundle, and it **is** in this user's `dsh.profile.bundles`):
  `ASAR/dsh-experimental-plugin-market-bundle`, rows `plugin-market` + `ui-plugin-market`.

The Add-plugin dialog accepts, verbatim (`ASAR/dsh-client-ui-plugin-manager/README.md`,
"Installing a bundle"):

> "**Add plugin** takes a package name with an optional version, a Git address, a tarball, or
> **an absolute local path**; the dialog says a package name is what follows `dsh plugin add` in a
> README."
> "**Install a third-party plugin** | Closes the menu and opens the same dialog for a package name,
> Git repository, or **local directory**."

Host-side enforcement — `ASAR/dsh-plugin-manager/lib/index.js:69-82` (`parseInstallSpec`):
```js
const path = spec.replace(/^(?:file|link):/, "");
if (path !== spec || isAbsolute(path)) {
    if (!isAbsolute(path)) throw invalid(spec, "a local path must be absolute");
    return TARBALL_SPEC.test(path) ? {kind:"tarball",…} : {kind:"path", spec, path};
}
```
i.e. `link:C:/…` / `file:C:/…` / a bare absolute path are all accepted; **relative paths are refused**
("a local path must be absolute").

And `inspect` pre-validates a local path — `ASAR/dsh-plugin-manager/lib/index.js:1855-1868`:
```js
if (!existsSync(parsed.path)) return refused("not-a-package", "the path does not exist");
read = JSON.parse(await readFile(join(parsed.path, "package.json"), "utf8"));   // must be a package
if (inspection.name === void 0) return refused("not-a-package", "the package.json names no package");
if (!inspection.bundle) return refused("not-a-bundle", `${inspection.name} declares no dsh.bundle`);
```

### 5.2 The hard limit that answers the question

**A package without `dsh.bundle` is refused before anything installs** — the `not-a-bundle` check
above, and again post-install at `ASAR/dsh-plugin-manager/lib/index.js:2074`
(`if (manifest?.dsh?.bundle === void 0) throw new ManagementFailure("not-bundle")`).
The README states this as a designed limitation (`ASAR/dsh-client-ui-plugin-manager/README.md`,
Known Limitations):

> "**Only bundles are managed** — a dependency without a bundle patch is refused before it installs;
> one the profile already holds is left off the page unless the profile selects it, and **loading
> plain plugin modules stays a file operation**."

So:

| Intent | UI can do it? |
|---|---|
| Install a local plugin **that declares `dsh.bundle.patch`** (Path B) | **Yes** — enter `%USERPROFILE%\dsh-better-sidebar` in Add plugin |
| Turn it on/off, edit its config page, uninstall | **Yes** |
| Toggle an individual *row* of a bundle (`pluginManager.setPluginEnabled` writes `disabled:` into `PROFILE\cordis.patch.yml` under the toggle rules) | **Yes** |
| Install a bare module with no `dsh.bundle` (Path A, profile-patch row only) | **No** — refused with `not-a-bundle`; you must edit `PROFILE\cordis.patch.yml` by hand |
| Add a patch row for a plugin you installed yourself | **No UI** — hand-edit `cordis.patch.yml` |
| Install from a plugin *market* index (Discover tab) | **Yes**, but that needs a third-party index source configured; not applicable to local dev |

**⇒ Consequence for the better-sidebar plugin: if you want the Plugins panel to show/manage it,
package it as a real bundle (Path B: `dsh.bundle.patch` + own `cordis.patch.yml` + `dsh.client`) and
install it via **Add plugin → local absolute directory**. That gets you a card, an on/off switch, and
uninstall — all without hand-editing profile files.**

### 5.3 Extra UI facts worth knowing

- The UI **cannot** disable its own management components
  (`ASAR/dsh-plugin-manager/README.md`, Known Limitations: "The manager cannot disable its own
  management components, change another profile, or edit an agent preset's composition.")
- **Desktop package operations are owned by the Desktop shell** — same README: "Desktop package
  operations remain owned by the Desktop shell." The profile's package manager is the **bundled**
  pnpm, not the user's `pnpm` on `PATH` —
  `ASAR/dsh-desktop-host/lib/cli.js` `runDesktopCli` passes
  `command: process.execPath, args: ["--expose-internals", …/runtime/dependencies/pnpm/bin/pnpm.mjs]`,
  and `runtime.json` pins `pnpm: 11.28.5`. Manual `pnpm add` in the profile dir with the *user's*
  pnpm 11.22.0 also works (that is how `anchored-standard` was linked), but the two can disagree on
  lockfile metadata.
- **`dsh plugin` CLI cannot manage the desktop profile** unless invoked through the Desktop-installed
  carrier — `ASAR/dsh/README.md`: "The `desktop` name is reserved for the Electron-owned profile, so
  the CLI rejects boot and config-dump requests for it. The npm CLI also rejects its
  plugin-management requests; the Desktop-installed command can manage the initialized Desktop
  profile using that installation's runtime." Enforced at `ASAR/dsh/lib/bin.js:119`
  (`if (!manageDesktopProfile) rejectElectronProfile(plugin, options.profile)`), and only
  `dsh-desktop-host/lib/cli.js` sets `manageDesktopProfile: true`.
  ⇒ **from a plain shell, hand-editing files is the only route**; `dsh plugin --profile desktop add …`
  will refuse.
- Installation is **not** activation — `ASAR/dsh-client-ui-plugin-manager/README.md`: "A successful
  installation does not certify that a module can activate."
- A bundle that provides the management components is **locked** (cannot be switched off);
  `ASAR/dsh-plugin-manager/README.md`: "Management bundles remain protected if their files become
  unreadable."
- Install writes are transactional-ish: failure/cancel restores `package.json` and `pnpm-lock.yaml`
  (but **not** `pnpm-workspace.yaml`), and downloaded files may remain.

---

## Appendix A — Quick reference card

```jsonc
// %USERPROFILE%\dsh-better-sidebar\package.json   (Path B: bundle, UI-installable)
{
  "name": "dsh-better-sidebar",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./index.js",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "immediately": true, "inject": [] }
  }
}
```
```js
// index.js — host half; empty is fine for a pure-UI plugin
export function apply() {}
```
```js
// client.js — browser half; MUST register under the bare package name
window.__ModuleLoader__.load({
  id: 'dsh-better-sidebar',
  factory: (require) => {
    const module = { exports: {} }
    const exports = module.exports
    const React = require('react')          // only platform-seed modules may be required
    const inject = ['slots', 'locale']      // Cordis services, NOT dsh.client.inject
    function apply(ctx) { /* ctx.slots.inject(...) */ }
    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
```
```yaml
# %USERPROFILE%\dsh-better-sidebar\cordis.patch.yml — mounted by dsh.bundle.patch
- insert:
    - id: better-sidebar
      name: 'dsh-better-sidebar'     # bare package name ⇒ browser half attaches
      config: {}
```

Checks before restarting:

- [ ] `PROFILE\package.json` has `"dsh-better-sidebar": "link:%USERPROFILE%/dsh-better-sidebar"`
- [ ] `PROFILE\node_modules\dsh-better-sidebar` exists and is a **real symlink** (not a junction)
- [ ] Path B: `dsh.profile.bundles` contains it. Path A: `PROFILE\cordis.patch.yml` has the row.
- [ ] No `engines.dsh` and no `@deepseek-ai/dsh*` `peerDependencies` (unless intentional)
- [ ] `client.js` requires only seed modules (`react`, `react/jsx-runtime`, `react-dom`, `zod`,
      `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`, `-ui-slots`, `-ui-primitives`,
      `-ui-dockkit`, `@tanstack/react-virtual`)
- [ ] Only **one** loader row resolves to this package name

## Appendix B — Things I could NOT determine

1. **Whether a live (HMR) recomposition can add a brand-new `link:` without a restart** (§3.5). The
   code looks permissive for *additive* profile mappings, but I did not exercise it against the live
   profile (read-only mandate).
2. **Whether `dsh.client.inject` is intended as module-arrival or service injection.** Every piece of
   code treats it as module-arrival (§1.3); the name suggests otherwise. No doc in the shipped tree
   states the intent.
3. **Whether the `platform` field accepts anything but `"web"`.** Validation accepts any string, but
   resolution requires exactly `"web"` (`lib/index.js:733`), and all 79 shipped declarations use
   `"web"`. Whether other values are reserved for future shells is not stated.
4. **Why `PROFILE\cordis.patch.yml` targets a `dsh-soul-md` row** that does not exist in the
   installation or the profile `node_modules` — presumably a plugin that was removed; its patch is a
   live no-op warning. Not investigated further (out of scope).
5. **The exact pnpm version that produced the current lockfile** — `.modules.yaml` says
   `pnpm@11.28.5` (the bundled one), while several logs show `using pnpm v11.7.0`. Mixed history;
   does not affect packaging.
