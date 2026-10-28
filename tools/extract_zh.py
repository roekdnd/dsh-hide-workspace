import io, re, json, os

# ASAR_ROOT points at the directory produced by extract_asar.py.
ASAR_ROOT = os.environ.get("ASAR_OUT", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "asar"))
src = os.path.join(ASAR_ROOT, "dsh", "node_modules", "@deepseek-ai",
                 "dsh-client-ui-workspace", "lib", "client.js")
s = io.open(src, encoding="utf-8", errors="replace").read()

start = s.find("const zh = {")
end = s.find("const en = {")
seg = s[start:end]

# pattern: "key": "value"  (value may contain escaped quotes)
pat = re.compile(r'"([A-Za-z0-9_.]+)":\s*"([^"]*)"')
pairs = pat.findall(seg)

want = [
    "section.workspaces", "viewOptions.hideArchived", "viewOptions.showArchived",
    "viewOptions.onlyArchived", "delete.workspace", "rename", "delete.desc",
    "menu.archiveSession", "menu.unarchiveSession", "row.archived",
    "empty.noneArchived", "filterBy.label", "workspace.add", "menu.addWorkspace",
    "actions.workspace.aria", "viewOptions.label",
]
out = {k: v for k, v in pairs if k in want}

dst = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "docs", "research", "zh-strings.json")
io.open(dst, "w", encoding="utf-8").write(json.dumps(out, ensure_ascii=False, indent=2))
print(json.dumps(out, ensure_ascii=False, indent=2))
