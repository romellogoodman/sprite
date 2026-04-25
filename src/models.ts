/**
 * The catalog of Claude models sprite knows about. Mirrors
 * https://platform.claude.com/docs/en/about-claude/models/overview — keep
 * in sync when a new model ships or a retirement date arrives.
 *
 * `id` is the Claude API alias (the short form, not the dated snapshot).
 * Sprite reads/writes this as SPRITE_MODEL; unknown ids still work (the
 * API accepts them) but fall back to a 200K context window.
 */
export type ModelTier = "current" | "legacy" | "deprecated";

export type ModelInfo = {
  id: string;
  label: string;
  contextWindow: number;
  description: string;
  tier: ModelTier;
};

export const MODELS: ModelInfo[] = [
  {
    id: "claude-opus-4-7",
    label: "Opus 4.7",
    contextWindow: 1_000_000,
    description: "most capable; complex reasoning & agentic coding",
    tier: "current",
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    contextWindow: 1_000_000,
    description: "best balance of speed and intelligence",
    tier: "current",
  },
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    contextWindow: 200_000,
    description: "fastest with near-frontier intelligence",
    tier: "current",
  },
  {
    id: "claude-opus-4-6",
    label: "Opus 4.6",
    contextWindow: 1_000_000,
    description: "previous Opus generation",
    tier: "legacy",
  },
  {
    id: "claude-sonnet-4-5",
    label: "Sonnet 4.5",
    contextWindow: 200_000,
    description: "previous Sonnet generation",
    tier: "legacy",
  },
  {
    id: "claude-opus-4-5",
    label: "Opus 4.5",
    contextWindow: 200_000,
    description: "earlier Opus 4 generation",
    tier: "legacy",
  },
  {
    id: "claude-opus-4-1",
    label: "Opus 4.1",
    contextWindow: 200_000,
    description: "earlier Opus 4 generation",
    tier: "legacy",
  },
  {
    id: "claude-sonnet-4-0",
    label: "Sonnet 4",
    contextWindow: 200_000,
    description: "retires 2026-06-15",
    tier: "deprecated",
  },
  {
    id: "claude-opus-4-0",
    label: "Opus 4",
    contextWindow: 200_000,
    description: "retires 2026-06-15",
    tier: "deprecated",
  },
];

export function findModel(id: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id);
}
