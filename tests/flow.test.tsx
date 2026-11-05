import { expect, mock, test } from 'claude-code/testing'
import { calibrate, classify, condense } from '../hooks/ledger'
import { formatCommand } from '../hooks/command'
import { fitTrace, MAX_TRACE_CHARS } from '../hooks/history'
import { costOf, modelKey, PRICES_JSON, rateOf } from '../hooks/pricing'

const PANE = {
  plugin: 'agent-trace',
  component: 'Pane',
  requestId: 'agent-trace',
  props: {
    title: 'Agent trace',
    isFocused: false,
    bodyColumns: 110,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 120 },
    view: {},
  },
} as const

const SURFACES = ['terminal', 'desktop', 'vscode', 'mobile'] as const

const reminder = (body: string) => `<system-reminder>${body}</system-reminder>`

const FIRST = [
  {
    role: 'user',
    content: [
      {
        type: 'text',
        text:
          reminder(
            `Contents of /Users/x/Claude Build Opus 5.5/repo/AGENTS.md (project instructions, checked into the codebase):\n${'a'.repeat(2000)}\n\n` +
              `Contents of /Users/x/.claude/projects/p/memory/MEMORY.md (user's auto-memory, persists across conversations):\n${'m'.repeat(400)}`,
          ) +
          reminder(`The following skills are available for use with the Skill tool:\n${'s'.repeat(1200)}`) +
          reminder(`UserPromptSubmit hook additional context: Plugin-catalog match: ${'p'.repeat(800)}`) +
          '/review-story PSS-202',
      },
    ],
  },
]

// The second request also carries a hook that timed out.
const SECOND = [
  ...FIRST,
  { role: 'assistant', content: [{ type: 'text', text: 'r'.repeat(200) }] },
  { role: 'user', content: [{ type: 'text', text: reminder('PostToolUse:Edit hook timed out after 120s') }] },
]

let messages: readonly unknown[] = FIRST

const USAGE = {
  model: 'claude-sonnet-5-5',
  input_tokens: 1000,
  output_tokens: 200,
  cache_read_input_tokens: 9000,
  cache_creation_input_tokens: 0,
}

