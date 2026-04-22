# sprite

A small helping hand inside your computer.

A CLI coding agent: an LLM in a loop with four tools — `read_file`, `list_files`, `edit_file`, `bash`. It works in whatever directory you run it from.

## Run

```sh
git clone https://github.com/romellogoodman/sprite.git
cd sprite
npm install
npm link
```

Then from any directory:

```sh
sprite                    # interactive
sprite -c                 # continue the last session in this directory
sprite -p "run the tests" # one-shot: print and exit (scriptable; stderr shows tool activity)
sprite --trust            # skip bash confirmations
```

First launch will ask for an Anthropic API key. It's saved to `~/.config/sprite/config.json` (or set `ANTHROPIC_API_KEY` to skip the prompt).

## In the prompt

- `↑ / ↓` — recall previous prompts
- `Esc` — clear the input
- `Ctrl+A / E / U` — start of line, end of line, clear line
- `! <command>` — run a shell command yourself; output shows inline, no tokens spent
- `@path/to/file` — the file's contents are inlined when you submit
- Multi-line pastes collapse to `[Pasted #1 N lines]` and expand on submit
- `/clear` — reset the conversation
- `/compact` — summarize the conversation so far and keep going with just the summary in context
- `/logout` — forget the saved API key
- `exit` — quit

## Project context

sprite reads `AGENTS.md`, `AGENT.md`, and `CLAUDE.md` from the current directory, every parent up to the git root, and `~/.config/sprite/` (global). Whatever it finds is appended to the system prompt, so you can tell it how your project works once and it'll remember.

## Permissions

Shell commands prompt for confirmation before running. Choosing "always" remembers the command prefix for this project (stored in `~/.config/sprite/projects.json`, keyed by directory so a cloned repo can't pre-seed its own allowlist). Commands containing shell operators (`;`, `|`, `$(` …) always prompt. `--trust` skips all of it.

## Storage

```
~/.config/sprite/
  config.json        API key
  projects.json      per-directory bash allowlists
  AGENTS.md          global instructions (optional)
  sessions/<dir>/    conversation history, one JSONL per session
```

## Dev

```sh
npm start        # run from source
npm run typecheck
```

## References

- [How to Build an Agent](https://ampcode.com/notes/how-to-build-an-agent)
- [The Emperor Has No Clothes](https://www.mihaileric.com/The-Emperor-Has-No-Clothes/)
