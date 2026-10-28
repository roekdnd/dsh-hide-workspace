Scratch artifacts for R3-persistence.md (safe to delete).

zod-strip-proof.mjs
  The empirical test proving zod strips unknown keys from the workspace record schema
  (see R3-persistence.md section 1.5). Run: node zod-strip-proof.mjs
  Expected output ends with:  hidden survived? false

main_extract.js  (NOT committed - regenerate it)
  The Electron main process, pulled from resources/app.asar!/lib/main.js (516716 bytes).
  It is shipped third-party code, so it is not in this repository; run
  tools/extract_asar.py and read <ASAR_OUT>/lib/main.js instead.
  It proves the desktop renderer origin is the constant custom scheme dsh-app://app
  (not http://127.0.0.1:<ephemeral-port>), which is why localStorage does NOT reset
  per launch. See R3-persistence.md section 3.3.
  Key lines in that file: 7010 (SCHEME), 11881 (registerSchemesAsPrivileged),
  12135 (applicationUrl), 12407 (protocol.handle).