const localDay = () => {
  const day = new Date()
  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`
}

type On = Parameters<Parameters<typeof test>[1]>[1]
type Engine = Parameters<Parameters<typeof test>[1]>[0]

type Clock = ReturnType<typeof mock.clock>

// What `git diff --numstat HEAD` prints; the apex test run below changes a file.
let disk: Record<string, string> = {}
let sessionId = 's1'
const HISTORY = '/home/u/.claude/agent-trace/history'
let numstatOut = ''

// The model each request's usage names, so a test can bring an unpriced one.
let usageModel = 'claude-sonnet-5-5'
// Counters a test adds to each request's usage, such as cache writes.
let usageExtra: Record<string, number> = {}
// /context's breakdown, when the host reports one; absent by default, as on older hosts.
let breakdown: unknown
// What the daily-cost script was run with.
let pythonArgv: string[] = []
// An Agent call held open until the test releases it: as in the host, the subagent's
// spawn, its calls and its end happen inside the call, and the call's answer comes last.
let agentHold: Promise<unknown> | undefined
const holdAgent = () => {
  let release: (answer: unknown) => void = () => undefined
  agentHold = new Promise(done => (release = done))
  return release
}
// A subagent's model request held in flight until the test releases it.
let stepHold: Promise<unknown> | undefined
const holdStep = () => {
  let release: () => void = () => undefined
  stepHold = new Promise<void>(done => (release = done))
  return release
}

const SUMMARY = { role: 'user', text: 'Summary of the conversation so far', toolUses: [] } as const

// Each hook here stands for the engine beneath the mod.
const engine = (on: On, clock: Clock, window = 200_000) => {
  numstatOut = ''
  usageModel = 'claude-sonnet-5-5'
  usageExtra = {}
  breakdown = undefined
  agentHold = undefined
  stepHold = undefined
  on('session.usage', (_, e) => {
    const asked = Boolean((e as { breakdown?: string } | undefined)?.breakdown)
    return { value: { startedAt: 0, context: { window, tokens: 10_000, percent: 5, ...(asked && breakdown ? { breakdown: breakdown as never } : {}) }, rateLimits: [], cost: { usd: 1.25 } } }
  })
  on('tool.check', { tool: 'Probe' }, () => ({ decision: 'ask' }))
  on('session.compact', () => ({ messages: [SUMMARY], tokensBefore: 180_000, tokensAfter: 40_000 }))
  on('classic.PostToolUse', () => ({}))
  on('classic.PostToolUseFailure', () => ({}))
  on('command.register', () => ({ value: { command: 'agent-trace' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  // Saved traces go to this map, never to a real home folder.
  on('env.get', () => ({ value: '/home/u' }))
  on('session.id', () => ({ value: sessionId }))
  on('fs.write', (_, e) => {
    const write = e as { path?: string; text?: string }
    disk[String(write.path)] = String(write.text)
    return { value: undefined }
  })
  on('fs.exists', (_, e) => ({ value: String((e as { path?: string }).path) in disk }))
  on('fs.read', (_, e) => {
    const text = disk[String((e as { path?: string }).path)]
    if (text === undefined) throw new Error('ENOENT')
    return { value: text }
  })
  on('process.run', (_, e) => {
    const argv = (e as { argv?: string[] }).argv ?? Object.values(e as object).find(Array.isArray) ?? []
    if (String(argv[0]) === 'python3') pythonArgv = argv.map(String)
    if (String(argv[0]) === 'rm') delete disk[String(argv.at(-1))]
    const stdout =
      String(argv[0]) === 'python3'
        ? JSON.stringify({ day: localDay(), total: 24.39, requests: 313 })
        : argv.includes('--short')
          ? 'abc1234\n'
          : argv.includes('--numstat')
            ? numstatOut
            : argv.includes('--show-toplevel')
              ? '/repo\n'
              : 'feature/PSS-202-x\n'
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('session.messages', () => ({ value: messages }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('agent.spawn', (_, e) => ({ model: 'claude-sonnet-5-5', agentId: ({ 't1-ag2': 'a2', 't1-ag3': 'a3' } as Record<string, string>)[e.tool_use_id] ?? 'a1' }))
  on('prompt.compose', () => ({ sections: [{ id: 'intro', text: 'x'.repeat(400), scope: 'shared' }] }))
  on('turn.step', async function* (_, e) {
    const hold = e.agentId ? stepHold : undefined
    if (hold) {
      stepHold = undefined
      await hold
    }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: { ...USAGE, ...usageExtra, model: usageModel } }
  })
  on('tool.call', async (_, e) => {
    const hold = agentHold
    if (String(e.tool) === 'Agent' && hold) {
      agentHold = undefined
      return (await hold) as never
    }
    const command = String((e as { command?: string }).command ?? '')
    if (command.includes('PSSORG')) return { deny: 'block-protected-orgs.sh: PSSORG is a protected org. Use PSSCLAUDEORG.' }
    if (command.includes('apex run test')) {
      numstatOut = '12\t3\tforce-app/Foo.cls\n'
      await clock.advance(1200)
      return { isError: true, result: {}, text: '21 passed, 1 failed: testBulkInsert. See the log.' }
    }
    return { result: {}, text: 'x'.repeat(800) }
  })
}

const COMPOSE = { model: 'claude-sonnet-5-5', promptModel: 'claude-sonnet-5-5', surfaces: [], tools: [], outputStyle: null, traits: [] }

const step = async ($: Engine, turnId: string, index: number, agentId?: string) => {
  const run = $.turn.step({ turnId, index, model: 'claude-sonnet-5-5', messageCount: 1, ...(agentId ? { agentId } : {}) } as never)
  for await (const _ of run) void _
  await run.result
}

const runPrompt = async ($: Engine, turnId: string, text: string, command?: string) => {
  messages = FIRST
  // Inputs carry only the fields the mod reads.
  await $.prompt.submit({ text, ...(command ? { command: { name: command, args: text.split(' ')[1] ?? '' } } : {}) } as never)
  await $.turn.start({ text, turnId })
  await $.prompt.compose(COMPOSE)
  await step($, turnId, 0)
  await $.tool.call({ tool: 'Skill', tool_use_id: `${turnId}-sk`, skill: 'review-story' } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: `${turnId}-b`, command: 'sf org display --target-org PSSORG' } as never)
  await $.tool.call({ tool: 'Agent', tool_use_id: `${turnId}-ag`, subagent_type: 'story-reviewer', description: 'Fresh review of PSS-202' } as never)
  await $.agent.spawn({ tool_use_id: `${turnId}-ag` } as never)
  await step($, `${turnId}-sub`, 0, 'a1')
  await $.tool.call({ tool: 'Read', tool_use_id: `${turnId}-r`, agentId: 'a1', file_path: '/repo/design.md' } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: `${turnId}-t`, command: 'sf apex run test --tests PSS_RiskAssessmentServiceTest' } as never)
  messages = SECOND
  await step($, turnId, 1)
  await $.turn.complete({ turnId, answer: 'Review done.', durationMs: 10, isAborted: false, reason: 'answer' } as never)
}

test('the flow lists each step in order, colored by kind, with problems and details', async ($, on) => {
  engine(on, mock.clock(on, { now: Date.now() }))
  mock.store(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await runPrompt($, 't1', '/review-story PSS-202', 'review-story')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /You sent “\/review-story PSS-202”/ })).toBeDefined()
    for (const kind of ['Your prompt', 'Context loaded', 'Model request', 'Subagent', 'Hook', 'Answer']) {
      expect(await ui.find({ type: 'Text', text: new RegExp(`^${kind}$`) })).toBeDefined()
    }
    expect(await ui.find({ type: 'Text', text: /Loaded skill: review-story/ })).toBeDefined()
    // Status labels are pills: padded text on the terminal, an outlined pill elsewhere.
    expect(await ui.find({ type: 'Text', text: /^ ?Blocked by hook ?$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ ?Check failed ?$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ ?Hook failed ?$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^✕ 2 failed, 1 blocked ›$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ PSS-202 $/ })).toBeDefined()
    // The prompt's time rides in its status pill.
    expect(await ui.find({ type: 'Text', text: /^ ?✓ Done in \S+ ?$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\$24\.39$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Answer ready/ })).toBeDefined()

    // Details stay folded until asked for.
    expect(await ui.find({ type: 'Text', text: /System prompt, AGENTS\.md, MEMORY\.md, skill list/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ {3}AGENTS\.md$/ })).toBeUndefined()
    await ui.press({ key: 'open:context-model-t1-0' })
    expect(await ui.find({ type: 'Text', text: /^ {3}AGENTS\.md$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ {3}MEMORY\.md$/ })).toBeDefined()
    await ui.press({ key: 'open:t1-ag' })
    expect(await ui.find({ type: 'Text', text: /┆ Read design\.md/ })).toBeDefined()
    // Its requests are listed in a section of their own, each with its input split as the API reported it.
    expect(await ui.find({ type: 'Text', text: /^Requests \(1\)$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^1\. 10\.0k in: 1\.0k new · 9\.0k read · 0 written · 200 out$/ })).toBeDefined()
    await ui.press({ key: 'open:t1-b' })
    expect(await ui.find({ type: 'Text', text: /PSSORG is a protected org\.$/ })).toBeDefined()
    await ui.press({ key: 'open:context-model-t1-0' })
    await ui.press({ key: 'open:t1-ag' })
    await ui.press({ key: 'open:t1-b' })

    // The problems chip lists only the failed and blocked steps, each opened.
    expect(await ui.find({ type: 'Text', text: /PSSORG is a protected org\.$/ })).toBeUndefined()
    await ui.press({ key: 'problems' })
    expect(await ui.find({ type: 'Text', text: /PSSORG is a protected org\.$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^21 passed, 1 failed: testBulkInsert\.$/ })).toBeDefined()
    expect(await ui.find({ key: 'step:t1-ag' })).toBeUndefined()
    await ui.press({ key: 'open:t1-b' })
    await ui.press({ key: 'open:t1-t' })
    await ui.press({ key: 'open:hook-model-t1-1-hook:PostToolUse:Edit hook:failed' })
    await ui.press({ key: 'filter:all' })
    await ui.unmount()
  }

  // Only sizes reach the pane, never file or message text.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'open:context-model-t1-0' })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).not.toContain('aaaa')
  expect(drawn).not.toContain('xxxx')
  await ui.unmount()
})

test('each card shows how long its step took over a bar of its share, with its tokens and cost as pills above the bar', async ($, on) => {
  engine(on, mock.clock(on, { now: Date.now() }))
  mock.store(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await runPrompt($, 't1', '/review-story PSS-202', 'review-story')

  // The terminal draws the meter as a fixed run of cells: ━ for the step's share, ─ for the rest.
  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const meter = async (key: string) => String((await terminal.find({ key }))?.text ?? '')
  // The time and the pills share the top line; the bar is under them. Every step has both, a bare track
  // for a step that took no time, so the bars line up down the list.
  expect(await meter('bar:prompt-t1')).toMatch(/^0ms\+\d+ tok─+$/)
  // A tool call is a slim row: its time and what it added, with no bar.
  expect(String((await terminal.find({ key: 'slim:t1-t' }))?.text)).toMatch(/1\.2s · \+\d+ tok/)
  expect(await meter('bar:model-t1-0')).toMatch(/\d+ out\$[\d.]+/)
  const widths = (await terminal.findAll({ type: 'Box' })).filter(box => /^bar:/.test(String(box.key ?? '')) && !/^bar:header/.test(String(box.key ?? ''))).map(box => box.props.width)
  expect(new Set(widths).size).toBe(1)
  // The bar is as wide as the meter.
  expect((await meter('bar:model-t1-0')).replace(/^.*\$[\d.]+/, '')).toHaveLength(Number(widths[0]))
  await terminal.unmount()

  // Off the terminal the pills are Svg, fully round (radius half the height), with no share text beside the time;
  // the meter widens with the pane and never gets narrower than the time and the pills need.
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const pills = (await ui.find({ key: 'pills:model-t1-0' }))?.children ?? []
    expect(pills.length).toBe(2)
    for (const pill of pills) expect(String(pill.children?.[0]?.props.source)).toContain('rx="8.5"')
    for (const id of ['model-t1-0']) expect(JSON.stringify(await ui.find({ key: `bar:${id}` }))).not.toContain('of prompt"')
    const widthAt = async (body: number) => {
      await ui.redraw({ ...PANE.props, bodyColumns: body })
      return Number((await ui.find({ key: 'bar:model-t1-0' }))?.props.width)
    }
    const [narrow, middle, broad] = [await widthAt(70), await widthAt(100), await widthAt(140)]
    expect(narrow).toBeLessThanOrEqual(middle)
    expect(middle).toBeLessThanOrEqual(broad)
    expect(broad).toBeLessThanOrEqual(40)
    // However narrow the pane, the meter stays on the card's right, beside the open button, with its bar;
    // below 80 columns only the cost pill is kept.
    for (const body of [70, 50, 36]) {
      await ui.redraw({ ...PANE.props, bodyColumns: body })
      const card = await ui.find({ key: 'step:model-t1-0' })
      const head = card?.children?.[0]
      expect(JSON.stringify(head)).toContain('"bar:model-t1-0"')
      expect(JSON.stringify(head)).toContain('"open:model-t1-0"')
      expect((await ui.find({ key: 'pills:model-t1-0' }))?.children?.length).toBe(1)
      expect(String((await ui.find({ key: 'bar:model-t1-0' }))?.children?.at(-1)?.children?.[0]?.props.source)).toContain('<rect')
    }
    await ui.redraw({ ...PANE.props, bodyColumns: 110 })
    await ui.unmount()
  }

  // The other surfaces draw the same meter as a rounded Svg pill, and each step has a tinted icon tile.
  for (const surface of ['desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    const svg = String((await ui.find({ key: 'bar:model-t1-0' }))?.children?.at(-1)?.children?.[0]?.props.source ?? '')
    expect(svg).toContain('rx="3"')
    expect(svg).not.toContain('url(#run)')
    const icon = String((await ui.find({ key: 'icon:model-t1-0' }))?.children?.[0]?.props.source ?? '')
    expect(icon).toContain('fill-opacity="0.16"')
    await ui.unmount()
  }
})

test('the arrows page between prompts and titles drop the tags Claude Code adds', async ($, on) => {
  engine(on, mock.clock(on, { now: Date.now() }))
  mock.store(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await runPrompt($, 't1', '/review-story PSS-202', 'review-story')
  await runPrompt($, 't2', '<ide_opened_file>The user opened the file /Users/x/settings.json in the IDE.</ide_opened_file>Explain the failing test')
  // Pasted text carries attributes on both tags; a message that is all paste is titled by the paste.
  await runPrompt($, 't3', '<pasted_content id="8476">\nReview this repo for bugs\n</pasted_content id="8476">')
  await runPrompt($, 't4', '<pasted_content id="15e0">a long log</pasted_content id="15e0"> Why does this fail?')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^4 of 4$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /You sent “Why does this fail\?”/ })).toBeDefined()

    await ui.press({ key: 'prev' })
    expect(await ui.find({ type: 'Text', text: /You sent “Review this repo for bugs”/ })).toBeDefined()
    expect(JSON.stringify(await ui.drawn())).not.toContain('pasted_content')

    await ui.press({ key: 'prev' })
    expect(await ui.find({ type: 'Text', text: /^2 of 4$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /You sent “Explain the failing test”/ })).toBeDefined()
    expect(JSON.stringify(await ui.drawn())).not.toContain('ide_opened_file')

    await ui.press({ key: 'prev' })
    expect(await ui.find({ type: 'Text', text: /^1 of 4$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /You sent “\/review-story PSS-202”/ })).toBeDefined()

    await ui.press({ key: 'next' })
    expect(await ui.find({ type: 'Text', text: /^2 of 4$/ })).toBeDefined()
    await ui.press({ key: 'latest' })
    expect(await ui.find({ type: 'Text', text: /^4 of 4$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('steps carry their timings, the reported window, a subagent report, compaction and row origins', async ($, on) => {
  const clock = mock.clock(on, { now: Date.now() })
  engine(on, clock)
  mock.store(on)
  const session = mock.session(on)
  // The last value the mod wrote under each key, as it reached the engine.
  const written: Record<string, unknown> = {}
  on('state.set', (_, e, next) => {
    const set = e as { key?: string; value?: unknown }
    if (set.key) written[set.key] = set.value
    return next(e)
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await runPrompt($, 't1', '/review-story PSS-202', 'review-story')

  // What Claude Code reports after the run: the tool's own run time, a permission ask,
  // the subagent's end, a compaction and a row it appended.
  await $.classic.PostToolUseFailure({ tool_name: 'Bash', tool_input: {}, tool_use_id: 't1-t', error: '1 failed', duration_ms: 900 })
  await $.tool.check({ tool: 'Probe', input: {}, tool_use_id: 't1-t' })
  await $.turn.complete({ turnId: 'sub-1', agentId: 'a1', answer: 'Report: guard clause missing', durationMs: 4200, isAborted: false, reason: 'answer' } as never)
  await $.session.compact({ trigger: 'auto', messages: [SUMMARY] } as never)
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: 'n'.repeat(400) }] } } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // The window is the one Claude Code reports, not an assumed 1M.
  expect(await ui.find({ type: 'Text', text: /of 200(\.0)?k window$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Claude Code compacted the conversation/ })).toBeDefined()
  // The note follows the step's kind on its second line.
  expect(await ui.find({ type: 'Text', text: /^ · 180(\.0)?k → 40(\.0)?k/ })).toBeDefined()

  // The meter has the time; an opened step lists no timing rows of its own.
  await ui.press({ key: 'open:t1-t' })
  expect(await ui.find({ type: 'Text', text: /^1\.2s$/ })).toBeDefined()
  for (const timing of [/^Tool ran$/, /^Started$/, /^First token$/, /^300ms \(inferred\)$/]) expect(await ui.find({ type: 'Text', text: timing })).toBeUndefined()

  await ui.press({ key: 'open:t1-ag' })
  expect(await ui.find({ type: 'Text', text: /^4\.2s$/ })).toBeDefined()

  // Previews are kept in session state only, and drawn only when "Show input and output" is pressed.
  const kept = written.steps as { id: string; preview?: { input?: string; output?: string } }[]
  const tests = kept.find(step => step.id === 't1-t')
  expect(tests?.preview?.input).toContain('apex run test')
  expect(tests?.preview?.output).toContain('testBulkInsert')
  expect(kept.find(step => step.id === 't1-ag')?.preview?.output).toBe('Report: guard clause missing')
  expect(JSON.stringify(await ui.drawn())).not.toContain('guard clause missing')

  // A row's route and size are kept, never its text.
  expect(session.appended().length).toBeGreaterThan(0)
  const rows = written.origins as { door: string; tokens: number }[]
  expect(rows.at(-1)?.door).toBe('note')
  expect(rows.at(-1)?.tokens).toBe(100)
  expect(JSON.stringify(rows)).not.toContain('nnnn')
  await ui.unmount()
})

test('the inspector filters, searches, switches views and shows details in tabs', async ($, on) => {
  engine(on, mock.clock(on, { now: Date.now() }))
  mock.store(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await runPrompt($, 't1', '/review-story PSS-202', 'review-story')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // The run header: the model, the branch at its commit, and the token totals.
    // The model sits beside the status in the terminal and in the facts under the title elsewhere.
    expect(await ui.find({ type: 'Text', text: surface === 'terminal' ? /✦ sonnet-5-5/ : /^\d\d:\d\d · sonnet-5-5 · feature/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /feature\/PSS-202-x @ abc1234/ })).toBeDefined()
    // Every request's input summed, and how many requests that sum covers.
    expect(await ui.find({ type: 'Text', text: /^Tokens$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\S+ in across \d+ requests?$/ })).toBeDefined()
    // A lean bar of re-read, output and new tokens, named in the line under it.
    expect(await ui.find({ key: 'bar:header-tokens' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^re-read \S+ · out \S+ · new \S+$/ })).toBeDefined()
    // No breakdown panel: that feature is kept aside on its own branch.
    expect(await ui.find({ text: /^Show breakdown$/ })).toBeUndefined()

    // Filters narrow the list; clearing them brings every step back.
    await ui.press({ key: 'filter:problems' })
    expect(await ui.find({ type: 'Text', text: /^Showing 3 of \d+ steps$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Loaded skill/ })).toBeUndefined()
    await ui.press({ key: 'clear-filters' })
    expect(await ui.find({ type: 'Text', text: /Loaded skill/ })).toBeDefined()
    if (surface !== 'mobile') {
      await ui.input({ key: 'search', text: 'APEX', kind: 'change' })
      expect(await ui.find({ type: 'Text', text: /^Showing 1 of \d+ steps$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^ ?Check failed ?$/ })).toBeDefined()
      await ui.press({ key: 'clear-filters' })
    }

    // An opened step stacks its sections; the raw record is behind a link.
    const codes = async () => (await ui.findAll({ type: 'Code' })).map(code => String(code.props.source))
    await ui.press({ key: 'open:t1-t' })
    for (const title of [/^Details$/, /^Tokens & cost$/, /^Requested by$/]) expect(await ui.find({ type: 'Text', text: title })).toBeDefined()
    // The command is a code block of its own under its label, always drawn; what a step read and
    // wrote (its arguments as JSON, its output) is drawn only when asked for.
    expect((await codes()).some(source => source === 'sf apex run test --tests PSS_RiskAssessmentServiceTest')).toBe(true)
    expect((await codes()).some(source => source.includes('"command"'))).toBe(false)
    await ui.press({ key: 'io:t1-t' })
    expect(await ui.find({ type: 'Text', text: /^Input and output$/ })).toBeDefined()
    expect((await codes()).some(source => source.includes('"command"'))).toBe(true)
    expect(await ui.find({ type: 'Text', text: /^First 20 lines, kept in this session only\.$/ })).toBeDefined()
    expect((await codes()).some(source => source.includes('"kind": "tool"'))).toBe(false)
    await ui.press({ key: 'raw:t1-t' })
    expect((await codes()).some(source => source.includes('"kind": "tool"'))).toBe(true)
    await ui.press({ key: 'raw:t1-t' })
    expect((await codes()).some(source => source.includes('"kind": "tool"'))).toBe(false)
    await ui.press({ key: 'rel:t1-t:model-t1-0' })
    expect(await ui.find({ type: 'Text', text: /^Read from cache$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^observed$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^estimated$/ })).toBeDefined()
    await ui.press({ key: 'open:t1-t' })
    await ui.press({ key: 'open:model-t1-0' })

    // Another view replaces the list.
    await ui.press({ key: 'mode:story' })
    expect(await ui.find({ type: 'Text', text: /^What happened$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Loaded skill/ })).toBeUndefined()
    await ui.press({ key: 'mode:inspect' })
    await ui.unmount()
  }

  // A wide pane shows one step's details beside the list.
  const wide = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, bodyColumns: 180 } })
  expect(await wide.find({ type: 'Text', text: /^Press › on a step to inspect it here\.$/ })).toBeDefined()
  await wide.press({ key: 'open:t1-b' })
  expect(await wide.find({ type: 'Text', text: /PSSORG is a protected org\.$/ })).toBeDefined()
  await wide.press({ key: 'open:t1-t' })
  expect(await wide.find({ type: 'Text', text: /PSSORG is a protected org\.$/ })).toBeUndefined()
  expect(await wide.find({ type: 'Text', text: /^Requested by$/ })).toBeDefined()
  await wide.press({ key: 'open:t1-t' })
  await wide.unmount()

  // Steps that take no time say so; the test run shows its time and share of the prompt.
  const terminal = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await terminal.find({ key: 'bar:done-t1' }))?.text).toMatch(/^0ms─+$/)
  expect(String((await terminal.find({ key: 'slim:t1-t' }))?.text)).toMatch(/1\.2s · \+\d+ tok/)
  await terminal.unmount()
})

test('the context atlas breaks the window into parts, with growth, cache, routes and compactions', async ($, on) => {
  engine(on, mock.clock(on, { now: Date.now() }))
  mock.store(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await runPrompt($, 't1', '/review-story PSS-202', 'review-story')
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: 'n'.repeat(400) }] } } as never)
  await $.session.compact({ trigger: 'auto', messages: [SUMMARY] } as never)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'mode:context' })
    // The latest request's measured total, against the reported window.
    expect(await ui.find({ type: 'Text', text: /^Context sent with request 2 · sonnet-5-5$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^10(\.0)?k$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /of 200(\.0)?k window · 5\.0% used$/ })).toBeDefined()
    // A funnel in place of the bar: a centred bar per part, on the part's own row.
    expect(await ui.find({ key: 'bar:atlas' })).toBeUndefined()
    expect(await ui.find({ key: 'funnel:instructions' })).toBeDefined()
    expect(await ui.find({ key: 'funnel:atlas' })).toBeUndefined()
    // Each part, with its growth since the request before; opened, its largest items.
    expect(await ui.find({ type: 'Text', text: /^Project instructions$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\S+ · \S+% · \+\S+$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\+ is the growth since the last request\.$/ })).toBeDefined()
    // Medium: the rows keep their bars and only the tokens beside them.
    await ui.redraw({ ...PANE.props, bodyColumns: 50 })
    expect(await ui.find({ key: 'funnel:instructions' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^\S+ · \S+% · \+\S+$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^\+ is the growth since the last request\.$/ })).toBeUndefined()
    // Narrow: one small funnel above the list, its parts told apart by their swatches.
    await ui.redraw({ ...PANE.props, bodyColumns: 36 })
    expect(await ui.find({ key: 'funnel:atlas' })).toBeDefined()
    expect(await ui.find({ key: 'funnel:instructions' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^\S+ · \S+%$/ })).toBeDefined()
    await ui.redraw({ ...PANE.props, bodyColumns: 110 })
    expect(await ui.find({ type: 'Text', text: /^AGENTS\.md$/ })).toBeUndefined()
    await ui.press({ key: 'part:instructions' })
    expect(await ui.find({ type: 'Text', text: /^AGENTS\.md$/ })).toBeDefined()
    // What the text can't account for is unattributed, not labelled tool definitions: with no
    // /context estimate to size them, nothing here says how much of it the tools are.
    expect(await ui.find({ key: 'part:tools' })).toBeUndefined()
    await ui.press({ key: 'part:other' })
    expect(await ui.find({ type: 'Text', text: /^Unattributed$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Not accounted for by the text$/ })).toBeDefined()
    await ui.press({ key: 'part:instructions' })
    await ui.press({ key: 'part:other' })
    // Cache use, the rows added by route, and compactions.
    expect(await ui.find({ type: 'Text', text: /^90% of this request was read from cache/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Plugin notes ×1$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^≈100$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Compactions$/ })).toBeDefined()
    // Well under the window: no warning.
    expect(await ui.find({ type: 'Text', text: /^Context is \d+% full/ })).toBeUndefined()
    // Names and sizes only.
    const drawn = JSON.stringify(await ui.drawn())
    expect(drawn).not.toContain('aaaa')
    expect(drawn).not.toContain('nnnn')
    await ui.press({ key: 'mode:inspect' })
    await ui.unmount()
  }
})

test('the context atlas warns as the window fills', async ($, on) => {
  engine(on, mock.clock(on, { now: Date.now() }), 12_000)
  mock.store(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await runPrompt($, 't1', '/review-story PSS-202', 'review-story')

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'mode:context' })
  expect(await ui.find({ type: 'Text', text: /^Context is 83% full\. Claude Code compacts on its own near the limit/ })).toBeDefined()
  await ui.unmount()
})

test('the agent topology shows the main agent, each subagent and what it did, and the cost split', async ($, on) => {
  engine(on, mock.clock(on, { now: Date.now() }))
  mock.store(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await runPrompt($, 't1', '/review-story PSS-202', 'review-story')
  // A second subagent, in the background, which starts one of its own.
  await $.tool.call({ tool: 'Agent', tool_use_id: 't1-ag2', subagent_type: 'explorer', description: 'Map the tests' } as never)
  await $.agent.spawn({ tool_use_id: 't1-ag2', subagentType: 'explorer', description: 'Map the tests', background: true } as never)
  await $.agent.spawn({ tool_use_id: 't1-ag3', parentAgentId: 'a2', subagentType: 'helper', description: 'Read one file' } as never)
  await step($, 'sub-3', 0, 'a3')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'mode:agents' })
    expect(await ui.find({ type: 'Text', text: /^Agent topology$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^2 subagents/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Main agent$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /2 requests · 5 tool calls · / })).toBeDefined()
    // Each subagent: its type, model, what it did; a nested one rolls up into its parent.
    expect(await ui.find({ type: 'Text', text: /^story-reviewer$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 request · 1 tool call · / })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^explorer$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /sonnet-5-5 · background$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /↳ ◇ helper · Read one file$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Cost by agent$/ })).toBeDefined()
    expect(await ui.find({ key: 'bar:agents-cost' })).toBeDefined()

    // The main agent and each subagent carry the same icon tiles as their cards in Inspect.
    if (surface !== 'terminal') {
      expect(await ui.find({ key: 'icon:main-agent' })).toBeDefined()
      expect(await ui.find({ key: 'icon:agent:t1-ag' })).toBeDefined()
    }
    // Inspect › opens the subagent's details right under its card, in the Agents view.
    expect(await ui.find({ type: 'Text', text: /┆ Read design\.md/ })).toBeUndefined()
    await ui.press({ key: 'inspect:t1-ag' })
    // The button's label is drawn inside it, so it is found by text alone.
    expect(await ui.find({ text: /Hide ‹/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /┆ Read design\.md/ })).toBeDefined()
    // Opened in Agents: the subagent's requests and tool calls on its own timeline.
    expect(await ui.find({ type: 'Text', text: /^Requests and tool calls$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^✦ Request 1 · / })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Agent topology$/ })).toBeDefined()
    // Hide ‹ folds it again.
    await ui.press({ key: 'inspect:t1-ag' })
    expect(await ui.find({ type: 'Text', text: /┆ Read design\.md/ })).toBeUndefined()
    await ui.unmount()
  }
})

test('story mode tells the prompt in plain sentences from the recorded steps, and copies them', async ($, on) => {
  engine(on, mock.clock(on, { now: Date.now() }))
  mock.store(on)
  let copied = ''
  on('ui.copy', (_, e) => {
    copied = String((e as { text?: string }).text ?? '')
    return { value: { isCopied: true } }
  })
  on('ui.toast', () => ({ value: {} }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await runPrompt($, 't1', '/review-story PSS-202', 'review-story')
  // Two calls that succeed one after the other share a sentence.
  await $.tool.call({ tool: 'Read', tool_use_id: 't1-r1', file_path: '/repo/design.md' } as never)
  await $.tool.call({ tool: 'Grep', tool_use_id: 't1-g1', pattern: 'TODO' } as never)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'mode:story' })
    expect(await ui.find({ type: 'Text', text: /^Done in .+ · 2 model requests · 6 tool calls · 1 subagent · 3 problems · \$/ })).toBeDefined()
    for (const sentence of [
      /^You asked “\/review-story PSS-202”\.$/,
      /^Claude Code sent .+ tokens of context with it: system prompt, AGENTS\.md/,
      /^Claude \(sonnet-5-5\) read 10(\.0)?k tokens \(90% from cache\) and asked for 4 tool calls\.$/,
      /^It loaded the review-story skill\.$/,
      /^A hook blocked Bash \(sf org display --target-org PSSORG\): .*PSSORG is a protected org\.$/,
      /^It handed “Fresh review of PSS-202” to a story-reviewer subagent, which made 1 request and 1 tool call/,
      /^Apex tests \(sf apex run test .+\) failed in 1\.2s: 21 passed, 1 failed: testBulkInsert\.$/,
      /^The PostToolUse:Edit hook reported an error\.$/,
      /^Claude \(sonnet-5-5\) read 10(\.0)?k tokens \(90% from cache\) and wrote the answer\.$/,
      /^The answer was ready after /,
      /^It ran 2 tools: Read \(design\.md\) and Grep \(TODO\)\.$/,
    ]) {
      expect(await ui.find({ type: 'Text', text: sentence })).toBeDefined()
    }
    expect(await ui.find({ type: 'Text', text: /^\+0ms$/ })).toBeDefined()

    // › opens the step in the inspector.
    await ui.press({ key: 'story:0' })
    expect(await ui.find({ key: 'raw:prompt-t1' })).toBeDefined()
    await ui.press({ key: 'open:prompt-t1' })
    await ui.unmount()
  }

  // The copy is Markdown of the same sentences: no file or message text.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'mode:story' })
  await ui.press({ key: 'copy-story' })
  expect(copied).toContain('### /review-story PSS-202')
  expect(copied).toContain('**A hook blocked Bash')
  expect(copied).toContain('feature/PSS-202-x @ abc1234')
  expect(copied).not.toContain('aaaa')
  expect(copied).not.toContain('xxxx')
  await ui.unmount()
})

test('insights point at what stands out, and the outcome lists the files a prompt changed', async ($, on) => {
  engine(on, mock.clock(on, { now: Date.now() }))
  mock.store(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await runPrompt($, 't1', '/review-story PSS-202', 'review-story')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^Insights$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^1\.2s$/ })).toBeDefined()
    // Rows have room between them off the terminal; a label never shrinks under a long value; the
    // figure sits beside its label and the step's button, kept short, follows it and wraps below on a narrow pane.
    const boxes = await ui.findAll({ type: 'Box' })
    expect(boxes.some(box => box.props.rowGap === 0.75)).toBe(surface !== 'terminal')
    const [labelBox, group] = (await ui.find({ key: 'insight:Slowest' }))?.children ?? []
    expect([labelBox?.props.width, labelBox?.props.flexShrink]).toEqual([16, 0])
    expect(group?.props.flexWrap).toBe('wrap')
    expect(JSON.stringify(group?.children?.[0])).toContain('1.2s')
    expect(JSON.stringify(group?.children?.[1])).toContain('insight:Slowest')
    expect(JSON.stringify(group?.children?.[1])).toContain('…')
    expect(await ui.find({ type: 'Text', text: /^Costliest$/ })).toBeDefined()
    // No contributor is large enough to call out.
    expect(await ui.find({ type: 'Text', text: /^Most context$/ })).toBeUndefined()
    // Git's counts for the file the prompt changed.
    expect(await ui.find({ type: 'Text', text: /^1 file · \+12 −3 against the last commit$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^force-app\/Foo\.cls$/ })).toBeDefined()
    // An insight opens its step.
    await ui.press({ key: 'insight:Slowest' })
    expect(await ui.find({ key: 'raw:t1-t' })).toBeDefined()
    await ui.press({ key: 'open:t1-t' })
    await ui.press({ key: 'mode:story' })
    expect(await ui.find({ type: 'Text', text: /^It changed 1 file: Foo\.cls\.$/ })).toBeDefined()
    await ui.press({ key: 'mode:inspect' })
    await ui.unmount()
  }
})

test("the Prompts view lists this session's prompts and exports share-safe", async ($, on) => {
  const start = Date.now()
  engine(on, mock.clock(on, { now: start }))
  // Nothing about earlier prompts is written to the store any more.
  const stored: Record<string, unknown> = {}
  on('store.get', (_, e) => ({ value: stored[String((e as { key?: string }).key)] }))
  on('store.set', (_, e) => {
    const set = e as { key?: string; value?: unknown }
    stored[String(set.key)] = JSON.parse(JSON.stringify(set.value))
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(stored) }))
  on('store.delete', () => ({ value: undefined }))
  // Export copies; only the session's saved trace is written to disk.
  disk = {}
  const copies = files(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await runPrompt($, 't1', '/review-story PSS-202', 'review-story')
  // A second prompt with a secret and an email in its words, which writes a new file.
  const words = 'Deploy with token=zq9SecretValue for me@example.com'
  await $.prompt.submit({ text: words } as never)
  await $.turn.start({ text: words, turnId: 't2' })
  await step($, 't2', 0)
  await $.tool.call({ tool: 'Write', tool_use_id: 't2-w', file_path: '/Users/x/repo/force-app/New.cls', content: 'class New {}' } as never)
  await $.turn.complete({ turnId: 't2', answer: '', durationMs: 10, isAborted: false, reason: 'answer' } as never)
  expect(Object.keys(stored).filter(key => key.startsWith('runs:'))).toEqual([])

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'mode:runs' })
    expect(await ui.find({ type: 'Text', text: /^This session$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^2 prompts · .+ of work · 1 had problems$/ })).toBeDefined()
    // Newest first, titles redacted, problems called out; no comparison or history.
    const rows = (await ui.findAll({ type: 'Box' })).map(box => String(box.key ?? '')).filter(key => key.startsWith('prompt:'))
    expect(rows).toEqual(['prompt:t2', 'prompt:t1'])
    expect(await ui.find({ type: 'Text', text: /^Deploy with token=<secret> for <email>$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^ {2}3 problems$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Run history|This prompt vs/ })).toBeUndefined()
    // › opens that prompt in Inspect.
    await ui.press({ key: 'prompt:t1' })
    expect(await ui.find({ type: 'Text', text: /^\/review-story PSS-202$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^1 of 2$/ })).toBeDefined()
    await ui.press({ key: 'next' })
    await ui.unmount()
  }

  // Export copies the story and the steps, redacted, without previews, and writes no file.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'export-md' })
  await ui.press({ key: 'export-json' })
  await ui.press({ key: 'export-csv' })
  expect(Object.keys(disk).filter(path => !path.startsWith(HISTORY))).toEqual([])
  const { md, json } = exported(copies)
  expect(copies.csv?.startsWith('time_s,agent,request,model,')).toBe(true)
  expect(md).toContain('### Deploy with token=<secret> for <email>')
  expect(json).toContain('~/repo/force-app/New.cls')
  for (const text of [md, json]) {
    expect(text).not.toContain('zq9SecretValue')
    expect(text).not.toContain('me@example.com')
    expect(text).not.toContain('/Users/x')
  }
  expect(json).not.toContain('"preview"')
  await ui.unmount()
})

test('a plain prompt reads cleanly, and the layout follows the pane as it is dragged narrower', async ($, on) => {
  engine(on, mock.clock(on, { now: Date.now() }))
  mock.store(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  messages = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }]
  await $.prompt.submit({ text: 'hi' } as never)
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await $.prompt.compose(COMPOSE)
  await step($, 't1', 0)
  await $.turn.complete({ turnId: 't1', answer: 'Hello!', durationMs: 900, isAborted: false, reason: 'answer' } as never)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // Nothing is made up to fill Insights.
    expect(await ui.find({ type: 'Text', text: /Nothing stands out · 1 model request · no tool calls$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Insights$/ })).toBeUndefined()
    for (const absent of [/^Slowest$/, /^Costliest$/, /^Changed files$/]) expect(await ui.find({ type: 'Text', text: absent })).toBeUndefined()

    // Above the steps: how long the prompt took, then its tokens and steps; no bare time axis.
    // Oldest step first, as the prompt ran: your prompt heads the list, the answer ends it.
    expect(await ui.find({ type: 'Text', text: /^↑ Oldest first$/ })).toBeDefined()
    const cards = (await ui.findAll({ type: 'Box' })).map(box => String(box.key ?? '')).filter(key => key.startsWith('step:'))
    expect(cards[0]).toMatch(/^step:prompt/)
    expect(cards.at(-1)).toMatch(/^step:done/)
    // The toggle lists them newest first, and flips back.
    await ui.press({ key: 'order' })
    expect(await ui.find({ type: 'Text', text: /^↓ Newest first$/ })).toBeDefined()
    const newest = (await ui.findAll({ type: 'Box' })).map(box => String(box.key ?? '')).filter(key => key.startsWith('step:'))
    expect(newest[0]).toMatch(/^step:done/)
    expect(newest.at(-1)).toMatch(/^step:prompt/)
    await ui.press({ key: 'order' })
    expect(await ui.find({ type: 'Text', text: /^↑ Oldest first$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /time axis/ })).toBeUndefined()

    // Each request shows its input and output tokens on a line of its own, not buried in the sub line.
    for (const label of ['In', 'Out', 'Cached']) expect(await ui.find({ type: 'Text', text: new RegExp(`^\\s*${label} $`) })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\d in \(\d+% cached\)/ })).toBeUndefined()

    // The terminal draws cards with a subtle border; elsewhere the editor's own hairline, and no
    // background fills anywhere (theme background keys come out tinted in some themes).
    const boxes = await ui.findAll({ type: 'Box' })
    const surfaces = boxes.filter(box => box.props.borderStyle === 'round' && !/^f?seg:|^stat:/.test(String(box.key ?? '')) && box.key !== 'status' && box.props.borderColor !== 'userMessageBackground' && !box.children?.some(child => /^seg:/.test(String(child.key ?? child.props?.key ?? ''))))
    expect(surfaces.length).toBeGreaterThan(0)
    for (const card of surfaces) {
      if (surface === 'terminal') expect(card.props.borderColor).toBe('subtle')
      else expect([card.props.borderColor, card.props.backgroundColor]).toEqual([undefined, undefined])
    }
    // Not even the view tabs keep a fill.
    for (const box of boxes) if (surface !== 'terminal') expect(['background', 'userMessageBackground']).not.toContain(box.props.backgroundColor)
    // No Box is drawn empty: VS Code paints a bordered box with nothing in it as a box, not a line.
    for (const box of boxes) if (box.props.borderStyle) expect((box.children ?? []).length).toBeGreaterThan(0)
    // Off the terminal each stat's label has its own color.
    if (surface !== 'terminal') expect((await ui.find({ type: 'Text', text: /^Tokens$/ }))?.props.color).toMatch(/^#/)

    // The status is outlined in its own color off the terminal, with no fill.
    const done = boxes.find(box => box.key === 'status')
    if (surface === 'terminal') expect(done).toBeUndefined()
    else {
      expect(done?.props.borderColor).toBe('success')
      expect(done?.props.backgroundColor).toBeUndefined()
    }

    // VS Code wraps rows unless told otherwise; each row says, so a card never drops below its step number.
    const rows = (await ui.findAll({ type: 'Box' })).filter(box => box.props.flexDirection === 'row')
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.props.flexWrap).toBeDefined()

    // Tabs: underlined over a rule in the terminal; elsewhere a segmented control whose
    // active segment is raised on the tray. Each tab carries a count of what is in it.
    const tab = await ui.find({ key: 'mode:inspect' })
    expect(tab?.props.plain).toBe(true)
    expect(JSON.stringify(tab)).toContain('"bold":true')
    expect(JSON.stringify(tab)).toContain(surface === 'terminal' || surface === 'vscode' ? '"underline":true' : '"underline":false')
    expect(await ui.find({ type: 'Text', text: /^  4$/ })).toBeDefined()
    if (surface !== 'terminal') {
      // The active view is an outlined segment in a hairline tray; no tab is a filled native button.
      // VS Code draws each Button as its own bordered box, so there our tray and outline are left off.
      expect((await ui.find({ key: 'seg:inspect' }))?.props.borderColor).toBe(surface === 'vscode' ? undefined : 'inactive')
      expect((await ui.find({ key: 'seg:context' }))?.props.borderStyle).toBeUndefined()
      for (const mode of ['inspect', 'context', 'agents', 'story', 'runs']) expect((await ui.find({ key: `mode:${mode}` }))?.props.dimColor).toBe(true)
      // The step filters are the same segmented control, beside a search that takes the rest of the row.
      expect((await ui.find({ key: 'fseg:all' }))?.props.borderColor).toBe(surface === 'vscode' ? undefined : 'inactive')
      if (surface === 'vscode') for (const box of boxes) expect(box.props.borderStyle && box.children?.some(child => /^f?seg:/.test(String(child.key ?? child.props?.key ?? '')))).toBeFalsy()
      const row = (await ui.findAll({ type: 'Box' })).find(box => box.children?.some(child => child.type === 'Box' && child.props.minWidth === 24))
      expect(row?.props.flexDirection).toBe('row')
      expect(row?.children?.find(child => child.props.minWidth === 24)?.props.flexGrow).toBe(1)
      // VS Code stretches its field only inside a column.
      expect(row?.children?.find(child => child.props.minWidth === 24)?.props.flexDirection).toBe('column')
    }

    // Stat cards: four to a row, then two, then one; rules never run past the pane.
    for (const [body, width] of [
      [110, '24%'],
      [60, '48%'],
      [36, '100%'],
    ] as const) {
      await ui.redraw({ ...PANE.props, bodyColumns: body })
      const stat = await ui.find({ key: 'stat:Tokens' })
      expect(stat?.props.width).toBe(width)
      for (const rule of await ui.findAll({ type: 'Text', text: /^─+$/ })) expect(String(rule.text).length).toBeLessThanOrEqual(body - 2)
    }
    await ui.unmount()
  }
})

test('tool calls that overlap, or that one request sent out together, are marked parallel', async ($, on) => {
  engine(on, mock.clock(on, { now: Date.now() }))
  mock.store(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  messages = [{ role: 'user', content: [{ type: 'text', text: 'run the checks' }] }]
  await $.prompt.submit({ text: 'run the checks' } as never)
  await $.turn.start({ text: 'run the checks', turnId: 't1' })
  await $.prompt.compose(COMPOSE)
  await step($, 't1', 0)
  // Two test runs at once (each takes 1.2s on the mock clock), then one more after both.
  const check = (id: string, name: string) => $.tool.call({ tool: 'Bash', tool_use_id: id, command: `sf apex ${'run'} test --tests ${name}` } as never)
  await Promise.all([check('p1', 'A'), check('p2', 'B')])
  await check('s1', 'C')
  await step($, 't1', 1)
  // Two reads the next request asked for together: the first fails at once, ending before the second starts.
  await $.tool.call({ tool: 'Read', tool_use_id: 'r1', file_path: '/repo/missing.md' } as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 'r2', file_path: '/repo/notes.md' } as never)
  await step($, 't1', 2)
  await $.turn.complete({ turnId: 't1', answer: 'Done.', durationMs: 4000, isAborted: false, reason: 'answer' } as never)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^  ⇉ parallel 1 of 2$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^  ⇉ parallel 2 of 2$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^4 in parallel \(2 batches\) · 1 one after another$/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the context ledger names each listed skill and says what each hook added', () => {
  const skillList = [
    'The following skills are available for use with the Skill tool:',
    '',
    '- superpowers:brainstorming: You MUST use this before any creative work',
    '- dataviz: Use this skill whenever you are about to create a chart',
    '- example-plugin:environment-validate',
  ].join('\n')
  const hook = 'SessionStart hook additional context: plugin: example-plugin v2.3.0\nproject: absent'
  const parts = condense(classify([{ role: 'user', content: [{ type: 'text', text: reminder(skillList) + reminder(hook) + 'hi' }] }] as never, new Map(), null))
  const skills = parts.skills.map(item => item.name)
  for (const name of ['superpowers:brainstorming', 'dataviz', 'example-plugin:environment-validate']) expect(skills).toContain(name)
  expect(skills).not.toContain('Available skills list')
  expect(parts.hooks.find(item => item.name === 'SessionStart hook')?.note).toBe('plugin: example-plugin v2.3.0')
})

// --- Repairs from the 2026-10-28 review. Credentials, logs and prices below are made up. ---

type Kept = {
  id: string
  turnId: string
  status?: string
  label?: string
  at: number
  end?: number
  agent?: { problems: number; failed?: number; blocked?: number; launched?: boolean; ended?: boolean }
}
type KeptTurn = { id: string; title: string; at: number; agentsEnd?: number; cost: number; tokens?: { input: number; cacheRead: number }; evicted?: number; calls?: number; subagents?: number }

// The last value the mod wrote under each key, as it reached the engine.
const capture = (on: On) => {
  const written: Record<string, unknown> = {}
  on('state.set', (_, e, next) => {
    const set = e as { key?: string; value?: unknown }
    if (set.key) written[set.key] = set.value
    return next(e)
  })
  return written
}

// What the pane copied: the latest copy of each export (by its shape) and the last copy of any kind.
const files = (on: On) => {
  const wrote: Record<string, string> = {}
  on('ui.copy', (_, e) => {
    const text = String((e as { text?: string }).text ?? '')
    wrote[text.startsWith('{') ? 'json' : text.startsWith('time_s,') ? 'csv' : 'md'] = text
    wrote.last = text
    return { value: { isCopied: true } }
  })
  on('ui.toast', () => ({ value: {} }))
  return wrote
}

const exported = (wrote: Record<string, string>) => ({ md: wrote.md ?? '', json: wrote.json ?? '' })

const begin = async ($: Engine, turnId: string, text: string) => {
  messages = [{ role: 'user', content: [{ type: 'text', text }] }]
  await $.turn.start({ text, turnId })
  await step($, turnId, 0)
}

const finish = ($: Engine, turnId: string) => $.turn.complete({ turnId, answer: 'Done.', durationMs: 10, isAborted: false, reason: 'answer' } as never)

// The harness's expect has no toBeCloseTo: equal to `digits` decimal places.
const close = (actual: number | undefined, expected: number, digits = 8) => {
  expect(typeof actual).toBe('number')
  expect(Math.abs((actual ?? Number.NaN) - expected)).toBeLessThanOrEqual(10 ** -digits)
}

// What one request costs at Sonnet 5.5's rates: 1,000 new, 9,000 from cache, 200 out.
const REQUEST = (1000 * 2 + 9000 * 0.1 + 200 * 10) / 1e6

test('a default export leaves commands, output and credentials out; copies keep commands but mask credentials', async ($, on) => {
  engine(on, mock.clock(on, { now: Date.now() }))
  mock.store(on)
  const wrote = files(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await begin($, 'secret', 'Upload settings')
  const fake = { json: 'review_fake_value_42', env: 'fakeEnvKey1234', bearer: 'fakeBearer987654', pg: 'fakePg555', flag: 'fake pass 77', url: 'fakeUrl888', header: 'fakeHeader321' }
  const commands = [
    `curl --data '{"password":"${fake.json}"}' https://example.test`,
    `API_KEY=${fake.env} npm run deploy`,
    `curl -H "Authorization: Bearer ${fake.bearer}" https://example.test`,
    `psql postgres://admin:${fake.pg}@db.example.test/app`,
    `deploy --password "${fake.flag}" --verbose`,
    `git clone https://bot:${fake.url}@github.com/x/y.git`,
    `curl -H 'x-api-key: ${fake.header}' https://example.test`,
  ]
  for (const [at, command] of commands.entries()) await $.tool.call({ tool: 'Bash', tool_use_id: `c${at}`, command } as never)
  await finish($, 'secret')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'export-md' })
  await ui.press({ key: 'export-json' })
  const { md, json } = exported(wrote)
  expect(md.length).toBeGreaterThan(0)
  for (const text of [md, json]) {
    for (const value of Object.values(fake)) expect(text).not.toContain(value)
    // Commands and tool output are left out of a default export, not only masked.
    for (const command of ['curl', 'psql', 'npm run deploy', 'example.test', 'xxxx']) expect(text).not.toContain(command)
  }
  expect(md).toContain('It ran 7 tools: Bash, Bash, Bash, Bash, Bash, Bash and Bash.')
  // Operational facts stay: kind, status, time, model, tokens, cost and the ids that link them.
  const record = JSON.parse(json) as { schema: string; privacy: string; complete: { steps: boolean; cost: boolean }; steps: Record<string, unknown>[] }
  expect(record.schema).toBe('agent-trace/export@4')
  expect(record.privacy).toContain('best effort')
  expect(record.complete).toEqual({ steps: true, cost: true })
  const bash = record.steps.find(one => one.id === 'c0')
  expect([bash?.kind, bash?.name, bash?.status, bash?.requestedBy]).toEqual(['tool', 'Bash', 'ok', 'model-secret-0'])
  expect(typeof bash?.durationMs).toBe('number')
  const request = record.steps.find(one => one.id === 'model-secret-0')
  expect(request?.tokens).toEqual({ input: 1000, output: 200, cacheRead: 9000, cacheWrite: 0 })
  close(request?.cost as number, REQUEST, 8)
  for (const field of ['"preview"', '"details"', '"sub"', '"nest"']) expect(json).not.toContain(field)

  // The Story copy keeps the commands the pane shows and masks what it can.
  await ui.press({ key: 'mode:story' })
  await ui.press({ key: 'copy-story' })
  expect(wrote.last).toContain('curl --data')
  expect(wrote.last).toContain('"password":"<secret>"')
  for (const value of Object.values(fake)) expect(wrote.last).not.toContain(value)
  // So does a step's JSON.
  await ui.press({ key: 'mode:inspect' })
  await ui.press({ key: 'open:c4' })
  await ui.press({ key: 'copy:c4' })
  expect(wrote.last).toContain('--password <secret>')
  expect(wrote.last).not.toContain(fake.flag)
  await ui.unmount()
})

