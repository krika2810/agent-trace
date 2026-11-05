export type StepKind = 'prompt' | 'context' | 'hook' | 'model' | 'skill' | 'tool' | 'agent' | 'compact' | 'done'

export type StepStatus = 'running' | 'ok' | 'failed' | 'blocked'

// Where a figure comes from: Claude Code reported it, the mod computed it from
// what was reported, a rule applied to reported events, or nothing reports it.
export type Quality = 'observed' | 'estimated' | 'inferred' | 'unavailable'

// The four counters the API reports for one request.
export type Tokens = { input: number; output: number; cacheRead: number; cacheWrite: number }

// What one or more requests cost at API rates, in dollars, by what was billed: an estimate
// from the reported counters and the price table, never a bill.
export type CostSplit = { input: number; cacheRead: number; cacheWrite: number; output: number }

// One request a subagent made. Times observed, counters as the API reported them, cost estimated.
export type AgentRequest = {
  at: number
  end: number
  model: string
  // How many messages the request carried, as Claude Code reports it.
  messages: number
  tokens: Tokens
  cost?: number
  split?: CostSplit
  // Made by a subagent this one started: counted in its card, not its own.
  nested?: boolean
  // When its first streamed chunk arrived (observed), and why the model stopped.
  firstToken?: number
  stopReason?: string
  // The request failed before a response arrived.
  failed?: boolean
  // What its input held, by part: sized from its messages' text and scaled to the measured
  // input (estimated). `hidden` is the measured rest the text can't account for (inferred).
  parts?: Partial<Record<PartKey, number>>
  hidden?: number
}

// One tool call a subagent made. Times observed; `runMs` is the tool's own run time as
// Claude Code reports it; `added` is estimated from the result's text.
export type AgentCall = {
  id: string
  at: number
  end?: number
  name: string
  status?: StepStatus
  added?: number
  runMs?: number
  asked?: boolean
  nested?: boolean
  // The command or path it ran on, kept for this session only (a detailed export carries it).
  detail?: string
}

// The first lines of a call's input and output, kept for this session only:
// never written to the store or an export.
export type Preview = { input?: string; output?: string }

// `code` values are drawn in a code block of their own, in `language` where it is known.
export type Detail = { key: string; value: string; code?: boolean; language?: string }

// A label and its amount (tokens or cost), already formatted.
export type Row = { name: string; value: string; status?: 'failed' | 'blocked' }

// One card in the flow. Only sizes, names and commands are kept, never file
// or message text.
export type Step = {
  id: string
  turnId: string
  kind: StepKind
  title: string
  sub?: string
  status?: StepStatus
  // The badge on a failed or blocked step: "Check failed", "Hook failed"…
  label?: string
  // A command still running after its call returned, until a task notification ends it.
  background?: boolean
  // Tokens this step put into the context.
  added?: number
  // API-rate estimate; undefined when no price is known (never counted as zero).
  cost?: number
  // Requests counted here whose model has no known price, so `cost` is partial.
  unpriced?: number
  // Measured context after a model request; other steps derive theirs.
  ctx?: number
  details: Detail[]
  items?: Row[]
  nest?: Row[]
  // Start and end on the mod's clock, in milliseconds.
  at: number
  end?: number
  // A model request: when its first chunk arrived, and what it reported.
  firstToken?: number
  model?: string
  effort?: string | number
  tokens?: Tokens
  // The cost by what was billed: for a subagent's card, summed over its requests.
  split?: CostSplit
  // A model request's input by part, sized from its text and scaled to the measured input
  // (estimated); `other` is what the text can't account for.
  parts?: Partial<Record<PartKey, number>>
  stopReason?: string
  // A tool call: how long the tool itself ran (PostToolUse, without permission
  // or hook time), and whether a permission check asked first.
  runMs?: number
  asked?: boolean
  preview?: Preview
  // A subagent's own figures: its id, type, and what it did, counted as reported.
  agent?: {
    id?: string
    type: string
    requests: number
    calls: number
    // Calls inside it that failed or were blocked, and nested subagents that stopped:
    // problems it met, whatever its own outcome. `problems` is their sum.
    problems: number
    failed?: number
    blocked?: number
    background?: boolean
    // The Agent call returned once the agent started (background): its run goes on.
    launched?: boolean
    // Its own run ended (its turn.complete), however the call that started it fared.
    ended?: boolean
    // The task the main agent handed it, in tokens estimated from its text (chars / 4).
    handoff?: number
    // Its own requests, oldest first; past MAX_LOG the oldest are dropped (the totals still count them).
    log?: AgentRequest[]
    // What its first request carried: its messages sized from their text (estimated) and scaled
    // to the input the API reported (measured). `hidden` is the rest of that measured input: its
    // system prompt, tool definitions and overhead, which Claude Code doesn't expose per subagent.
    loaded?: { total: number; parts: Partial<Record<PartKey, LedgerItem[]>>; hidden: number }
    // Its tool calls, oldest first; past MAX_LOG the oldest are dropped (the totals still count them).
    callLog?: AgentCall[]
    // Its runs' usage as Claude Code reported it at each run's end (observed), summed.
    reported?: Tokens
    // How long its own run took, as Claude Code reported at its end; the card's wall time also counts the lead-in from the Agent call.
    ranMs?: number
    // The report it handed back, in tokens estimated from its final answer's text (chars / 4).
    report?: number
    // When each of its requests still waiting for a reply went out: what the lifecycle shows in flight.
    asking?: number[]
    // Subagents it started itself; their work is counted in its own figures.
    children?: { id?: string; type: string; task: string; state?: 'running' | 'done' | 'stopped' }[]
  }
  // Which figures on this step are observed, estimated or inferred.
  q?: { time?: Quality; tokens?: Quality; cost?: Quality; added?: Quality }
}

