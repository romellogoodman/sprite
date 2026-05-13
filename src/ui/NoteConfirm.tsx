import { Box, Text } from "ink";

/**
 * Approval prompt for save_note. Shows the full note so the user can vet it
 * before it lands in the persistent cross-session file — the note ends up in
 * future system prompts, so this is the gate that keeps the model from
 * writing its own instructions.
 */
export function NoteConfirm({ note }: { note: string }) {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="green"
      paddingX={1}
    >
      <Text>
        sprite wants to remember: <Text color="green">{note}</Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text color="cyan">[y]</Text> save{" "}
          <Text dimColor>— loaded into context on future sessions here</Text>
        </Text>
        <Text>
          <Text color="cyan">[n]</Text> skip
        </Text>
      </Box>
    </Box>
  );
}
