import { Box, Text } from "ink";
import { Markdown } from "./Markdown.js";

export type DisplayLine =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      input: string;
      output?: string;
      isError?: boolean;
    }
  | { kind: "error"; text: string };

export function Line({
  line,
  verbose,
}: {
  line: DisplayLine;
  verbose: boolean;
}) {
  switch (line.kind) {
    case "user":
      return (
        <Box marginTop={1}>
          <Text color="cyan">❯ </Text>
          <Text>{line.text}</Text>
        </Box>
      );
    case "assistant":
      return (
        <Box marginTop={1} flexDirection="column">
          <Markdown>{line.text}</Markdown>
        </Box>
      );
    case "tool": {
      const done = line.output !== undefined;
      const color = !done ? "yellow" : line.isError ? "red" : "green";
      return (
        <Box marginLeft={2} marginTop={1} flexDirection="column">
          <Text>
            <Text color={color}>●</Text> <Text bold>{line.name}</Text>
            {line.input ? <Text dimColor> {line.input}</Text> : null}
          </Text>
          {done && (
            <Box marginLeft={2} flexDirection="column">
              <ToolOutput text={verbose ? line.output! : clip(line.output!)} />
            </Box>
          )}
        </Box>
      );
    }
    case "error":
      return (
        <Box marginTop={1}>
          <Text color="red">✗ {line.text}</Text>
        </Box>
      );
  }
}

function ToolOutput({ text }: { text: string }) {
  return (
    <>
      {text.split("\n").map((l, i) => {
        if (l.startsWith("+ ")) {
          return (
            <Text key={i} backgroundColor="#1c3b1c" color="greenBright">
              {l}
            </Text>
          );
        }
        if (l.startsWith("- ")) {
          return (
            <Text key={i} backgroundColor="#4a1e1e" color="redBright">
              {l}
            </Text>
          );
        }
        return (
          <Text key={i} dimColor>
            {l || " "}
          </Text>
        );
      })}
    </>
  );
}

/** Trim tool output for display: first 6 lines, note how many were hidden. */
function clip(s: string): string {
  const lines = s.replace(/\s+$/, "").split("\n");
  if (lines.length <= 6) return lines.join("\n");
  return (
    lines.slice(0, 6).join("\n") +
    `\n… +${lines.length - 6} more lines (ctrl + o)`
  );
}
