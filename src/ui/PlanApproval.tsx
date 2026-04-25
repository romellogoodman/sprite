import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { PlanDecision } from "../tools.js";

/**
 * Shows a plan (markdown string) and collects approve / reject.
 * On reject, drops into a freeform input so the user can type feedback that
 * goes back to the model as the tool result.
 */
export function PlanApproval({
  plan,
  onDecision,
}: {
  plan: string;
  onDecision: (d: PlanDecision) => void;
}) {
  const [mode, setMode] = useState<"prompt" | "feedback">("prompt");
  const [feedback, setFeedback] = useState("");

  useInput((ch, key) => {
    if (mode === "feedback") {
      if (key.escape) {
        setMode("prompt");
        setFeedback("");
        return;
      }
      if (key.return) {
        onDecision({ approved: false, feedback: feedback.trim() });
        return;
      }
      if (key.backspace || key.delete) {
        setFeedback((t) => t.slice(0, -1));
        return;
      }
      if (ch && !key.ctrl && !key.meta) setFeedback((t) => t + ch);
      return;
    }

    const c = ch?.toLowerCase();
    if (c === "y" || key.return) {
      onDecision({ approved: true });
      return;
    }
    if (c === "n") {
      setMode("feedback");
    }
  });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1}>
      <Text color="magenta" bold>
        Plan ready for approval
      </Text>
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        {plan.split("\n").map((line, i) => (
          <Text key={i}>{line || " "}</Text>
        ))}
      </Box>
      {mode === "prompt" ? (
        <Text dimColor>
          <Text color="cyan">[y]</Text> approve & proceed ·{" "}
          <Text color="cyan">[n]</Text> reject with feedback
        </Text>
      ) : (
        <Box flexDirection="column">
          <Text dimColor>Type feedback for the model, then enter:</Text>
          <Box>
            <Text color="cyan">» </Text>
            <Text>{feedback}</Text>
            <Text color="cyan">▏</Text>
          </Box>
        </Box>
      )}
    </Box>
  );
}
