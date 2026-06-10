import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Static, Text, useApp, useInput } from "ink";
import Spinner from "ink-spinner";
import type Anthropic from "@anthropic-ai/sdk";
import {
  runTurn,
  compactHistory,
  classifyCommand,
  invalidateProjectContext,
  model,
  contextWindow,
  type AgentEvent,
} from "../agent.js";
import { resolveCommand, listCommands } from "../commands.js";
import { MODELS } from "../models.js";
import {
  bash,
  summarizeInput,
  type BashApproval,
  type PermissionMode,
  type PlanDecision,
  type Question,
  type QuestionAnswer,
  type ToolContext,
  type WriteApproval,
} from "../tools.js";
import { startSession, loadLastSession, type Session } from "../session.js";
import { poem } from "../poem.js";
import { loadApiKey, saveApiKey, clearApiKey } from "../config.js";
import { PromptInput } from "./PromptInput.js";
import { BRAND, PLAN_ACCENT, AUTO_ACCENT, WARN } from "./theme.js";
import { Header } from "./Header.js";
import { Line, type DisplayLine } from "./Line.js";
import { BashConfirm } from "./BashConfirm.js";
import { WriteConfirm } from "./WriteConfirm.js";
import { NoteConfirm } from "./NoteConfirm.js";
import { ModelPicker } from "./ModelPicker.js";
import { Login } from "./Login.js";
import { QuestionPrompt } from "./QuestionPrompt.js";
import { PlanApproval } from "./PlanApproval.js";

