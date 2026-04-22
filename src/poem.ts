const adjectives = [
  "quiet", "patient", "silver", "slow", "small", "steady", "soft",
  "careful", "bright", "warm", "low", "still", "gentle", "early",
  "hollow", "narrow", "loose", "spare", "faint", "clear",
];

const nouns = [
  "river", "thread", "stone", "light", "hand", "page", "window",
  "wire", "lantern", "field", "signal", "margin", "current",
  "ember", "hinge", "ink", "frame", "channel", "grain", "line",
];

const verbs = [
  "thinking", "turning", "reading", "listening", "tracing",
  "sorting", "reaching", "weighing", "untangling", "gathering",
  "holding", "following", "mending", "sifting", "measuring",
  "unwinding", "considering", "mapping", "settling", "working",
];

function pick<T>(xs: readonly T[]): T {
  return xs[Math.floor(Math.random() * xs.length)]!;
}

/** A three-word imagist phrase for the busy spinner. */
export function poem(): string {
  return `${pick(adjectives)} ${pick(nouns)} ${pick(verbs)}`;
}
