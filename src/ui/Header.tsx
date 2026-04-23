import { Box, Text } from "ink";
import { model, contextWindow } from "../agent.js";

export function Header({ contextUsed }: { contextUsed: number }) {
  const cwd = process.cwd();
  const home = process.env.HOME ?? "";
  const pretty =
    home && cwd.startsWith(home) ? "~" + cwd.slice(home.length) : cwd;
  const pct = Math.round((100 * contextUsed) / contextWindow());
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={1}
      marginTop={1}
      marginBottom={1}
    >
      <Text>
        <Text color="cyan" bold>
          sprite
        </Text>
        <Text dimColor> · a small helping hand inside your computer</Text>
      </Text>
      <Text dimColor>
        cwd: {pretty} · {model()}
        {contextUsed > 0 && (
          <Text color={pct >= 75 ? "yellow" : undefined}> · {pct}% context</Text>
        )}
      </Text>
      <Box marginTop={1}>
        <Text dimColor>
          <Text color="cyan">!</Text> shell <Text color="cyan">@</Text> file{" "}
          <Text color="cyan">/</Text> commands <Text color="cyan">↑↓</Text>{" "}
          history
        </Text>
      </Box>
    </Box>
  );
}
