import type { AgentCall, AgentRequest, CostSplit, PartKey, Quality, Step, Tokens, Turn } from '../types'
import { formatCost, formatTokens, PART_ORDER, PARTS } from './ledger'
import { writeRateOf } from './pricing'

// One prompt's whole run as data: every request, tool call and agent, with the totals derived from
// those records alone, so the JSON, the Markdown and the CSV agree with each other by construction.
// What Claude Code doesn't expose is said so, never filled in.

export type ReportMode = 'share-safe' | 'detailed'

export type ReportInput = {
  turn: Turn
  flow: Step[]
  // Later prompts that delivered this run's background subagents' reports, with their steps.
  handBacks: { turn: Turn; flow: Step[] }[]
  mode: ReportMode
  // The step's name without its free text (the tool, check, skill or hook).
  nameOf: (step: Step) => string
  // Masks credentials, emails and home folders; applied to every free text a detailed report keeps.
  redact: (text: string) => string
  branch?: string
  commit?: string
}

type TokenRow = { uncachedInput: number; cacheRead: number; cacheCreation: number; output: number; totalInput: number }

export type RequestRow = {
  id: string
  agent: string
  number: number
  status: 'ok' | 'failed'
  model: string
  effort?: string | number
  startedAt: string
  endedAt?: string
  startMs: number
  durationMs?: number
  // From the request going out to its first streamed chunk.
  latencyMs?: number
  stopReason?: string
  tokens?: TokenRow
  costUsd: number | null
  costSplitUsd?: CostSplit
  context?: {
    totalInputTokens: number
    byPart: Record<string, number>
    unattributedTokens: number
    quality: { totalInputTokens: Quality; byPart: Quality; unattributedTokens: Quality }
  }
  // The tool calls this request asked for, by id (the main loop and hand-backs).
  askedFor?: string[]
  quality: { time: Quality; latency: Quality; tokens: Quality; cost: Quality }
}

export type CallRole = 'tool' | 'skill' | 'delegation' | 'handback'

// The call a background subagent reports its result through; Claude Code counts it among the subagent's tool uses.
const HANDBACK_TOOL = 'SubagentHandback'

export type CallRow = {
  id: string
  agent: string
  requestedBy?: string
  name: string
  kind: string
  // What the call is: a tool, a skill, a delegation (the Agent call that starts a subagent) or a
  // hand-back (the call a subagent reports its result through). Only tools do work in the repository.
  role: CallRole
  status?: string
  label?: string
  startedAt: string
  endedAt?: string
  startMs: number
  durationMs?: number
  // The tool's own run time as Claude Code reports it (PostToolUse), without permission prompts or hooks.
  runMs?: number
  permissionAsked?: boolean
  // The call's wall time less the tool's own run time: permission prompts, hooks and overhead.
  waitMs?: number
  // Calls of the same agent whose wall times overlapped this one's.
  parallelWith?: string[]
  resultTokens?: number
  // A tool has no API charge itself; its result is billed as new input to the next request,
  // estimated here at that model's cache-write rate.
  resultCostUsd?: number
  detail?: string
  output?: string
  quality: { time: Quality; runMs: Quality; waitMs: Quality; resultTokens: Quality; resultCostUsd: Quality }
}

export type AgentRow = {
  id: string
  kind: 'main' | 'subagent' | 'handback'
  parent?: string
  type?: string
  model?: string
  background?: boolean
  status?: string
  stepId?: string
  turnId?: string
  startedAt: string
  endedAt?: string
  durationMs?: number
  // How long the subagent's own run took, as Claude Code reported it; durationMs also counts the lead-in from the Agent call.
  ranMs?: number
  requests: number
  requestsLogged: number
  toolCalls: number
  toolCallsLogged: number
  tokens: TokenRow
  costUsd: number
  unpricedRequests: number
  costSplitUsd: CostSplit
  // What the parent handed the subagent and what it loaded on its own, from its first request.
  handoff?: {
    fromParent: {
      taskTokens?: number
      task?: string
      conversationTokens?: number
      addedByClaudeCodeTokens?: number
      quality: { taskTokens: Quality; conversationTokens: Quality; addedByClaudeCodeTokens: Quality }
    }
    loadedByChild: { byPart: Record<string, number>; quality: Quality }
    unattributedTokens?: number
    firstRequestInputTokens?: number
    note: string
  }
  report?: string
  // Delivered the reports of these agents (a hand-back).
  delivers?: string[]
}

export type Check = { name: string; recorded: number; reference: number; difference: number; ok: boolean; note: string }

const EMPTY_SPLIT: CostSplit = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 }

const iso = (ms: number) => new Date(ms).toISOString()

const tokenRow = (t: Tokens): TokenRow => ({
  uncachedInput: t.input,
  cacheRead: t.cacheRead,
  cacheCreation: t.cacheWrite,
  output: t.output,
  totalInput: t.input + t.cacheRead + t.cacheWrite,
})