export type Turn = {
  id: string
  title: string
  status: 'running' | 'done' | 'failed'
  requests: number
  cost: number
  at: number
  end?: number
  // Wall time as Claude Code reports it at the end of the turn.
  durationMs?: number
  // When its last subagent's run ended: a background one can end after the answer.
  agentsEnd?: number
  // Claude Code's own usage for the turn's main loop, reported at its end (observed).
  reported?: Tokens
  // The first lines of the final answer, kept for this session only.
  answer?: string
  // A hand-back: the subagents whose reports this prompt delivered, by agent id.
  handsBack?: string[]
  // Its cost by what was billed, its subagents' included. Absent on a turn recorded before it existed.
  split?: CostSplit
  reason?: string
  // Files this prompt changed: git's counts where it tracks them, else an edit tool's path.
  outcome?: FileChange[]
  // Running totals, kept apart from the steps so they survive when old steps
  // are dropped to bound memory. Absent on a turn recorded before they existed.
  tokens?: Tokens
  calls?: number
  subagents?: number
  // Its subagents' requests that reported tokens; `requests` counts the main loop's alone.
  agentRequests?: number
  // Steps that failed or were blocked, and problems inside its subagents.
  failed?: number
  blocked?: number
  nested?: number
  models?: string[]
  // Requests whose model has no known price: `cost` leaves them out.
  unpriced?: number
  // How many of its steps were dropped to keep the pane's memory bounded.
  evicted?: number
}

// One changed file. `added`/`removed` are git's line counts (observed); absent
// for a file only an edit tool reports (untracked, or no net change).
export type FileChange = { path: string; added?: number; removed?: number }

// One prompt's figures and redacted title: a row of the Prompts view and an export's summary.
export type RunSummary = {
  id: string
  at: number
  title: string
  // To the answer, or to the last background subagent's end if that is later.
  durationMs: number
  // Claude Code's wall time for the answer alone.
  answerMs: number
  requests: number
  calls: number
  subagents: number
  problems: number
  cost: number
  // Requests left out of `cost` because their model has no known price.
  unpriced: number
  // Steps dropped to bound memory: the figures above still count them.
  evicted: number
  tokensIn: number
  tokensOut: number
  cacheRead: number
  models: string[]
  branch?: string
  files: number
  added: number
  removed: number
}

export type FlowContext = {
  // A ticket key in the branch name (ABC-123), the branch and its short commit.
  story?: string
  branch?: string
  commit?: string
  turnId?: string
  // agentId -> the step id of the top-level Agent call whose chain started it.
  agents: Record<string, string>
  // agentId -> the prompt it was started in, so its cost stays there after later prompts begin.
  agentTurns?: Record<string, string>
  // Agents started by another subagent: their work rolls up into the chain's card.
  nestedAgents?: string[]
  // Agents whose run hasn't ended: while any runs, a composed system prompt may be theirs.
  live?: string[]
  // Hook output item key -> times seen, so a hook shows as a step when it adds text again.
  hookCounts: Record<string, number>
  // A slash command's title, from prompt.submit to turn.start.
  pendingTitle?: string
  // Tool call ids a permission check asked about.
  asked?: string[]
  // The session model's context window and the session's cost, as Claude Code reports them.
  window?: number
  sessionCost?: number
  // The repository's top folder, and `git diff --numstat` at the prompt's start (path -> "added removed").
  root?: string
  baseline?: Record<string, string>
  // Paths edit tools wrote during the prompt.
  touched?: string[]
  // The session id its trace is saved under, kept if a /clear moves the process to another.
  historyId?: string
}

