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
sprite
```

First launch will ask for an Anthropic API key. It's saved to `~/.config/sprite/config.json` (or set `ANTHROPIC_API_KEY` to skip the prompt). Type `/logout` to clear it, `exit` to quit.

## Dev

```sh
npm start        # run from source
npm run typecheck
```

## References

- [How to Build an Agent](https://ampcode.com/notes/how-to-build-an-agent)
- [The Emperor Has No Clothes](https://www.mihaileric.com/The-Emperor-Has-No-Clothes/)
