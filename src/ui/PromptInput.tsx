import { useState, useEffect, useRef, type ReactNode } from "react";
import { Box, Text, useInput } from "ink";
import chalk from "chalk";
import { findTrigger, getCompletions, type Completion } from "../completion.js";

type Props = {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  placeholder?: string;
  /** Previously submitted prompts, oldest first. ↑/↓ cycles through these. */
  history?: string[];
  isActive?: boolean;
  /** Called on backspace-at-empty or Esc; lets the parent drop a mode. */
  onExitMode?: () => void;
  /** Rendered to the left of the input line (e.g. "❯ " or "! "). */
  prefix?: ReactNode;
};

const PASTE_START = "[200~";
const PASTE_END = "[201~";

/**
 * Single-line text input for the main prompt. Replaces ink-text-input so we
 * can own cursor placement (history recall) and handle bracketed paste:
 * multi-line pastes collapse to a `[Pasted #n N lines]` token in the visible
 * line and are expanded back to their full contents on submit.
 */
export function PromptInput({
  value,
  onChange,
  onSubmit,
  placeholder = "",
  history = [],
  isActive = true,
  onExitMode,
  prefix,
}: Props) {
  const [cursor, setCursor] = useState(value.length);
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [pastes, setPastes] = useState<string[]>([]);
  const [compSel, setCompSel] = useState(0);
  const [compDismissed, setCompDismissed] = useState(false);
  const inPaste = useRef(false);
  const pasteBuf = useRef("");

  const trigger = compDismissed ? null : findTrigger(value, cursor);
  const completions: Completion[] = trigger ? getCompletions(trigger) : [];
  const showCompletions = completions.length > 0;

  useEffect(() => {
    if (cursor > value.length) setCursor(value.length);
  }, [value, cursor]);

  useEffect(() => {
    process.stdout.write("\x1b[?2004h");
    return () => {
      process.stdout.write("\x1b[?2004l");
    };
  }, []);

  const setValue = (v: string, c: number) => {
    onChange(v);
    setCursor(Math.max(0, Math.min(c, v.length)));
    setCompDismissed(false);
    setCompSel(0);
  };

  const acceptCompletion = () => {
    if (!trigger || !completions[compSel]) return;
    const picked = completions[compSel].value;
    const tail = picked.endsWith("/") ? "" : " ";
    const next = value.slice(0, trigger.start) + picked + tail + value.slice(trigger.end);
    setValue(next, trigger.start + picked.length + tail.length);
  };

  const insert = (text: string) => {
    setHistoryIdx(null);
    setValue(value.slice(0, cursor) + text + value.slice(cursor), cursor + text.length);
  };

  const finishPaste = (raw: string) => {
    const text = raw.replace(/\r\n?/g, "\n");
    if (!text.includes("\n") && text.length < 200) return insert(text);
    const n = pastes.length + 1;
    const lines = text.split("\n").length;
    setPastes((p) => [...p, text]);
    insert(`[Pasted #${n} ${lines} line${lines === 1 ? "" : "s"}]`);
  };

  const expandPastes = (v: string): string =>
    v.replace(/\[Pasted #(\d+) \d+ lines?\]/g, (m, n) => pastes[Number(n) - 1] ?? m);

  const recall = (dir: 1 | -1) => {
    if (history.length === 0) return;
    if (historyIdx === null) {
      if (dir === 1) return;
      setDraft(value);
      const i = history.length - 1;
      setHistoryIdx(i);
      setValue(history[i]!, history[i]!.length);
      return;
    }
    const next = historyIdx + dir;
    if (next < 0) return;
    if (next >= history.length) {
      setHistoryIdx(null);
      setValue(draft, draft.length);
      return;
    }
    setHistoryIdx(next);
    setValue(history[next]!, history[next]!.length);
  };

  useInput(
    (input, key) => {
      // Mid-paste: buffer until the end marker shows up. Search the
      // accumulated buffer in case the marker straddles two stdin chunks.
      if (inPaste.current) {
        pasteBuf.current += input;
        const end = pasteBuf.current.indexOf(PASTE_END);
        if (end === -1) return;
        const body = pasteBuf.current.slice(0, end).replace(/\x1b$/, "");
        pasteBuf.current = "";
        inPaste.current = false;
        return finishPaste(body);
      }

      // Bracketed paste start. Ink strips the leading ESC, so the marker
      // arrives as "[200~". The end marker may be in this same chunk.
      if (input.startsWith(PASTE_START)) {
        const rest = input.slice(PASTE_START.length);
        const end = rest.indexOf(PASTE_END);
        if (end !== -1) {
          return finishPaste(rest.slice(0, end).replace(/\x1b$/, ""));
        }
        inPaste.current = true;
        pasteBuf.current = rest;
        return;
      }

      // Fallback for terminals without bracketed paste: a multi-char chunk
      // containing a newline can only be a paste — with one exception. If
      // the only newline is at the very end (a user typed fast and hit
      // Enter in the same stdin chunk, e.g. "/model\r"), treat it as text +
      // submit, not as a multi-line paste. Real pastes have interior
      // newlines and will still hit finishPaste.
      if (!key.return && input.length > 1 && /[\r\n]/.test(input)) {
        const m = input.match(/^([^\r\n]+)[\r\n]+$/);
        if (m) {
          const combined = value.slice(0, cursor) + m[1] + value.slice(cursor);
          setHistoryIdx(null);
          setDraft("");
          setPastes([]);
          onSubmit(expandPastes(combined));
          return;
        }
        return finishPaste(input);
      }

      if (key.upArrow) {
        if (showCompletions)
          return setCompSel((s) => (s - 1 + completions.length) % completions.length);
        return recall(-1);
      }
      if (key.downArrow) {
        if (showCompletions) return setCompSel((s) => (s + 1) % completions.length);
        return recall(1);
      }
      if (key.ctrl && input === "c") return;

      if (key.tab) {
        if (showCompletions) acceptCompletion();
        return;
      }

      if (key.return) {
        if (showCompletions) return acceptCompletion();
        setHistoryIdx(null);
        setDraft("");
        setPastes([]);
        onSubmit(expandPastes(value));
        return;
      }

      if (key.leftArrow) return setCursor(Math.max(0, cursor - 1));
      if (key.rightArrow) return setCursor(Math.min(value.length, cursor + 1));

      if (key.ctrl) {
        if (input === "a") setCursor(0);
        else if (input === "e") setCursor(value.length);
        else if (input === "u") setValue("", 0);
        return;
      }

      if (key.backspace || key.delete) {
        if (value.length === 0) return onExitMode?.();
        if (cursor === 0) return;
        setHistoryIdx(null);
        return setValue(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
      }

      if (key.escape) {
        if (showCompletions) return setCompDismissed(true);
        setHistoryIdx(null);
        setDraft("");
        setPastes([]);
        setValue("", 0);
        return onExitMode?.();
      }

      if (key.meta) return;

      // eslint-disable-next-line no-control-regex
      const clean = input.replace(/[\x00-\x1f\x7f]/g, "");
      if (clean) insert(clean);
    },
    { isActive },
  );

  let line: string;
  if (value.length === 0) {
    line = placeholder
      ? chalk.inverse(placeholder[0]) + chalk.dim(placeholder.slice(1))
      : chalk.inverse(" ");
  } else {
    line = "";
    let i = 0;
    for (const ch of value) {
      line += i === cursor ? chalk.inverse(ch) : ch;
      i++;
    }
    if (cursor === value.length) line += chalk.inverse(" ");
  }

  const cols = process.stdout.columns || 80;

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" height={showCompletions ? MAX_VISIBLE + 1 : 0}>
        {showCompletions && (
          <>
            <Dropdown items={completions} selected={compSel} cols={cols} />
            <Text dimColor>{"─".repeat(cols)}</Text>
          </>
        )}
      </Box>
      <Box>
        {prefix}
        <Text>{line}</Text>
      </Box>
    </Box>
  );
}

const MAX_VISIBLE = 5;

function Dropdown({
  items,
  selected,
  cols,
}: { items: Completion[]; selected: number; cols: number }) {
  const start = Math.max(0, Math.min(selected - 2, items.length - MAX_VISIBLE));
  const visible = items.slice(start, start + MAX_VISIBLE);
  const nameW = Math.min(
    Math.max(...visible.map((c) => c.value.length)) + 2,
    Math.floor(cols * 0.4),
  );
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {visible.map((c, i) => {
        const idx = start + i;
        const sel = idx === selected;
        const name = c.value.padEnd(nameW).slice(0, nameW);
        const desc = c.desc
          ? c.desc.length > cols - nameW - 4
            ? c.desc.slice(0, cols - nameW - 5) + "…"
            : c.desc
          : "";
        return (
          <Text key={idx} color={sel ? "cyan" : undefined} dimColor={!sel}>
            {name}
            {desc}
          </Text>
        );
      })}
    </Box>
  );
}