// One saved session in the list, without opening its file.
export type HistoryEntry = {
  id: string
  at: number
  savedAt: number
  title: string
  project?: string
  prompts: number
  cost: number
  unpriced?: number
  problems: number
  // For Analytics: spend by day and by model, input and cache reads, and calls. Absent on an
  // entry saved before Analytics, until its file has been opened once to fill them.
  days?: Record<string, number>
  models?: Record<string, number>
  tokensIn?: number
  cacheRead?: number
  calls?: number
}

// A session's trace as its file holds it.
export type SavedTrace = {
  v: 1
  id: string
  savedAt: number
  turns: Turn[]
  steps: Step[]
  atlas: AtlasSnapshot[]
  origins: Origin[]
  context: FlowContext
}

// One row added to a conversation, as session.append reports it: the route it
// came by and who caused it. Sizes only, never the row's text.
export type Origin = {
  at: number
  turnId?: string
  agentId?: string
  door: string
  by: string
  name?: string
  tokens: number
}

export type ViewMode = 'inspect' | 'context' | 'agents' | 'story' | 'runs' | 'analytics'

export type DetailTab = 'summary' | 'io' | 'tokens' | 'raw' | 'related'

export type StepFilter = 'all' | 'problems' | 'model' | 'tool' | 'agent' | 'hook'

// The context one request sent, by part: sized from its text, scaled to the
// input total the API reported. Names and sizes only, never the text.
export type AtlasSnapshot = {
  turnId: string
  stepId: string
  at: number
  // The input total the API reported for the request (observed).
  total: number
  cacheRead: number
  cacheWrite: number
  parts: Record<PartKey, LedgerItem[]>
  // Each part's size at the request before this one, for growth.
  before?: Partial<Record<PartKey, number>>
  // Claude Code's own /context categories just after the request (local estimates),
  // where the host reports them.
  native?: { model: string; total: number; rows: { name: string; tokens: number }[] }
}

export type FlowView = {
  // A turn id; null follows the latest prompt.
  selected: string | null
  open: string[]
  mode?: ViewMode
  // The details tab each open step shows; summary when absent.
  tabs?: Record<string, DetailTab>
  filter?: StepFilter
  query?: string
  // Steps run oldest first, as the prompt ran; newest first once the toggle beside the filters is set.
  order?: 'newest' | 'oldest'
  // Parts opened in the context atlas.
  parts?: string[]
  // Subagent cards whose every request is listed.
  more?: string[]
  // Copy exports in detail (commands, previews, tasks, reports, the answer) rather than share-safe.
  detailed?: boolean
  // Analytics: this session or all saved sessions, and how many days the latter covers.
  scope?: 'session' | 'all'
  range?: 7 | 14 | 30
  // The request and the day picked on Analytics' two charts; absent, the latest.
  point?: number
  day?: number
}

// Kept so the copied ledger module type-checks unchanged.
export type Span = {
  id: string
  status: 'running' | 'done' | 'failed' | 'blocked'
  detail?: string
  check?: string
}

export type PromptSnapshot = {
  model: string
  at: number
  sections: { id: string; scope: 'shared' | 'session'; tokens: number }[]
}

export type PartKey = 'system' | 'tools' | 'instructions' | 'memory' | 'skills' | 'agents' | 'results' | 'hooks' | 'conversation' | 'other'

export type LedgerItem = {
  key: string
  name: string
  note?: string
  tokens: number
  count?: number
  status?: 'failed' | 'blocked'
  kind?: string
}

declare module 'claude-code' {
  interface PluginState {
    'agent-trace': {
      steps: Step[]
      turns: Turn[]
      context: FlowContext
      prompt: PromptSnapshot | null
      today: { day: string; total: number; unpriced?: number }
      view: FlowView
      origins: Origin[]
      atlas: AtlasSnapshot[]
      history: HistoryEntry[]
      archive: SavedTrace | null
    }
  }
}
