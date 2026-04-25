/**
 * The catalog of Claude models sprite knows about. Mirrors
 * https://platform.claude.com/docs/en/about-claude/models/overview — keep
 * in sync when a new model ships. Older generations are intentionally
 * omitted; pass --model <id> to use one anyway.
 *
 * `id` is the Claude API alias (the short form, not the dated snapshot).
 * Sprite reads/writes this as SPRITE_MODEL; unknown ids still work (the
 * API accepts them) but fall back to a 200K context window.
 */
export type ModelInfo = {
  id: string;
  label: string;
  contextWindow: number;
  description: string;
  /** USD per million input tokens. */
  priceIn: number;
  /** USD per million output tokens. */
  priceOut: number;
};

export const MODELS: ModelInfo[] = [
  {
    id: "claude-opus-4-7",
    label: "Opus 4.7",
    contextWindow: 1_000_000,
    description: "Most capable — complex reasoning and agentic coding",
    priceIn: 5,
    priceOut: 25,
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    contextWindow: 1_000_000,
    description: "Best balance of speed and intelligence",
    priceIn: 3,
    priceOut: 15,
  },
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    contextWindow: 200_000,
    description: "Fastest with near-frontier intelligence",
    priceIn: 1,
    priceOut: 5,
  },
];

export function findModel(id: string): ModelInfo | undefined {
  return MODELS.find((m) => m.id === id);
}
