import { useEffect, useRef, useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import type Anthropic from "@anthropic-ai/sdk";
import { runTurn, compactHistory, type AgentEvent } from "../agent.js";
import { resolveCommand, listCommands } from "../commands.js";
import { bash, type BashApproval, type ToolContext } from "../tools.js";
import { startSession, loadLastSession, type Session } from "../session.js";
import { poem } from "../poem.js";
import {
  loadApiKey,
  saveApiKey,
  clearApiKey,
  isBashAllowed,
  allowBashPrefix,
  suggestBashPrefix,
} from "../config.js";
import { PromptInput } from "./PromptInput.js";
import { Header } from "./Header.js";
import { Line, type DisplayLine } from "./Line.js";
import { BashConfirm } from "./BashConfirm.js";
import { Login } from "./Login.js";

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
  // `busy` drives rendering; `busyRef` is what handleSubmit reads so the
  // queue check isn't stale inside the long-lived async closure.
  const [busy, setBusyState] = useState(false);
  const busyRef = useRef(false);
  const setBusy = (v: boolean) => {
    busyRef.current = v;
    setBusyState(v);
  };
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
  const abortRef = useRef<AbortController | null>(null);
  const queuedRef = useRef<string | null>(null);
  const [queued, setQueuedState] = useState<string | null>(null);
  const setQueued = (v: string | null) => {
    queuedRef.current = v;
    setQueuedState(v);
  };
  const handleSubmitRef = useRef<(v: string) => Promise<void>>(async () => {});

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

  useInput((ch, key) => {
    if (key.ctrl && ch === "o") setVerbose((v) => !v);
    // Esc on an empty prompt cancels the turn. With text in the prompt,
    // PromptInput's own Esc handler clears it first — so it's esc-esc to
    // cancel while typing a follow-up.
    if (key.escape && busy && input === "") {
      abortRef.current?.abort();
      setQueued(null);
      // If we were waiting on a bash confirmation, let it go so the
      // confirmBash promise resolves and the turn can unwind.
      if (pendingBash) {
        const { resolve } = pendingBash;
        setPendingBash(null);
        resolve("no");
      }
    }
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

  // Drain the follow-up queue whenever a turn ends. Runs post-render so
  // handleSubmit (via the ref) sees the fresh history; an inline recursive
  // call from inside handleSubmit would reuse the stale closure and drop
  // the just-completed turn. Esc clears the queue before abort, so
  // cancelled turns don't auto-continue.
  useEffect(() => {
    if (busy || queuedRef.current === null) return;
    const next = queuedRef.current;
    setQueued(null);
    void handleSubmitRef.current(next);
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
        text: `(auto-compacted at ${e.pct}% — ${e.before} → ${e.after} messages, recent turns kept verbatim)`,
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
    if (!text) return;

    // A turn is already running — stash this for when it finishes. One
    // slot; a second Enter replaces the first.
    if (busyRef.current) {
      setInput("");
      setQueued(text);
      return;
    }

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
      setPhrase(cmd.length > 40 ? cmd.slice(0, 40) + "…" : cmd);
      setBusy(true);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const output = await bash(cmd, controller.signal);
        push({
          kind: "tool",
          id: "",
          name: "$",
          input: cmd,
          output,
          isError: false,
        });
      } catch (err) {
        if (controller.signal.aborted) {
          push({ kind: "assistant", text: "(cancelled)" });
        } else {
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
      } finally {
        abortRef.current = null;
        setBusy(false);
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

    // Custom slash commands: expand /name args to the template body and
    // send that through runTurn, but show the short form in the transcript.
    let message = text;
    if (text.startsWith("/")) {
      const sp = text.indexOf(" ");
      const name = sp === -1 ? text.slice(1) : text.slice(1, sp);
      const args = sp === -1 ? "" : text.slice(sp + 1).trim();
      const expanded = resolveCommand(name, args);
      if (expanded === undefined) {
        setInput("");
        const avail = listCommands();
        push({
          kind: "error",
          text:
            avail.length > 0
              ? `Unknown command /${name}. Available: ${avail.map((n) => `/${n}`).join(", ")}`
              : `Unknown command /${name}. Put a ${name}.md in ./.sprite/commands/ or ~/.config/sprite/commands/ to define it.`,
        });
        return;
      }
      message = expanded;
    }

    setInput("");
    setInputHistory((h) => (h[h.length - 1] === text ? h : [...h, text]));
    setPhrase(poem());
    setBusy(true);
    push({ kind: "user", text });

    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const newHistory = await runTurn(
        apiKey,
        history,
        message,
        toolCtx,
        handleEvent,
        controller.signal,
      );
      setHistory(newHistory);
      session.save(newHistory);
    } catch (err) {
      if (controller.signal.aborted) {
        push({ kind: "assistant", text: "(cancelled)" });
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        push({ kind: "error", text: msg });
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
    }
  };
  handleSubmitRef.current = handleSubmit;

  return (
    <Box flexDirection="column">
      <Header contextUsed={contextUsed} />

      <Box flexDirection="column" marginBottom={1}>
        {lines.map((line, i) => (
          <Line key={i} line={line} verbose={verbose} />
        ))}
      </Box>

      {pendingBash ? (
        <BashConfirm command={pendingBash.command} />
      ) : (
        <Box flexDirection="column">
          {busy && (
            <Box>
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
                  {" · esc to stop"}
                </Text>
              )}
            </Box>
          )}
          {queued !== null && (
            <Text dimColor>
              {"  "}↳ queued: {queued.length > 60 ? queued.slice(0, 60) + "…" : queued}
            </Text>
          )}
          <PromptInput
            prefix={
              bashMode ? (
                <Text color="yellow">! </Text>
              ) : (
                <Text color={busy ? "gray" : "cyan"}>❯ </Text>
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
                : busy
                  ? "type a follow-up · enter to queue · esc to stop"
                  : "ask sprite anything (or 'exit')"
            }
          />
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
