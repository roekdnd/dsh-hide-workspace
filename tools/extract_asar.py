import struct, json, os

# Both locations come from the environment so this file carries no machine paths.
#   DSH_INSTALL  directory holding the DeepSeek Harness install (contains resources/app.asar)
#   ASAR_OUT     directory to extract into
DSH_INSTALL = os.environ.get("DSH_INSTALL")
ASAR_OUT = os.environ.get("ASAR_OUT", os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "asar"))
if not DSH_INSTALL:
    raise SystemExit("set DSH_INSTALL to the DeepSeek Harness install directory")

asar = os.path.join(DSH_INSTALL, "resources", "app.asar")
out  = ASAR_OUT

f = open(asar,'rb')
_, headerSize, paddedStrLen, jsonLen = struct.unpack('<IIII', f.read(16))
hdr = json.loads(f.read(jsonLen).decode('utf-8'))
base = 8 + headerSize

def walk(node, path=''):
    for name, meta in node.get('files', {}).items():
        p = os.path.join(path, name)
        if 'files' in meta:
            yield from walk(meta, p)
        else:
            yield p, meta

os.makedirs(out, exist_ok=True)
n = skip = 0
for rel, meta in walk(hdr):
    dest = os.path.join(out, rel)
    if meta.get('unpacked'):
        skip += 1
        continue
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    f.seek(base + int(meta['offset']))
    with open(dest,'wb') as o:
        o.write(f.read(int(meta['size'])))
    n += 1
print("extracted", n, "skipped(unpacked)", skip)
