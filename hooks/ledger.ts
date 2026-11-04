import type { LedgerItem, PartKey, PromptSnapshot, Span } from '../types'

export type Block = { type: string; [field: string]: unknown }
export type Message = { role: 'user' | 'assistant'; content: readonly Block[] }

export const PART_ORDER: PartKey[] = [
  'system',
  'tools',
  'instructions',
  'memory',
  'skills',
  'agents',
  'results',
  'hooks',
  'conversation',
  'other',
]

// Plain words: the pane is meant to read without knowing Claude Code's internals.
export const PARTS: Record<PartKey, { label: string; hint: string; color: string }> = {
  system: { label: 'System prompt', hint: 'Claude Code built-in rules', color: '#8e98ad' },
  tools: { label: 'Tool definitions', hint: 'built-in and MCP tools', color: '#a3acbd' },
  instructions: { label: 'Project instructions', hint: 'AGENTS.md, CLAUDE.md', color: '#2f7ae0' },
  memory: { label: 'Memory', hint: 'MEMORY.md and its files', color: '#63a4f0' },
  skills: { label: 'Skills', hint: 'skill list and loaded skills', color: '#7a6be0' },
  agents: { label: 'Subagents', hint: 'reports returned to you', color: '#b07ae0' },
  results: { label: 'Tool results', hint: 'Read, Bash, Grep, MCP', color: '#13957d' },
  hooks: { label: 'Hook output', hint: 'text hooks inject', color: '#c98a1b' },
  conversation: { label: 'Conversation', hint: 'your messages and my replies', color: '#4d5a73' },
  other: {
    label: 'Unattributed',
    hint: "what the text can't account for: tool definitions, images, tokenizer differences, per-request overhead",
    color: '#b8bfcc',
  },
}

// The API reports one input total per request, so each part is sized from its
// text and the parts are scaled to that measured total afterwards.
const CHARS_PER_TOKEN = 4
const ITEMS_PER_PART = 6

type Draft = { part: PartKey; key: string; name: string; note?: string; chars: number; count: number } & Pick<
  LedgerItem,
  'status' | 'kind'
>

const textOf = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).join('\n')
  if (value && typeof value === 'object') {
    const block = value as Record<string, unknown>
    if (typeof block.text === 'string') return block.text
    if (typeof block.thinking === 'string') return block.thinking
    if ('content' in block) return textOf(block.content)
  }
  return ''
}

const REMINDER = /<system-reminder>([\s\S]*?)<\/system-reminder>/g

const clip = (text: string, size: number) => (text.length > size ? `${text.slice(0, size - 1)}…` : text)

const shortPath = (path: string) => path.split('/').slice(-2).join('/')

