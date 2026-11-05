import type { CostSplit, FileChange, HistoryEntry, Quality, RunSummary, Step, Tokens, Turn } from '../types'
import { formatCost, formatTokens } from './ledger'
import { rateOf } from './pricing'

// The Analytics view's figures: this session's prompts and steps rolled up, and the saved
// sessions' list rolled up by day, project and model. Names and sizes only, as everywhere else.

const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

export const dayKey = (ms: number) => {
  const date = new Date(ms)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length === 0 ? 0 : sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

const short = (model: string) => model.replace(/^claude-/, '').replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '')
const toolName = (step: Step) => step.title.split(' · ')[0] ?? step.title
const commandOf = (step: Step) => step.details.find(detail => detail.key === 'Command')?.value ?? step.title
const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0)

// A run of an insight's sentence; bold runs carry its figures.
export type Run = { text: string; bold?: boolean }
export type Insight = { tone: 'warn' | 'info'; runs: Run[] }

export type PromptCost = { id: string; n: number; title: string; cost: number; unpriced: number; split?: CostSplit; times?: number }
export type CtxPoint = { at: number; tokens: number; compact?: boolean }
export type ToolRow = { name: string; calls: number; timed: number; runMs: number; added: number; failed: number; blocked: number }
export type TimeRow = { key: 'model' | 'tools' | 'agents' | 'waiting' | 'overhead'; label: string; ms: number }
export type ProblemRow = { tool: string; reason: string; status: 'failed' | 'blocked'; count: number }
export type FileRow = { path: string; added: number; removed: number; tracked: boolean }
export type SpenderRow = { name: string; cost: number; main?: boolean; runs: number }

// One call made more than once with the same input: how many times it ran, how many of those were
// repeats (no successful edit since the last time), what the repeats re-added, and the prompts they
// were in. `search` is the text Inspect's step search finds those calls by.
export type RepeatRow = { label: string; search: string; times: number; repeats: number; tokens: number; turns: string[] }

// Calls made again with the same input, with no edit between them to make a second look worth it.
export const duplicatesOf = (steps: Step[]) => {
  const seen = new Set<string>()
  const byKey = new Map<string, RepeatRow>()
  let count = 0
  let tokens = 0
  let calls = 0
  for (const step of [...steps].sort((a, b) => a.at - b.at)) {
    if (step.kind !== 'tool') continue
    calls += 1
    const name = toolName(step)
    if (EDIT_TOOLS.includes(name)) {
      if (step.status === 'ok') seen.clear()
      continue
    }
    if (step.status !== 'ok') continue
    const search = commandOf(step)
    const key = `${name}\n${search}`
    const row = byKey.get(key) ?? { label: search === step.title ? step.title.replace(' · ', ' ') : `${name} ${search}`, search, times: 0, repeats: 0, tokens: 0, turns: [] }
    row.times += 1
    byKey.set(key, row)
    if (seen.has(key)) {
      count += 1
      tokens += step.added ?? 0
      row.repeats += 1
      row.tokens += step.added ?? 0
      if (!row.turns.includes(step.turnId)) row.turns.push(step.turnId)
    } else seen.add(key)
  }
  const rows = [...byKey.values()].filter(row => row.repeats > 0).sort((a, b) => b.tokens - a.tokens || b.repeats - a.repeats)
  return { count, tokens, calls, rows }
}

// What reading from the cache saved on each priced request: its reads at the input rate less the read rate.
const savedOn = (model: string | undefined, tokens: Tokens | undefined) => {
  const rate = model ? rateOf(model) : undefined
  return rate && tokens ? tokens.cacheRead * Math.max(0, rate.input - rate.cacheRead) : 0
}

export const cacheSavedOf = (steps: Step[]) =>
  steps.reduce((sum, step) => {
    if (step.kind === 'model') return sum + savedOn(step.model, step.tokens)
    if (step.kind === 'agent') return sum + (step.agent?.log ?? []).reduce((inner, request) => inner + savedOn(request.model, request.tokens), 0)
    return sum
  }, 0)

