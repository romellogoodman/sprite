import { useState } from "react";
import { Box, Text, useInput } from "ink";
import { MODELS } from "../models.js";

type Props = {
  current: string;
  onConfirm: (id: string) => void;
  onCancel: () => void;
};

const LABEL_WIDTH = 14;

/**
 * Arrow-key picker. Owns its own selection state and input handling so App
 * doesn't have to juggle per-key handlers. Highlights the current model
 * with a checkmark, the hovered row with a caret.
 */
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
      <Text dimColor>Switch for this session — history stays.</Text>

      <Box flexDirection="column" marginTop={1}>
        {MODELS.map((m, i) => {
          const isCurrent = m.id === current;
          const isHover = i === selected;
          const ctx =
            m.contextWindow >= 1_000_000
              ? "1M context"
              : `${Math.round(m.contextWindow / 1000)}K context`;
          const price = `$${m.priceIn}/$${m.priceOut} per Mtok`;
          const tail = `${m.description} · ${ctx} · ${price}`;

          return (
            <Box key={m.id} flexDirection="row">
              <Box width={2}>
                <Text color="cyan">{isHover ? "›" : " "}</Text>
              </Box>
              <Box width={LABEL_WIDTH}>
                <Text
                  color={isHover ? "cyan" : undefined}
                  bold={isHover || isCurrent}
                >
                  {m.label}
                  {isCurrent ? " ✓" : ""}
                </Text>
              </Box>
              <Box flexGrow={1}>
                <Text dimColor={!isHover}>{tail}</Text>
              </Box>
            </Box>
          );
        })}
      </Box>

      <Box marginTop={1}>
        <Text dimColor>↑↓ to move · enter to confirm · esc to cancel</Text>
      </Box>
    </Box>
  );
}