const addRow = (a: TokenRow, b: TokenRow): TokenRow => ({
  uncachedInput: a.uncachedInput + b.uncachedInput,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheCreation: a.cacheCreation + b.cacheCreation,
  output: a.output + b.output,
  totalInput: a.totalInput + b.totalInput,
})

const ZERO: TokenRow = { uncachedInput: 0, cacheRead: 0, cacheCreation: 0, output: 0, totalInput: 0 }

const addSplit = (a: CostSplit, b: CostSplit | undefined): CostSplit =>
  b ? { input: a.input + b.input, cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite, output: a.output + b.output } : a

const round = (value: number, digits = 6) => Math.round(value * 10 ** digits) / 10 ** digits

const byLabel = (parts: Partial<Record<PartKey, number>> | undefined, skip: PartKey[] = []) =>
  Object.fromEntries(PART_ORDER.filter(part => !skip.includes(part) && (parts?.[part] ?? 0) > 0).map(part => [PARTS[part].label, Math.round(parts?.[part] ?? 0)]))

const VERIFY = /\b(test|tests|jest|vitest|pytest|mocha|lint|eslint|tsc|typecheck|build|validate|verify|check|apex run test|deploy validate|--dry-run)\b/i

const isCall = (step: Step) => step.kind === 'tool' || step.kind === 'skill' || step.kind === 'agent'

const commandOf = (step: Step) => step.details.find(detail => detail.key === 'Command' || detail.key === 'Task')?.value

// Ids of calls whose wall times overlap, per call.
const overlaps = (calls: { id: string; at: number; end?: number }[]) => {
  const found: Record<string, string[]> = {}
  for (const one of calls) {
    const with_ = calls.filter(other => other.id !== one.id && other.end !== undefined && one.end !== undefined && other.at < one.end && one.at < other.end).map(other => other.id)
    if (with_.length) found[one.id] = with_
  }
  return found
}

