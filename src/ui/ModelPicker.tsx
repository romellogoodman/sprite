import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { MODELS } from "../models.js";

type Props = {
  current: string;
  onConfirm: (id: string) => void;
  onCancel: () => void;
};

export function ModelPicker({ current, onConfirm, onCancel }: Props) {
  const initial = Math.max(
    0,
    MODELS.findIndex((m) => m.id === current),
  );
  const [selected, setSelected] = useState(initial);

  useInput((_, key) => {
    if (key.upArrow) setSelected((i) => (i - 1 + MODELS.length) % MODELS.length);
    else if (key.downArrow) setSelected((i) => (i + 1) % MODELS.length);
    else if (key.return) onConfirm(MODELS[selected].id);
    else if (key.escape) onCancel();
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
    >
      <Text bold>Select model</Text>

      <Box flexDirection="column" marginTop={1}>
        {MODELS.map((m, i) => {
          const isCurrent = m.id === current;
          const isHover = i === selected;
          return (
            <Text key={m.id} color={isHover ? "cyan" : undefined}>
              {isHover ? "› " : "  "}
              <Text bold={isHover || isCurrent}>{m.label}</Text>
              {isCurrent ? " ✓" : ""}
            </Text>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>↑↓ · enter · esc</Text>
      </Box>
    </Box>
  );
}
