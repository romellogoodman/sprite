import { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";
import { configPath } from "../config.js";

export function Login({ onLogin }: { onLogin: (key: string) => void }) {
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