export const buildReport = (input: ReportInput) => {
  const { turn, flow, handBacks, mode, nameOf, redact } = input
  const detailed = mode === 'detailed'
  const free = (text: string | undefined) => (detailed && text ? redact(text) : undefined)
  const answerText = (text: string | undefined) => (detailed ? free(text) : text ? '(left out of a share-safe export)' : undefined)
  const rel = (ms: number) => ms - turn.at
  const requests: RequestRow[] = []
  const calls: CallRow[] = []
  const agents: AgentRow[] = []

  const agentRow = (id: string, kind: AgentRow['kind'], at: number, extra: Partial<AgentRow> = {}): AgentRow => ({
    id,
    kind,
    startedAt: iso(at),
    requests: 0,
    requestsLogged: 0,
    toolCalls: 0,
    toolCallsLogged: 0,
    tokens: ZERO,
    costUsd: 0,
    unpricedRequests: 0,
    costSplitUsd: EMPTY_SPLIT,
    ...extra,
  })

  // A loop's own model requests and tool calls: the main loop's, or a hand-back's.
  const loop = (agent: string, steps: Step[]) => {
    const asked = new Map<string, string[]>()
    let asker: string | undefined
    let number = 0
    const models = steps.filter(step => step.kind === 'model')
    for (const step of steps) {
      if (step.kind === 'model') {
        number += 1
        asker = step.id
        asked.set(step.id, [])
        const t = step.tokens
        const priced = step.cost !== undefined
        requests.push({
          id: step.id,
          agent,
          number,
          status: step.status === 'failed' ? 'failed' : 'ok',
          model: step.model ?? '',
          effort: step.effort,
          startedAt: iso(step.at),
          endedAt: step.end !== undefined ? iso(step.end) : undefined,
          startMs: rel(step.at),
          durationMs: step.end !== undefined ? step.end - step.at : undefined,
          latencyMs: step.firstToken !== undefined ? step.firstToken - step.at : undefined,
          stopReason: step.stopReason,
          tokens: t && tokenRow(t),
          costUsd: priced ? round(step.cost as number) : t ? null : 0,
          costSplitUsd: step.split,
          context:
            t && step.parts
              ? {
                  totalInputTokens: tokenRow(t).totalInput,
                  byPart: byLabel(step.parts, ['other']),
                  unattributedTokens: Math.round(step.parts.other ?? 0),
                  quality: { totalInputTokens: 'observed', byPart: 'estimated', unattributedTokens: 'inferred' },
                }
              : undefined,
          quality: { time: 'observed', latency: step.firstToken !== undefined ? 'observed' : 'unavailable', tokens: t ? 'observed' : 'unavailable', cost: priced ? 'estimated' : 'unavailable' },
        })
        continue
      }
      if (!isCall(step)) continue
      if (asker) asked.get(asker)?.push(step.id)
      // The request after the call reads its result first, as new input.
      const reader = models.find(model => model.at >= (step.end ?? step.at))
      const rate = reader?.model ? writeRateOf(reader.model) : undefined
      const duration = step.end !== undefined ? step.end - step.at : undefined
      calls.push({
        id: step.id,
        agent,
        requestedBy: asker,
        name: nameOf(step),
        kind: step.kind,
        role: step.kind === 'agent' ? 'delegation' : step.kind === 'skill' ? 'skill' : 'tool',
        status: step.status,
        label: step.label,
        startedAt: iso(step.at),
        endedAt: step.end !== undefined ? iso(step.end) : undefined,
        startMs: rel(step.at),
        durationMs: duration,
        runMs: step.runMs,
        permissionAsked: step.asked || undefined,
        waitMs: duration !== undefined && step.runMs !== undefined ? Math.max(0, duration - step.runMs) : undefined,
        resultTokens: step.added,
        resultCostUsd: step.added && rate !== undefined ? round(step.added * rate) : undefined,
        detail: free(commandOf(step)),
        output: free(step.kind === 'agent' ? undefined : step.preview?.output),
        quality: {
          time: 'observed',
          runMs: step.runMs !== undefined ? 'observed' : 'unavailable',
          waitMs: step.runMs !== undefined ? 'inferred' : 'unavailable',
          resultTokens: step.added !== undefined ? 'estimated' : 'unavailable',
          resultCostUsd: step.added && rate !== undefined ? 'inferred' : 'unavailable',
        },
      })
    }
    for (const request of requests) if (asked.has(request.id) && request.agent === agent) request.askedFor = asked.get(request.id)
  }

  // A subagent's requests and calls, from its card's logs.
  const subagent = (id: string, card: Step, parent: string) => {
    const a = card.agent
    if (!a) return
    const log = a.log ?? []
    const skipped = Math.max(0, a.requests - log.length)
    log.forEach((request: AgentRequest, at) => {
      const t = request.tokens
      const priced = request.cost !== undefined
      requests.push({
        id: `${card.id}#request-${skipped + at + 1}`,
        agent: request.nested ? `${id}_nested` : id,
        number: skipped + at + 1,
        status: request.failed ? 'failed' : 'ok',
        model: request.model,
        startedAt: iso(request.at),
        endedAt: iso(request.end),
        startMs: rel(request.at),
        durationMs: request.end - request.at,
        latencyMs: request.firstToken !== undefined ? request.firstToken - request.at : undefined,
        stopReason: request.stopReason,
        tokens: request.failed ? undefined : tokenRow(t),
        costUsd: priced ? round(request.cost as number) : request.failed ? 0 : null,
        costSplitUsd: request.split,
        context:
          !request.failed && request.parts
            ? {
                totalInputTokens: tokenRow(t).totalInput,
                byPart: byLabel(request.parts),
                unattributedTokens: Math.round(request.hidden ?? 0),
                quality: { totalInputTokens: 'observed', byPart: 'estimated', unattributedTokens: 'inferred' },
              }
            : undefined,
        quality: {
          time: 'observed',
          latency: request.firstToken !== undefined ? 'observed' : 'unavailable',
          tokens: request.failed ? 'unavailable' : 'observed',
          cost: priced ? 'estimated' : 'unavailable',
        },
      })
    })
    const callLog = a.callLog ?? []
    const parallel = overlaps(callLog)
    callLog.forEach((call: AgentCall) => {
      const duration = call.end !== undefined ? call.end - call.at : undefined
      const reader = log.find(request => request.at >= (call.end ?? call.at))
      const rate = reader ? writeRateOf(reader.model) : undefined
      calls.push({
        id: call.id,
        agent: call.nested ? `${id}_nested` : id,
        name: call.name,
        kind: 'tool',
        role: call.name === HANDBACK_TOOL ? 'handback' : 'tool',
        status: call.status,
        startedAt: iso(call.at),
        endedAt: call.end !== undefined ? iso(call.end) : undefined,
        startMs: rel(call.at),
        durationMs: duration,
        runMs: call.runMs,
        permissionAsked: call.asked,
        waitMs: duration !== undefined && call.runMs !== undefined ? Math.max(0, duration - call.runMs) : undefined,
        parallelWith: parallel[call.id],
        resultTokens: call.added,
        resultCostUsd: call.added && rate !== undefined ? round(call.added * rate) : undefined,
        detail: free(call.detail),
        quality: {
          time: 'observed',
          runMs: call.runMs !== undefined ? 'observed' : 'unavailable',
          waitMs: call.runMs !== undefined ? 'inferred' : 'unavailable',
          resultTokens: call.added !== undefined ? 'estimated' : 'unavailable',
          resultCostUsd: call.added && rate !== undefined ? 'inferred' : 'unavailable',
        },
      })
    })
    const first = log.find(request => !request.nested && !request.failed)
    const parts = a.loaded ? Object.fromEntries(Object.entries(a.loaded.parts).map(([part, items]) => [part, (items ?? []).reduce((sum, item) => sum + item.tokens, 0)])) : first?.parts
    agents.push(
      agentRow(id, 'subagent', card.at, {
        parent,
        type: a.type,
        model: card.model,
        background: a.background,
        status: card.status,
        stepId: card.id,
        endedAt: card.end !== undefined ? iso(card.end) : undefined,
        durationMs: card.end !== undefined ? card.end - card.at : undefined,
        ranMs: a.ranMs,
        requests: a.requests,
        requestsLogged: log.length,
        toolCalls: a.calls,
        toolCallsLogged: callLog.length,
        handoff: {
          fromParent: {
            taskTokens: a.handoff,
            task: free(card.preview?.input),
            // The whole conversation part of the first request: the task plus what Claude Code put around it.
            conversationTokens: parts?.conversation !== undefined ? Math.round(parts.conversation) : undefined,
            // The part of it the task's text doesn't explain: Claude Code's environment, date, account and hand-back notes.
            addedByClaudeCodeTokens:
              parts?.conversation !== undefined && a.handoff !== undefined ? Math.max(0, Math.round(parts.conversation) - a.handoff) : undefined,
            quality: {
              taskTokens: a.handoff !== undefined ? 'estimated' : 'unavailable',
              conversationTokens: parts?.conversation !== undefined ? 'estimated' : 'unavailable',
              addedByClaudeCodeTokens: parts?.conversation !== undefined && a.handoff !== undefined ? 'inferred' : 'unavailable',
            },
          },
          loadedByChild: { byPart: byLabel(parts as Partial<Record<PartKey, number>> | undefined, ['conversation']), quality: parts ? 'estimated' : 'unavailable' },
          unattributedTokens: a.loaded?.hidden ?? first?.hidden,
          firstRequestInputTokens: first ? tokenRow(first.tokens).totalInput : undefined,
          note:
            "fromParent.taskTokens is all the parent chose to hand over: the task its Agent call passed, sized from its text. conversationTokens is the whole conversation part of the subagent's first request: that task plus " +
            'notes Claude Code adds around it (environment, date, account, hand-back instructions); addedByClaudeCodeTokens is the difference, so it is not something the parent sent. ' +
            'loadedByChild is what Claude Code added to its first request on its own (project instructions, memory, skills, hook text). ' +
            "unattributedTokens is the measured rest: it includes the subagent's system prompt and tool definitions, which Claude Code doesn't expose per subagent.",
        },
        report: free(card.preview?.output),
      }),
    )
  }

  // The main loop, its subagents, then each hand-back and any subagents it started.
  loop('main', flow)
  const mainCalls = calls.filter(call => call.agent === 'main')
  const parallel = overlaps(mainCalls.map(call => ({ id: call.id, at: call.startMs, end: call.durationMs !== undefined ? call.startMs + call.durationMs : undefined })))
  for (const call of mainCalls) call.parallelWith = parallel[call.id]
  agents.push(
    agentRow('main', 'main', turn.at, {
      turnId: turn.id,
      status: turn.status,
      endedAt: turn.end !== undefined ? iso(turn.end) : undefined,
      durationMs: turn.durationMs ?? (turn.end !== undefined ? turn.end - turn.at : undefined),
    }),
  )
  const cards = flow.filter(step => step.kind === 'agent')
  const nameOfAgent = new Map<string, string>()
  cards.forEach((card, n) => {
    const id = `subagent_${n + 1}`
    if (card.agent?.id) nameOfAgent.set(card.agent.id, id)
    subagent(id, card, 'main')
  })
  handBacks.forEach((back, n) => {
    const id = `handback_${n + 1}`
    loop(id, back.flow)
    agents.push(
      agentRow(id, 'handback', back.turn.at, {
        parent: 'main',
        turnId: back.turn.id,
        status: back.turn.status,
        endedAt: back.turn.end !== undefined ? iso(back.turn.end) : undefined,
        durationMs: back.turn.durationMs ?? (back.turn.end !== undefined ? back.turn.end - back.turn.at : undefined),
        delivers: (back.turn.handsBack ?? []).map(agentId => nameOfAgent.get(agentId) ?? agentId),
        report: free(back.turn.answer),
      }),
    )
    back.flow.filter(step => step.kind === 'agent').forEach((card, m) => subagent(`${id}_subagent_${m + 1}`, card, id))
  })

  // Each agent's figures, summed from its own records; nested subagents roll into the card that started them.
  const owner = (agent: string) => agent.replace(/_nested$/, '')
  for (const agent of agents) {
    const mine = requests.filter(request => owner(request.agent) === agent.id)
    agent.requestsLogged = mine.length
    if (agent.kind !== 'subagent') agent.requests = mine.length
    agent.tokens = mine.reduce((sum, request) => (request.tokens ? addRow(sum, request.tokens) : sum), ZERO)
    agent.costUsd = round(mine.reduce((sum, request) => sum + (request.costUsd ?? 0), 0))
    agent.unpricedRequests = mine.filter(request => request.costUsd === null).length
    agent.costSplitUsd = mine.reduce((sum, request) => addSplit(sum, request.costSplitUsd), EMPTY_SPLIT)
    const theirs = calls.filter(call => owner(call.agent) === agent.id)
    agent.toolCallsLogged = theirs.length
    if (agent.kind !== 'subagent') agent.toolCalls = theirs.length
  }

  // The run: from the prompt to the later of its answer, its last subagent's end and its last hand-back's end.
  const ends = [turn.end, turn.agentsEnd, ...handBacks.map(back => back.turn.end)].filter((value): value is number => value !== undefined)
  const endedAt = ends.length ? Math.max(...ends) : undefined
  const tokens = requests.reduce((sum, request) => (request.tokens ? addRow(sum, request.tokens) : sum), ZERO)
  const cost = round(requests.reduce((sum, request) => sum + (request.costUsd ?? 0), 0))
  const split = requests.reduce((sum, request) => addSplit(sum, request.costSplitUsd), EMPTY_SPLIT)
  const unpriced = requests.filter(request => request.costUsd === null).length
  const notLogged = agents.reduce((sum, agent) => sum + Math.max(0, agent.requests - agent.requestsLogged), 0)
  const callsNotLogged = agents.reduce((sum, agent) => sum + Math.max(0, agent.toolCalls - agent.toolCallsLogged), 0)

  // Each figure checked against an independent record of it: the running totals the pane keeps,
  // and the usage Claude Code reports at each turn's end.
  const checks: Check[] = []
  const check = (name: string, recorded: number, reference: number, note: string, tolerance = 0) =>
    checks.push({ name, recorded: round(recorded), reference: round(reference), difference: round(recorded - reference), ok: Math.abs(recorded - reference) <= tolerance, note })
  const runningCost = turn.cost + handBacks.reduce((sum, back) => sum + back.turn.cost, 0)
  // Each request's cost is rounded to 6 places, so the sum may drift by half a millionth of a dollar per request.
  check('cost', cost, runningCost, "The requests' costs summed, against the prompt's and its hand-backs' running totals.", requests.length * 5e-7 + 1e-9)
  const running = [turn, ...handBacks.map(back => back.turn)].reduce<Tokens | undefined>(
    (sum, one) => (sum && one.tokens ? { input: sum.input + one.tokens.input, output: sum.output + one.tokens.output, cacheRead: sum.cacheRead + one.tokens.cacheRead, cacheWrite: sum.cacheWrite + one.tokens.cacheWrite } : undefined),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  )
  if (running) check('tokens.totalInput', tokens.totalInput, tokenRow(running).totalInput, "The requests' input summed, against the running totals.")
  if (running) check('tokens.output', tokens.output, running.output, "The requests' output summed, against the running totals.")
  const mainLoop = (agent: string, reported: Tokens | undefined) => {
    if (!reported) return
    const theirs = requests.filter(request => request.agent === agent).reduce((sum, request) => (request.tokens ? addRow(sum, request.tokens) : sum), ZERO)
    check(`${agent}.reportedTotalInput`, theirs.totalInput, tokenRow(reported).totalInput, `${agent}'s requests summed, against the usage Claude Code reported at its turn's end.`)
    check(`${agent}.reportedOutput`, theirs.output, reported.output, `${agent}'s output summed, against the usage Claude Code reported at its turn's end.`)
  }
  mainLoop('main', turn.reported)
  handBacks.forEach((back, n) => mainLoop(`handback_${n + 1}`, back.turn.reported))
  for (const card of [...cards, ...handBacks.flatMap(back => back.flow.filter(step => step.kind === 'agent'))]) {
    const agent = agents.find(one => one.stepId === card.id)
    if (!agent) continue
    check(`${agent.id}.requests`, agent.requestsLogged, agent.requests, 'Its logged requests, against the requests counted on its card (a long run drops the oldest from the log).')
    if (card.agent?.reported) {
      check(`${agent.id}.reportedTotalInput`, agent.tokens.totalInput, tokenRow(card.agent.reported).totalInput, 'Its requests summed, against the usage Claude Code reported at the end of its runs.')
    }
  }
  check('requests', requests.length, agents.reduce((sum, agent) => sum + agent.requests, 0), 'The request records, against the requests counted per agent.')
  if (endedAt !== undefined) {
    const last = Math.max(...requests.map(request => (request.endedAt ? Date.parse(request.endedAt) : 0)), ...calls.map(call => (call.endedAt ? Date.parse(call.endedAt) : 0)))
    check('timing.lastRecordWithinRun', Math.max(0, last - endedAt), 0, 'How far the last request or call ended after the run did: 0 when every record falls within the run.')
  }

  const verification = calls
    .filter(call => VERIFY.test(`${call.name} ${call.label ?? ''} ${commandOfCall(call, flow, cards) ?? ''}`))
    .map(call => ({ id: call.id, agent: call.agent, name: call.name, status: call.status, label: call.label, detail: call.detail, output: call.output }))

  return {
    schema: 'agent-trace/export@4',
    exportedBy: 'agent-trace',
    mode,
    run: {
      turnId: turn.id,
      title: redact(turn.title),
      branch: input.branch && redact(input.branch),
      commit: input.commit,
      scope: 'This prompt, every subagent it started, and the later prompts that delivered their reports (hand-backs).',
      startedAt: iso(turn.at),
      answeredAt: turn.end !== undefined ? iso(turn.end) : undefined,
      endedAt: endedAt !== undefined ? iso(endedAt) : undefined,
      answerMs: turn.durationMs ?? (turn.end !== undefined ? turn.end - turn.at : undefined),
      durationMs: endedAt !== undefined ? endedAt - turn.at : undefined,
      complete: { steps: !turn.evicted && handBacks.every(back => !back.turn.evicted), requests: notLogged === 0, toolCalls: callsNotLogged === 0, cost: unpriced === 0 },
      totals: {
        requests: {
          all: requests.length,
          byAgent: Object.fromEntries(agents.map(agent => [agent.id, agent.requests])),
          failed: requests.filter(request => request.status === 'failed').length,
          notLogged,
        },
        toolCalls: {
          all: calls.length,
          byAgent: Object.fromEntries(agents.map(agent => [agent.id, agent.toolCalls])),
          // Claude Code counts a delegation and a subagent's hand-back call among tool calls; `all` keeps that count.
          byRole: Object.fromEntries((['tool', 'skill', 'delegation', 'handback'] as CallRole[]).map(role => [role, calls.filter(call => call.role === role).length])),
          failed: calls.filter(call => call.status === 'failed').length,
          blocked: calls.filter(call => call.status === 'blocked').length,
          notLogged: callsNotLogged,
        },
        tokens,
        costUsd: cost,
        costSplitUsd: split,
        costByAgentUsd: Object.fromEntries(agents.map(agent => [agent.id, agent.costUsd])),
        unpricedRequests: unpriced,
      },
    },
    agents,
    requests,
    toolCalls: calls,
    outputs: {
      // The run's last answer: the final hand-back's when the prompt only launched background subagents.
      finalAnswer: answerText(handBacks.at(-1)?.turn.answer ?? turn.answer),
      finalAnswerFrom: handBacks.at(-1)?.turn.answer ? `handback_${handBacks.length}` : 'main',
      // The answer the prompt itself ended with, before any hand-back.
      promptAnswer: handBacks.length ? answerText(turn.answer) : undefined,
      // Each hand-back's answer, in order.
      handBackAnswers: handBacks.map((back, n) => ({ agent: `handback_${n + 1}`, answer: answerText(back.turn.answer) })),
      filesChanged: turn.outcome ?? [],
      verification,
    },
    checks,
    quality: {
      observed: 'As Claude Code or the API reported it: times, token counts, stop reasons, tool run times.',
      estimated: 'Computed: costs from the API price table, context parts and results from text length (about 4 characters a token), scaled to the measured input.',
      inferred: "A measured figure less an estimate or another measure: unattributed context, permission waits, a tool result's cost.",
      unavailable: 'Not exposed to the mod; left out rather than guessed.',
    },
    notExposed: [
      'Retries: Claude Code passes them as opaque stream items, so they are not counted. A request that failed outright is recorded as failed.',
      "A subagent's system prompt and tool definitions: they are inside its unattributedTokens, never split out.",
      'Exact tokens per context part: the API reports one input total per request; parts are sized from their text.',
      "Permission waits: Claude Code doesn't time them; waitMs is the call's wall time less the tool's own run time.",
      'Tool costs: tools are not billed; resultCostUsd estimates what their result costs the next request.',
      'Latency of a request whose first chunk never arrived.',
    ],
    privacy:
      mode === 'detailed'
        ? 'Detailed: keeps commands, the first lines of tool output, subagent tasks and reports, and the final answer, with credentials, emails and home folders masked (best effort). Keep it local.'
        : 'Share-safe: leaves out commands, tool input and output, error messages, subagent tasks and reports, and the final answer; masks credentials, emails and home folders (best effort). Still included: the prompt title, git branch and commit, model, tool, skill and subagent names, timings, token counts and costs.',
  }
}

