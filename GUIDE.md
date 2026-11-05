# agent-trace guide

The full reference for every view, figure and setting. For install and a quick tour, see the [README](./README.md).

## What it shows

- **Run header:** a ticket key from the branch name (`ABC-123`), a Live/Done/Stopped badge that carries the prompt's time (`✓ Done in 1m 06s`, counting up while it runs), the models and effort used, and `‹ N / M ›` arrows (`Latest »` jumps back to the newest prompt). Then the prompt's title, its start time, how long it took, the step count, and the branch at its commit. A prompt's time runs until its last background subagent ends, not only until its answer. Story and exports also give the time of the answer itself.
- **Summary strip:** Context (with a bar of the window Claude Code reports for your model), Tokens (every request's input summed, its subagents included, and how many requests that covers: `223.7k in across 4 requests`), with a lean bar of re-read from cache, output and new tokens and the same three named under it (`re-read 19.31M · out 75.9k · new 122.8k`). This prompt and Today (from your session logs).
- **Problems chip:** beside the status badge, only when a step failed or was blocked, or a subagent met a failed or blocked call (or a stopped subagent of its own) inside its run (`✕ 1 failed ›`). Each problem counts once. Pressing it filters the list to those steps and opens them; a subagent's card names what went wrong inside it under **Problem inside**. A subagent can finish (Done) and still show the problems it met.
- **Views:** Inspect, Context, Agents, Story, Prompts and Analytics.
- **Insights** (top of Inspect, as a card only when something stands out; otherwise one line beside the tabs): the slowest step, the costliest request, the step that added the most context, a request with a low cache hit, time spent waiting on permission prompts (inferred), each opening its step; and the files the prompt changed, with git's line counts against the last commit (files only an edit tool reports, such as untracked ones, show as "edited").
- **Earlier sessions** (in the Prompts view, under this session's prompts, and on the first screen of a new session): your saved sessions by day, each with its first prompt, time, project, prompt count, cost and problems. › opens one read-only: a banner names it, the status reads Saved, every view shows that session, and **Back to this session** returns. A session reopened under its own id gets its trace back, and anything that was running when it closed reads as Not finished.
- **Prompts:** this session's prompts, newest first: the session's total cost, time and how many prompts had problems, then each prompt's share of the cost, its cost and time, and its problems. › opens a prompt in Inspect. A prompt whose older steps were dropped (see Retention) says "older steps trimmed"; its figures still count them.
- **Analytics:** the session rolled up, with **This session / All sessions** at the top. Each card says how its figures are known (observed or estimated).
  - **This session:** up to three things that stand out (a prompt far over the median cost, a tool that added most of the tool-result tokens, the context near its window, repeated calls, or one call made five or more times in a prompt as a likely loop, a run of the same failure, the cache hit rate). Then tiles for cost, tokens, cache hit, wall time, tool calls and duplicate calls: the same tool with the same input made again with no edit between (inferred), with `Review ›` opening the prompt with the most-repeated call. When there are any, Repeated calls lists them by tokens re-added: the call, how many times it ran, its prompt and what the repeats re-added; a prompt number opens that prompt in Inspect with its steps searched for the call. Cost by prompt splits each prompt by cache read, cache write, new input and output, flags a prompt at 3× the median or more, and says roughly what the cache saved (reads priced at the input rate less the read rate). Context over the session plots the measured context after each request against the window, marking the biggest jump and each compaction. Tools lists calls, average run time, tokens added and failure rate per tool. Where the time went sums model, tool, subagent, permission-wait and hook-and-check time over steps, so calls that ran together each count. What went wrong groups failures and blocks by tool and reason. What it produced lists the files changed and the cost per 100 lines. Who spent it splits cost between the main agent and each subagent type.
  - **All sessions** (7, 14 or 30 days): the saved sessions on this computer and this one. Tiles for spend, sessions, cost per prompt, cache hit, problems per tool call and the busiest day, then spend per day, the costliest sessions (› opens one), spend by project and spend by model. A session saved before Analytics existed has its file read once to fill in its model, day and cache figures.
- **Copy** (footer): **CSV · Markdown · JSON** copy the prompt's whole run to the clipboard; nothing is written to disk. The run is the prompt, every subagent it started, and the later prompts that delivered their reports (hand-backs). The mode button beside them switches between **Share-safe** (the default) and **Detailed**. All three come from one report, so their totals agree.
  - **CSV**: one row per model request (`main`, `subagent_1`, `subagent_1_nested`, `handback_1`…) in the order they started, then a `TOTAL` row equal to the report's totals. Token columns are as the API reported them; `_usd_est` columns are API-rate estimates, blank where no price is known.
  - **Markdown**: the story, then run totals, an agents table, what each subagent was handed and loaded, every request and tool call with its timing, outputs, reconciliation checks, and what Claude Code doesn't expose.
  - **JSON** (`"schema": "agent-trace/export@4"`):
    - `run`: start, answer and end timestamps, duration, and totals by agent: requests, tool calls, tokens (uncached input, cache reads, cache creation, output, total input) and cost split by type.
    - `agents`: the main agent, each subagent (with its parent, type, model, background, times, and `handoff`: what the parent passed, what it loaded on its own, and the unattributed rest) and each hand-back.
    - `requests`: every model request: start and end, time to first token, stop reason, failure, tokens, cost and its split, and its context by part.
    - `toolCalls`: every tool call, a subagent's included: who asked for it, start and end, the tool's own run time, permission prompts and the inferred wait, calls it overlapped, its result's size and inferred cost.
    - `outputs`: changed files, checks and tests run, and (detailed) the final answer.
    - `checks`: each total reconciled against the running totals and against the usage Claude Code reports at each turn's end.
    - `quality` and `notExposed`: what is observed, estimated, inferred or unavailable, and what the API doesn't give (retries, a subagent's system prompt and tools, per-part token counts, permission wait times).
  - **Share-safe** leaves out commands, tool output, subagent tasks and reports, and the final answer. **Detailed** keeps them (first lines only for output) for local analysis. Both mask credentials, emails and home folders (best effort).

- **Story mode** (the Story view): the prompt told in plain sentences, each with its time into the prompt: what you asked, the context sent, what each model request read and asked for, the tools run (successes in a row share a sentence), what a hook blocked and why, what failed, what each subagent was handed and did, compactions and when the answer was ready. Problems stand out in their color. It is written from the recorded steps alone, without asking a model. › opens a step in the inspector; **Copy as Markdown** copies the same sentences, with the branch and commit (masked as described under Privacy).
- **Agent topology** (the Agents view): the main agent at the root, with its models, requests, tool calls, tokens and cost, and a branch for each subagent it started: its type, a Running/Done/failed badge, model, background or not, its task, how long it ran and what share of the prompt that was, its requests, tool calls, problems, tokens and cost. A subagent's own subagents are listed under it and counted in its figures. A cost bar splits the prompt's cost by agent.
- **Subagent lifecycle** (on each subagent's card in the Agents view, live): a rail of five stages, Delegate · Initialize · Run · Hand back · Cost, filled as its events arrive, with every stage's figures in view without opening anything. **Delegate:** the task's size (≈, from its text), its type, model, foreground or background, and the main request that started it. **Initialize:** its first request's measured input and cache writes, split into its messages' parts (estimated) and the rest, its system prompt, tool definitions and overhead (inferred: Claude Code doesn't expose these per subagent). **Run:** requests, tool calls, the share of input read from cache, a request in flight, and a column per request (read from cache, written to cache striped, new, output) showing the context grow. **Hand back:** the report's size (≈) and the main request that took it in, with its new tokens (inferred), or the later prompt that delivered a background agent's report. **Cost:** the API-rate estimate split by type, a check that its requests add up to the usage Claude Code reported at its end, and what reading from cache saved (≈). Inspect › adds every request and tool call on the subagent's own timeline (∥ marks calls that ran together); each request opens to its times, first token, stop reason, four counters, cost, what it carried and how much of the previous request's cache it re-read. On Inspect, a subagent's card shows the stages as dots and where it is, and Lifecycle › opens it in the Agents view. Hide ‹ folds the details.
- **Background commands:** a command run in the background returns as soon as it starts. Its card stays Running, and the status reads `✓ Answered · background tasks running`, until its task notification says it finished, failed or was stopped. The Agents view lists them in a **Background tasks** card, this prompt's first and then the rest of the session's, each with its command, start time, duration and outcome; › opens its card in Inspect. They're saved with the session, so an opened earlier session shows its own. A command that started before its card tracked it is still listed, from its output, as "End not recorded". The list covers the prompts and steps the pane keeps (see Retention).
- **Background subagents:** an Agent call that runs in the background returns as soon as the agent starts. Its card stays Running until the agent's own run ends (Done, or Stopped if it is interrupted), and its time is the run's, not the call's. Its requests and cost belong to the prompt that started it, even once a later prompt is running. That prompt reads "Answered in 15.0s, background subagents still running" until they end, then "Done in 1m 06s (answer at 15.0s)". When a background subagent's report comes back as a turn of its own, that turn is titled by the subagent's place among those its prompt started ("Subagent 3"). In the Agents view the main agent's time is the whole prompt's; each subagent shows its own run, what it was handed, its first request's size and cache writes, and the hand-back that delivered its report (`↩ Report handed back in “Subagent 1” · 1 request · $0.012`). The cost card adds the hand-backs to the main agent's and each subagent's cost, and splits the total by type (cache writes, cache reads, output, new input). A known failure is never overwritten by a later success.
- **Context atlas** (the Context view): the context the prompt's latest request sent, against your model's window, as a funnel of its parts, largest first (system prompt, tool definitions, project instructions, memory, skills, subagent reports, tool results, hook output, conversation, unattributed). Each part's row carries a centred bar as wide as its share of the largest part, its size, its share of the window and how much it grew since the request before; open one for its largest items. As the pane narrows, the rows first keep only the size beside the bar, then below 40 columns one small funnel sits above a plain list. Below: how much was read from cache, Claude Code's own `/context` categories where the host reports them, the rows Claude Code added during the prompt by route (tool results, hook context, attachments…), and any compactions. A warning appears at 60% full, and a stronger one at 80%. The total is the API's count (observed); the parts are sized from their text and scaled to it, so they are estimates. Tool definitions are sized from `/context`'s own estimate (`$.session.usage({ breakdown: 'summary' })`, local estimates, read once per request, never the token-count API). What the text can't account for beyond that is shown as **Unattributed** rather than guessed. Without the breakdown (older hosts), all of it is unattributed.
- **Filters and search:** chips for All, Problems, Model, Tools, Agents and Hooks, with counts, and a search field for titles, commands and details (not on mobile, which draws no fields yet).
- **Tool calls under their request:** each model request lists what it asked for beneath it, hung off it by an elbow: its tools and skills in one tray of slim rows (what ran, its time, what it added, › for the rest), a subagent as its full card. A problem, or a command running in the background, says so on the line below.
- **Steps:** one card per step, oldest first as the prompt ran (the `↑ Oldest first` toggle beside the filters lists them newest first), each with an icon for its kind, its title, what kind of step it is and what it did, and a meter on the card's right: how long the step took over a bar of its share of the prompt (a striped fill while it is still running; a bare track for a step that took no time). On the meter's top line, right-aligned opposite the time and just above the bar, two pills give the step's tokens and cost: a request's output (`805 out`) or what another step added to the context (`+199 tok`), then its cost (`$0.055`, or `$0` for a call that costs nothing itself). Off the terminal the pills are drawn as Svg, so they are fully round; on it they are muted text. The meter is the same width on every card, grows and shrinks with the pane (up to 40 columns), and is never narrower than the time and the widest pills. It stays on the right however narrow the pane; below 80 columns only the cost pill is kept, since the tokens are on the card's left. Tool calls that ran in parallel say so. Cards cover your prompt, context loaded, hooks, model requests, skills, tool calls, subagents (their requests and calls nested), compactions and the answer.
- **Details:** a card's › opens one panel with its sections stacked:
  - **Details:** the command, why it failed, what the context held, a subagent's calls.
  - **Tokens & cost:** new input, cache reads and writes, output, cache hit and cost, each marked observed, estimated or inferred. **Cost by type** splits the cost into cache writes, cache reads, output and new input, largest first (API-rate estimates from the reported counters).
  - **Handed over and loaded** (a subagent): the task the main agent handed it (≈ tokens, estimated from its text), its first request's input as the API reported it (new, read from cache, written to cache, out), and what that input held: its messages by part (project instructions, memory, skills, the task…), sized from their text and scaled to the measured total (estimated), and the measured rest, its system prompt, tool definitions and overhead (inferred). Claude Code doesn't expose a subagent's system prompt or tool list, so that rest is never split further. If the session can't read the subagent's messages, it says so.
  - **Requests** (a subagent): each of its requests with its input split as the API reported it, its output and its cost. The first 6 show; **Show all** lists the rest (the last 60 are kept; the totals count every one). A request made by a subagent it started is marked nested.
  - **Requested by:** the model request that asked for a call. A request's own calls are on the tree beneath it.
  - **Show input and output:** the first 20 lines of a tool call's arguments and result, or a subagent's task and report, drawn only when pressed.
  - **Show raw record** and **Copy as JSON:** the step's record as JSON.
- **Wide panes** (150 columns or more) show the details beside the list instead of under the card.
- Colors come from your Claude Code theme, so the pane follows light and dark.
- The layout follows the pane as you drag it: the four stats sit in a row, then two by two, then one above another; meters keep a fixed width beside each card; tabs and filters wrap rather than overflow.

Each session's whole trace is saved on this computer, as one JSON file in `~/.claude/agent-trace/history/` (the folder is yours alone), and listed in the mod's store. It saves when a prompt ends, when the session ends, and at most every 30 seconds while a prompt runs. **It holds your commands, file paths and Input/Output previews (20 lines at most, which can include file contents).** Credentials, emails and home folders are masked first, on a best-effort basis, so read a file before sharing it. Nothing leaves your computer. Sessions older than 30 days are deleted at the next session's start. A file holds about 3 MB: past that its oldest previews go first, then its oldest steps, and the prompt says "older steps trimmed". **Clear** in the footer empties the pane only; `/agent-trace clear` also deletes every saved session.

Tokens are as the API reports them; costs are API-rate estimates. Previews are drawn only when you ask for them.

## Costs

- Costs are **API-rate estimates**: what the requests would cost on Anthropic's first-party API. On a Claude plan they are not what you are billed.
- Rates are in `hooks/pricing.ts`, checked against [the pricing page](https://platform.claude.com/docs/en/about-claude/pricing) on 2026-10-28. Models are matched by exact version (Sonnet 5 and Sonnet 5.5 are priced apart), with date and platform suffixes (`-20250929`, `@20251101`, `us.anthropic.…-v1:0`, `[1m]`) ignored.
- The rates cover:
  - 5-minute and 1-hour cache writes. A write with no reported split is priced as 5-minute, the API's default.
  - Cache reads.
  - Haiku 5.5's higher prices for prompts over 100,000 tokens.
  - Fast mode.
  - The 1.1x price for US-only inference (`inference_geo: "us"`) on 4.6 and later.
  - Batch-API discounts aren't modelled.
- A model with no known price is **unpriced, not free**. Its request shows "price unknown", and totals read `$0.42 + 1 unpriced`. An export gives such a request's cost as `null` and sets `complete.cost` to `false`.
- `scripts/today_cost.py` receives the same table from the mod as JSON, so the Python and TypeScript prices can't drift. Update `hooks/pricing.ts` only.
- **Today** reads Claude Code's local session logs (`~/.claude/projects/**/*.jsonl`) with that table. It counts the local calendar day.
  - It skips a malformed line, timestamp or usage block on its own.
  - It counts a record without message and request ids once rather than merging it with others.
  - It reports requests it couldn't price.
  - It caches each log's result by size and modification time in the system temp folder.
  - If it fails, the pane shows `–` and tracing carries on.

## Retention

- Per session the pane keeps the last 12 prompts and the last 600 steps, 1,000 context rows and 50 permission asks.
- Past 600 steps the oldest finished steps are dropped first. A step still running (a background subagent) is kept, so its later figures still land.
- Each prompt keeps its own totals apart from its steps, so they don't change when its steps are dropped: requests, tool calls, subagents, tokens, cost, unpriced requests and problems.
- A prompt that lost steps says so in Inspect, in the Prompts view ("older steps trimmed"), in its story, and in an export (`complete.steps: false`, `summary.evicted`).
- A subagent's card lists its last 100 calls and 60 requests, and names up to 5 problems inside it.

## Privacy

- **Copy** (CSV, Markdown, JSON) gives a fixed shape:
  - Each step's id, kind, name (the tool, check, skill or hook, never its arguments), status, label, times, model, effort, tokens, cost, quality tags, and the ids that tie it to its request and subagent.
  - The prompt's summary, the commit, and the changed files' paths.
  - `costs`: the whole run's cost, its own requests, each subagent's and the hand-backs', and `byCategory` (new input, cache reads, cache writes, output). Each step carries its `costSplit`.
  - For each subagent: `handoffTokens` (estimated), `firstRequest` (its input total observed, its parts by name estimated, `notExposed` inferred) and `requestLog`, each request's times, model, message count, tokens and cost.
  - `handBacks`: the later prompts that delivered a background subagent's report, with their own steps, tokens and cost.
  - A `quality` note: observed is as Claude Code or the API reported it; estimated is from text length or API prices; inferred is a measured total less the estimates.
  - The story, told without commands, error text or tasks.
- The CSV holds names and numbers only: agents, request numbers, models, tokens and costs.
- Export leaves out commands, tool input and output, error messages, subagent tasks and reports, and previews. A subagent's first request is exported as sizes by part only, never its items' names.
- The prompt's title and file paths are kept, with credentials, emails and home folders masked.
- **Copy as Markdown** (Story) and **Copy as JSON** (a step) keep the commands and reasons the pane shows, since you copy them on purpose, and mask what they can.
- Masking is pattern matching, so treat it as best effort, not a guarantee. It catches:
  - Common key shapes (`sk-…`, `ghp_…`, `AKIA…`).
  - Bearer and Basic tokens.
  - `user:password@` in URLs and connection strings.
  - `key=value`, `key: value` and JSON `"key": "value"` where the key names a credential (token, secret, password, api key, access or private key, credentials).
  - `--password`/`--token`-style flags, emails, and `/Users/<name>` and `/home/<name>`.

  Anything else in the title or a path is kept as written. Read an export before you share it.

## Compatibility

- Tested with Claude Code 2.1.296: `claude plugin validate .` and `claude plugin test .`. The marketplace install line works from 2.1.275.
- A minimum version for every API the mod uses hasn't been established; the mod reads `.claude-plugin/types/` (the installed host's declarations) as the reference.
- `/context`'s breakdown is read only when the host reports it.
- Tests drive the hooks and the pane's elements through the harness. They don't show how the pane looks in the terminal, Desktop, VS Code or mobile: check that in a live session.

## Layout

| Path | What it holds |
|---|---|
| `.claude-plugin/plugin.json` | Mod manifest |
| `hooks/register.tsx` | Event hooks and the pane |
| `hooks/history.ts` | Fits a saved session's trace into one file |
| `hooks/ledger.ts` | Sorts the context into parts (instructions, memory, skills, hooks…) |
| `hooks/pricing.ts` | API-rate cost per model: the one price table |
| `scripts/today_cost.py` | Sums today's cost from `~/.claude/projects/**/*.jsonl`, with the table the mod passes it |
| `types/index.d.ts` | Types for the mod's state |
| `tests/flow.test.tsx` | Tests for the pane and the hooks |
| `tests/test_today_cost.py` | Tests for the daily reader, on made-up logs |
