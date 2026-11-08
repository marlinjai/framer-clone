/** Type surface of validate.mjs (the dependency-free Agent Plugin validator). */
export interface PluginValidationResult {
  errors: string[];
  warnings: string[];
}
export const DEFAULT_PLUGIN_DIR: string;
export const DEFAULT_MIRROR_DIR: string;
export function validatePlugin(pluginDir?: string): PluginValidationResult;

/**
 * Checks the public mirror's Claude Code files (.claude-plugin/plugin.json,
 * .claude-plugin/marketplace.json, .mcp.json, LICENSE) against the payload: one
 * version everywhere, the same servers, address and headers, no file in both.
 */
export function validateMirror(pluginDir: string, mirrorDir: string): PluginValidationResult;

/**
 * A frontmatter value: a scalar, a sequence of scalars, a one-level mapping, or
 * null when the shape is deeper than the Agent Skills field set models.
 */
export type FrontmatterValue = string | string[] | Record<string, string | string[] | null> | null;

/**
 * Reads the YAML frontmatter of a SKILL.md. Accepts block scalars (">" and "|"
 * with chomping and indentation indicators), quoted and plain continuations, and
 * block sequences. Appends one message per unreadable line to `errors`, prefixed
 * with `file`. Returns undefined when there is no frontmatter at all.
 */
export function parseFrontmatter(text: string, file: string, errors: string[]): Record<string, FrontmatterValue> | undefined;
