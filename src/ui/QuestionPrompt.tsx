import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Question, QuestionAnswer } from "../tools.js";

/**
 * Multiple-choice answer UI for ask_user_question. Handles one question at a
 * time; when the questions array has more, we advance through them and
 * resolve once all are answered.
 *
 * Keys: up/down to move the highlight, space to toggle (multi-select),
 * enter to accept, 'o' to pick "Other" and type a freeform answer.
 */
export function QuestionPrompt({
  questions,
  onComplete,
  onCancel,
}: {
  questions: Question[];
  onComplete: (answers: QuestionAnswer[]) => void;
  onCancel: () => void;
}) {
  const [answered, setAnswered] = useState<QuestionAnswer[]>([]);
  const current = questions[answered.length];

  const handleAnswer = (answer: string) => {
    const next = [...answered, { question: current.question, answer }];
    if (next.length === questions.length) onComplete(next);
    else setAnswered(next);
  };

  if (!current) return null;

  return (
    <SingleQuestion
      key={answered.length}
      index={answered.length}
      total={questions.length}
      question={current}
      onAnswer={handleAnswer}
      onCancel={onCancel}
    />
  );
}

function SingleQuestion({
  index,
  total,
  question,
  onAnswer,
  onCancel,
}: {
  index: number;
  total: number;
  question: Question;
  onAnswer: (answer: string) => void;
  onCancel: () => void;
}) {
  const options = question.options;
  const otherIndex = options.length; // extra "Other" slot
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [otherMode, setOtherMode] = useState(false);
  const [otherText, setOtherText] = useState("");

  const isMulti = !!question.multiSelect;

  useInput((ch, key) => {
    if (otherMode) {
      if (key.escape) {
        setOtherMode(false);
        setOtherText("");
        return;
      }
      if (key.return) {
        const v = otherText.trim();
        if (v) onAnswer(v);
        return;
      }
      if (key.backspace || key.delete) {
        setOtherText((t) => t.slice(0, -1));
        return;
      }
      if (ch && !key.ctrl && !key.meta) setOtherText((t) => t + ch);
      return;
    }

    if (key.escape) {
      onCancel();
      return;
    }
    if (key.upArrow) {
      setCursor((c) => (c - 1 + (otherIndex + 1)) % (otherIndex + 1));
      return;
    }
    if (key.downArrow) {
      setCursor((c) => (c + 1) % (otherIndex + 1));
      return;
    }
    if (ch === " " && isMulti && cursor !== otherIndex) {
      setSelected((s) => {
        const next = new Set(s);
        if (next.has(cursor)) next.delete(cursor);
        else next.add(cursor);
        return next;
      });
      return;
    }
    if (key.return) {
      if (cursor === otherIndex) {
        setOtherMode(true);
        return;
      }
      if (isMulti) {
        const picks = selected.has(cursor)
          ? [...selected]
          : [...selected, cursor];
        if (picks.length === 0) {
          onAnswer(options[cursor].label);
          return;
        }
        const labels = picks
          .sort((a, b) => a - b)
          .map((i) => options[i].label)
          .join(", ");
        onAnswer(labels);
        return;
      }
      onAnswer(options[cursor].label);
      return;
    }
    if (ch?.toLowerCase() === "o") {
      setOtherMode(true);
    }
  });

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="magenta"
      paddingX={1}
    >
      <Box>
        <Text color="magenta" bold>
          [{question.header}]
        </Text>
        <Text> </Text>
        <Text>{question.question}</Text>
        {total > 1 && (
          <Text dimColor>
            {"  "}
            ({index + 1}/{total})
          </Text>
        )}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {options.map((opt, i) => {
          const isCursor = cursor === i && !otherMode;
          const isChecked = isMulti && selected.has(i);
          const bullet = isMulti ? (isChecked ? "[x]" : "[ ]") : isCursor ? "▸" : " ";
          return (
            <Box key={i} flexDirection="column">
              <Text color={isCursor ? "cyan" : undefined}>
                {bullet} {opt.label}
              </Text>
              <Text dimColor>    {opt.description}</Text>
            </Box>
          );
        })}
        <Text color={cursor === otherIndex && !otherMode ? "cyan" : undefined}>
          {cursor === otherIndex && !otherMode ? "▸" : " "} Other (type a freeform answer)
        </Text>
      </Box>
      {otherMode ? (
        <Box marginTop={1}>
          <Text color="cyan">» </Text>
          <Text>{otherText}</Text>
          <Text color="cyan">▏</Text>
        </Box>
      ) : (
        <Box marginTop={1}>
          <Text dimColor>
            {isMulti
              ? "space toggle · enter submit · o other · esc skip"
              : "↑↓ move · enter pick · o other · esc skip"}
          </Text>
        </Box>
      )}
    </Box>
  );
}
