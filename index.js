/**
 * Host half of dsh-hide-workspace.
 *
 * Pure-UI plugin: this empty `apply` exists only so the plugin appears in the host
 * cordis.yml / Loader. The browser half ships via `exports["./client"]`, discovered
 * through the package.json `dsh.client` declaration.
 */
export function apply() {}
