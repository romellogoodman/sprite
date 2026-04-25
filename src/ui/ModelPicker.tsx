import { Box, Text } from "ink";
import { MODELS, type ModelTier } from "../models.js";

/**
 * Read-only view. The App-level `useInput` handler translates the numeric
 * keypress to an index in MODELS and calls `onPick` — putting that logic
 * here would duplicate the pattern BashConfirm already uses.
 */
export function ModelPicker({ current }: { current: string }) {
  const groups: { tier: ModelTier; header: string }[] = [
    { tier: "current", header: "Current" },
    { tier: "legacy", header: "Legacy" },
    { tier: "deprecated", header: "Deprecated" },
  ];

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <Text>
        Pick a model <Text dimColor>(current: {current})</Text>
      </Text>

      {groups.map((g) => {
        const items = MODELS.map((m, i) => ({ m, i })).filter(
          (x) => x.m.tier === g.tier,
        );
        if (items.length === 0) return null;
        return (
          <Box key={g.tier} flexDirection="column" marginTop={1}>
            <Text dimColor>{g.header}</Text>
            {items.map(({ m, i }) => {
              const isCurrent = m.id === current;
              const ctx =
                m.contextWindow >= 1_000_000
                  ? "1M"
                  : `${Math.round(m.contextWindow / 1000)}K`;
              return (
                <Text key={m.id}>
                  <Text color="cyan">[{i + 1}]</Text>{" "}
                  <Text bold={isCurrent}>{m.id}</Text>
                  {isCurrent && <Text color="green"> ←</Text>}
                  <Text dimColor>
                    {"  "}
                    {ctx} · {m.description}
                  </Text>
                </Text>
              );
            })}
          </Box>
        );
      })}

      <Box marginTop={1}>
        <Text dimColor>type a number · esc to cancel</Text>
      </Box>
    </Box>
  );
}
