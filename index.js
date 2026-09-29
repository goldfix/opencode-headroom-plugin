/**
 * Conventional root entrypoint.
 *
 * OpenCode resolves a plugin referenced by filesystem path (either via
 * `plugins` in opencode.json or through `.opencode/plugins/` auto-discovery)
 * by looking for `index.*`/`server.*` directly in this directory — it does
 * NOT consult `package.json`'s `exports` field for local path references
 * (that field only applies when the plugin is installed and referenced by
 * npm package name). Keep the real implementation in src/ and re-export it
 * here so both resolution paths work.
 */
export { default } from "./src/index.js"
