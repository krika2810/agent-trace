# agent-trace

**See exactly what Claude Code does after you send a prompt.**

<a href="assets/demo.mp4"><img src="assets/demo-thumbnail.jpg" alt="agent-trace demo video" width="720"></a>

[▶ Watch the demo](assets/demo.mp4) (3 min)

agent-trace adds a pane beside the chat that lists every step Claude takes: each model request, tool call and subagent, with how long it took, how many tokens it used and what it cost. Use it to find what's slow, what's expensive and what failed.

Works in the terminal, Claude Desktop's Code tab and the VS Code extension.

```bash
claude plugin marketplace add krika2810/agent-trace
claude plugin install agent-trace@agent-trace
```

> [!IMPORTANT]
> Mods run inside Claude Code with your user permissions. They can see session events, start processes, access files, and make network requests. Read the source before installing any mod, including this one.

> [!NOTE]
> Costs are API-rate estimates, not a bill. On a Claude plan (Pro, Max, Team) you aren't charged these amounts. Read them as "what this would cost on the API", useful for comparing prompts.

## Views

### Inspect

One card per step, with its time, tokens and cost, and tool calls nested under the request that asked for them. Insights at the top point out the slowest step, the costliest request and low cache hits. A Problems chip appears when a step fails or is blocked, and opens those steps.

<img src="assets/inspect.png" alt="Inspect view: summary strip, insights and one card per model request with its tool calls" width="720">

### Parallel tool calls

Tool calls that ran at the same time are marked `parallel 1 of 3`, `2 of 3` and so on, each with its own time and the tokens it added. Insights counts how many ran in parallel and in how many batches.

<img src="assets/parallel.png" alt="Inspect view: one request with three WebFetch calls marked parallel 1 of 3, 2 of 3 and 3 of 3" width="720">

### Context

What the latest request sent, as a funnel ordered largest part first (system prompt, tool definitions, memory, skills, tool results, conversation), measured against your model's context window. Open a part to see its largest items.

<img src="assets/context.png" alt="Context view: a funnel of tool definitions, tool results, skills, conversation and the rest" width="720">

### Agents

The main agent and every subagent it started. Each subagent shows a live five-stage lifecycle (Delegate, Initialize, Run, Hand back, Cost), and the view lists background commands too.

<img src="assets/agents.png" alt="Agents view: a subagent's Delegate, Initialize, Run, Hand back and Cost stages" width="720">

### Story

The prompt told in plain sentences, each with its time. It is written from the recorded steps alone, without asking a model, and copies as Markdown.

<img src="assets/story.png" alt="Story view: the prompt told in plain sentences with timestamps" width="720">

### Prompts

This session's prompts with their cost and time, and your earlier sessions, saved on this computer. Open an earlier session to see its whole trace.

<img src="assets/prompts.png" alt="Prompts view: this session's prompts and earlier sessions" width="720">

### Analytics

Patterns across the whole session, or across every saved session. It starts with what stands out, then lists repeated tool calls (the same call with the same input and no edit between, with the tokens it re-added, flagged as a likely loop at five or more in a prompt), cost by prompt, context over the session, tools, where the time went, what went wrong, what it produced and who spent it. **All sessions** adds spend per day, the costliest sessions, and spend by project and by model.

### Copy

The footer copies a whole run as CSV, Markdown or JSON to the clipboard. It is share-safe by default: commands, tool output and the final answer are left out, and credentials, emails and home folders are masked.

The screenshots show the pane in Claude Desktop. Exact spacing and colors vary by surface and theme.

[Read the full guide](./GUIDE.md): every figure, the cost model, retention and privacy.

## What is a mod?

A mod is a Claude Code plugin with TypeScript event handlers. Claude Code calls them when something happens: a session starts, a prompt is submitted, Claude calls a tool, a subagent starts, part of the interface is rendered. agent-trace listens to those events, records each step, and draws the pane.

## Requirements

- Claude Code 2.1.275 or newer
- Git, so Claude Code can clone the marketplace
- Python 3, for the Today figure (the rest of the pane works without it)

Check your version with `claude --version`, or enter `/status` in the desktop Code tab.

## Quick start

### 1. Add the marketplace

```bash
claude plugin marketplace add krika2810/agent-trace
```

Or, in a Claude Code session:

```text
/plugin marketplace add krika2810/agent-trace
```

### 2. Install the mod

```bash
claude plugin install agent-trace@agent-trace
```

Inside a session, use `/plugin install agent-trace@agent-trace`.

