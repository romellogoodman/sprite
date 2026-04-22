import { useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import type Anthropic from "@anthropic-ai/sdk";
import { runTurn, type AgentEvent } from "./agent.js";
import type { BashApproval, ToolContext } from "./tools.js";
import { PromptInput } from "./PromptInput.js";
import { startSession, loadLastSession, type Session } from "./session.js";
import {
  loadApiKey,
  saveApiKey,
  clearApiKey,
  configPath,
  isBashAllowed,
  allowBashPrefix,
  suggestBashPrefix,
} from "./config.js";

type DisplayLine =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "tool"; name: string; input: string }
  | { kind: "result"; name: string; output: string; isError: boolean }
  | { kind: "error"; text: string };

type PendingBash = {
  command: string;
  resolve: (a: BashApproval) => void;
};

export function App({
  trust = false,
  resume = false,
}: { trust?: boolean; resume?: boolean }) {
  const { exit } = useApp();
  const [apiKey, setApiKey] = useState<string | undefined>(() => loadApiKey());
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [lines, setLines] = useState<DisplayLine[]>(() => {
    if (!resume) return [];
    const prev = loadLastSession();
    return prev.length > 0
      ? [{ kind: "assistant", text: `(resumed — ${prev.length} prior messages in context)` }]
      : [{ kind: "error", text: "No prior session to continue in this directory." }];
  });
  const [history, setHistory] = useState<Anthropic.MessageParam[]>(() =>
    resume ? loadLastSession() : [],
  );
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [pendingBash, setPendingBash] = useState<PendingBash | null>(null);
  const [session, setSession] = useState<Session>(() => startSession());

  const push = (line: DisplayLine) =>
    setLines((prev) => [...prev, line]);

  const toolCtx = useRef<ToolContext>({
    trust,
    isAllowed: isBashAllowed,
    allowPrefix: allowBashPrefix,
    suggestPrefix: suggestBashPrefix,
    confirmBash: (command) =>
      new Promise<BashApproval>((resolve) => {
        setPendingBash({ command, resolve });
      }),
  }).current;

  useInput(
    (ch) => {
      if (!pendingBash) return;
      const c = ch.toLowerCase();
      if (c === "y" || c === "a" || c === "n") {
        const answer: BashApproval =
          c === "y" ? "yes" : c === "a" ? "always" : "no";
        const { resolve } = pendingBash;
        setPendingBash(null);
        resolve(answer);
      }
    },
    { isActive: pendingBash !== null },
  );

  if (!apiKey) {
    return (
      <Login
        onLogin={(key) => {
          saveApiKey(key);
          setApiKey(key);
        }}
      />
    );
  }

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

    if (text === "/clear") {
      setInput("");
      setLines([]);
      setHistory([]);
      setSession(startSession());
      return;
    }

    if (text === "/logout") {
      clearApiKey();
      setInput("");
      setApiKey(undefined);
      setLines([]);
      setHistory([]);
      return;
    }

    setInput("");
    setInputHistory((h) => (h[h.length - 1] === text ? h : [...h, text]));
    setBusy(true);
    push({ kind: "user", text });

    try {
      const newHistory = await runTurn(apiKey, history, text, toolCtx, handleEvent);
      setHistory(newHistory);
      session.save(newHistory);
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
        <Text>A small helping hand inside your computer.</Text>
      </Box>

      <Box flexDirection="column" marginBottom={1}>
        {lines.map((line, i) => (
          <Line key={i} line={line} />
        ))}
      </Box>

      <Box>
        {pendingBash ? (
          <BashConfirm command={pendingBash.command} />
        ) : busy ? (
          <>
            <Text color="cyan">
              <Spinner type="dots" />
            </Text>
            <Text> working…</Text>
          </>
        ) : (
          <>
            <Text color="cyan">❯ </Text>
            <PromptInput
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              history={inputHistory}
              placeholder="ask sprite anything (or 'exit')"
            />
          </>
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

function BashConfirm({ command }: { command: string }) {
  const prefix = suggestBashPrefix(command);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text>
        sprite wants to run: <Text color="yellow">{command}</Text>
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          <Text color="cyan">[y]</Text> run once
        </Text>
        <Text>
          <Text color="cyan">[a]</Text> always allow{" "}
          <Text color="gray">"{prefix} …" in this project</Text>
        </Text>
        <Text>
          <Text color="cyan">[n]</Text> deny
        </Text>
      </Box>
    </Box>
  );
}

function Login({ onLogin }: { onLogin: (key: string) => void }) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (v: string) => {
    const key = v.trim();
    if (!key) return;
    if (!key.startsWith("sk-ant-")) {
      setError("That doesn't look like an Anthropic key (expected sk-ant-…).");
      return;
    }
    setError(null);
    onLogin(key);
  };

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text>A small helping hand inside your computer.</Text>
      </Box>
      <Text>No API key found. Paste your Anthropic API key:</Text>
      <Text color="gray" dimColor>
        (saved to {configPath()}; env ANTHROPIC_API_KEY overrides)
      </Text>
      <Box marginTop={1}>
        <Text color="cyan">key ❯ </Text>
        <TextInput value={value} onChange={setValue} onSubmit={submit} mask="•" />
      </Box>
      {error && (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}
    </Box>
  );
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `… (${s.length - max} more chars)`;
}
