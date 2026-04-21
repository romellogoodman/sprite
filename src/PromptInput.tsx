import { useState, useEffect } from "react";
import { Text, useInput } from "ink";
import chalk from "chalk";

type Props = {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (v: string) => void;
  placeholder?: string;
  /** Previously submitted prompts, oldest first. ↑/↓ cycles through these. */
  history?: string[];
  isActive?: boolean;
};

/**
 * Single-line text input for the main prompt. Replaces ink-text-input so we
 * can own cursor placement (needed for history recall) and, later, paste.
 */
export function PromptInput({
  value,
  onChange,
  onSubmit,
  placeholder = "",
  history = [],
  isActive = true,
}: Props) {
  const [cursor, setCursor] = useState(value.length);
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  const [draft, setDraft] = useState("");

  useEffect(() => {
    if (cursor > value.length) setCursor(value.length);
  }, [value, cursor]);

  const setValue = (v: string, c: number) => {
    onChange(v);
    setCursor(Math.max(0, Math.min(c, v.length)));
  };

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
      if (key.upArrow) return recall(-1);
      if (key.downArrow) return recall(1);
      if (key.ctrl && input === "c") return;
      if (key.tab) return;

      if (key.return) {
        setHistoryIdx(null);
        setDraft("");
        onSubmit(value);
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
        if (cursor === 0) return;
        setHistoryIdx(null);
        return setValue(value.slice(0, cursor - 1) + value.slice(cursor), cursor - 1);
      }

      if (key.meta || key.escape) return;

      // eslint-disable-next-line no-control-regex
      const clean = input.replace(/[\x00-\x1f\x7f]/g, "");
      if (clean) {
        setHistoryIdx(null);
        setValue(value.slice(0, cursor) + clean + value.slice(cursor), cursor + clean.length);
      }
    },
    { isActive },
  );

  if (value.length === 0) {
    const ph = placeholder
      ? chalk.inverse(placeholder[0]) + chalk.grey(placeholder.slice(1))
      : chalk.inverse(" ");
    return <Text>{ph}</Text>;
  }

  let out = "";
  let i = 0;
  for (const ch of value) {
    out += i === cursor ? chalk.inverse(ch) : ch;
    i++;
  }
  if (cursor === value.length) out += chalk.inverse(" ");
  return <Text>{out}</Text>;
}