export const sessionStats = (turns: Turn[], steps: Step[], runs: RunSummary[], window?: number) => {
  const cost = runs.reduce((sum, one) => sum + one.cost, 0)
  const unpriced = runs.reduce((sum, one) => sum + one.unpriced, 0)
  const tokens = turns.reduce<Tokens>(
    (sum, turn) => {
      const t = turn.tokens ?? steps.filter(step => step.turnId === turn.id && step.tokens).reduce<Tokens>((all, step) => addTokens(all, step.tokens as Tokens), zero())
      return addTokens(sum, t)
    },
    zero(),
  )
  const totalIn = tokens.input + tokens.cacheRead + tokens.cacheWrite
  const wallMs = runs.reduce((sum, one) => sum + one.durationMs, 0)
  const requests = turns.reduce((sum, turn) => sum + turn.requests + (turn.agentRequests ?? 0), 0)
  const calls = runs.reduce((sum, one) => sum + one.calls, 0)
  const failed = turns.reduce((sum, turn) => sum + (turn.failed ?? steps.filter(step => step.turnId === turn.id && step.status === 'failed').length), 0)
  const blocked = turns.reduce((sum, turn) => sum + (turn.blocked ?? steps.filter(step => step.turnId === turn.id && step.status === 'blocked').length), 0)
  const dupes = duplicatesOf(steps)

  // Cost by prompt, in the order they were sent; a prompt far over the median is flagged.
  const middle = median(runs.map(one => one.cost).filter(one => one > 0))
  const prompts: PromptCost[] = turns.map((turn, at) => {
    const run = runs.find(one => one.id === turn.id)
    const times = runs.length >= 3 && middle > 0 ? turn.cost / middle : undefined
    return { id: turn.id, n: at + 1, title: run?.title ?? turn.title, cost: turn.cost, unpriced: turn.unpriced ?? 0, split: turn.split, times }
  })
  const saved = cacheSavedOf(steps)

  // Context after each of the main agent's requests, and where a compaction cut it.
  const points: CtxPoint[] = steps
    .filter(step => (step.kind === 'model' || step.kind === 'compact') && step.ctx)
    .sort((a, b) => a.at - b.at)
    .map(step => ({ at: step.at, tokens: step.ctx ?? 0, compact: step.kind === 'compact' || undefined }))
  let jump = { at: -1, by: 0 }
  points.forEach((point, at) => {
    const before = points[at - 1]
    if (before && !point.compact && point.tokens - before.tokens > jump.by) jump = { at, by: point.tokens - before.tokens }
  })
  const peak = points.reduce((most, point, at) => (point.tokens > (points[most]?.tokens ?? 0) ? at : most), 0)

  // Tools by name: how often, how long they ran, what they added, how often they failed.
  const toolMap = new Map<string, ToolRow>()
  for (const step of steps) {
    if (step.kind !== 'tool' && step.kind !== 'skill') continue
    const name = step.kind === 'skill' ? 'Skill' : toolName(step)
    const row = toolMap.get(name) ?? { name, calls: 0, timed: 0, runMs: 0, added: 0, failed: 0, blocked: 0 }
    row.calls += 1
    const ran = step.runMs ?? (step.end !== undefined && !step.background ? step.end - step.at : undefined)
    if (ran !== undefined) {
      row.timed += 1
      row.runMs += ran
    }
    row.added += step.added ?? 0
    if (step.status === 'failed') row.failed += 1
    if (step.status === 'blocked') row.blocked += 1
    toolMap.set(name, row)
  }
  const tools = [...toolMap.values()].sort((a, b) => b.added - a.added || b.calls - a.calls)

  // Where the time went, summed over steps: parallel calls each count their own time.
  const time: Record<TimeRow['key'], number> = { model: 0, tools: 0, agents: 0, waiting: 0, overhead: 0 }
  for (const step of steps) {
    if (step.end === undefined) continue
    const took = Math.max(0, step.end - step.at)
    if (step.kind === 'model') time.model += took
    else if (step.kind === 'agent') time.agents += took
    else if ((step.kind === 'tool' || step.kind === 'skill') && !step.background) {
      const ran = Math.min(took, step.runMs ?? took)
      time.tools += ran
      time[step.asked ? 'waiting' : 'overhead'] += took - ran
    }
  }
  const timeRows: TimeRow[] = (
    [
      ['model', 'Model'],
      ['tools', 'Tools'],
      ['agents', 'Subagents'],
      ['waiting', 'Waiting on you'],
      ['overhead', 'Hooks and checks'],
    ] as const
  )
    .map(([key, label]) => ({ key, label, ms: time[key] }))
    .filter(row => row.ms > 0)

  // What went wrong, by tool and reason.
  const problemMap = new Map<string, ProblemRow>()
  for (const step of steps) {
    if (step.status !== 'failed' && step.status !== 'blocked') continue
    if (step.kind !== 'tool' && step.kind !== 'skill' && step.kind !== 'agent' && step.kind !== 'hook') continue
    const tool = step.kind === 'agent' ? (step.agent?.type ?? 'Subagent') : toolName(step)
    const said = step.details.find(detail => detail.key === 'Why')?.value || step.label || (step.status === 'blocked' ? 'Blocked' : 'Failed')
    const reason = said.length > 80 ? `${said.slice(0, 79)}…` : said
    const key = `${step.status}\n${tool}\n${reason}`
    const row = problemMap.get(key) ?? { tool, reason, status: step.status, count: 0 }
    row.count += 1
    problemMap.set(key, row)
  }
  const problems = [...problemMap.values()].sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool))

  // Files changed across the session, by path.
  const fileMap = new Map<string, FileRow>()
  for (const turn of turns)
    for (const file of turn.outcome ?? ([] as FileChange[])) {
      const row = fileMap.get(file.path) ?? { path: file.path, added: 0, removed: 0, tracked: false }
      row.added += file.added ?? 0
      row.removed += file.removed ?? 0
      row.tracked ||= file.added !== undefined
      fileMap.set(file.path, row)
    }
  const files = [...fileMap.values()].sort((a, b) => b.added + b.removed - (a.added + a.removed))
  const lines = files.reduce((sum, file) => sum + file.added + file.removed, 0)

  // Who spent it: each subagent type's cards, and the main agent's rest.
  const agentMap = new Map<string, SpenderRow>()
  for (const step of steps) {
    if (step.kind !== 'agent') continue
    const name = step.agent?.type ?? 'Subagent'
    const row = agentMap.get(name) ?? { name, cost: 0, runs: 0 }
    row.cost += step.cost ?? 0
    row.runs += 1
    agentMap.set(name, row)
  }
  const agentCost = [...agentMap.values()].reduce((sum, one) => sum + one.cost, 0)
  const spenders: SpenderRow[] = [{ name: 'Main agent', cost: Math.max(0, cost - agentCost), main: true, runs: turns.length }, ...[...agentMap.values()].sort((a, b) => b.cost - a.cost)]

  // The notable things first: a prompt far over the median, a tool that filled the context,
  // the context near its window, repeated calls, a run of failures, and the cache.
  const insights: Insight[] = []
  const top = [...prompts].sort((a, b) => b.cost - a.cost)[0]
  if (top?.times && top.times >= 2) {
    const run = runs.find(one => one.id === top.id)
    insights.push({
      tone: 'warn',
      runs: [{ text: `Prompt ${top.n}`, bold: true }, { text: ' cost ' }, { text: `${top.times.toFixed(1)}×`, bold: true }, { text: ` the median prompt${run?.subagents ? `, with ${run.subagents} subagent${run.subagents === 1 ? '' : 's'}` : ''}.` }],
    })
  }
  const added = tools.reduce((sum, one) => sum + one.added, 0)
  const filler = tools[0]
  if (filler && tools.length > 1 && added > 0 && filler.added / added >= 0.3)
    insights.push({ tone: 'info', runs: [{ text: filler.name, bold: true }, { text: ' added ' }, { text: `${percent(filler.added, added)}%`, bold: true }, { text: ' of all tool-result tokens, more than any other tool.' }] })
  const high = points[peak]
  if (window && high && high.tokens / window >= 0.8)
    insights.push({ tone: 'warn', runs: [{ text: 'Context peaked at ' }, { text: `${percent(high.tokens, window)}%`, bold: true }, { text: ` of the ${formatTokens(window)} window.` }] })
  // Five or more repeats of one call in one prompt reads as a loop; otherwise the total.
  const loop = dupes.rows.find(row => row.repeats >= 5 && row.turns.length === 1)
  const loopAt = loop ? turns.findIndex(turn => turn.id === loop.turns[0]) : -1
  if (loop && loopAt >= 0)
    insights.push({ tone: 'warn', runs: [{ text: loop.label, bold: true }, { text: ` ran ${loop.times} times in prompt ${loopAt + 1} with no edit between: a likely loop.` }] })
  else if (dupes.count > 0)
    insights.push({ tone: 'warn', runs: [{ text: `${dupes.count} call${dupes.count === 1 ? '' : 's'}`, bold: true }, { text: ` repeated with the same input, re-adding ≈${formatTokens(dupes.tokens)} tokens.` }] })
  const worst = problems[0]
  if (worst && worst.count >= 2)
    insights.push({ tone: 'warn', runs: [{ text: worst.tool, bold: true }, { text: ` ${worst.status} ${worst.count} times: ${worst.reason.replace(/[.…]$/, '')}.` }] })
  if (totalIn > 0) {
    const hits = steps.filter(step => step.kind === 'model' && step.tokens).map(step => step.tokens as Tokens)
    const lowest = hits.reduce((least, t) => Math.min(least, t.cacheRead / Math.max(1, t.input + t.cacheRead + t.cacheWrite)), 1)
    insights.push({
      tone: 'info',
      runs: [{ text: 'Cache hit rate is ' }, { text: `${percent(tokens.cacheRead, totalIn)}%`, bold: true }, { text: hits.length > 1 ? `; the lowest request was ${Math.round(lowest * 100)}%.` : '.' }],
    })
  }

  return {
    cost,
    unpriced,
    tokens,
    totalIn,
    hit: totalIn ? tokens.cacheRead / totalIn : 0,
    wallMs,
    requests,
    calls,
    failed,
    blocked,
    dupes,
    prompts,
    saved,
    points,
    jump: jump.at >= 0 ? jump : undefined,
    peak: points.length ? peak : undefined,
    tools,
    time: timeRows,
    problems,
    files,
    lines,
    spenders,
    insights: insights.slice(0, 3),
  }
}