// Commands run from the repo root start with `cd "<repo>" &&`; the label drops it.
export const tidyCommand = (command: string) => command.replace(/^cd\s+("[^"]*"|\S+)\s*&&\s*/, '').replace(/\s+/g, ' ')

// A reminder is what Claude Code adds around your messages: project files,
// memory, the skill list, hook output and tool announcements.
type Seed = Omit<Draft, 'chars' | 'count'>
type Sized = { seed: Seed; chars: number }

// One reminder can hold several files; each is sized up to the next header.
// Paths may contain spaces ("Claude Build Opus 5.5"), so a path runs to " (".
const fileDrafts = (text: string): Sized[] => {
  const found = [...text.matchAll(/Contents of (\/.+?\.md) \(/g)]
  return found.map((match, index) => {
    const path = match[1] ?? ''
    const start = index === 0 ? 0 : (match.index ?? 0)
    const end = found[index + 1]?.index ?? text.length
    const file = path.split('/').pop() ?? path
    const seed: Seed = /\/memory\/[^/]+\.md$/.test(path)
      ? { part: 'memory', key: `file:${path}`, name: file }
      : { part: 'instructions', key: `file:${path}`, name: /^(AGENTS|CLAUDE)\.md$/.test(file) ? file : shortPath(path) }
    return { seed, chars: end - start }
  })
}

// The skill list names each skill on a line of its own: `- name: what it does`.
const skillDrafts = (text: string): Sized[] => {
  const lines = text.split('\n')
  const skills = lines.flatMap(line => {
    const name = line.match(/^- (\S+?)(?::\s|:?$)/)?.[1]
    return name ? [{ seed: { part: 'skills', key: `skills:list:${name}`, name, note: 'listed' } as Seed, chars: line.length + 1 }] : []
  })
  const framing = text.length - skills.reduce((sum, one) => sum + one.chars, 0)
  return [...skills, ...(framing > 0 ? [{ seed: { part: 'skills', key: 'skills:list', name: 'Skill list heading' } as Seed, chars: framing }] : [])]
}

// What a hook said, in a few words: the text after its own heading.
const hookNote = (text: string) => {
  const said = text.split(/additional context:|hook (?:error|failed|timed out|blocking error):?/i).at(-1) ?? text
  const line = said.split('\n').map(one => one.trim()).find(Boolean)
  return line ? clip(line, 70) : undefined
}

const NAMED: [RegExp, Seed][] = [
  [/Plugin-catalog match/, { part: 'hooks', key: 'hook:plugin-suggestions', name: 'Plugin suggestions' }],
  [/durable context|Skills first \(required\)/, { part: 'hooks', key: 'hook:session-start', name: 'Session start banner' }],
  [/skills are available|following skills/i, { part: 'skills', key: 'skills:list', name: 'Available skills list' }],
  [
    /deferred tools|tools just became available|tools below are now available|MCP Server Instructions/i,
    { part: 'tools', key: 'tools:announcements', name: 'Newly available tools' },
  ],
  [/ide_selection|ide_opened_file|opened the file|selected the following/i, { part: 'conversation', key: 'reminder:editor', name: 'Open file in your editor' }],
  [/userEmail|gitStatus/, { part: 'conversation', key: 'reminder:account', name: 'Account and git status' }],
  [/Attribution for git commits/, { part: 'conversation', key: 'reminder:attribution', name: 'Commit sign-off note' }],
  [/todo list|task list|TodoWrite/i, { part: 'conversation', key: 'reminder:tasks', name: 'Task list reminder' }],
  [/local-command|command-name/, { part: 'conversation', key: 'reminder:commands', name: 'Slash command output' }],
]

const firstLine = (text: string) =>
  clip((text.split('\n').find(line => line.trim()) ?? 'Note').replace(/^[#\s*-]+/, '').trim(), 40)

const reminderDrafts = (text: string): Sized[] => {
  const files = fileDrafts(text)
  if (files.length > 0) return files
  const chars = text.length
  const failure = text.match(/(\w+(?::[\w*]+)?) hook (?:error|failed|timed out|blocking error)/i)
  if (failure) {
    const name = `${failure[1]} hook`
    return [{ seed: { part: 'hooks', key: `hook:${name}:failed`, name, status: 'failed', kind: 'Hook failed', note: hookNote(text) }, chars }]
  }
  const named = NAMED.find(([pattern]) => pattern.test(text))
  if (named?.[1].key === 'skills:list') return skillDrafts(text)
  if (named) return [{ seed: named[1].part === 'hooks' ? { ...named[1], note: hookNote(text) } : named[1], chars }]
  const hook = text.match(/(\w+(?::[\w*]+)?) hook/)
  if (hook) return [{ seed: { part: 'hooks', key: `hook:${hook[1]}`, name: `${hook[1]} hook`, note: hookNote(text) }, chars }]
  const name = firstLine(text)
  return [{ seed: { part: 'conversation', key: `reminder:${name}`, name: `Note: ${name}` }, chars }]
}

const detailOf = (input: unknown): string => {
  const fields = (input ?? {}) as Record<string, unknown>
  for (const field of ['command', 'file_path', 'pattern', 'skill', 'description', 'url', 'query']) {
    const value = fields[field]
    if (typeof value !== 'string') continue
    if (field === 'file_path') return value.split('/').pop() ?? value
    return field === 'command' ? tidyCommand(value) : value
  }
  return ''
}

export const classify = (
  messages: readonly Message[],
  spansById: ReadonlyMap<string, Span>,
  system: PromptSnapshot | null,
): Record<PartKey, LedgerItem[]> => {
  const drafts = new Map<string, Draft>()
  // `repeats` marks text injected again and again (hook output, reminders), whose count is worth showing.
  const add = (draft: Seed, chars: number, repeats = false) => {
    if (chars <= 0) return
    const known = drafts.get(draft.key)
    if (known) {
      known.chars += chars
      if (repeats) known.count += 1
    } else {
      drafts.set(draft.key, { ...draft, chars, count: 1 })
    }
  }
  const addText = (text: string, plain: Seed) => {
    let rest = text
    for (const match of text.matchAll(REMINDER)) {
      for (const { seed, chars } of reminderDrafts(match[1] ?? '')) add(seed, chars, true)
      rest = rest.replace(match[0], '')
    }
    const skill = rest.match(/^Base directory for this skill:\s*(\S+)/)
    if (skill) {
      const name = (skill[1] ?? '').replace(/\/$/, '').split('/').pop() ?? 'skill'
      add({ part: 'skills', key: `skill:${name}`, name, note: 'loaded' }, rest.length)
      return
    }
    add(plain, rest.trim().length)
  }

  const uses = new Map<string, { name: string; input: unknown }>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use' && typeof block.id === 'string') {
        uses.set(block.id, { name: String(block.name ?? 'tool'), input: block.input })
      }
    }
  }

  for (const message of messages) {
    for (const block of message.content) {
      if (message.role === 'assistant') {
        if (block.type === 'tool_use') {
          add({ part: 'conversation', key: 'conversation:tool-inputs', name: 'My tool requests' }, JSON.stringify(block.input ?? {}).length)
        } else {
          add({ part: 'conversation', key: 'conversation:mine', name: 'My replies' }, textOf(block).length)
        }
        continue
      }
      if (block.type === 'text') {
        addText(textOf(block), { part: 'conversation', key: 'conversation:yours', name: 'Your messages' })
        continue
      }
      if (block.type !== 'tool_result') continue

      const id = String(block.tool_use_id ?? '')
      const use = uses.get(id)
      const span = spansById.get(id)
      const body = textOf(block.content)
      const toolName = use?.name ?? 'tool'
      if (toolName === 'Skill') {
        const name = detailOf(use?.input) || 'skill'
        addText(body, { part: 'skills', key: `skill:${name}`, name, note: 'loaded' })
        continue
      }
      if (toolName === 'Agent' || toolName === 'Task') {
        const type = String((use?.input as Record<string, unknown> | undefined)?.subagent_type ?? 'general')
        addText(body, { part: 'agents', key: `agent:${id}`, name: `${type} report` })
        continue
      }
      const status =
        span?.status === 'blocked' || span?.status === 'failed'
          ? span.status
          : block.is_error === true
            ? 'failed'
            : undefined
      const detail = (span?.check ? (span.detail ?? '') : detailOf(use?.input)).replace(/\s+/g, ' ')
      addText(body, {
        part: 'results',
        key: `result:${id}`,
        name: `${span?.check ?? toolName}${detail ? ` ${clip(detail, 40)}` : ''}`,
        status,
        kind: status === 'blocked' ? 'Blocked by hook' : status ? (span?.check ? 'Check failed' : 'Tool failed') : undefined,
      })
    }
  }

  // Section ids are internal names, so the system prompt is one row.
  const sections = system?.sections ?? []
  add(
    { part: 'system', key: 'system:base', name: "Claude Code's built-in instructions" },
    sections.reduce((sum, section) => sum + section.tokens, 0) * CHARS_PER_TOKEN,
  )

  const parts = Object.fromEntries(PART_ORDER.map(part => [part, [] as LedgerItem[]])) as Record<PartKey, LedgerItem[]>
  for (const draft of drafts.values()) {
    const { part, chars, count, ...rest } = draft
    parts[part].push({ ...rest, tokens: chars / CHARS_PER_TOKEN, count: count > 1 ? count : undefined })
  }
  return parts
}

// Scales the estimates to the measured input. What the text can't account for
// goes to tool definitions only as far as Claude Code's own /context estimate
// sizes them (`toolTokens`); the rest is shown as unattributed, never guessed.
export const calibrate = (parts: Record<PartKey, LedgerItem[]>, measuredIn: number, toolTokens?: number): Record<PartKey, LedgerItem[]> => {
  const estimated = PART_ORDER.reduce((sum, part) => sum + (parts[part] ?? []).reduce((s, item) => s + item.tokens, 0), 0)
  const scale = measuredIn > 0 && estimated > measuredIn ? measuredIn / estimated : 1
  const scaled = Object.fromEntries(
    PART_ORDER.map(part => [part, (parts[part] ?? []).map(item => ({ ...item, tokens: Math.round(item.tokens * scale) }))]),
  ) as Record<PartKey, LedgerItem[]>
  const remainder = Math.round(measuredIn - estimated * scale)
  const tools = Math.min(Math.max(0, remainder), Math.round(toolTokens ?? 0))
  if (tools > 0) scaled.tools.push({ key: 'tools:native', name: 'Tool definitions', note: "Sized by Claude Code's /context estimate", tokens: tools })
  if (remainder - tools > 0) scaled.other.push({ key: 'other:unattributed', name: 'Not accounted for by the text', tokens: remainder - tools })
  return scaled
}

// Keeps each part readable: problems and the largest items, the rest in one row.
export const condense = (parts: Record<PartKey, LedgerItem[]>): Record<PartKey, LedgerItem[]> =>
  Object.fromEntries(
    PART_ORDER.map(part => {
      const sorted = [...(parts[part] ?? [])].sort((a, b) => Number(!!b.status) - Number(!!a.status) || b.tokens - a.tokens)
      const kept = sorted.slice(0, ITEMS_PER_PART)
      const rest = sorted.slice(ITEMS_PER_PART).filter(item => !item.status)
      const problems = sorted.slice(ITEMS_PER_PART).filter(item => item.status)
      const more = rest.reduce((sum, item) => sum + item.tokens, 0)
      return [
        part,
        [
          ...kept,
          ...problems,
          ...(rest.length > 0
            ? [{ key: `${part}:more`, name: `${rest.length} other ${part === 'skills' ? 'skills' : 'items'}`, note: clip(rest.map(item => item.name).join(', '), 160), tokens: more }]
            : []),
        ],
      ]
    }),
  ) as Record<PartKey, LedgerItem[]>

export const partTokens = (items?: readonly LedgerItem[]) => (items ?? []).reduce((sum, item) => sum + item.tokens, 0)

export const formatTokens = (count: number) =>
  count < 1000 ? `${Math.round(count)}` : count < 1_000_000 ? `${(count / 1000).toFixed(1)}k` : `${(count / 1_000_000).toFixed(2)}M`

export const formatCost = (amount: number) =>
  amount <= 0 ? '–' : amount < 0.0001 ? '<$0.0001' : amount < 0.01 ? `$${amount.toFixed(4)}` : amount < 1 ? `$${amount.toFixed(3)}` : `$${amount.toFixed(2)}`
