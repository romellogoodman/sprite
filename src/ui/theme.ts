/**
 * One place for every color the TUI uses (ported from lca). Ink accepts
 * chalk-style named colors; sprite uses named colors throughout so they
 * follow the user's terminal theme.
 *
 * When a diff uses red/green for -/+ lines, those stay hardcoded at the call
 * site — that's universal convention, not a theming decision.
 */

/** Main accent — prompt caret, header, pickers, selection highlights. */
export const BRAND = "cyan";

/** Accent when `plan` mode is active (shift+tab). */
export const PLAN_ACCENT = "magenta";

/** Accent when `auto` mode is active (shift+tab). */
export const AUTO_ACCENT = "green";

/** Border/text color for "wait, human attention needed" overlays and !-shell mode. */
export const WARN = "yellow";

/** Semantic: code blocks, inline backticks, keybinding hints. */
export const CODE = "cyan";