export type SessionStats = ReturnType<typeof sessionStats>

const zero = (): Tokens => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
const addTokens = (a: Tokens, b: Tokens): Tokens => ({ input: a.input + b.input, output: a.output + b.output, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite })

// What a saved session's list entry keeps for Analytics: spend by day and model, input and
// cache reads, and calls. Spend a step can't name a model for goes to the prompt's own model.
export const entryFigures = (turns: Turn[], steps: Step[]): Pick<HistoryEntry, 'days' | 'models' | 'tokensIn' | 'cacheRead' | 'calls'> => {
  const days: Record<string, number> = {}
  const models: Record<string, number> = {}
  let tokensIn = 0
  let cacheRead = 0
  let calls = 0
  for (const turn of turns) {
    const day = dayKey(turn.at)
    days[day] = (days[day] ?? 0) + turn.cost
    const flow = steps.filter(step => step.turnId === turn.id)
    let named = 0
    const add = (model: string | undefined, cost: number | undefined) => {
      if (!model || !cost) return
      models[short(model)] = (models[short(model)] ?? 0) + cost
      named += cost
    }
    for (const step of flow) {
      if (step.kind === 'model') add(step.model, step.cost)
      else if (step.kind === 'agent') for (const request of step.agent?.log ?? []) add(request.model, request.cost)
    }
    const rest = turn.cost - named
    if (rest > 0.0005) {
      const own = turn.models?.[0] ?? flow.find(step => step.kind === 'model' && step.model)?.model
      const key = own ? short(own) : 'other'
      models[key] = (models[key] ?? 0) + rest
    }
    const t = turn.tokens ?? flow.filter(step => step.tokens).reduce<Tokens>((all, step) => addTokens(all, step.tokens as Tokens), zero())
    tokensIn += t.input + t.cacheRead + t.cacheWrite
    cacheRead += t.cacheRead
    calls += turn.calls ?? flow.filter(step => step.kind === 'tool' || step.kind === 'skill' || step.kind === 'agent').length
  }
  return { days, models, tokensIn, cacheRead, calls }
}

