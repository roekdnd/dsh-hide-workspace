// Minimal reimplementation of the SlotCore single-slot semantics found in
// dsh-web-frontend/dist/assets/index-BXV-oxvX.js (register()/entriesOfSlot()).
// Purpose: prove that a lower `priority` shadows a shipped single-slot entry.
const entries = [];
function register(opts) {
  const p = opts.priority ?? 0;
  if (entries.find(e => (e.options.priority ?? 0) === p))
    throw new Error(`single slot "${opts.name}" already has an entry at priority ${p} - register at a different priority to shadow it (lowest renders)`);
  entries.push({ options: opts });
  // real impl: sort ascending by priority for non-list kinds
  entries.sort((a,b) => (a.options.priority ?? 0) - (b.options.priority ?? 0));
}
function entriesOfSlot() { return entries; }   // single: no id dedupe
function renders() { return entriesOfSlot()[0]?.options.id; }  // renderer L1174

// 1) upstream ui-workspace registers at default priority (0)
register({ name: 'sidebar.workspaces', id: 'ui-workspace-shipped' });
console.log('after upstream only -> renders:', renders());

// 2) our plugin registers at LOWER priority (-100)
register({ name: 'sidebar.workspaces', id: 'hide-workspace', priority: -100 });
console.log('after our -100 plugin -> renders:', renders());

// 3) same priority must throw (proves you cannot naively double-register)
try { register({ name: 'sidebar.workspaces', id: 'naive' }); }
catch (e) { console.log('same-priority register -> THROWS:', e.message); }
