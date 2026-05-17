import { Box, Text } from "ink";
import { suggestWriteDir } from "../config.js";

/**
 * Confirmation dialog shown when `edit_file` wants to write to a path
 * outside the workspace. Parallel to BashConfirm: same y/a/n pattern, same
 * layout, same key bindings (handled in App.tsx).
 *
 * "always" saves the directory shown here to `projects.json` so subsequent
 * writes into that subtree are silent. The dir comes from `suggestWriteDir`,
 * which picks the shallowest directory that doesn't yet exist (the root of
 * the new project being scaffolded), falling back to the immediate parent.
 */
export function WriteConfirm({ path: targetPath }: { path: string }) {
  const dir = suggestWriteDir(targetPath);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="yellow"
      paddingX={1}
    >
      <Text>
        sprite wants to write: <Text color="yellow">{targetPath}</Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text color="cyan">[y]</Text> write once
        </Text>
        <Text>
          <Text color="cyan">[a]</Text> always allow writes under{" "}
          <Text dimColor>"{dir}" in this project</Text>
        </Text>
        <Text>
          <Text color="cyan">[n]</Text> deny
        </Text>
      </Box>
    </Box>
  );
}