// An entry saved before Analytics existed has none of its figures: its file is opened once to fill them.
export const needsFigures = (entry: HistoryEntry) => entry.models === undefined

// `sessions`: how many sessions spent something that day.
export type DayBar = { day: string; at: number; cost: number; sessions: number }

// The saved sessions (this one among them) over the last `range` days.
export const allStats = (entries: HistoryEntry[], now: number, range: number) => {
  const first = new Date(now)
  first.setHours(0, 0, 0, 0)
  first.setDate(first.getDate() - (range - 1))
  const from = first.getTime()
  const bars: DayBar[] = Array.from({ length: range }, (_, n) => {
    const at = new Date(from)
    at.setDate(at.getDate() + n)
    return { day: dayKey(at.getTime()), at: at.getTime(), cost: 0, sessions: 0 }
  })
  const index = new Map(bars.map((bar, n) => [bar.day, n]))
  const inRange = entries.filter(entry => (entry.savedAt ?? entry.at) >= from)
  const projects = new Map<string, number>()
  const models = new Map<string, number>()
  let spend = 0
  let prompts = 0
  let unpriced = 0
  let problems = 0
  let calls = 0
  let callsKnown = 0
  let tokensIn = 0
  let cacheRead = 0
  let modelsKnown = 0
  for (const entry of inRange) {
    // Spend by day where the entry kept it, else all on the day it started.
    const days = entry.days ?? { [dayKey(entry.at)]: entry.cost }
    let counted = 0
    for (const [day, cost] of Object.entries(days)) {
      const at = index.get(day)
      if (at === undefined) continue
      const bar = bars[at]
      if (bar) {
        bar.cost += cost
        if (cost > 0) bar.sessions += 1
      }
      counted += cost
    }
    // A session that began before the range counts only its days inside it.
    const share = entry.cost > 0 ? counted / entry.cost : 0
    spend += counted
    prompts += entry.prompts
    unpriced += entry.unpriced ?? 0
    problems += entry.problems
    if (entry.calls !== undefined) {
      calls += entry.calls
      callsKnown += 1
    }
    if (entry.tokensIn !== undefined) {
      tokensIn += entry.tokensIn * share
      cacheRead += (entry.cacheRead ?? 0) * share
    }
    const project = entry.project ?? 'No project'
    projects.set(project, (projects.get(project) ?? 0) + counted)
    if (entry.models) {
      modelsKnown += 1
      for (const [model, cost] of Object.entries(entry.models)) models.set(model, (models.get(model) ?? 0) + cost * share)
    }
  }
  const busiest = bars.reduce((most, bar) => (bar.cost > most.cost ? bar : most), bars[0] ?? { day: '', at: from, cost: 0, sessions: 0 })
  const sortDesc = (map: Map<string, number>) =>
    [...map.entries()]
      .map(([name, cost]) => ({ name, cost }))
      .filter(one => one.cost > 0)
      .sort((a, b) => b.cost - a.cost)
  return {
    from,
    bars,
    spend,
    sessions: inRange.length,
    prompts,
    unpriced,
    perPrompt: prompts ? spend / prompts : 0,
    hit: tokensIn ? cacheRead / tokensIn : undefined,
    problemRate: callsKnown === inRange.length && calls ? problems / calls : undefined,
    busiest: busiest.cost > 0 ? busiest : undefined,
    top: [...inRange].sort((a, b) => b.cost - a.cost).slice(0, 5),
    projects: sortDesc(projects),
    models: sortDesc(models),
    modelsKnown,
  }
}