test('problems inside a subagent reach the prompt counts, the Problems filter, Story and exports, once each', async ($, on) => {
  engine(on, mock.clock(on, { now: Date.now() }))
  mock.store(on)
  const wrote = files(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await begin($, 't1', 'review it')
  // As the host orders it: the spawn, the subagent's work and its end all happen inside the Agent call.
  // It meets a failed call, a blocked one and a helper of its own that is stopped, and still finishes.
  const release = holdAgent()
  const call = $.tool.call({ tool: 'Agent', tool_use_id: 't1-ag', subagent_type: 'reviewer', description: 'Review the change' } as never)
  await $.agent.spawn({ tool_use_id: 't1-ag', subagentType: 'reviewer', description: 'Review the change', prompt: 'Review it', background: false } as never)
  await step($, 'sub-1', 0, 'a1')
  await $.tool.call({ tool: 'Bash', tool_use_id: 'in-1', agentId: 'a1', command: 'sf apex run test --tests A' } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'in-2', agentId: 'a1', command: 'sf org display --target-org PSSORG' } as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 'in-3', agentId: 'a1', file_path: '/repo/a.md' } as never)
  await $.agent.spawn({ tool_use_id: 't1-ag3', parentAgentId: 'a1', subagentType: 'helper', description: 'Check one file', prompt: 'x', background: false } as never)
  await $.turn.complete({ turnId: 'sub-3', agentId: 'a3', answer: '', durationMs: 5, isAborted: true, reason: 'aborted' } as never)
  await $.turn.complete({ turnId: 'sub-1', agentId: 'a1', answer: 'Fine after a retry.', durationMs: 50, isAborted: false, reason: 'answer' } as never)
  release({ result: { status: 'completed' }, text: 'Fine after a retry.' })
  await call
  // A second subagent that meets no problem.
  await $.tool.call({ tool: 'Agent', tool_use_id: 't1-ag2', subagent_type: 'explorer', description: 'Map files' } as never)
  await $.agent.spawn({ tool_use_id: 't1-ag2', subagentType: 'explorer', description: 'Map files', prompt: 'x', background: false } as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 'in-4', agentId: 'a2', file_path: '/repo/b.md' } as never)
  await step($, 't1', 1)
  await finish($, 't1')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // The failed call and the stopped helper are failures, the blocked call a block: three, once each.
    expect(await ui.find({ type: 'Text', text: /^✕ 2 failed, 1 blocked ›$/ })).toBeDefined()
    // The chip lists the subagent that met them, opened on what went wrong inside it.
    await ui.press({ key: 'problems' })
    expect(await ui.find({ key: 'step:t1-ag' })).toBeDefined()
    expect(await ui.find({ key: 'step:t1-ag2' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^Showing 1 of \d+ steps$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Bash sf apex run test --tests A failed: 21 passed, 1 failed: testBulkInsert\.$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Bash sf org display --target-org PSSORG was blocked: block-protected-orgs\.sh: PSSORG is a protected org\.$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^helper subagent was stopped$/ })).toBeDefined()
    await ui.press({ key: 'open:t1-ag' })
    await ui.press({ key: 'filter:all' })
    // It finished: its own outcome is Done, with the problems it met beside it.
    await ui.press({ key: 'mode:agents' })
    expect(await ui.find({ type: 'Text', text: /3 problems/ })).toBeDefined()
    expect((await ui.findAll({ type: 'Text', text: /^ ?✓ Done ?$/ })).length).toBeGreaterThanOrEqual(2)
    await ui.press({ key: 'mode:story' })
    expect(await ui.find({ type: 'Text', text: / · 3 problems · / })).toBeDefined()
    expect(
      await ui.find({
        type: 'Text',
        text: /^It handed “Review the change” to a reviewer subagent, which made 1 request and 3 tool calls in .+ and reported back, though 2 steps inside it failed and 1 call was blocked inside it\.$/,
      }),
    ).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^It handed “Map files” to a explorer subagent, which made 0 requests and 1 tool call.* and reported back\.$/ })).toBeDefined()
    await ui.press({ key: 'mode:runs' })
    expect(await ui.find({ type: 'Text', text: /^ {2}3 problems$/ })).toBeDefined()
    await ui.press({ key: 'mode:inspect' })
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'export-md' })
  await ui.press({ key: 'export-json' })
  const record = JSON.parse(exported(wrote).json) as { summary: { problems: number }; steps: Record<string, unknown>[] }
  expect(record.summary.problems).toBe(3)
  const card = record.steps.find(one => one.id === 't1-ag') as { status: string; agent: Record<string, unknown> }
  expect([card.status, card.agent.problems, card.agent.failed, card.agent.blocked]).toEqual(['ok', 3, 2, 1])
  expect((record.steps.find(one => one.id === 't1-ag2') as { agent: Record<string, unknown> }).agent.problems).toBe(0)
  await ui.unmount()
})

