import { useState } from "react";
import { Box, Text, useApp } from "ink";
import TextInput from "ink-text-input";
import type Anthropic from "@anthropic-ai/sdk";
import { runTurn, type AgentEvent } from "./agent.js";

type DisplayLine =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; input: string }
  | { kind: "result"; name: string; output: string; isError: boolean }
  | { kind: "error"; text: string };

export function App() {
  const { exit } = useApp();
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<DisplayLine[]>([]);
  const [history, setHistory] = useState<Anthropic.MessageParam[]>([]);

  const push = (line: DisplayLine) =>
    setLines((prev) => [...prev, line]);

  const handleEvent = (e: AgentEvent) => {
    if (e.type === "text") {
      push({ kind: "assistant", text: e.text });
    } else if (e.type === "tool_use") {
      push({ kind: "tool", name: e.name, input: JSON.stringify(e.input) });
    } else if (e.type === "tool_result") {
      push({
        kind: "result",
        name: e.name,
        output: truncate(e.output, 500),
        isError: e.isError,
      });
    }
  };

  const handleSubmit = async (value: string) => {
    const text = value.trim();
    if (!text || busy) return;

    if (text === "exit" || text === "quit") {
      exit();
      return;
    }

    setInput("");
    setBusy(true);
    push({ kind: "user", text });

    try {
      const newHistory = await runTurn(history, text, handleEvent);
      setHistory(newHistory);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      push({ kind: "error", text: msg });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color="gray">sprite — a small hand for file work.</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {lines.map((line, i) => (
          <Line key={i} line={line} />
        ))}
      </Box>

      <Box>
        <Text color={busy ? "gray" : "cyan"}>{busy ? "… " : "❯ "}</Text>
        {busy ? (
          <Text color="gray">thinking</Text>
        ) : (
          <TextInput
            value={input}
            onChange={setInput}
            onSubmit={handleSubmit}
            placeholder="ask sprite anything (or 'exit')"
          />
        )}
      </Box>
    </Box>
  );
}

function Line({ line }: { line: DisplayLine }) {
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
          <Text>{line.text}</Text>
        </Box>
      );
    case "tool":
      return (
        <Box marginLeft={2}>
          <Text color="yellow">⚙ {line.name}</Text>
          <Text color="gray"> {line.input}</Text>
        </Box>
      );
    case "result":
      return (
        <Box marginLeft={2} flexDirection="column">
          <Text color={line.isError ? "red" : "green"}>
            {line.isError ? "✗" : "✓"} {line.name}
          </Text>
          <Box marginLeft={2}>
            <Text color="gray" dimColor>
              {line.output}
            </Text>
          </Box>
        </Box>
      );
    case "error":
      return (
        <Box marginTop={1}>
          <Text color="red">✗ {line.text}</Text>
        </Box>
      );
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `… (${s.length - max} more chars)`;
}
