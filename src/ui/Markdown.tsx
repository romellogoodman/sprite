import { Fragment, type ReactNode } from "react";
import { Box, Text } from "ink";
import { marked, type Token, type Tokens } from "marked";

/**
 * Render a markdown string to Ink. Covers the constructs Claude actually
 * emits in a coding session: headings, bold/italic/strike, inline + fenced
 * code, links, lists (nested + ordered), blockquotes, tables, hr.
 * Anything unrecognised falls through to its raw text.
 */
export function Markdown({ children }: { children: string }) {
  const tokens = marked.lexer(children);
  return (
    <Box flexDirection="column" gap={1}>
      {tokens
        .filter((t) => t.type !== "space")
        .map((t, i) => (
          <Block key={i} token={t} />
        ))}
    </Box>
  );
}

function Block({ token }: { token: Token }): ReactNode {
  switch (token.type) {
    case "paragraph":
      return <Text>{inline(token.tokens)}</Text>;

    case "text":
      return (
        <Text>
          {"tokens" in token && token.tokens
            ? inline(token.tokens)
            : token.text}
        </Text>
      );

    case "heading": {
      const h = token as Tokens.Heading;
      return (
        <Text bold color={h.depth <= 2 ? "cyan" : undefined}>
          {"#".repeat(h.depth)} {inline(h.tokens)}
        </Text>
      );
    }

    case "code": {
      const c = token as Tokens.Code;
      return (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderDimColor
          paddingLeft={1}
        >
          {c.lang && (
            <Text dimColor italic>
              {c.lang}
            </Text>
          )}
          <Text>{c.text}</Text>
        </Box>
      );
    }

    case "blockquote": {
      const q = token as Tokens.Blockquote;
      return (
        <Box
          borderStyle="single"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderColor="gray"
          paddingLeft={1}
          flexDirection="column"
          gap={1}
        >
          {q.tokens
            .filter((t) => t.type !== "space")
            .map((t, i) => (
              <Box key={i}>
                <Text dimColor>
                  <Block token={t} />
                </Text>
              </Box>
            ))}
        </Box>
      );
    }

    case "list":
      return <List token={token as Tokens.List} />;

    case "table":
      return <Table token={token as Tokens.Table} />;

    case "hr":
      return <Text dimColor>{"─".repeat(40)}</Text>;

    case "html":
      return <Text dimColor>{token.raw.replace(/\n$/, "")}</Text>;

    case "space":
      return null;

    default:
      return <Text>{"raw" in token ? token.raw : ""}</Text>;
  }
}

function List({ token }: { token: Tokens.List }) {
  const start = typeof token.start === "number" ? token.start : 1;
  return (
    <Box flexDirection="column">
      {token.items.map((item, i) => {
        const [head, ...rest] = item.tokens;
        const marker = token.ordered ? `${start + i}.` : "•";
        return (
          <Box key={i} flexDirection="column">
            <Box>
              <Box minWidth={marker.length + 1}>
                <Text color="cyan">{marker}</Text>
              </Box>
              <Box flexGrow={1}>{head && <Block token={head} />}</Box>
            </Box>
            {rest.length > 0 && (
              <Box flexDirection="column" marginLeft={marker.length + 1}>
                {rest
                  .filter((t) => t.type !== "space")
                  .map((t, j) => (
                    <Block key={j} token={t} />
                  ))}
              </Box>
            )}
          </Box>
        );
      })}
    </Box>
  );
}

function Table({ token }: { token: Tokens.Table }) {
  const widths = token.header.map((h, c) =>
    Math.max(
      plain(h.tokens).length,
      ...token.rows.map((r) => plain(r[c]?.tokens).length),
    ),
  );
  const sep = widths.map((w) => "─".repeat(w)).join("─┼─");
  const row = (cells: Tokens.TableCell[]) =>
    cells
      .map((cell, c) => pad(plain(cell.tokens), widths[c], token.align[c]))
      .join(" │ ");
  return (
    <Box flexDirection="column">
      <Text bold>{row(token.header)}</Text>
      <Text dimColor>{sep}</Text>
      {token.rows.map((r, i) => (
        <Text key={i}>{row(r)}</Text>
      ))}
    </Box>
  );
}

/** Render inline tokens to nodes suitable for nesting inside a <Text>. */
function inline(tokens: Token[] = []): ReactNode {
  return tokens.map((t, i) => {
    switch (t.type) {
      case "text":
      case "escape":
      case "html":
        return (t as Tokens.Text).text;
      case "strong":
        return (
          <Text key={i} bold>
            {inline((t as Tokens.Strong).tokens)}
          </Text>
        );
      case "em":
        return (
          <Text key={i} italic>
            {inline((t as Tokens.Em).tokens)}
          </Text>
        );
      case "del":
        return (
          <Text key={i} strikethrough>
            {inline((t as Tokens.Del).tokens)}
          </Text>
        );
      case "codespan":
        return (
          <Text key={i} color="cyan">
            {(t as Tokens.Codespan).text}
          </Text>
        );
      case "link": {
        const l = t as Tokens.Link;
        const label = plain(l.tokens);
        const auto = label === l.href;
        return (
          <Fragment key={i}>
            <Text color="blue" underline>
              {auto ? l.href : inline(l.tokens)}
            </Text>
            {!auto && <Text dimColor> ({l.href})</Text>}
          </Fragment>
        );
      }
      case "image": {
        const img = t as Tokens.Image;
        return (
          <Text key={i} dimColor>
            [image: {img.text || img.href}]
          </Text>
        );
      }
      case "br":
        return "\n";
      default:
        return "raw" in t ? t.raw : "";
    }
  });
}

/** Plain-text content of inline tokens, for measuring table column widths. */
function plain(tokens: Token[] = []): string {
  return tokens
    .map((t) => {
      if ("tokens" in t && t.tokens) return plain(t.tokens);
      if ("text" in t) return (t as { text: string }).text;
      return "raw" in t ? t.raw : "";
    })
    .join("");
}

function pad(s: string, w: number, align: "left" | "right" | "center" | null) {
  const d = w - s.length;
  if (d <= 0) return s;
  if (align === "right") return " ".repeat(d) + s;
  if (align === "center") {
    const l = Math.floor(d / 2);
    return " ".repeat(l) + s + " ".repeat(d - l);
  }
  return s + " ".repeat(d);
}
