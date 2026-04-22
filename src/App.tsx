import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import TextInput from "ink-text-input";
import Spinner from "ink-spinner";
import type Anthropic from "@anthropic-ai/sdk";
import {
  runTurn,
  compactHistory,
  model,
  contextWindow,
  type AgentEvent,
} from "./agent.js";
import { bash, type BashApproval, type ToolContext } from "./tools.js";
import { PromptInput } from "./PromptInput.js";
import { startSession, loadLastSession, type Session } from "./session.js";
import { poem } from "./poem.js";
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
  | {
      kind: "tool";
      id: string;
      name: string;
      input: string;
      output?: string;
      isError?: boolean;
    }
  | { kind: "error"; text: string };

type PendingBash = {
  command: string;
  resolve: (a: BashApproval) => void;
};

export function App({
  trust = false,
  resume = false,
}: {
  trust?: boolean;
  resume?: boolean;
}) {
  const { exit } = useApp();
  const [apiKey, setApiKey] = useState<string | undefined>(() => loadApiKey());
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [phrase, setPhrase] = useState("working");
  const [elapsed, setElapsed] = useState(0);
  const [tokens, setTokens] = useState({ in: 0, out: 0 });
  const [contextUsed, setContextUsed] = useState(0);
  const [lines, setLines] = useState<DisplayLine[]>(() => {
    if (!resume) return [];
    const prev = loadLastSession();
    return prev.length > 0
      ? [
          {
            kind: "assistant",
            text: `(resumed — ${prev.length} prior messages in context)`,
          },
        ]
      : [
          {
            kind: "error",
            text: "No prior session to continue in this directory.",
          },
        ];
  });
  const [history, setHistory] = useState<Anthropic.MessageParam[]>(() =>
    resume ? loadLastSession() : [],
  );
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [bashMode, setBashMode] = useState(false);
  const [verbose, setVerbose] = useState(false);
  const [pendingBash, setPendingBash] = useState<PendingBash | null>(null);
  const [session, setSession] = useState<Session>(() => startSession());

  const push = (line: DisplayLine) => setLines((prev) => [...prev, line]);

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

  useInput((input, key) => {
    if (key.ctrl && input === "o") setVerbose((v) => !v);
  });

  useEffect(() => {
    if (!busy) return;
    setElapsed(0);
    setTokens({ in: 0, out: 0 });
    const start = Date.now();
    const t = setInterval(
      () => setElapsed(Math.floor((Date.now() - start) / 1000)),
      1000,
    );
    return () => clearInterval(t);
  }, [busy]);

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
      setLines((prev) => {
        const last = prev[prev.length - 1];
        if (last?.kind === "assistant") {
          return [...prev.slice(0, -1), { ...last, text: last.text + e.text }];
        }
        return [...prev, { kind: "assistant", text: e.text }];
      });
    } else if (e.type === "tool_use") {
      push({
        kind: "tool",
        id: e.id,
        name: e.name,
        input: summarizeInput(e.name, e.input),
      });
    } else if (e.type === "usage") {
      setTokens((t) => ({ in: t.in + e.input, out: t.out + e.output }));
      setContextUsed(e.input);
    } else if (e.type === "compacted") {
      push({
        kind: "assistant",
        text: `(auto-compacted at ${e.pct}% — ${e.before} messages → summary)`,
      });
      setContextUsed(0);
    } else if (e.type === "tool_result") {
      setLines((prev) =>
        prev.map((l) =>
          l.kind === "tool" && l.id === e.id
            ? { ...l, output: e.output, isError: e.isError }
            : l,
        ),
      );
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
      setContextUsed(0);
      setSession(startSession());
      return;
    }

    if (text === "/compact") {
      setInput("");
      if (history.length === 0) {
        push({ kind: "error", text: "Nothing to compact yet." });
        return;
      }
      setPhrase(poem());
      setBusy(true);
      push({ kind: "user", text: "/compact" });
      try {
        const before = history.length;
        const compacted = await compactHistory(apiKey, history);
        setHistory(compacted);
        setContextUsed(0);
        session.save(compacted);
        push({
          kind: "assistant",
          text: `Compacted ${before} messages into a summary. Context is fresh; keep going.`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        push({ kind: "error", text: msg });
      } finally {
        setBusy(false);
      }
      return;
    }

    if (bashMode || text.startsWith("!")) {
      const cmd = bashMode ? text : text.slice(1).trim();
      setInput("");
      setBashMode(false);
      if (!cmd) return;
      setInputHistory((h) =>
        h[h.length - 1] === `!${cmd}` ? h : [...h, `!${cmd}`],
      );
      push({ kind: "user", text: `! ${cmd}` });
      try {
        push({
          kind: "tool",
          id: "",
          name: "$",
          input: cmd,
          output: bash(cmd),
          isError: false,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        push({
          kind: "tool",
          id: "",
          name: "$",
          input: cmd,
          output: msg,
          isError: true,
        });
      }
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
    setPhrase(poem());
    setBusy(true);
    push({ kind: "user", text });

    try {
      const newHistory = await runTurn(
        apiKey,
        history,
        text,
        toolCtx,
        handleEvent,
      );
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
      <Header contextUsed={contextUsed} />

      <Box flexDirection="column" marginBottom={1}>
        {lines.map((line, i) => (
          <Line key={i} line={line} verbose={verbose} />
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
            <Text dimColor> {phrase}…</Text>
            {elapsed >= 5 && (
              <Text dimColor>
                {" "}
                {elapsed}s
                {tokens.in + tokens.out > 0 &&
                  ` · ${fmtTokens(tokens.in + tokens.out)} tokens`}
              </Text>
            )}
          </>
        ) : (
          <PromptInput
            prefix={
              bashMode ? (
                <Text color="yellow">! </Text>
              ) : (
                <Text color="cyan">❯ </Text>
              )
            }
            value={input}
            onChange={(v) => {
              if (!bashMode && input === "" && v.startsWith("!")) {
                setBashMode(true);
                setInput(v.slice(1).replace(/^\s+/, ""));
                return;
              }
              setInput(v);
            }}
            onSubmit={handleSubmit}
            onExitMode={() => setBashMode(false)}
            history={inputHistory}
            placeholder={
              bashMode
                ? "run a shell command"
                : "ask sprite anything (or 'exit')"
            }
          />
        )}
      </Box>
    </Box>
  );
}

function Header({ contextUsed }: { contextUsed: number }) {
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

function Line({ line, verbose }: { line: DisplayLine; verbose: boolean }) {
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

function BashConfirm({ command }: { command: string }) {
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
      </Box>
      <Text>No API key found. Paste your Anthropic API key:</Text>
      <Text dimColor>
        (saved to {configPath()}; env ANTHROPIC_API_KEY overrides)
      </Text>
      <Box marginTop={1}>
        <Text color="cyan">key ❯ </Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={submit}
          mask="•"
        />
      </Box>
      {error && (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}
    </Box>
  );
}

/** One-line summary of a tool's input for the header, instead of raw JSON. */
function summarizeInput(name: string, input: unknown): string {
  const o = input as Record<string, unknown>;
  if (name === "read_file" || name === "list_files")
    return String(o?.path ?? "");
  if (name === "edit_file") return String(o?.path ?? "");
  if (name === "bash") return String(o?.command ?? "");
  return JSON.stringify(input);
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
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
