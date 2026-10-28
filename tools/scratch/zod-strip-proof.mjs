// Resolves zod out of the extracted bundle; run tools/extract_asar.py first and
// point ASAR_OUT at its output directory.
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const asarRoot = process.env.ASAR_OUT ?? path.resolve(import.meta.dirname, '..', '..', 'asar');
const zodUrl = pathToFileURL(path.join(asarRoot, 'dsh', 'node_modules', 'zod', 'index.js')).href;
const { z } = await import(zodUrl);
const rec = z.object({ path: z.string(), title: z.string(), sessionIds: z.array(z.string()), createdAt: z.string(), updatedAt: z.string() });
const stored = { path: 'C:/x', title: 'T', sessionIds: [], createdAt: 'a', updatedAt: 'b', hidden: true, hiddenAt: '2026-01-01' };
const out = rec.parse(stored);
console.log('in :', JSON.stringify(stored));
console.log('out:', JSON.stringify(out));
console.log('hidden survived?', 'hidden' in out);
try { z.object({a:z.string()}).strict().parse({a:'1',b:2}); } catch(e){ console.log('strict() would reject extras =>', e.constructor.name); }