type PendingBash = {
  command: string;
  reason?: string;
  resolve: (a: BashApproval) => void;
};
type PendingWrite = {
  path: string;
  resolve: (a: WriteApproval) => void;
};
type PendingQuestion = {
  questions: Question[];
  resolve: (a: QuestionAnswer[]) => void;
};
type PendingPlan = {
  plan: string;
  resolve: (d: PlanDecision) => void;
};
type PendingNote = {
  note: string;
  resolve: (approved: boolean) => void;
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
  const resumed = useMemo(
    () => (resume ? loadLastSession() : []),
    [resume],
  );
  const [lines, setLines] = useState<DisplayLine[]>(() => {
    if (!resume) return [];
    return resumed.length > 0
      ? [
          {
            kind: "assistant",
            text: `(resumed — ${resumed.length} prior messages in context)`,
          },
        ]
      : [
          {
            kind: "error",
            text: "No prior session to continue in this directory.",
          },
        ];
  });
  // `committedCount` is the prefix of `lines` that's been frozen into the
  // <Static> buffer so the terminal can scroll it natively. A line is safe to
  // freeze once it's guaranteed to stop mutating: users/errors on arrival,
  // tools when their output lands, assistant text once a newer line seals it.
  const committedCount = useMemo(() => {
    let n = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const isLast = i === lines.length - 1;
      const done =
        line.kind === "user" ||
        line.kind === "error" ||
        (line.kind === "tool" && line.output !== undefined) ||
        (line.kind === "assistant" && !isLast);
      if (!done) break;
      n = i + 1;
    }
    return n;
  }, [lines]);
  const [history, setHistory] = useState<Anthropic.MessageParam[]>(resumed);
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [bashMode, setBashMode] = useState(false);
  const [verbose, setVerbose] = useState(false);
  const [pendingBash, setPendingBash] = useState<PendingBash | null>(null);
  const [pendingWrite, setPendingWrite] = useState<PendingWrite | null>(null);
  const [pendingQuestion, setPendingQuestion] =
    useState<PendingQuestion | null>(null);
  const [pendingPlan, setPendingPlan] = useState<PendingPlan | null>(null);
  const [pendingNote, setPendingNote] = useState<PendingNote | null>(null);
  const [mode, setModeState] = useState<PermissionMode>("default");
  const modeRef = useRef<PermissionMode>("default");
  const setMode = (m: PermissionMode) => {
    modeRef.current = m;
    setModeState(m);
  };
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  // Re-render when the model changes so the header reflects it (model() reads
  // the env var, which React doesn't track on its own).
  const [, setModelTick] = useState(0);
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
    getMode: () => modeRef.current,
    setMode,
    confirmBash: (command, reason) =>
      new Promise<BashApproval>((resolve) => {
        setPendingBash({ command, reason, resolve });
      }),
    confirmWrite: (absPath) =>
      new Promise<WriteApproval>((resolve) => {
        setPendingWrite({ path: absPath, resolve });
      }),
    // Read the key from config at call time rather than closing over the
    // apiKey state — this ref object is built on first render, possibly
    // before login. A thrown/missing key is caught in runBash and degrades
    // to the confirmation prompt.
    classifyBash: (command, signal) =>
      classifyCommand(loadApiKey()!, command, process.cwd(), signal),
    askQuestion: (questions) =>
      new Promise<QuestionAnswer[]>((resolve) => {
        setPendingQuestion({ questions, resolve });
      }),
    approvePlan: (plan) =>
      new Promise<PlanDecision>((resolve) => {
        setPendingPlan({ plan, resolve });
      }),
    confirmNote: (note) =>
      new Promise<boolean>((resolve) => {
        setPendingNote({ note, resolve });
      }),
  }).current;

  useInput((ch, key) => {
    if (key.ctrl && ch === "o") setVerbose((v) => !v);
    // Shift+Tab cycles permission modes: default ↔ plan. Only while idle —
    // mid-turn mode flips still work at the tool layer (getMode() is live),
    // but the UX is confusing so we don't expose it here.
    if (key.shift && key.tab && !busy && !modelPickerOpen) {
      const cycle: PermissionMode[] = ["default", "plan", "auto"];
      const next =
        cycle[(cycle.indexOf(modeRef.current) + 1) % cycle.length]!;
      setMode(next);
      return;
    }
    // Esc during a turn always aborts. PromptInput's own esc handler also
    // runs, so any draft text is cleared at the same time. Picker's useInput
    // owns esc while it's open.
    if (key.escape && busy && !modelPickerOpen) {
      abortRef.current?.abort();
      setQueued(null);
      // If we were waiting on a confirmation, let the promise resolve so
      // the turn can unwind cleanly.
      if (pendingBash) {
        const { resolve } = pendingBash;
        setPendingBash(null);
        resolve("no");
      }
      if (pendingWrite) {
        const { resolve } = pendingWrite;
        setPendingWrite(null);
        resolve("no");
      }
      if (pendingQuestion) {
        const { resolve } = pendingQuestion;
        setPendingQuestion(null);
        resolve([]);
      }
      if (pendingPlan) {
        const { resolve } = pendingPlan;
        setPendingPlan(null);
        resolve({ approved: false, feedback: "user cancelled" });
      }
      if (pendingNote) {
        const { resolve } = pendingNote;
        setPendingNote(null);
        resolve(false);
      }
    }
  });

  const pickModel = (id: string) => {
    process.env.SPRITE_MODEL = id;
    setModelPickerOpen(false);
    setModelTick((t) => t + 1);
    push({
      kind: "assistant",
      text: `Model set to ${id}. New turns will use it; history stays.`,
    });
  };

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

  useInput(
    (ch) => {
      if (!pendingWrite) return;
      const c = ch.toLowerCase();
      if (c === "y" || c === "a" || c === "n") {
        const answer: WriteApproval =
          c === "y" ? "yes" : c === "a" ? "always" : "no";
        const { resolve } = pendingWrite;
        setPendingWrite(null);
        resolve(answer);
      }
    },
    { isActive: pendingWrite !== null },
  );

  useInput(
    (ch) => {
      if (!pendingNote) return;
      const c = ch.toLowerCase();
      if (c === "y" || c === "n") {
        const { resolve } = pendingNote;
        setPendingNote(null);
        resolve(c === "y");
      }
    },
    { isActive: pendingNote !== null },
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
    } else if (e.type === "retry") {
      setPhrase(`retrying (${e.attempt}/3) in ${Math.round(e.delayMs / 1000)}s`);
    } else if (e.type === "checkpoint") {
      // Snapshot mid-turn so a crash or Ctrl+C doesn't lose the tool work
      // already done; the final save after runTurn returns overwrites this.
      session.save(e.messages);
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
    setInput("");

    // A turn is already running — stash this for when it finishes. One
    // slot; a second Enter replaces the first.
    if (busyRef.current) {
      setQueued(text);
      return;
    }

    if (text === "exit" || text === "quit") {
      exit();
      return;
    }

    if (text === "/clear") {
      setLines([]);
      setHistory([]);
      setContextUsed(0);
      invalidateProjectContext();
      setSession(startSession());
      return;
    }

    if (text === "/compact") {
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
      setApiKey(undefined);
      setLines([]);
      setHistory([]);
      return;
    }

    if (text === "/model") {
      setModelPickerOpen(true);
      return;
    }

    // Allow a direct pick: /model <id> skips the picker UI.
    if (text.startsWith("/model ")) {
      const id = text.slice(7).trim();
      const picked = MODELS.find((m) => m.id === id || m.id.endsWith(id));
      if (!picked) {
        push({
          kind: "error",
          text: `Unknown model "${id}". Run /model to see the list.`,
        });
        return;
      }
      pickModel(picked.id);
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

  // One accent color drives both the prompt caret and the status line, so a
  // mode flip reads as a single signal (plan → magenta everywhere, etc.).
  const accent = bashMode
    ? WARN
    : mode === "plan"
      ? PLAN_ACCENT
      : mode === "auto"
        ? AUTO_ACCENT
        : busy
          ? "gray"
          : BRAND;
  const pct = Math.round((100 * contextUsed) / contextWindow());
  const status = [
    mode === "plan" ? "plan mode" : mode === "auto" ? "auto mode" : null,
    pct >= 60 ? `${pct}% context` : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <Box flexDirection="column">
      <Static
        items={[
          { __masthead: true } as const,
          ...lines.slice(0, committedCount),
        ]}
      >
        {(item, i) =>
          "__masthead" in item ? (
            <Header key="header" />
          ) : (
            <Line key={i} line={item} verbose={verbose} />
          )
        }
      </Static>

      <Box flexDirection="column" marginBottom={1}>
        {lines.slice(committedCount).map((line, i) => (
          <Line key={committedCount + i} line={line} verbose={verbose} />
        ))}
      </Box>

      {pendingBash ? (
        <BashConfirm
          command={pendingBash.command}
          reason={pendingBash.reason}
        />
      ) : pendingWrite ? (
        <WriteConfirm path={pendingWrite.path} />
      ) : pendingNote ? (
        <NoteConfirm note={pendingNote.note} />
      ) : pendingQuestion ? (
        <QuestionPrompt
          questions={pendingQuestion.questions}
          onComplete={(answers) => {
            const { resolve } = pendingQuestion;
            setPendingQuestion(null);
            resolve(answers);
          }}
          onCancel={() => {
            const { resolve } = pendingQuestion;
            setPendingQuestion(null);
            resolve([]);
          }}
        />
      ) : pendingPlan ? (
        <PlanApproval
          plan={pendingPlan.plan}
          onDecision={(d) => {
            const { resolve } = pendingPlan;
            setPendingPlan(null);
            resolve(d);
          }}
        />
      ) : modelPickerOpen ? (
        <ModelPicker
          current={model()}
          onConfirm={pickModel}
          onCancel={() => setModelPickerOpen(false)}
        />
      ) : (
        <Box flexDirection="column">
          {busy && (
            <Box>
              <Text color={BRAND}>
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
              <Text color={accent}>
                {bashMode ? "! " : "❯ "}
              </Text>
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
          {/* Always rendered (blank when empty) so toggling the status
              text doesn't shift the layout and jump the screen. */}
          <Text color={accent}>{status || " "}</Text>
        </Box>
      )}
    </Box>
  );
}

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
}