### 3. Load it

Start a new session, or enter `/reload-plugins` in an open one. The pane opens on its own, or run `/agent-trace`. `/agent-trace clear` resets it.

Terminal and desktop local sessions share user-scoped plugins, so one install covers both.

## Develop locally

No Node.js, bundler or dependency install is needed. Claude Code loads the TypeScript directly and supplies the test runner.

```bash
git clone https://github.com/krika2810/agent-trace.git
cd agent-trace
claude plugin validate .
claude plugin test .
python3 -I tests/test_today_cost.py
claude --plugin-dir .
```

`--plugin-dir` reloads the hooks after each change. The Python tests use made-up logs in a temporary folder and never read your session logs.

## Anatomy

```text
agent-trace/
├── .claude-plugin/
│   ├── plugin.json        # mod manifest
│   └── marketplace.json   # makes the repo installable as a marketplace
├── hooks/
│   ├── hooks.json
│   ├── register.tsx       # event handlers and the pane
│   ├── history.ts         # saves a session's trace to one file
│   ├── ledger.ts          # sorts the context into parts
│   ├── pricing.ts         # the one API-rate price table
│   └── report.ts          # CSV, Markdown and JSON exports
├── scripts/
│   └── today_cost.py      # sums today's cost from local session logs
├── tests/
│   ├── flow.test.tsx
│   └── test_today_cost.py
└── types/index.d.ts
```

## Updating

```bash
claude plugin update agent-trace@agent-trace
```

Then start a new session or enter `/reload-plugins`.

## Disable or uninstall

Open `/plugin`, select the Installed tab, and disable or uninstall it. From the shell:

```bash
claude plugin disable agent-trace@agent-trace
claude plugin uninstall agent-trace@agent-trace
```

## Troubleshooting

**The pane doesn't appear.** Check `claude --version`, confirm the mod is enabled in `/plugin`, enter `/reload-plugins`, and run `/agent-trace`. Make sure the workspace is trusted, Claude Code wasn't started with `--safe-mode` or `--bare`, and `disableAllHooks` is off.

**Today shows `–`.** Python 3 isn't on your PATH, or the session logs couldn't be read. Tracing carries on without it.

## Security and privacy

Claude Code mods are not sandboxed. Run `claude plugin validate .` to see the hooks and API calls, then read the source.

- agent-trace makes no network requests. It runs `git` in your repository (branch, commit, changed lines), `python3` for Today, and `mkdir` and `rm` for its saved history.
- Each session's trace is saved as one JSON file in `~/.claude/agent-trace/history/`. It includes commands, file paths and short input and output previews. Credentials, emails and home folders are masked first, on a best-effort basis. Files are deleted after 30 days, and `/agent-trace clear` deletes them all.
- Exports are share-safe by default. Masking is pattern matching, so read an export before you share it.

Full details are in the [guide](./GUIDE.md#privacy).

## Contributing

Bug reports, ideas and pull requests are welcome.

- **Found a bug or have an idea?** [Open an issue](https://github.com/krika2810/agent-trace/issues/new). For a bug, include your Claude Code version, the surface (terminal, Desktop or VS Code) and a screenshot if you can.
- **Want to change the code?** For anything bigger than a small fix, open an issue first so we can agree on the approach.

### Raise a pull request

1. Click **Fork** at the top of this page, then clone your fork:

   ```bash
   git clone https://github.com/<your-username>/agent-trace.git
   cd agent-trace
   git checkout -b my-change
   ```

2. Make your change and try it in a live session:

   ```bash
   claude --plugin-dir .
   ```

3. Run the checks:

   ```bash
   claude plugin validate .
   claude plugin test .
   python3 -I tests/test_today_cost.py
   ```

4. Commit, push your branch, and open the pull request:

   ```bash
   git commit -am "Describe the change"
   git push -u origin my-change
   ```

   GitHub then shows a **Compare & pull request** button on your fork. Or, with the [GitHub CLI](https://cli.github.com), run `gh pr create`.

In the pull request, say what changed and why. For a change to the pane, add a before and after screenshot. Every pull request is reviewed before it's merged.

## Documentation

- [Claude Code mods overview](https://code.claude.com/docs/en/plugins/mods/overview)
- [Create a mod](https://code.claude.com/docs/en/plugins/mods/create)
- [Test a mod](https://code.claude.com/docs/en/plugins/mods/test)
- [Create a plugin marketplace](https://code.claude.com/docs/en/plugins/create-marketplace)

## License

[MIT](./LICENSE)