export type AllStats = ReturnType<typeof allStats>

// A quality tag in the mod's own words, for a chart's corner.
export const QUALITY_OF: Record<string, Quality> = {
  cost: 'estimated',
  context: 'observed',
  tools: 'observed',
  time: 'observed',
  problems: 'observed',
  produced: 'observed',
  spenders: 'estimated',
  dupes: 'inferred',
}

// --- Charts, drawn as Svg sources. Grey text and grid read on light and dark themes alike.

const AXIS = '#8b93a1'
const FONT = `font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif" font-size="11" fill="${AXIS}"`
// An axis label short enough for the margin: 500k, 1.2M.
const tick = (v: number) => (v >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${Math.round(v / 1e3)}k` : String(Math.round(v)))
const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// What one request's point says: the readout under the chart.
export const pointText = (points: CtxPoint[], n: number, window?: number) => {
  const point = points[n]
  if (!point) return ''
  const before = points[n - 1]
  const change = before ? point.tokens - before.tokens : 0
  return [
    `Request ${n + 1} of ${points.length}`,
    `${formatTokens(point.tokens)}${window ? ` (${Math.round((point.tokens / window) * 100)}% of the window)` : ''}`,
    point.compact ? 'compacted' : change ? `${change > 0 ? '+' : '−'}${formatTokens(Math.abs(change))} from the one before` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

// What one day's column says: the readout under the chart.
export const dayText = (bar: DayBar | undefined) =>
  bar ? `${new Date(bar.at).toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' })} · ${formatCost(bar.cost)}${bar.sessions ? ` · ${bar.sessions} session${bar.sessions === 1 ? '' : 's'}` : ''}` : ''

// The charts are drawn at 16px a cell, about twice a real one, so an Svg is only ever scaled down
// into its slot. Each lays out at real size (`drawn / SCALE` wide) inside a group scaled back up, so
// its labels and strokes come out at their stated size, and its height grows with its width so a
// wide pane does not flatten it.
const SCALE = 2
const chartHeight = (width: number) => Math.round(Math.min(260, Math.max(150, width * 0.28)))
const frame = (width: number, height: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width * SCALE} ${height * SCALE}"><g transform="scale(${SCALE})">${body}</g></svg>`

// Context after each request against the window: an area under a line, the window dashed, the
// biggest jump and each compaction marked, and the picked request ringed on a guide line.
// Sized by its viewBox alone, so it fills its slot.
export const contextChart = (
  points: CtxPoint[],
  window: number | undefined,
  jump: { at: number; by: number } | undefined,
  drawn: number,
  colors: { line: string; warn: string; ok: string },
  picked?: number,
) => {
  const width = drawn / SCALE
  const height = chartHeight(width)
  const left = 48
  const right = 10
  const top = 14
  const bottom = height - 26
  const most = Math.max(window ?? 0, ...points.map(point => point.tokens), 1)
  const x = (n: number) => left + (points.length > 1 ? (n * (width - left - right)) / (points.length - 1) : (width - left - right) / 2)
  const y = (v: number) => bottom - (v / most) * (bottom - top)
  const out: string[] = []
  const ticks = window ? [0, window / 2, window] : [0, most / 2, most]
  for (const value of ticks) {
    const dashed = window && value === window
    out.push(`<line x1="${left}" x2="${width - right}" y1="${y(value).toFixed(1)}" y2="${y(value).toFixed(1)}" stroke="${dashed ? colors.warn : AXIS}" stroke-opacity="${dashed ? 0.9 : 0.3}" stroke-width="1"${dashed ? ' stroke-dasharray="4 3"' : ''}/>`)
    out.push(`<text x="${left - 6}" y="${(y(value) + 4).toFixed(1)}" text-anchor="end" ${FONT}>${tick(value)}</text>`)
  }
  if (window) out.push(`<text x="${width - right}" y="${(y(window) - 5).toFixed(1)}" text-anchor="end" ${FONT}>window ${tick(window)}</text>`)
  const line = points.map((point, n) => `${x(n).toFixed(1)},${y(point.tokens).toFixed(1)}`)
  if (points.length > 0) {
    out.push(`<polygon points="${x(0).toFixed(1)},${bottom} ${line.join(' ')} ${x(points.length - 1).toFixed(1)},${bottom}" fill="${colors.line}" fill-opacity="0.14"/>`)
    out.push(`<polyline points="${line.join(' ')}" fill="none" stroke="${colors.line}" stroke-width="2" stroke-linejoin="round"/>`)
  }
  const mark = (n: number, color: string, label: string, toLeft: boolean) => {
    const point = points[n]
    if (!point) return
    out.push(`<circle cx="${x(n).toFixed(1)}" cy="${y(point.tokens).toFixed(1)}" r="4" fill="${color}"/>`)
    const room = toLeft ? x(n) - left > 120 : width - right - x(n) > 120
    const anchor = toLeft === room ? 'end' : 'start'
    out.push(`<text x="${(x(n) + (anchor === 'end' ? -8 : 8)).toFixed(1)}" y="${(y(point.tokens) - 12).toFixed(1)}" text-anchor="${anchor}" ${FONT}>${escape(label)}</text>`)
  }
  if (jump) mark(jump.at, colors.warn, `+${formatTokens(jump.by)} in one request`, true)
  points.forEach((point, n) => (point.compact ? mark(n, colors.ok, 'compacted', false) : undefined))
  const labels = [...new Set([0, Math.floor((points.length - 1) / 2), points.length - 1])].filter(n => n >= 0)
  for (const n of labels) out.push(`<text x="${x(n).toFixed(1)}" y="${bottom + 16}" text-anchor="middle" ${FONT}>${n + 1}</text>`)
  out.push(`<text x="${((left + width - right) / 2).toFixed(1)}" y="${height - 2}" text-anchor="middle" ${FONT}>request</text>`)
  const chosen = picked !== undefined ? points[picked] : undefined
  if (picked !== undefined && chosen) {
    out.push(`<line x1="${x(picked).toFixed(1)}" x2="${x(picked).toFixed(1)}" y1="${top}" y2="${bottom}" stroke="${AXIS}" stroke-opacity="0.7" stroke-width="1" stroke-dasharray="2 2"/>`)
    out.push(`<circle cx="${x(picked).toFixed(1)}" cy="${y(chosen.tokens).toFixed(1)}" r="5" fill="none" stroke="${colors.line}" stroke-width="2.5"/>`)
  }
  return frame(width, height, out.join(''))
}

// Spend per day as columns, today in the accent, the busiest day labelled.
// The picked day is outlined.
export const dayChart = (bars: DayBar[], today: string, drawn: number, colors: { bar: string; today: string }, picked?: number) => {
  const width = drawn / SCALE
  const height = chartHeight(width)
  const left = 48
  const right = 6
  const top = 16
  const bottom = height - 26
  const most = Math.max(0.01, ...bars.map(bar => bar.cost))
  const step = (width - left - right) / Math.max(1, bars.length)
  const y = (v: number) => bottom - (v / most) * (bottom - top)
  const out: string[] = []
  for (const value of [0, most / 2, most]) {
    out.push(`<line x1="${left}" x2="${width - right}" y1="${y(value).toFixed(1)}" y2="${y(value).toFixed(1)}" stroke="${AXIS}" stroke-opacity="0.3" stroke-width="1"/>`)
    out.push(`<text x="${left - 6}" y="${(y(value) + 4).toFixed(1)}" text-anchor="end" ${FONT}>${escape(formatCost(value))}</text>`)
  }
  const busiest = bars.reduce((most, bar, n) => (bar.cost > (bars[most]?.cost ?? 0) ? n : most), 0)
  const every = Math.max(1, Math.ceil(bars.length / 6))
  bars.forEach((bar, n) => {
    const x = left + n * step + step * 0.18
    const w = step * 0.64
    if (bar.cost > 0) out.push(`<rect x="${x.toFixed(1)}" y="${y(bar.cost).toFixed(1)}" width="${w.toFixed(1)}" height="${(bottom - y(bar.cost)).toFixed(1)}" rx="2" fill="${bar.day === today ? colors.today : colors.bar}"/>`)
    if (n === busiest && bar.cost > 0) out.push(`<text x="${(x + w / 2).toFixed(1)}" y="${(y(bar.cost) - 5).toFixed(1)}" text-anchor="middle" ${FONT}>${escape(formatCost(bar.cost))}</text>`)
    if (n % every === 0 || n === bars.length - 1) {
      const label = new Date(bar.at).toLocaleDateString('en', { month: 'short', day: 'numeric' })
      out.push(`<text x="${(x + w / 2).toFixed(1)}" y="${bottom + 16}" text-anchor="middle" ${FONT}>${escape(label)}</text>`)
    }
    if (n === picked) out.push(`<rect x="${(x - 2).toFixed(1)}" y="${(Math.min(y(bar.cost), bottom - 4) - 2).toFixed(1)}" width="${(w + 4).toFixed(1)}" height="${(bottom - Math.min(y(bar.cost), bottom - 4) + 2).toFixed(1)}" rx="3" fill="none" stroke="${colors.today}" stroke-width="1.5"/>`)
  })
  return frame(width, height, out.join(''))
}

// The terminal's charts: one block character per point, scaled to the tallest.
const BLOCKS = '▁▂▃▄▅▆▇█'
export const sparkline = (values: number[], cells: number, most = Math.max(1, ...values)) => {
  if (values.length === 0) return ''
  const picked = values.length <= cells ? values : Array.from({ length: cells }, (_, n) => Math.max(...values.slice(Math.floor((n * values.length) / cells), Math.floor(((n + 1) * values.length) / cells))))
  return picked.map(value => (value <= 0 ? ' ' : BLOCKS[Math.min(BLOCKS.length - 1, Math.floor((value / most) * BLOCKS.length))])).join('')
}