test('a background subagent runs on after its launch, ends with its own run, and is paid for by the prompt that started it', async ($, on) => {
  const clock = mock.clock(on, { now: Date.now() })
  engine(on, clock)
  mock.store(on)
  const written = capture(on)
  const card = () => (written.steps as Kept[]).find(one => one.id === 't1-ag2')
  const turnOf = (id: string) => (written.turns as KeptTurn[]).find(one => one.id === id)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await begin($, 't1', 'map the tests')
  const release = holdAgent()
  const call = $.tool.call({ tool: 'Agent', tool_use_id: 't1-ag2', subagent_type: 'explorer', description: 'Map the tests', run_in_background: true } as never)
  await $.agent.spawn({ tool_use_id: 't1-ag2', subagentType: 'explorer', description: 'Map the tests', prompt: 'x', background: true } as never)
  release({ result: { status: 'async_launched', agentId: 'a2', description: 'Map the tests', prompt: 'x', outputFile: '/tmp/out' }, text: 'Async agent launched.' })
  await call
  // The call returning is the launch, not the agent's end.
  expect(card()?.status).toBe('running')
  expect(card()?.agent?.launched).toBe(true)
  await step($, 't1', 1)
  await finish($, 't1')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'mode:agents' })
  expect(await ui.find({ type: 'Text', text: /^ ?● Running ?$/ })).toBeDefined()
  await ui.press({ key: 'mode:story' })
  expect(await ui.find({ type: 'Text', text: /^It handed “Map the tests” to a explorer subagent, which is still working in the background\.$/ })).toBeDefined()
  // Answered, but not done while its background subagent works on.
  expect(await ui.find({ type: 'Text', text: /^Answered in 10ms, background subagents still running · / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ ?✓ Answered · subagents running · \S+ ?$/ })).toBeDefined()
  await ui.press({ key: 'mode:inspect' })
  await ui.unmount()

  // A later prompt starts; the agent works on, then ends.
  await begin($, 't2', 'something else')
  await clock.advance(3000)
  await step($, 'sub-2', 0, 'a2')
  await $.turn.complete({ turnId: 'sub-2', agentId: 'a2', answer: 'Mapped 12 tests.', durationMs: 3100, isAborted: false, reason: 'answer' } as never)
  expect(card()?.status).toBe('ok')
  expect((card()?.end ?? 0) - (card()?.at ?? 0)).toBeGreaterThanOrEqual(3000)
  // The first prompt runs until its subagent's end, its answer kept apart.
  expect((turnOf('t1')?.agentsEnd ?? 0) - (turnOf('t1')?.at ?? 0)).toBeGreaterThanOrEqual(3000)
  const later = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await later.press({ key: 'prev' })
  await later.press({ key: 'mode:story' })
  expect(await later.find({ type: 'Text', text: /^Done in [3-9]\.\ds \(answer at 10ms\) · / })).toBeDefined()
  expect(await later.find({ type: 'Text', text: /^Its last background subagent finished after [3-9]\.\ds\.$/ })).toBeDefined()
  expect(await later.find({ type: 'Text', text: /^ ?✓ Done in [3-9]\.\ds ?$/ })).toBeDefined()
  expect(await later.find({ type: 'Text', text: /answer at 10ms/ })).toBeDefined()
  await later.unmount()
  // Its report comes back as a turn of its own, titled by its place among the first prompt's subagents.
  await begin($, 't3', '<agent-message from="a2">\n[Subagent hand-back] The text below is the final report of a subagent.\nMapped 12 tests.\n</agent-message>')
  expect(turnOf('t3')?.title).toBe('Subagent 1')
  const back = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(JSON.stringify(await back.drawn())).not.toContain('agent-message')
  await back.unmount()
  // Its request is the first prompt's cost, not the second's.
  close(turnOf('t1')?.cost, REQUEST * 3, 8)
  close(turnOf('t2')?.cost, REQUEST, 8)
  expect(turnOf('t1')?.tokens?.input).toBe(3000)
})

