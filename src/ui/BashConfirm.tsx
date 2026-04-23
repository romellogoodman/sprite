import { Box, Text } from "ink";
import { suggestBashPrefix } from "../config.js";

export function BashConfirm({ command }: { command: string }) {
  const prefix = suggestBashPrefix(command);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
    >
      <Text>
        sprite wants to run: <Text color="yellow">{command}</Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text color="cyan">[y]</Text> run once
        </Text>
        <Text>
          <Text color="cyan">[a]</Text> always allow{" "}
          <Text dimColor>"{prefix} …" in this project</Text>
        </Text>
        <Text>
          <Text color="cyan">[n]</Text> deny
        </Text>
      </Box>
    </Box>
  );
}