// The command a call ran, for spotting checks and tests; a subagent's calls keep theirs on its card's log.
const commandOfCall = (call: CallRow, flow: Step[], cards: Step[]) => {
  const step = flow.find(one => one.id === call.id)
  if (step) return commandOf(step)
  for (const card of cards) {
    const found = card.agent?.callLog?.find(one => one.id === call.id)
    if (found) return found.detail
  }
  return undefined
}

export type Report = ReturnType<typeof buildReport>

const CSV_HEADER = [
  'time_s',
  'agent',
  'request',
  'model',
  'new_input_tok',
  'cache_read_tok',
  'cache_write_tok',
  'output_tok',
  'cost_usd_est',
  'cache_write_usd_est',
  'cache_read_usd_est',
  'output_usd_est',
  'input_usd_est',
]

// A field as CSV writes it: quoted when it holds a comma, a quote or a line break.
const csvField = (value: string | number | undefined) => {
  const text = value === undefined ? '' : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

// One row per model request, in the order they started, then a TOTAL row equal to the report's totals.
export const reportCsv = (report: Report) => {
  const usd = (value: number | null | undefined) => (value === undefined || value === null ? undefined : value.toFixed(4))
  const rows = [...report.requests].sort((a, b) => a.startMs - b.startMs)
  const line = (row: RequestRow) => [
    (row.startMs / 1000).toFixed(1),
    row.agent,
    row.number,
    row.model,
    row.tokens?.uncachedInput,
    row.tokens?.cacheRead,
    row.tokens?.cacheCreation,
    row.tokens?.output,
    usd(row.costUsd),
    usd(row.costSplitUsd?.cacheWrite),
    usd(row.costSplitUsd?.cacheRead),
    usd(row.costSplitUsd?.output),
    usd(row.costSplitUsd?.input),
  ]
  const t = report.run.totals
  // A total of costs some rows lack would read as complete: blank instead.
  const priced = t.unpricedRequests === 0
  const split = rows.every(row => row.costSplitUsd || row.costUsd === 0)
  const total = [
    '',
    'TOTAL',
    '',
    '',
    t.tokens.uncachedInput,
    t.tokens.cacheRead,
    t.tokens.cacheCreation,
    t.tokens.output,
    priced ? usd(t.costUsd) : undefined,
    priced && split ? usd(t.costSplitUsd.cacheWrite) : undefined,
    priced && split ? usd(t.costSplitUsd.cacheRead) : undefined,
    priced && split ? usd(t.costSplitUsd.output) : undefined,
    priced && split ? usd(t.costSplitUsd.input) : undefined,
  ]
  return `${[CSV_HEADER, ...rows.map(line), total].map(fields => fields.map(csvField).join(',')).join('\n')}\n`
}

const seconds = (ms: number | undefined) => (ms === undefined ? '–' : ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`)
const cell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ')

// The same report as Markdown: totals, agents, timing, every request, tool calls, context, outputs and checks.
export const reportMarkdown = (report: Report, story: string) => {
  const r = report.run
  const t = r.totals
  const lines: string[] = [
    story,
    '',
    '## Run totals',
    '',
    `_${r.scope}_`,
    '',
    `- Duration: ${seconds(r.durationMs)} (answer at ${seconds(r.answerMs)}); started ${r.startedAt}${r.endedAt ? `, ended ${r.endedAt}` : ''}`,
    `- Requests: ${t.requests.all} (${Object.entries(t.requests.byAgent)
      .map(([agent, count]) => `${agent} ${count}`)
      .join(', ')})${t.requests.failed ? `, ${t.requests.failed} failed` : ''}${t.requests.notLogged ? `, ${t.requests.notLogged} not logged` : ''}`,
    `- Tool calls: ${t.toolCalls.all} (${t.toolCalls.byRole.tool} tools${t.toolCalls.byRole.skill ? `, ${t.toolCalls.byRole.skill} skills` : ''}, ${t.toolCalls.byRole.delegation} delegation${t.toolCalls.byRole.delegation === 1 ? '' : 's'} to subagents, ${t.toolCalls.byRole.handback} hand-back report${t.toolCalls.byRole.handback === 1 ? '' : 's'})${t.toolCalls.failed ? `, ${t.toolCalls.failed} failed` : ''}${t.toolCalls.blocked ? `, ${t.toolCalls.blocked} blocked` : ''}`,
    `- Input: ${formatTokens(t.tokens.totalInput)} (${formatTokens(t.tokens.uncachedInput)} uncached, ${formatTokens(t.tokens.cacheRead)} cache reads, ${formatTokens(t.tokens.cacheCreation)} cache writes) · output ${formatTokens(t.tokens.output)} (observed)`,
    `- Cost: ${formatCost(t.costUsd)}${t.unpricedRequests ? ` + ${t.unpricedRequests} unpriced` : ''} (estimated): cache writes ${formatCost(t.costSplitUsd.cacheWrite)}, cache reads ${formatCost(t.costSplitUsd.cacheRead)}, output ${formatCost(t.costSplitUsd.output)}, uncached input ${formatCost(t.costSplitUsd.input)}`,
    '',
    '## Agents',
    '',
    '| Agent | Kind | Ran | Requests | Tool calls | Input | Cache writes | Output | Cost (est.) |',
    '| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...report.agents.map(
      agent =>
        `| ${agent.id}${agent.type ? ` (${agent.type})` : ''} | ${agent.kind}${agent.background ? ', background' : ''} | ${seconds(agent.ranMs ?? agent.durationMs)} | ${agent.requests} | ${agent.toolCalls} | ${formatTokens(agent.tokens.totalInput)} | ${formatTokens(agent.tokens.cacheCreation)} | ${formatTokens(agent.tokens.output)} | ${formatCost(agent.costUsd)} |`,
    ),
  ]
  for (const agent of report.agents.filter(one => one.handoff)) {
    const h = agent.handoff
    if (!h) continue
    lines.push(
      '',
      `### ${agent.id}: what it was handed and what it loaded`,
      '',
      `- From the parent: the task, ≈${h.fromParent.taskTokens === undefined ? '?' : formatTokens(h.fromParent.taskTokens)} tokens (estimated)${h.fromParent.conversationTokens !== undefined ? `; its conversation part in its first request ≈${formatTokens(h.fromParent.conversationTokens)}, of which ≈${formatTokens(h.fromParent.addedByClaudeCodeTokens ?? 0)} is notes Claude Code added around the task (environment, date, account; estimated)` : ''}`,
      `- Loaded by the subagent: ${Object.entries(h.loadedByChild.byPart).map(([part, tokens]) => `${part} ≈${formatTokens(tokens)}`).join(', ') || 'nothing readable'} (estimated)`,
      `- Unattributed: ≈${h.unattributedTokens === undefined ? '?' : formatTokens(h.unattributedTokens)} of ${h.firstRequestInputTokens === undefined ? '?' : formatTokens(h.firstRequestInputTokens)} input (inferred; includes its system prompt and tool definitions, not exposed)`,
      ...(h.fromParent.task ? ['', '```text', h.fromParent.task, '```'] : []),
    )
  }
  lines.push(
    '',
    '## Requests',
    '',
    '| Start | Agent | # | Status | Took | First token | Uncached | Cache read | Cache write | Output | Cost (est.) |',
    '| ---: | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...[...report.requests]
      .sort((a, b) => a.startMs - b.startMs)
      .map(
        row =>
          `| ${seconds(row.startMs)} | ${row.agent} | ${row.number} | ${row.status}${row.stopReason ? ` (${row.stopReason})` : ''} | ${seconds(row.durationMs)} | ${seconds(row.latencyMs)} | ${row.tokens ? formatTokens(row.tokens.uncachedInput) : '–'} | ${row.tokens ? formatTokens(row.tokens.cacheRead) : '–'} | ${row.tokens ? formatTokens(row.tokens.cacheCreation) : '–'} | ${row.tokens ? formatTokens(row.tokens.output) : '–'} | ${row.costUsd === null ? 'unpriced' : formatCost(row.costUsd)} |`,
      ),
    '',
    '## Tool calls',
    '',
    '| Start | Agent | Tool (role) | Status | Took | Ran | Wait | Parallel | Result | Result cost |',
    '| ---: | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...[...report.toolCalls]
      .sort((a, b) => a.startMs - b.startMs)
      .map(
        call =>
          `| ${seconds(call.startMs)} | ${call.agent} | ${cell(call.name)}${call.role === 'delegation' ? ' (delegation)' : call.role === 'handback' ? ' (hand-back report)' : ''}${call.detail ? `: \`${cell(call.detail).slice(0, 80)}\`` : ''} | ${call.status ?? '–'}${call.permissionAsked ? ', asked' : ''} | ${seconds(call.durationMs)} | ${seconds(call.runMs)} | ${seconds(call.waitMs)} | ${call.parallelWith?.length ?? 0} | ${call.resultTokens === undefined ? '–' : `≈${formatTokens(call.resultTokens)}`} | ${call.resultCostUsd === undefined ? '–' : formatCost(call.resultCostUsd)} |`,
      ),
    '',
    '## Outputs',
    '',
    `- Files changed: ${report.outputs.filesChanged.length ? report.outputs.filesChanged.map(file => file.path).join(', ') : 'none'}`,
    `- Checks and tests run: ${report.outputs.verification.length ? report.outputs.verification.map(one => `${one.name} (${one.agent}, ${one.status ?? 'running'})`).join(', ') : 'none recorded'}`,
    ...(report.outputs.finalAnswer && report.mode === 'detailed'
      ? [
          '',
          `**Final answer (first lines${report.outputs.finalAnswerFrom === 'main' ? '' : `, given in ${report.outputs.finalAnswerFrom} after the subagents handed back`}):**`,
          '',
          '```text',
          report.outputs.finalAnswer,
          '```',
          ...(report.outputs.promptAnswer ? ['', '**Answer when the prompt first returned, before the hand-back (first lines):**', '', '```text', report.outputs.promptAnswer, '```'] : []),
        ]
      : []),
    '',
    '## Reconciliation',
    '',
    '| Check | Recorded | Reference | Difference | OK |',
    '| --- | ---: | ---: | ---: | --- |',
    ...report.checks.map(one => `| ${one.name} | ${one.recorded} | ${one.reference} | ${one.difference} | ${one.ok ? 'yes' : '**no**'} |`),
    '',
    '## Not exposed',
    '',
    ...report.notExposed.map(item => `- ${item}`),
    '',
    `_${Object.entries(report.quality)
      .map(([name, text]) => `${name}: ${text}`)
      .join(' ')}_`,
    '',
    `_${report.privacy}_`,
  )
  return lines.join('\n')
}