test("a subagent's lifecycle follows it live: delegated, its first request, a request in flight, its report taken in by main, its cost", async ($, on) => {
  const clock = mock.clock(on, { now: Date.now() })
  engine(on, clock)
  usageExtra = { cache_creation_input_tokens: 4000 }
  mock.store(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await begin($, 't1', 'find the cache sums')
  const release = holdAgent()
  const call = $.tool.call({ tool: 'Agent', tool_use_id: 't1-ag', subagent_type: 'Explore', description: 'Find the sums' } as never)
  await $.agent.spawn({ tool_use_id: 't1-ag', subagentType: 'Explore', description: 'Find the sums', prompt: 'Find every place cache tokens are summed.', background: false } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Handed its task, no reply yet: it is initializing.
  expect(await ui.find({ type: 'Text', text: /^● ◉ ○ ○ ○ {2}Initialize · waiting for its first reply$/ })).toBeDefined()
  await step($, 'sub-1', 0, 'a1')
  // A request held in flight: the run is live and says so, on the card and in the Agents view.
  const go = holdStep()
  const pending = step($, 'sub-1', 1, 'a1')
  await clock.advance(1500)
  expect(await ui.find({ type: 'Text', text: /^● ● ◉ ○ ○ {2}Run · request 2 in flight$/ })).toBeDefined()
  await ui.press({ key: 'lifecycle:t1-ag' })
  expect(await ui.find({ type: 'Text', text: /^request 2 in flight · 1\.5s$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Waiting for its report$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\$\S+ at API rates · est\.$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^✦ Request 2 · 1\.5s…$/ })).toBeDefined()
  go()
  await pending
  await $.turn.complete({ turnId: 'sub-1', agentId: 'a1', answer: `Found them. ${'r'.repeat(796)}`, durationMs: 1600, isAborted: false, reason: 'answer' } as never)
  release({ result: { status: 'completed' }, text: `Found them. ${'r'.repeat(796)}` })
  await call
  await step($, 't1', 1)
  // Its report is sized from its text, and the main request after it took it in.
  expect(await ui.find({ type: 'Text', text: /^Report ≈202 tokens · est\.$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Main request 2 took it in: 5\.0k new tokens \(inferred\)$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^2 requests · 0 tool calls · 64% of input read from cache$/ })).toBeDefined()
  await finish($, 't1')
  await ui.press({ key: 'mode:inspect' })
  expect(await ui.find({ type: 'Text', text: /^● ● ● ● ● {2}Cost · done · \$\S+$/ })).toBeDefined()
})

test("a subagent's card shows what it was handed, what its first request carried and each request; the run's cost includes its hand-back", async ($, on) => {
  const clock = mock.clock(on, { now: Date.now() })
  engine(on, clock)
  usageExtra = { cache_creation_input_tokens: 4000 }
  mock.store(on)
  const wrote = files(on)
  const written = capture(on)
  const card = () => (written.steps as Kept[]).find(one => one.id === 't1-ag2') as Kept & { agent: Record<string, unknown>; split?: Record<string, number> }
  const turnOf = (id: string) => (written.turns as KeptTurn[]).find(one => one.id === id)
  const task = 'Find every test file and say what each covers. '.repeat(8)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await begin($, 't1', 'map the tests')
  const release = holdAgent()
  const call = $.tool.call({ tool: 'Agent', tool_use_id: 't1-ag2', subagent_type: 'Explore', description: 'Map the tests', run_in_background: true } as never)
  await $.agent.spawn({ tool_use_id: 't1-ag2', subagentType: 'Explore', description: 'Map the tests', prompt: task, background: true } as never)
  release({ result: { status: 'async_launched', agentId: 'a2', description: 'Map the tests', prompt: task, outputFile: '/tmp/out' }, text: 'Async agent launched.' })
  await call
  await step($, 't1', 1)
  // Claude Code reports each loop's usage at its end: the reconciliation checks the requests against it.
  const used = (n: number) => ({ model: 'claude-sonnet-5-5', input_tokens: 1000 * n, output_tokens: 200 * n, cache_read_input_tokens: 9000 * n, cache_creation_input_tokens: 4000 * n })
  await $.turn.complete({ turnId: 't1', answer: 'Started the mapping.', durationMs: 10, isAborted: false, reason: 'answer', usage: used(2) } as never)
  // The subagent's own conversation: project instructions and its task.
  messages = [{ role: 'user', content: [{ type: 'text', text: reminder(`Contents of /repo/CLAUDE.md (project instructions, checked into the codebase):\n${'c'.repeat(4000)}`) + task }] }]
  for (let index = 0; index < 8; index += 1) {
    await step($, 'sub-2', index, 'a2')
    if (index === 3) await $.tool.call({ tool: 'Bash', tool_use_id: 'a2-test', agentId: 'a2', command: 'npm test' } as never)
  }
  await $.turn.complete({ turnId: 'sub-2', agentId: 'a2', answer: 'Mapped 12 tests.', durationMs: 3100, isAborted: false, reason: 'answer', usage: used(8) } as never)
  await begin($, 't2', '<agent-message from="a2">\nMapped 12 tests.\n</agent-message>')
  await finish($, 't2')

  // Recorded: the hand-over (estimated from its text), every request, and the first request's parts.
  expect(card().agent.handoff).toBe(Math.ceil(task.length / 4))
  expect((card().agent.log as unknown[]).length).toBe(8)
  const loaded = card().agent.loaded as { total: number; hidden: number; parts: Record<string, { tokens: number }[]> }
  expect(loaded.total).toBe(14_000)
  expect(loaded.parts.instructions?.[0]?.tokens).toBeGreaterThan(900)
  // What its messages can't account for is the measured rest, not a guess.
  const shown = Object.values(loaded.parts).flat().reduce((sum, item) => sum + item.tokens, 0)
  expect(shown + loaded.hidden).toBe(14_000)
  // The cost split adds up to the cost, for the card and for the prompt.
  const sum = (split?: Record<string, number>) => Object.values(split ?? {}).reduce((total, value) => total + value, 0)
  close(sum(card().split), card().cost ?? 0, 10)
  close(sum((turnOf('t1') as KeptTurn & { split?: Record<string, number> }).split), turnOf('t1')?.cost ?? 0, 10)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'prev' })
  // The Tokens stat counts the same requests its total sums: the main agent's two and the subagent's eight.
  expect(await ui.find({ type: 'Text', text: /^140\.0k in across 10 requests$/ })).toBeDefined()
  await ui.press({ key: 'open:t1-ag2' })
  expect(await ui.find({ type: 'Text', text: /^Handed over and loaded$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: new RegExp(`^≈${Math.ceil(task.length / 4)} tokens of task text$`) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ {2}Project instructions$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ {2}Unattributed \(its system prompt and tools are in here\)$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /· inferred$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^cache writes \$\S+ \(\d+%\)/ })).toBeDefined()
  // Six requests, then the rest on request.
  expect(await ui.find({ type: 'Text', text: /^Requests \(8\)$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^6\. 14\.0k in: 1\.0k new · 9\.0k read · 4\.0k written · 200 out$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^7\. / })).toBeUndefined()
  await ui.press({ key: 'more:t1-ag2' })
  expect(await ui.find({ type: 'Text', text: /^8\. 14\.0k in/ })).toBeDefined()

  // Inspect's card jumps to the lifecycle in the Agents view, the card left open.
  await ui.press({ key: 'lifecycle:t1-ag2' })
  // The Agents view follows the run through its five stages to its hand-back and counts it in the cost.
  expect(await ui.find({ type: 'Text', text: new RegExp(`^≈${Math.ceil(task.length / 4)} tokens of task text handed over · est\\.$`) })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Explore on sonnet-5-5 · background · from main request 2$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Started with 14\.0k tokens · 4\.0k written to cache · 9\.0k read from a cache made before it$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /its system prompt, tool definitions and overhead \(inferred: not exposed per subagent\)$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^8 requests · 1 tool call · 64% of input read from cache$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Input per request: … → 14\.0k → 14\.0k/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Report ≈\d+ tokens · est\.$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ {2}↩ Report handed back in “Subagent 1” · 1 request · \$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^\$\S+ at API rates · est\.$/ })).toBeDefined()
  // Its requests are checked against the usage Claude Code reported at its end.
  expect(await ui.find({ type: 'Text', text: /^✓ Its requests add up to the usage Claude Code reported at its end$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Reading from cache saved ≈\$\S+ against sending that input uncached · est\.$/ })).toBeDefined()
  // Opened: every request and tool call on its timeline; a request opens to its counters and cache.
  expect(await ui.find({ type: 'Text', text: /^Requests and tool calls$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^✦ Request 8 · / })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^ {2}▸ Bash npm test · / })).toBeDefined()
  await ui.press({ key: 'open:t1-ag2#2' })
  expect(await ui.find({ type: 'Text', text: /^14,000 = 9,000 read from cache \+ 4,000 written to cache \+ 1,000 new$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Re-read 9,000 of the 13,000 tokens request 1 cached: 4,000 were sent again/ })).toBeDefined()
  // The lifecycle stands in for the hand-over and request sections the opened card used to repeat.
  expect(await ui.find({ type: 'Text', text: /^Handed over and loaded$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Hand-backs \(1 prompt\)$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^By type: cache writes/ })).toBeDefined()

  // The export carries the same, sizes only: never the task's text.
  await ui.press({ key: 'export-md' })
  await ui.press({ key: 'export-json' })
  const { md, json } = exported(wrote)
  type Totals = { requests: { all: number; byAgent: Record<string, number> }; toolCalls: { all: number }; tokens: { totalInput: number; output: number }; costUsd: number; costSplitUsd: Record<string, number>; costByAgentUsd: Record<string, number> }
  const record = JSON.parse(json) as {
    schema: string
    summary: { cost: number; requests: number; tokensIn: number; durationMs: number }
    run: { startedAt: string; endedAt: string; durationMs: number; totals: Totals }
    agents: { id: string; kind: string; requests: number; tokens: { totalInput: number }; costUsd: number; handoff?: { fromParent: { taskTokens: number; task?: string }; loadedByChild: { byPart: Record<string, number> }; unattributedTokens: number; firstRequestInputTokens: number } }[]
    requests: { agent: string; costUsd: number; tokens: { totalInput: number } }[]
    toolCalls: { id: string; agent: string; name: string; status: string }[]
    outputs: { verification: { id: string }[]; finalAnswer?: string }
    checks: { name: string; ok: boolean }[]
  }
  expect(record.schema).toBe('agent-trace/export@4')
  const t = record.run.totals
  // Every summary figure equals the detailed records' sum, the hand-back included.
  close(t.costUsd, (turnOf('t1')?.cost ?? 0) + (turnOf('t2')?.cost ?? 0), 6)
  close(record.summary.cost, t.costUsd, 9)
  close(record.requests.reduce((total, one) => total + one.costUsd, 0), t.costUsd, 6)
  close(sum(t.costSplitUsd), t.costUsd, 6)
  close(sum(t.costByAgentUsd), t.costUsd, 6)
  expect(t.requests.byAgent).toEqual({ main: 2, subagent_1: 8, handback_1: 1 })
  expect([record.summary.requests, record.requests.length]).toEqual([11, 11])
  expect([t.tokens.totalInput, record.summary.tokensIn]).toEqual([154_000, 154_000])
  expect(record.agents.reduce((total, one) => total + one.tokens.totalInput, 0)).toBe(t.tokens.totalInput)
  expect(record.run.durationMs).toBe(Date.parse(record.run.endedAt) - Date.parse(record.run.startedAt))
  expect(record.summary.durationMs).toBe(record.run.durationMs)
  // Reconciled against the running totals and against Claude Code's own reported usage.
  expect(record.checks.filter(one => !one.ok)).toEqual([])
  expect(record.checks.map(one => one.name)).toEqual(expect.arrayContaining(['cost', 'main.reportedTotalInput', 'subagent_1.reportedTotalInput', 'subagent_1.requests']))
  // What the parent handed over, what the child loaded, and the measured rest left unattributed.
  const child = record.agents.find(one => one.id === 'subagent_1')
  expect(child?.handoff?.fromParent.taskTokens).toBe(Math.ceil(task.length / 4))
  expect(child?.handoff?.fromParent.task).toBeUndefined()
  expect(child?.handoff?.loadedByChild.byPart['Project instructions']).toBeGreaterThan(900)
  expect(child?.handoff?.unattributedTokens).toBe(loaded.hidden)
  expect(child?.handoff?.firstRequestInputTokens).toBe(14_000)
  // The subagent's tool call, with its own agent, and counted as a check that was run.
  expect(record.toolCalls.find(one => one.id === 'a2-test')).toMatchObject({ agent: 'subagent_1', name: 'Bash', status: 'ok' })
  expect(record.outputs.verification.map(one => one.id)).toContain('a2-test')
  expect(record.outputs.finalAnswer).toBe('(left out of a share-safe export)')
  expect(md).toContain('## Reconciliation')
  expect(md).toContain('| subagent_1 (Explore) | subagent, background |')
  for (const text of [md, json]) expect(text).not.toContain('Find every test file')

  // The CSV: one row per model request, the main agent's, the subagent's and the hand-back's, then a total.
  await ui.press({ key: 'export-csv' })
  const csv = (wrote.csv ?? '').trim().split('\n')
  expect(csv[0]).toBe('time_s,agent,request,model,new_input_tok,cache_read_tok,cache_write_tok,output_tok,cost_usd_est,cache_write_usd_est,cache_read_usd_est,output_usd_est,input_usd_est')
  const body = csv.slice(1, -1).map(line => line.split(','))
  expect(body.map(fields => fields[1])).toEqual(['main', 'main', 'subagent_1', 'subagent_1', 'subagent_1', 'subagent_1', 'subagent_1', 'subagent_1', 'subagent_1', 'subagent_1', 'handback_1'])
  expect(body.filter(fields => fields[1] === 'subagent_1').map(fields => fields[2])).toEqual(['1', '2', '3', '4', '5', '6', '7', '8'])
  // Sorted by start, each row's input as the API split it, and its cost split adding up to its cost.
  const times = body.map(fields => Number(fields[0]))
  expect(times).toEqual([...times].sort((x, y) => x - y))
  expect(body[2]?.slice(4, 8)).toEqual(['1000', '9000', '4000', '200'])
  for (const fields of body) close(Number(fields[9]) + Number(fields[10]) + Number(fields[11]) + Number(fields[12]), Number(fields[8]), 3)
  const totalRow = csv.at(-1)?.split(',') ?? []
  expect(totalRow.slice(0, 8)).toEqual(['', 'TOTAL', '', '', '11000', '99000', '44000', '2200'])
  close(Number(totalRow[8]), t.costUsd, 3)
  expect(csv.join('\n')).not.toContain('Find every test file')
  // A detailed copy keeps the task, the command and the answer, for local analysis.
  await ui.press({ key: 'export-mode' })
  await ui.press({ key: 'export-json' })
  const full = JSON.parse(wrote.json ?? '{}') as { mode: string; agents: { id: string; handoff?: { fromParent: { task?: string } } }[]; toolCalls: { id: string; detail?: string }[]; outputs: { finalAnswer?: string } }
  expect(full.mode).toBe('detailed')
  expect(full.agents.find(one => one.id === 'subagent_1')?.handoff?.fromParent.task).toContain('Find every test file')
  expect(full.toolCalls.find(one => one.id === 'a2-test')?.detail).toBe('npm test')
  // The run's final answer is the hand-back's; the prompt's own answer, which only launched the subagent, is kept beside it.
  const answers = full.outputs as { finalAnswer?: string; finalAnswerFrom?: string; promptAnswer?: string; handBackAnswers?: { agent: string; answer?: string }[] }
  expect(answers.finalAnswer).toBe('Done.')
  expect(answers.finalAnswerFrom).toBe('handback_1')
  expect(answers.promptAnswer).toBe('Started the mapping.')
  expect(answers.handBackAnswers).toEqual([{ agent: 'handback_1', answer: 'Done.' }])
  // Tool calls say what they are: the delegation that started the subagent apart from its own tools.
  const roles = (full as unknown as { toolCalls: { id: string; role: string }[] }).toolCalls
  expect(roles.find(one => one.id === 't1-ag2')?.role).toBe('delegation')
  expect(roles.find(one => one.id === 'a2-test')?.role).toBe('tool')
  await ui.press({ key: 'export-mode' })
  await ui.unmount()
})

test('a subagent that was stopped stays failed when its call returns, and a launch that fails says so', async ($, on) => {
  engine(on, mock.clock(on, { now: Date.now() }))
  mock.store(on)
  const written = capture(on)
  const card = (id: string) => (written.steps as Kept[]).find(one => one.id === id)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await begin($, 't1', 'review')
  const release = holdAgent()
  const call = $.tool.call({ tool: 'Agent', tool_use_id: 't1-ag', subagent_type: 'reviewer', description: 'Review' } as never)
  await $.agent.spawn({ tool_use_id: 't1-ag', subagentType: 'reviewer', description: 'Review', prompt: 'x', background: false } as never)
  await $.turn.complete({ turnId: 'sub-1', agentId: 'a1', answer: '', durationMs: 20, isAborted: true, reason: 'aborted' } as never)
  release({ result: { status: 'completed' }, text: 'partial' })
  await call
  expect([card('t1-ag')?.status, card('t1-ag')?.label]).toEqual(['failed', 'Subagent stopped'])

  const refuse = holdAgent()
  const failing = $.tool.call({ tool: 'Agent', tool_use_id: 't1-ag2', subagent_type: 'missing', description: 'Map' } as never)
  refuse({ isError: true, result: {}, text: 'Agent type not found: missing.' })
  await failing
  expect([card('t1-ag2')?.status, card('t1-ag2')?.label]).toEqual(['failed', 'Subagent failed'])
  await finish($, 't1')

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'mode:story' })
  expect(await ui.find({ type: 'Text', text: /^It handed “Review” to a reviewer subagent, which was stopped before it finished\.$/ })).toBeDefined()
  await ui.unmount()
})

test('API-rate prices follow the model version, cache TTL, tiers and modes; an unknown model is unpriced, not free', () => {
  const only = (part: Record<string, unknown>) => ({ input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...part })
  const million = (field: string, model: string) => costOf(model, only({ [field]: 1_000_000 }))
  // Versions are told apart: no family pattern prices one version as another.
  close(million('cache_read_input_tokens', 'claude-sonnet-5-5'), 0.1, 10)
  close(million('cache_read_input_tokens', 'claude-sonnet-5'), 0.2, 10)
  close(million('cache_read_input_tokens', 'claude-fable-5-1'), 0.25, 10)
  close(million('cache_read_input_tokens', 'claude-fable-5'), 1, 10)
  close(million('input_tokens', 'claude-opus-5-5'), 4, 10)
  close(million('input_tokens', 'claude-opus-5'), 5, 10)
  // Older models that are still served have their published rates.
  expect(rateOf('claude-sonnet-4-6')).toBeDefined()
  close(million('input_tokens', 'claude-sonnet-4-6'), 3, 10)
  close(million('output_tokens', 'claude-haiku-4-5-20251001'), 5, 10)
  close(million('input_tokens', 'claude-3-5-haiku-20241022'), 0.8, 10)
  // Platform ids and suffixes name the same model.
  expect(modelKey('us.anthropic.claude-sonnet-4-5-20250929-v1:0')).toBe('sonnet-4-5')
  expect(modelKey('claude-opus-4-5@20251101')).toBe('opus-4-5')
  expect(modelKey('claude-opus-5-5[1m]')).toBe('opus-5-5')
  // Unknown stays unknown.
  expect(costOf('claude-future-9', only({ input_tokens: 1000 }))).toBeUndefined()
  expect(costOf('sonnet', only({ input_tokens: 1000 }))).toBeUndefined()
  // Cache writes: 5-minute and 1-hour rates; without the split, the API's default 5-minute one.
  close(costOf('claude-sonnet-5-5', only({ cache_creation_input_tokens: 2e6, cache_creation: { ephemeral_1h_input_tokens: 1e6, ephemeral_5m_input_tokens: 1e6 } })), 6.5, 10)
  close(costOf('claude-sonnet-5-5', only({ cache_creation_input_tokens: 1e6 })), 2.5, 10)
  // Haiku 5.5 prices a prompt over 100,000 tokens (cache reads included) at its higher rates.
  close(costOf('claude-haiku-5-5', only({ input_tokens: 100_000 })), 0.01, 10)
  close(costOf('claude-haiku-5-5', only({ input_tokens: 50_000, cache_read_input_tokens: 100_000 })), (50_000 * 0.5 + 100_000 * 0.05) / 1e6, 10)
  // Fast mode where it exists; unknown where it doesn't. US-only inference on 4.6 and later.
  close(costOf('claude-opus-5-5', only({ input_tokens: 1e6, speed: 'fast' })), 8, 10)
  close(costOf('claude-opus-5-5', only({ cache_read_input_tokens: 1e6, speed: 'fast' })), 0.4, 10)
  expect(costOf('claude-sonnet-5-5', only({ input_tokens: 1e6, speed: 'fast' }))).toBeUndefined()
  close(costOf('claude-sonnet-4-6', only({ input_tokens: 1e6, inference_geo: 'us' })), 3.3, 10)
  close(costOf('claude-haiku-4-5', only({ input_tokens: 1e6, inference_geo: 'us' })), 1, 10)
  // The daily script gets this table rather than a copy of its own.
  expect((JSON.parse(PRICES_JSON) as { prices: Record<string, { read: number }> }).prices['sonnet-5-5']?.read).toBe(0.1)
})

test('a request with no known price shows as unpriced, keeps totals partial, and exports null', async ($, on) => {
  engine(on, mock.clock(on, { now: Date.now() }))
  mock.store(on)
  const wrote = files(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await begin($, 't1', 'try the new model')
  usageModel = 'claude-future-9'
  await step($, 't1', 1)
  await finish($, 't1')
  // The daily total is priced from the mod's own table.
  expect(pythonArgv.slice(1, 2)).toEqual(['-I'])
  expect(pythonArgv.at(-1)).toBe(PRICES_JSON)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Text', text: /^\$0\.0049 \+ 1 unpriced$/ })).toBeDefined()
    await ui.press({ key: 'open:model-t1-1' })
    expect(await ui.find({ type: 'Text', text: /^Not available: no API price is known for claude-future-9$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^unavailable$/ })).toBeDefined()
    await ui.press({ key: 'open:model-t1-1' })
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'export-md' })
  await ui.press({ key: 'export-json' })
  const record = JSON.parse(exported(wrote).json) as { complete: { cost: boolean }; summary: { unpriced: number; cost: number }; steps: Record<string, unknown>[] }
  expect(record.complete.cost).toBe(false)
  expect(record.summary.unpriced).toBe(1)
  close(record.summary.cost, REQUEST, 8)
  const unpriced = record.steps.find(one => one.id === 'model-t1-1')
  expect([unpriced?.cost, unpriced?.unpricedRequests]).toEqual([null, 1])
  await ui.unmount()
})

// 601 calls past the cap, and a pane of 600 cards to draw: slower than the rest.
test("dropping old steps to bound memory keeps each prompt's totals, keeps a running agent, and says the trace is partial", { timeoutMs: 120_000 }, async ($, on) => {
  engine(on, mock.clock(on, { now: Date.now() }))
  mock.store(on)
  const written = capture(on)
  const wrote = files(on)
  const turnOf = (id: string) => (written.turns as KeptTurn[]).find(one => one.id === id)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await begin($, 'old', 'first prompt')
  // A background agent started here is still running when the old steps go.
  const release = holdAgent()
  const call = $.tool.call({ tool: 'Agent', tool_use_id: 'old-ag', subagent_type: 'explorer', description: 'Keep working', run_in_background: true } as never)
  await $.agent.spawn({ tool_use_id: 'old-ag', subagentType: 'explorer', description: 'Keep working', prompt: 'x', background: true } as never)
  release({ result: { status: 'async_launched' }, text: 'launched' })
  await call
  await finish($, 'old')
  const before = { ...turnOf('old') }

  await begin($, 'new', 'second prompt')
  for (let at = 0; at < 601; at += 1) await $.tool.call({ tool: 'Read', tool_use_id: `r${at}`, file_path: '/repo/a.txt' } as never)
  const kept = written.steps as Kept[]
  expect(kept.length).toBeLessThanOrEqual(600)
  expect(kept.some(one => one.id === 'model-old-0')).toBe(false)
  expect(kept.find(one => one.id === 'old-ag')?.status).toBe('running')
  // The old prompt's figures are what they were, and it knows it lost detail.
  close(turnOf('old')?.cost, before.cost ?? 0, 10)
  expect(turnOf('old')?.tokens).toEqual(before.tokens)
  expect([turnOf('old')?.calls, turnOf('old')?.subagents]).toEqual([1, 1])
  expect(turnOf('old')?.evicted ?? 0).toBeGreaterThan(0)

  // The agent's later work still lands on the prompt that started it.
  await step($, 'sub-2', 0, 'a1')
  close(turnOf('old')?.cost, REQUEST * 2, 8)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'mode:runs' })
  expect(await ui.find({ type: 'Text', text: /^ {2}· older steps trimmed$/ })).toBeDefined()
  await ui.press({ key: 'prompt:old' })
  expect(await ui.find({ type: 'Text', text: /older steps? of this prompt (was|were) dropped to keep memory bounded; the figures above still count/ })).toBeDefined()
  await ui.press({ key: 'export-md' })
  await ui.press({ key: 'export-json' })
  const record = JSON.parse(exported(wrote).json) as { complete: { steps: boolean }; summary: { tokensIn: number; calls: number; evicted: number } }
  expect(record.complete.steps).toBe(false)
  expect([record.summary.tokensIn, record.summary.calls]).toEqual([20_000, 1])
  expect(record.summary.evicted).toBeGreaterThan(0)
  await ui.unmount()
})

test("the context atlas sizes tool definitions by Claude Code's own /context estimate, leaves the rest unattributed, and keeps a subagent's system prompt out", async ($, on) => {
  const clock = mock.clock(on, { now: Date.now() })
  engine(on, clock)
  mock.store(on)
  const written = capture(on)
  breakdown = {
    categories: [
      { name: 'System prompt', tokens: 2500, color: 'promptBorder', isDeferred: false, kind: 'used' },
      { name: 'System tools', tokens: 3000, color: 'inactive', isDeferred: false, kind: 'used' },
      { name: 'MCP tools', tokens: 900, color: 'inactive', isDeferred: true, kind: 'deferred' },
      { name: 'Messages', tokens: 1200, color: 'permission', isDeferred: false, kind: 'used' },
      { name: 'Free space', tokens: 190_000, color: 'inactive', isDeferred: false, kind: 'free' },
    ],
    totalTokens: 6700,
    maxTokens: 200_000,
    rawMaxTokens: 200_000,
    autocompactSource: 'model',
    percentage: 3,
    gridRows: [],
    model: 'claude-sonnet-5-5',
    memoryFiles: [],
    mcpTools: [],
    agents: [],
    isAutoCompactEnabled: true,
    apiUsage: null,
  }
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await runPrompt($, 't1', '/review-story PSS-202', 'review-story')

  const snap = (written.atlas as { parts: Record<string, { key: string; tokens: number }[]>; total: number }[]).at(-1)
  const tools = snap?.parts.tools?.find(item => item.key === 'tools:native')
  const other = snap?.parts.other?.find(item => item.key === 'other:unattributed')
  expect(tools?.tokens).toBe(3000)
  expect(other?.tokens ?? 0).toBeGreaterThan(0)
  // Parts still add up to the observed total.
  const sum = Object.values(snap?.parts ?? {}).flat().reduce((total, item) => total + item.tokens, 0)
  expect(Math.abs(sum - (snap?.total ?? 0))).toBeLessThanOrEqual(12)

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'mode:context' })
  expect(await ui.find({ type: 'Text', text: /^Claude Code's own estimate$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^System tools$/ })).toBeDefined()
  // Each list ends in a rule and its total, in bold.
  expect(await ui.find({ key: 'total:atlas:parts' })).toBeDefined()
  expect(await ui.find({ key: 'total:atlas:native' })).toBeDefined()
  expect((await ui.find({ type: 'Text', text: /^6\.7k$/ }))?.props.bold).toBe(true)
  for (const absent of [/^Free space$/, /^MCP tools$/]) expect(await ui.find({ type: 'Text', text: absent })).toBeUndefined()
  await ui.press({ key: 'part:tools' })
  expect(await ui.find({ type: 'Text', text: /^Sized by Claude Code's \/context estimate$/ })).toBeDefined()
  await ui.unmount()

  // A system prompt composed while a subagent runs may be the subagent's: it is left alone.
  const composedAt = (written.prompt as { at: number }).at
  await $.tool.call({ tool: 'Agent', tool_use_id: 't1-ag2', subagent_type: 'explorer', description: 'Map' } as never)
  await $.agent.spawn({ tool_use_id: 't1-ag2', subagentType: 'explorer', description: 'Map', prompt: 'x', background: false } as never)
  await clock.advance(500)
  await $.prompt.compose(COMPOSE)
  expect((written.prompt as { at: number }).at).toBe(composedAt)
  for (const agentId of ['a1', 'a2']) await $.turn.complete({ turnId: `sub-${agentId}`, agentId, answer: '', durationMs: 5, isAborted: false, reason: 'answer' } as never)
  await clock.advance(500)
  await $.prompt.compose(COMPOSE)
  expect((written.prompt as { at: number }).at).toBeGreaterThan(composedAt)
})

test('status labels are pills like the header status: outlined and rounded off the terminal, filled on it', async ($, on) => {
  engine(on, mock.clock(on, { now: Date.now() }))
  mock.store(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await runPrompt($, 't1', '/review-story PSS-202', 'review-story')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    // A step's label ("Check failed") and the Agents view's state are drawn alike.
    const label = (id: string, text: RegExp) => (surface === 'terminal' ? ui.find({ type: 'Text', text }) : ui.find({ key: `label:${id}` }))
    const check = await label('t1-t', /^ ?Check failed ?$/)
    const blocked = await label('t1-b', /^ ?Blocked by hook ?$/)
    if (surface === 'terminal') {
      expect(check?.props.backgroundColor).toBe('error')
      expect(blocked?.props.backgroundColor).toBe('warning')
    } else {
      for (const [pill, color] of [[check, 'error'], [blocked, 'warning']] as const) {
        expect(pill?.props.borderStyle).toBe('round')
        expect(pill?.props.borderColor).toBe(color)
        // The header's: a hairline in its own color, no fill, padded half a cell and no more.
        expect(pill?.props.backgroundColor).toBeUndefined()
        expect([pill?.props.paddingX, pill?.props.paddingY]).toEqual([0.5, 0])
      }
      expect(await ui.find({ type: 'Text', text: /^Check failed$/ })).toBeDefined()
    }
    await ui.press({ key: 'mode:agents' })
    const done = surface === 'terminal' ? await ui.find({ type: 'Text', text: /^ ?✓ Done ?$/ }) : await ui.find({ key: 'agent-badge:t1-ag' })
    if (surface === 'terminal') expect(done?.props.backgroundColor).toBe('success')
    else {
      expect([done?.props.borderStyle, done?.props.borderColor, done?.props.backgroundColor]).toEqual(['round', 'success', undefined])
    }
    await ui.press({ key: 'mode:inspect' })
    await ui.unmount()
  }
})

test('a command is laid out one chained command to a line, quotes and subshells whole, multi-line commands as written', () => {
  expect(formatCommand('  git status  ')).toBe('git status')
  expect(formatCommand('git fetch -q origin && git log --oneline origin/main -3 && git switch -c fix/x')).toBe(
    ['git fetch -q origin', '  && git log --oneline origin/main -3', '  && git switch -c fix/x'].join('\n'),
  )
  // `;` ends a line, `|` and `||` lead the next; `2>&1` is not a chain.
  expect(formatCommand('git push 2>&1 | tail -2; git status --short | grep -v x || echo none')).toBe(
    ['git push 2>&1', '  | tail -2;', 'git status --short', '  | grep -v x', '  || echo none'].join('\n'),
  )
  // Operators inside quotes or a subshell belong to the command they are in.
  expect(formatCommand(`echo "a && b; c | d" && echo 'x || y' && echo $(ls | wc -l; date)`)).toBe(
    [`echo "a && b; c | d"`, `  && echo 'x || y'`, '  && echo $(ls | wc -l; date)'].join('\n'),
  )
  expect(formatCommand('curl -H "x: \\" && y" https://example.test')).toBe('curl -H "x: \\" && y" https://example.test')
  // A command that runs over several lines is kept as written, trailing spaces dropped.
  const heredoc = "git commit -F - <<'EOF'  \nTitle && more\n\nBody\nEOF\ngit log"
  expect(formatCommand(heredoc)).toBe("git commit -F - <<'EOF'\nTitle && more\n\nBody\nEOF\ngit log")
  // A very long one is cut at 40 lines and says how many are left.
  const long = Array.from({ length: 45 }, (_, at) => `echo ${at}`).join('\n')
  expect(formatCommand(long).split('\n')).toHaveLength(41)
  expect(formatCommand(long).endsWith('… 5 more lines')).toBe(true)
})

test('a command is drawn as a code block under its label, with the label never squeezed by a long value', async ($, on) => {
  engine(on, mock.clock(on, { now: Date.now() }))
  mock.store(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await begin($, 't1', 'run a chain')
  const chain = `git fetch -q origin && git log --oneline origin/fix/view-tab-boxes -3 && git switch -c fix/status-pills && ${'x'.repeat(200)}`
  await $.tool.call({ tool: 'Bash', tool_use_id: 'long', command: chain } as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 'read', file_path: '/repo/design.md' } as never)
  await finish($, 't1')

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'open:long' })
    const codes = async () => (await ui.findAll({ type: 'Code' })).map(code => ({ source: String(code.props.source), language: code.props.language }))
    const block = (await codes()).find(one => one.source.startsWith('git fetch'))
    expect(block?.language).toBe('bash')
    expect(block?.source.split('\n').slice(0, 3)).toEqual(['git fetch -q origin', '  && git log --oneline origin/fix/view-tab-boxes -3', '  && git switch -c fix/status-pills'])
    // The label sits above the block, not beside it.
    expect(await ui.find({ type: 'Text', text: /^Command$/ })).toBeDefined()
    await ui.press({ key: 'open:long' })
    await ui.press({ key: 'open:read' })
    expect((await codes()).find(one => one.source === 'design.md')?.language).toBeUndefined()
    await ui.press({ key: 'open:read' })
    await ui.unmount()
  }

  // Label and value rows (Tokens, Why…) keep their label at full width, whatever the value.
  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.press({ key: 'open:long' })
  const label = (await ui.findAll({ type: 'Box' })).find(box => box.props.width === 16)
  expect(label?.props.flexShrink).toBe(0)
  await ui.unmount()
})

test('calibrating context keeps the observed total and never names unexplained tokens tool definitions on its own', () => {
  const parts = classify([{ role: 'user', content: [{ type: 'text', text: 'h'.repeat(4000) }] }] as never, new Map(), null)
  const plain = calibrate(parts, 5000)
  expect(plain.tools).toEqual([])
  expect(plain.other.map(item => item.tokens)).toEqual([4000])
  const sized = calibrate(parts, 5000, 3000)
  expect(sized.tools.map(item => item.tokens)).toEqual([3000])
  expect(sized.other.map(item => item.tokens)).toEqual([1000])
  // An estimate larger than what is left can't make the total grow.
  expect(calibrate(parts, 5000, 9000).tools.map(item => item.tokens)).toEqual([4000])
})

// Replays a real background-subagent run (usage and timings as Claude Code's transcript recorded them) and checks the
// export against the sums of those same numbers. Message text is made up.
test('a real-shaped background run exports one scope everywhere: totals, final answer, call roles, run time, and a cost check that survives rounding', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  engine(on, clock)
  mock.store(on)
  const wrote = files(on)
  const usage = (i: number, cr: number, cw: number, out: number) => ({ input_tokens: i, cache_read_input_tokens: cr, cache_creation_input_tokens: cw, output_tokens: out })
  const run = async (turnId: string, index: number, ms: number, u: ReturnType<typeof usage>, agentId?: string) => {
    usageExtra = u
    const go = $.turn.step({ turnId, index, model: 'claude-sonnet-5-5', messageCount: 1 + index, ...(agentId ? { agentId } : {}) } as never)
    await clock.advance(ms)
    for await (const _ of go) void _
    await go.result
  }
  await $.session.start({ cwd: '/', surface: 'vscode', isInteractive: true })
  messages = [{ role: 'user', content: [{ type: 'text', text: 'report on the flow' }] }]
  await $.turn.start({ text: 'report on the flow', turnId: 't1' })
  await run('t1', 0, 7900, usage(2, 52208, 21227, 533))
  const release = holdAgent()
  const call = $.tool.call({ tool: 'Agent', tool_use_id: 't1-ag2', subagent_type: 'general-purpose', description: 'Investigate', run_in_background: true } as never)
  await clock.advance(10_000)
  await $.agent.spawn({ tool_use_id: 't1-ag2', subagentType: 'general-purpose', description: 'Investigate', prompt: 'Look at the flow. '.repeat(60), background: true } as never)
  release({ result: { status: 'async_launched', agentId: 'a2', description: 'Investigate', prompt: 'x', outputFile: '/tmp/o' }, text: 'Async agent launched.' })
  await call
  await run('t1', 1, 4600, usage(2, 73435, 921, 34))
  await clock.advance(14_000)
  await $.turn.complete({ turnId: 't1', answer: 'Launched a subagent.', durationMs: 44_000, isAborted: false, reason: 'answer', usage: { model: 'claude-sonnet-5-5', ...usage(4, 125_643, 22_148, 567) } } as never)
  // The subagent's first request: its task, and the notes Claude Code puts around it.
  messages = [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Look at the flow. '.repeat(60) },
        { type: 'text', text: reminder(`# Environment\n${'e'.repeat(1500)}`) },
        { type: 'text', text: reminder(`As you answer the user's questions, you can use the following context:\n# userEmail\n${'u'.repeat(600)}`) },
      ],
    },
  ]
  const requests: [number, ReturnType<typeof usage>][] = [
    [13_000, usage(2, 0, 51807, 114)],
    [9_000, usage(2, 51807, 3985, 273)],
    [5_000, usage(2, 55792, 18723, 182)],
    [10_000, usage(2, 74515, 4316, 252)],
    [11_000, usage(2, 78831, 9623, 879)],
    [28_000, usage(2, 88454, 3770, 3669)],
  ]
  for (const [index, [ms, u]] of requests.entries()) {
    await run('sub-2', index, ms, u, 'a2')
    if (index < 5) await $.tool.call({ tool: 'Bash', tool_use_id: `a2-b${index}`, agentId: 'a2', command: `grep -n thing${index} f.ts` } as never)
  }
  await $.tool.call({ tool: 'SubagentHandback', tool_use_id: 'a2-hb', agentId: 'a2', report: 'the report' } as never)
  await $.turn.complete({ turnId: 'sub-2', agentId: 'a2', answer: 'r'.repeat(5000), durationMs: 175_064, isAborted: false, reason: 'answer', usage: { model: 'claude-sonnet-5-5', ...usage(12, 349_399, 92_224, 5_369) } } as never)
  messages = [{ role: 'user', content: [{ type: 'text', text: 'x' }] }]
  await $.turn.start({ text: '<agent-message from="a2">\nthe report\n</agent-message>', turnId: 't2' })
  await run('t2', 0, 17_000, usage(4, 74356, 3660, 2683))
  await $.turn.complete({ turnId: 't2', answer: 'The final answer the user needs.', durationMs: 17_500, isAborted: false, reason: 'answer', usage: { model: 'claude-sonnet-5-5', ...usage(4, 74356, 3660, 2683) } } as never)

  const ui = await $.ui.mount({ ...PANE, surface: 'vscode' })
  await ui.press({ key: 'prev' })
  await ui.press({ key: 'export-mode' })
  await ui.press({ key: 'export-md' })
  await ui.press({ key: 'export-json' })
  type Rec = {
    run: { totals: { costUsd: number; toolCalls: { all: number; byRole: Record<string, number> } }; durationMs: number }
    agents: { id: string; ranMs?: number; handoff?: { fromParent: { taskTokens: number; conversationTokens: number; addedByClaudeCodeTokens: number } } }[]
    toolCalls: { id: string; role: string }[]
    checks: { name: string; ok: boolean }[]
    outputs: { finalAnswer: string; finalAnswerFrom: string; promptAnswer: string }
  }
  const record = JSON.parse(wrote.json ?? '{}') as Rec
  const md = wrote.md ?? ''
  expect(record.checks.filter(one => !one.ok)).toEqual([])
  expect(record.run.totals.toolCalls.byRole).toEqual({ tool: 5, skill: 0, delegation: 1, handback: 1 })
  expect(record.toolCalls.find(one => one.id === 'a2-hb')?.role).toBe('handback')
  expect(record.agents.find(one => one.id === 'subagent_1')?.ranMs).toBe(175_064)
  const handoff = record.agents.find(one => one.id === 'subagent_1')?.handoff?.fromParent
  expect(handoff?.addedByClaudeCodeTokens).toBeGreaterThan(400)
  expect((handoff?.addedByClaudeCodeTokens ?? 0) + (handoff?.taskTokens ?? 0)).toBe(handoff?.conversationTokens)
  expect(record.outputs).toMatchObject({ finalAnswer: 'The final answer the user needs.', finalAnswerFrom: 'handback_1', promptAnswer: 'Launched a subagent.' })
  // The Markdown's headline speaks for the same run as its totals: hand-back cost and time included.
  expect(md).toContain(`$${record.run.totals.costUsd.toFixed(3)} at API rates (incl. 1 hand-back)`)
  expect(md).toContain('· 9 model requests · 7 tool calls (5 tools, 1 delegation, 1 hand-back report)')
  expect(md).toContain('in 2m 55s')
  expect(md).toContain('by Claude Code\'s timing')
  expect(md).toContain('| subagent_1 (general-purpose) | subagent, background | 175.1s |')
  await ui.unmount()
})

const memoryStore = (on: On, seed: Record<string, unknown> = {}) => {
  const stored: Record<string, unknown> = { ...seed }
  on('store.get', (_, e) => ({ value: stored[String((e as { key?: string }).key)] }))
  on('store.set', (_, e) => {
    const set = e as { key?: string; value?: unknown }
    stored[String(set.key)] = JSON.parse(JSON.stringify(set.value))
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    delete stored[String((e as { key?: string }).key)]
    return { value: undefined }
  })
  on('store.keys', () => ({ value: Object.keys(stored) }))
  return stored
}

type Saved = { id: string; turns: { id: string; status: string }[]; steps: { id: string; status: string; preview?: { input?: string }; detail?: string }[] }
let savedTrace = ''
let savedIndex: unknown

test('a session saves its trace to a local file and lists itself, secrets masked, previews kept', async ($, on) => {
  disk = {}
  sessionId = 's1'
  engine(on, mock.clock(on, { now: Date.now() }))
  const stored = memoryStore(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'first prompt', turnId: 't1' })
  await step($, 't1', 0)
  await $.tool.call({ tool: 'Bash', tool_use_id: 't1-b', command: 'curl --token=sk-ant-abcdefghijklmnopqrstuvwxyz0123456789 https://x' } as never)
  await step($, 't1', 1)
  await $.turn.complete({ turnId: 't1', answer: 'Done.', durationMs: 10, isAborted: false, reason: 'answer' } as never)

  const file = disk[`${HISTORY}/s1.json`]
  expect(file).toBeDefined()
  const saved = JSON.parse(file ?? '{}') as Saved
  expect(saved.turns.map(one => one.id)).toEqual(['t1'])
  const bash = saved.steps.find(one => one.id === 't1-b')
  expect(bash?.preview?.input).toBeDefined()
  expect(file).not.toContain('sk-ant-abcdefghijklmnopqrstuvwxyz0123456789')

  const index = stored.sessions as { id: string; title: string; prompts: number; project?: string }[]
  expect(index.map(one => one.id)).toEqual(['s1'])
  expect(index[0]?.title).toBe('first prompt')
  expect(index[0]?.prompts).toBe(1)
  expect(index[0]?.project).toBe('repo')
  savedTrace = file ?? ''
  savedIndex = stored.sessions
})

test('earlier sessions show in a new session, even before its first prompt, and open read-only', async ($, on) => {
  expect(savedTrace).not.toBe('')
  disk = { [`${HISTORY}/s1.json`]: savedTrace }
  sessionId = 's2'
  engine(on, mock.clock(on, { now: Date.now() }))
  memoryStore(on, { sessions: savedIndex })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Earlier sessions$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^first prompt$/ })).toBeDefined()

  // Opened: a banner says so, the status says Saved, and its steps show in Inspect.
  await ui.press({ key: 'history:s1' })
  expect(await ui.find({ type: 'Text', text: /^Earlier session$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /read-only$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Saved · / })).toBeDefined()
  expect(await ui.find({ key: 'open:t1-b' })).toBeDefined()

  // Back to the live session, which still has nothing in it.
  await ui.press({ key: 'history:back' })
  expect(await ui.find({ type: 'Text', text: /^Earlier session$/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Nothing yet/ })).toBeDefined()

  // In a session with prompts of its own, the list sits under them in Prompts.
  await $.turn.start({ text: 'second session prompt', turnId: 't9' })
  await step($, 't9', 0)
  await $.turn.complete({ turnId: 't9', answer: 'Done.', durationMs: 10, isAborted: false, reason: 'answer' } as never)
  await ui.press({ key: 'mode:runs' })
  expect(await ui.find({ type: 'Text', text: /^This session$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Earlier sessions$/ })).toBeDefined()
  expect(await ui.find({ key: 'history:s1' })).toBeDefined()
  // A saved file that has gone away is dropped from the list rather than breaking the pane.
  delete disk[`${HISTORY}/s1.json`]
  await ui.press({ key: 'history:s1' })
  expect(await ui.find({ key: 'history:s1' })).toBeUndefined()
  await ui.unmount()
})

test('a session reopened under its own id gets its trace back, and what was running reads as unfinished', async ($, on) => {
  const running = JSON.parse(savedTrace) as Saved
  running.turns[0] = { ...(running.turns[0] as Saved['turns'][number]), status: 'running' }
  const call = running.steps.find(one => one.id === 't1-b')
  if (call) call.status = 'running'
  disk = { [`${HISTORY}/s1.json`]: JSON.stringify(running) }
  sessionId = 's1'
  engine(on, mock.clock(on, { now: Date.now() }))
  memoryStore(on, { sessions: savedIndex })
  const written = capture(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect((written.turns as Saved['turns'])[0]?.status).toBe('failed')
  expect((written.steps as Saved['steps']).find(one => one.id === 't1-b')?.status).toBe('failed')
  // Its own file isn't an earlier session.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'mode:runs' })
  expect(await ui.find({ key: 'history:s1' })).toBeUndefined()
  await ui.unmount()
})

test('saved sessions older than 30 days are removed at start, and /agent-trace clear removes them all', async ($, on) => {
  const now = Date.now()
  const day = 86_400_000
  disk = { [`${HISTORY}/old.json`]: '{}', [`${HISTORY}/new.json`]: '{}' }
  sessionId = 's3'
  engine(on, mock.clock(on, { now }))
  const entry = (id: string, savedAt: number) => ({ id, at: savedAt, savedAt, title: id, prompts: 1, cost: 0, problems: 0 })
  const stored = memoryStore(on, { sessions: [entry('old', now - 31 * day), entry('new', now - 29 * day)] })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect((stored.sessions as { id: string }[]).map(one => one.id)).toEqual(['new'])
  expect(disk[`${HISTORY}/old.json`]).toBeUndefined()
  expect(disk[`${HISTORY}/new.json`]).toBeDefined()

  await $.command.run({ command: 'agent-trace', args: 'clear' } as never)
  expect(stored.sessions ?? []).toEqual([])
  expect(disk[`${HISTORY}/new.json`]).toBeUndefined()
})

test('a trace too large for one file loses its oldest previews, then its oldest steps, and says so', () => {
  const step = (n: number, size: number) => ({ id: `s${n}`, turnId: 't1', preview: { output: 'x'.repeat(size) }, title: 'y'.repeat(size) })
  const trace = (steps: unknown[]) => ({ v: 1, id: 's', savedAt: 1, turns: [{ id: 't1' }], steps, atlas: [], origins: [], context: {} }) as never
  type Fitted = { steps: { id: string; preview?: unknown }[]; turns: { evicted?: number }[] }

  // Previews alone make it fit: every step stays, the newest keeps its preview.
  const previews = JSON.parse(fitTrace(trace(Array.from({ length: 10 }, (_, n) => step(n, 200_000)))) ?? '{}') as Fitted
  expect(previews.steps.length).toBe(10)
  expect(previews.steps[0]?.preview).toBeUndefined()
  expect(previews.steps.at(-1)?.preview).toBeDefined()
  expect(previews.turns[0]?.evicted).toBeUndefined()

  // Too big even so: the oldest steps go, counted on their prompt.
  const text = fitTrace(trace(Array.from({ length: 40 }, (_, n) => step(n, 200_000)))) ?? ''
  expect(text.length).toBeLessThanOrEqual(MAX_TRACE_CHARS)
  const steps = JSON.parse(text) as Fitted
  expect(steps.steps.at(-1)?.id).toBe('s39')
  expect(steps.steps.length).toBeLessThan(40)
  expect(steps.turns[0]?.evicted).toBe(40 - steps.steps.length)
})

test('a saved session that fails to open says why and stays listed; only a missing file leaves the list', async ($, on) => {
  disk = { [`${HISTORY}/s1.json`]: 'not json' }
  sessionId = 's2'
  engine(on, mock.clock(on, { now: Date.now() }))
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(String((e as { text?: string }).text ?? Object.values(e as object)[0]))
    return { value: {} }
  })
  memoryStore(on, { sessions: savedIndex })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'history:s1' })
  expect(toasts.at(-1)).toContain("Couldn't open that saved session")
  expect(await ui.find({ key: 'history:s1' })).toBeDefined()
  await ui.unmount()
})

test('a background command stays running after its call returns, keeps the prompt open, and ends with its notification', async ($, on) => {
  disk = {}
  sessionId = 's5'
  engine(on, mock.clock(on, { now: Date.now() }))
  memoryStore(on)
  const written = capture(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await begin($, 't1', 'run it')
  await step($, 't1', 0)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'bg1', command: 'npm test', run_in_background: true } as never)
  await step($, 't1', 1)
  await $.turn.complete({ turnId: 't1', answer: 'Started.', durationMs: 10, isAborted: false, reason: 'answer' } as never)
  const card = () => (written.steps as { id: string; status: string; sub?: string }[]).find(one => one.id === 'bg1')
  expect(card()?.status).toBe('running')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^ ?✓ Answered · background tasks running · \S+ ?$/ })).toBeDefined()
  await begin($, 't2', '<task-notification><task-id>x</task-id><tool-use-id>bg1</tool-use-id><status>completed</status><summary>Background command finished</summary></task-notification>')
  expect(card()?.status).toBe('ok')
  expect(card()?.sub).toBe('Finished in the background')
  // The turn that delivered it is named for the task, not just "Prompt".
  expect((written.turns as { id: string; title: string }[]).find(one => one.id === 't2')?.title).toBe('Background command finished')

  // The Agents tab lists it: under the later prompt it's history from earlier in the session.
  await ui.press({ key: 'mode:agents' })
  expect(await ui.find({ type: 'Text', text: /^Background tasks$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Earlier in this session$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /npm test$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /· run it$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^Done$/ })).toBeDefined()
  // Under its own prompt it's this prompt's, and › opens its card in Inspect.
  await ui.press({ key: 'prev' })
  expect(await ui.find({ type: 'Text', text: /^This prompt$/, key: undefined })).toBeDefined()
  await ui.press({ key: 'task:bg1' })
  expect(await ui.find({ key: 'mode:inspect' })).toBeDefined()
  await ui.unmount()
})

test('a background command recorded before tracking began still lists, from its output, and says its end is unknown', async ($, on) => {
  const earlier = JSON.parse(savedTrace) as Saved & { steps: (Saved['steps'][number] & { preview?: { output?: string } })[] }
  const call = earlier.steps.find(one => one.id === 't1-b')
  if (call) {
    call.status = 'ok'
    call.preview = { ...call.preview, output: 'Command running in background with ID: abc123. Output is being written to: /tmp/x' }
  }
  disk = { [`${HISTORY}/s1.json`]: JSON.stringify(earlier) }
  sessionId = 's1'
  engine(on, mock.clock(on, { now: Date.now() }))
  memoryStore(on, { sessions: savedIndex })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'mode:agents' })
  expect(await ui.find({ key: 'task:t1-b' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^End not recorded$/ })).toBeDefined()
  await ui.unmount()
})

test('tool calls sit as slim rows on a tree under the request that asked for them, in either order', async ($, on) => {
  disk = {}
  sessionId = 's7'
  engine(on, mock.clock(on, { now: Date.now() }))
  memoryStore(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await begin($, 't1', 'look around')
  await step($, 't1', 0)
  await $.tool.call({ tool: 'Skill', tool_use_id: 'c1', skill: 'review-story' } as never)
  await $.tool.call({ tool: 'Bash', tool_use_id: 'c2', command: 'ls' } as never)
  await step($, 't1', 1)
  await $.turn.complete({ turnId: 't1', answer: 'Done.', durationMs: 10, isAborted: false, reason: 'answer' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Each call on its own row, joined to its request, with no card label under it.
  expect(await ui.find({ key: 'slim:c1' })).toBeDefined()
  expect(await ui.find({ key: 'slim:c2' })).toBeDefined()
  // Both sit in one tray, hung off the request by one elbow drawn at an exact size, a hairline between them.
  expect(await ui.find({ key: 'tray:c1' })).toBeDefined()
  expect(await ui.find({ key: 'tray:c2' })).toBeUndefined()
  const elbow = (await ui.find({ key: 'elbow:tray-tree:c1' }))?.children?.[0]
  expect(elbow?.props.width).toBe(20)
  expect(String(elbow?.props.source)).toContain('<rect')
  expect(await ui.find({ key: 'rule:c2' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /in sequence/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /^Tool call( ·|$)/ })).toBeUndefined()
  // A request no longer needs the Asked for section; a call still names its request.
  await ui.press({ key: 'open:c2' })
  expect(await ui.find({ type: 'Text', text: /^Requested by$/ })).toBeDefined()
  await ui.unmount()
})

test('Analytics rolls this session up: what stands out, tiles, cost by prompt, context, tools, time, problems, files and spenders', async ($, on) => {
  disk = {}
  sessionId = 'an1'
  engine(on, mock.clock(on, { now: Date.now() }))
  memoryStore(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await runPrompt($, 't1', '/review-story PSS-202', 'review-story')
  // A second prompt reads the same file twice with no edit between: one duplicate.
  await $.turn.start({ text: 'read the design again', turnId: 't2' })
  await step($, 't2', 0)
  await $.tool.call({ tool: 'Read', tool_use_id: 't2-r1', file_path: '/repo/design.md' } as never)
  await $.tool.call({ tool: 'Read', tool_use_id: 't2-r2', file_path: '/repo/design.md' } as never)
  await step($, 't2', 1)
  await $.turn.complete({ turnId: 't2', answer: 'Done.', durationMs: 10, isAborted: false, reason: 'answer' } as never)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'mode:analytics' })
    for (const title of ['Cost by prompt', 'Context over the session', 'Tools', 'Where the time went', 'What went wrong', 'What it produced', 'Who spent it'])
      expect(await ui.find({ type: 'Text', text: new RegExp(`^${title}$`) })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Duplicate calls$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^1 of \d+$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: / repeated with the same input/ })).toBeDefined()
    // Repeated calls names the call, how often it ran and the prompt it was in, with a Review link on the tile.
    expect(await ui.find({ type: 'Text', text: /^Repeated calls$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Read .*design\.md$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^×2$/ })).toBeDefined()
    expect(await ui.find({ key: 'repeat:0:open' })).toBeDefined()
    expect(await ui.find({ key: 'tile:Duplicate calls:action' })).toBeDefined()
    // Cost by prompt lists both prompts in order; the spenders name the main agent and the subagent type.
    const rows = (await ui.findAll({ type: 'Box' })).map(box => String(box.key ?? '')).filter(key => key.startsWith('cost:'))
    expect(rows).toEqual(['cost:t1', 'cost:t2'])
    expect(await ui.find({ type: 'Text', text: /^Main agent$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^story-reviewer$/ })).toBeDefined()
    // The blocked org and the failed test are listed by tool, with why.
    expect(await ui.find({ type: 'Text', text: /protected org/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^1 blocked$/ })).toBeDefined()
    // Each chart says how its figures are known.
    expect((await ui.findAll({ type: 'Text', text: /^(estimated|observed)$/ })).length).toBeGreaterThanOrEqual(4)
    // Charts are drawn off the terminal; the terminal gets a text line.
    if (surface !== 'terminal') expect(await ui.find({ key: 'an:ctx:chart' })).toBeDefined()
    else expect(await ui.find({ key: 'an:ctx:spark' })).toBeDefined()
    // The chart is drawn as an image (an interactive Svg is a 300×150 frame on the desktop), and its
    // height grows with its width so a wide pane does not flatten it. Each point's figures are in a
    // readout under the chart that ‹ › step through, starting at the latest request.
    if (surface !== 'terminal') {
      const chart = (await ui.findAll({ type: 'Svg' as never } as never)).find(one => /^Context after each/.test(String(one.props.alt)))
      expect(chart?.props.isInteractive).toBeUndefined()
      const [, w, h] = String(chart?.props.source).match(/viewBox="0 0 (\d+) (\d+)"/) ?? []
      expect(Number(w) / Number(h)).toBeLessThanOrEqual(4)
    }
    const latest = await ui.find({ type: 'Text', text: /^Request (\d+) of \1 · / })
    expect(latest).toBeDefined()
    await ui.press({ key: 'ctxpick:prev' })
    expect(await ui.find({ type: 'Text', text: /^Request (\d+) of \1 · / })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /^Request \d+ of \d+ · / })).toBeDefined()
    await ui.press({ key: 'ctxpick:next' })
    expect(await ui.find({ type: 'Text', text: /^Request (\d+) of \1 · / })).toBeDefined()
    // The pane's layout rules hold: rows say how they wrap, and no bordered Box is empty.
    const boxes = await ui.findAll({ type: 'Box' })
    for (const box of boxes) if (box.props.flexDirection === 'row') expect(box.props.flexWrap).toBeDefined()
    for (const box of boxes) if (box.props.borderStyle) expect((box.children ?? []).length).toBeGreaterThan(0)
    // Tiles: three to a row, then two, then one.
    for (const [body, width] of [
      [110, '32%'],
      [60, '48%'],
      [36, '100%'],
    ] as const) {
      await ui.redraw({ ...PANE.props, bodyColumns: body })
      expect((await ui.find({ key: 'tile:Cost' }))?.props.width).toBe(width)
    }
    // A repeated call's prompt opens that prompt in Inspect, its steps searched for the call.
    await ui.redraw({ ...PANE.props })
    await ui.press({ key: 'repeat:0:open' })
    // Where Inspect has a search box (not a mobile app that did not ask for Input) it holds the call.
    const box = await ui.find({ key: 'search' })
    if (box) expect(String(box.props.value)).toMatch(/design\.md/)
    expect(await ui.find({ key: 'open:t2-r2' })).toBeDefined()
    await ui.press({ key: 'mode:analytics' })
    await ui.unmount()
  }
})

test('one call repeated five or more times in a prompt reads as a likely loop', async ($, on) => {
  disk = {}
  sessionId = 'an3'
  engine(on, mock.clock(on, { now: Date.now() }))
  memoryStore(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'fix the flaky test', turnId: 'l1' })
  await step($, 'l1', 0)
  for (let n = 0; n < 6; n += 1) await $.tool.call({ tool: 'Read', tool_use_id: `l1-r${n}`, file_path: '/repo/session.ts' } as never)
  await step($, 'l1', 1)
  await $.turn.complete({ turnId: 'l1', answer: 'Done.', durationMs: 10, isAborted: false, reason: 'answer' } as never)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'mode:analytics' })
  expect(await ui.find({ type: 'Text', text: /ran 6 times in prompt 1 with no edit between: a likely loop\.$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^×6$/ })).toBeDefined()
  // Review opens the prompt searched for the call.
  await ui.press({ key: 'tile:Duplicate calls:action' })
  expect(String((await ui.find({ key: 'search' }))?.props.value)).toMatch(/session\.ts/)
  await ui.unmount()
})

test('Analytics across sessions: spend by day, costliest sessions, projects and models; an old entry is filled from its file once', async ($, on) => {
  // The session saved above, listed as before Analytics: its entry has no model or day figures.
  expect(savedTrace).not.toBe('')
  const { days: _d, models: _m, tokensIn: _t, cacheRead: _c, calls: _k, ...bare } = ((savedIndex as Record<string, unknown>[])[0] ?? {})
  void [_d, _m, _t, _c, _k]
  disk = { [`${HISTORY}/s1.json`]: savedTrace }
  sessionId = 'now'
  engine(on, mock.clock(on, { now: Date.now() }))
  const stored = memoryStore(on, { sessions: [bare] })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.turn.start({ text: 'today prompt', turnId: 'n1' })
  await step($, 'n1', 0)
  await $.turn.complete({ turnId: 'n1', answer: 'Done.', durationMs: 10, isAborted: false, reason: 'answer' } as never)
  const list = () => stored.sessions as Record<string, unknown>[]

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'mode:analytics' })
    await ui.press({ key: 'scope:all' })
    for (const title of ['Spend per day', 'Costliest sessions', 'By project', 'By model']) expect(await ui.find({ type: 'Text', text: new RegExp(`^${title}$`) })).toBeDefined()
    // Both sessions are listed, the live one marked as this session.
    expect(await ui.find({ key: 'topcost:s1' })).toBeDefined()
    expect(await ui.find({ key: 'topcost:now' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^This session · / })).toBeDefined()
    // The old entry's file is read once and its figures kept in the list.
    for (let n = 0; n < 5 && list().some(one => one.id === 's1' && !one.models); n++) await ui.redraw(PANE.props)
    expect(list().find(one => one.id === 's1')?.models).toBeDefined()
    await ui.redraw(PANE.props)
    expect(await ui.find({ type: 'Text', text: /^sonnet-5-5$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Reading / })).toBeUndefined()
    // The day chart's readout starts on today and steps back a day.
    const today = new Date().toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric' })
    expect(await ui.find({ type: 'Text', text: new RegExp(`^${today} · \\$`) })).toBeDefined()
    await ui.press({ key: 'daypick:prev' })
    expect(await ui.find({ type: 'Text', text: new RegExp(`^${today} · `) })).toBeUndefined()
    await ui.press({ key: 'daypick:next' })
    // The range switches, and › on a saved session opens it.
    await ui.press({ key: 'range:7' })
    expect(await ui.find({ type: 'Text', text: /^last 7 days$/ })).toBeDefined()
    if (surface === 'desktop') {
      await ui.press({ key: 'topcost:s1' })
      expect(await ui.find({ type: 'Text', text: /^Earlier session$/ })).toBeDefined()
      await ui.press({ key: 'history:back' })
    }
    await ui.unmount()
  }
})
