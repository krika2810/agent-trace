import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren, TurnStepResult } from 'claude-code'

import type { AgentCall, AgentRequest, AtlasSnapshot, CostSplit, Detail, DetailTab, FileChange, HistoryEntry, SavedTrace, RunSummary, FlowContext, FlowView, LedgerItem, Origin, PartKey, PromptSnapshot, Quality, Row, Step, StepFilter, StepKind, StepStatus, Tokens, Turn, ViewMode } from '../types'
import type { Message } from './ledger'
import { formatCommand } from './command'
import { allStats, contextChart, dayChart, dayText, entryFigures, needsFigures, pointText, QUALITY_OF, type RepeatRow, sessionStats, sparkline } from './analytics'
import { fitTrace } from './history'
import { calibrate, classify, condense, formatCost, formatTokens, PART_ORDER, PARTS, partTokens, tidyCommand } from './ledger'
import { costOf, costSplitOf, PRICES_JSON, rateOf } from './pricing'
import { buildReport, reportCsv, reportMarkdown } from './report'

const PANE = 'agent-trace'
const TITLE = 'Agent trace'
// Steps are dropped oldest first past this many; each prompt keeps its own totals.
const MAX_STEPS = 600
const MAX_TURNS = 12
const MAX_ORIGINS = 1000
const MAX_ASKED = 50
const MAX_AGENTS = 200
// Rows listed inside a subagent's card, and problems inside it named in its details.
const MAX_NEST = 100
// A subagent's requests kept on its card, newest last.
const MAX_LOG = 60
// A subagent's requests listed before "Show all".
const REQUESTS_SHOWN = 6
const MAX_INNER = 5
const ITEMS_PER_PART = 4
const PREVIEW_LINES = 20
const PREVIEW_CHARS = 2000
// From this many columns the details sit beside the list instead of under a card.
const WIDE = 150
// Calls from one request that start this close together went out as one batch.
const TOGETHER_MS = 250
// Finished prompts kept per project, across sessions: figures and a redacted title only.
// Saved sessions: how long they stay, how often a running prompt saves, the list's length.
const HISTORY_DAYS = 30
const SAVE_EVERY_MS = 30_000
const MAX_SESSIONS = 300
const SESSIONS_KEY = 'sessions'
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']

const steps = atom({ plugin: 'agent-trace', key: 'steps' } as const, [] as Step[])
const turns = atom({ plugin: 'agent-trace', key: 'turns' } as const, [] as Turn[])
const context = atom({ plugin: 'agent-trace', key: 'context' } as const, { agents: {}, hookCounts: {} } as FlowContext)
const prompt = atom({ plugin: 'agent-trace', key: 'prompt' } as const, null as PromptSnapshot | null)
const today = atom({ plugin: 'agent-trace', key: 'today' } as const, { day: '', total: 0 })
const view = atom({ plugin: 'agent-trace', key: 'view' } as const, { selected: null, open: [] } as FlowView)
const origins = atom({ plugin: 'agent-trace', key: 'origins' } as const, [] as Origin[])
const atlas = atom({ plugin: 'agent-trace', key: 'atlas' } as const, [] as AtlasSnapshot[])
const history = atom({ plugin: 'agent-trace', key: 'history' } as const, [] as HistoryEntry[])
const archive = atom({ plugin: 'agent-trace', key: 'archive' } as const, null as SavedTrace | null)

// Text and borders take the person's theme by name, so the pane follows light
// and dark. Color is kept for meaning: a kind's icon, a status badge, a bar.
const INK = 'text'
const MUTED = 'inactive'
const LINE = 'subtle'
// The tray behind the segmented tabs off the terminal.
const TRAY = 'userMessageBackground'

// Each kind is told apart by its icon and label as well as its color. `tone`
// colors text by theme name; `bar` is a mid-tone hex for the drawn bars,
// which can't take a theme name and must read on light and dark alike.
const KINDS: Record<StepKind, { label: string; icon: string; tone: string; bar: string }> = {
  prompt: { label: 'Your prompt', icon: '›', tone: 'text', bar: '#7c8799' },
  context: { label: 'Context loaded', icon: '≡', tone: 'suggestion', bar: '#4a86e8' },
  hook: { label: 'Hook', icon: '↳', tone: 'warning', bar: '#d59a2c' },
  model: { label: 'Model request', icon: '✦', tone: 'permission', bar: '#7471e6' },
  skill: { label: 'Skill', icon: '✧', tone: 'merged', bar: '#9b7be3' },
  tool: { label: 'Tool call', icon: '▸', tone: 'planMode', bar: '#2aa58a' },
  agent: { label: 'Subagent', icon: '◇', tone: 'autoAccept', bar: '#b47ad9' },
  compact: { label: 'Compaction', icon: '↺', tone: 'ide', bar: '#5a9fc2' },
  done: { label: 'Answer', icon: '✓', tone: 'success', bar: '#3d9a5c' },
}

// The empty part of a bar: grey at partial opacity, so it sits back on either theme.
const TRACK_BAR = { color: '#8b93a1', opacity: 0.35, tone: LINE }

// Badges are solid, as shadcn draws them: the theme's inverse text on a status color.
const BADGE = 'inverseText'
const TONE = {
  failed: { text: 'error', edge: 'error', bar: '#d9534f' },
  blocked: { text: 'warning', edge: 'warning', bar: '#d59a2c' },
} as const

// Order matters: a dry-run is also a `project deploy start`.
const CHECK_PATTERNS: [RegExp, string][] = [
  [/prettier/, 'Format'],
  [/code-analyzer/, 'Analyzer'],
  [/apex run test/, 'Apex tests'],
  [/\bjest\b|test:unit/, 'Jest'],
  [/--dry-run|deploy validate/, 'Dry-run'],
  [/project deploy start/, 'Deploy'],
]

const clip = (text: string, size = 70) => (text.length > size ? `${text.slice(0, size - 1)}…` : text)

const dayOf = (ms: number) => {
  const date = new Date(ms)

  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

// Claude Code wraps a message in tags (the open editor file, a selection, pasted text), some
// with attributes; a title is only the person's own words. A message that is all paste is titled by it.
const cleanTitle = (text: string) => {
  const words = (value: string) =>
    value
      .replace(/<([a-z][\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1(?:\s[^>]*)?>/gi, ' ')
      .replace(/<\/?[a-z][\w-]*(?:\s[^>]*)?>/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  const pasted = [...text.matchAll(/<pasted_content(?:\s[^>]*)?>([\s\S]*?)<\/pasted_content(?:\s[^>]*)?>/gi)].map(match => match[1] ?? '').join(' ')

  return clip(words(text) || words(pasted), 60) || 'Prompt'
}

// A background subagent's report comes back as a turn of its own, wrapped in <agent-message from="id">.
// Titled by each subagent's place among those its prompt started: "Subagent 3", "Subagents 1 and 2".
// The subagents a hand-back delivers; empty for a message that holds anything else.
const handBackIds = (text: string) => {
  const ids = [...text.matchAll(/<agent-message\s+from="([^"]+)"/gi)].map(match => match[1] ?? '')
  return ids.length && !text.replace(/<agent-message[\s\S]*?<\/agent-message>/gi, '').trim() ? ids : []
}

const handBackTitle = (text: string, ctx: FlowContext, all: Step[]) => {
  const ids = handBackIds(text)
  if (!ids.length) return undefined
  const numbers = ids.map(id => {
    const card = all.find(step => step.id === ctx.agents[id])
    const started = all.filter(step => step.kind === 'agent' && step.turnId === card?.turnId).sort((a, b) => a.at - b.at)
    return card ? started.indexOf(card) + 1 : 0
  })
  const known = [...new Set(numbers.filter(number => number > 0))].sort((a, b) => a - b)
  if (!known.length) return ids.length === 1 ? 'Subagent' : 'Subagents'
  return `${known.length === 1 ? 'Subagent' : 'Subagents'} ${listOf(known.map(String))}`
}

const clock = (ms: number) => {
  const date = new Date(ms)

  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

const tokensOf = (text: string | undefined) => Math.ceil((text ?? '').length / 4)

const duration = (ms: number) => {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(1)}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(Math.round(seconds % 60)).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

// `color` draws the Svg bar, `tone` the terminal's text bar (a theme name).
type Segment = { color: string; value: number; opacity?: number; tone?: string }

// Whole units per segment by largest remainder, so the parts always add up to the room.
// Only segments with a value are kept, each at least `least` wide, taken from the widest.
const apportion = (segments: Segment[], room: number, least = 1) => {
  const shown = segments.filter(segment => segment.value > 0)
  const total = shown.reduce((sum, segment) => sum + segment.value, 0)
  const parts = shown.map(segment => {
    const exact = (segment.value / total) * Math.max(0, room)
    return { ...segment, size: Math.floor(exact), remainder: exact - Math.floor(exact) }
  })
  let left = Math.max(0, room) - parts.reduce((sum, part) => sum + part.size, 0)
  for (const part of [...parts].sort((a, b) => b.remainder - a.remainder)) {
    if (left <= 0) break
    part.size += 1
    left -= 1
  }
  for (const part of parts) {
    const widest = parts.reduce((most, one) => (one.size > most.size ? one : most), part)
    const need = least - part.size
    if (need <= 0 || widest.size - need < least) continue
    widest.size -= need
    part.size += need
  }
  return parts
}

// Wider than any surface's cell: an Svg wider than its slot is scaled down to fit,
// never stretched, so bars always span their slot exactly as the pane is resized.
const PX_PER_CELL = 16
// The token part of a request's sub line, which the card shows on a line of its own.
const TOKENS_SUB = /^[\d.,]+[kKM]? in \(\d+% cached\)(?: · [\d.,]+[kKM]? out)?(?: · |$)/

const svgBar = (segments: Segment[], cells: number, height: number) => {
  const width = Math.max(1, cells) * PX_PER_CELL
  const gap = Math.max(2, Math.round(height / 2))
  const count = segments.filter(segment => segment.value > 0).length
  let x = 0
  const rects = apportion(segments, width - gap * Math.max(0, count - 1), height).map(part => {
    const fade = part.opacity === undefined ? '' : ` fill-opacity="${part.opacity}"`
    const rect = `<rect x="${x}" y="0" width="${part.size}" height="${height}" rx="${height / 2}" fill="${part.color}"${fade}/>`
    x += part.size + gap
    return rect
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${rects.join('')}</svg>`
}

// A cell apiece between segments, so each reads as its own piece.
const textBar = (segments: Segment[], cells: number) => {
  const count = segments.filter(segment => segment.value > 0).length
  return apportion(segments, Math.max(count, cells - Math.max(0, count - 1))).map((part, at) => ({
    color: part.tone ?? part.color,
    text: `${at > 0 ? ' ' : ''}${'━'.repeat(part.size)}`,
  }))
}

// Where a subagent is in its lifecycle: a stage done, the one it is in, one to come, or where it stopped.
type StageState = 'done' | 'now' | 'next' | 'failed'

// The Context funnel's bars, stacked and centred, each as wide as its share of the widest.
// Its height is pinned by the Svg element, so the bars keep it as the pane is resized.
const FUNNEL_BAR_PX = 14
const FUNNEL_GAP_PX = 2
const funnelHeight = (bars: number) => bars * FUNNEL_BAR_PX + Math.max(0, bars - 1) * FUNNEL_GAP_PX
const svgFunnel = (bars: { color: string; value: number }[], widest: number, cells: number) => {
  const width = Math.max(1, cells) * PX_PER_CELL
  const height = funnelHeight(bars.length)
  const rects = bars.map((one, at) => {
    const size = Math.max(width * 0.015, (one.value / Math.max(1, widest)) * width)
    return `<rect x="${((width - size) / 2).toFixed(1)}" y="${at * (FUNNEL_BAR_PX + FUNNEL_GAP_PX)}" width="${size.toFixed(1)}" height="${FUNNEL_BAR_PX}" rx="2" fill="${one.color}"/>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${rects.join('')}</svg>`
}

const textFunnel = (value: number, widest: number, cells: number) => {
  const size = Math.min(cells, Math.max(1, Math.round((value / Math.max(1, widest)) * cells)))
  return `${' '.repeat(Math.floor((cells - size) / 2))}${'━'.repeat(size)}`
}

// The lifecycle's five stages as dots on a line, filled up to the stage it is in.
const svgRail = (states: StageState[], cells: number, accent: string) => {
  const width = Math.max(1, cells) * PX_PER_CELL
  const height = 18
  const mid = height / 2
  const xs = states.map((_, n) => ((n + 0.5) / states.length) * width)
  const reach = states.reduce((last, state, n) => (state === 'next' ? last : n), 0)
  const dots = states.map((state, n) => {
    const x = xs[n]?.toFixed(1)
    if (state === 'done') return `<circle cx="${x}" cy="${mid}" r="5" fill="${accent}"/>`
    if (state === 'failed') return `<circle cx="${x}" cy="${mid}" r="5" fill="#d9534f"/>`
    if (state === 'now') return `<circle cx="${x}" cy="${mid}" r="8" fill="${accent}" fill-opacity="0.25"/><circle cx="${x}" cy="${mid}" r="5" fill="none" stroke="${accent}" stroke-width="2.5"/>`
    return `<circle cx="${x}" cy="${mid}" r="5" fill="none" stroke="${TRACK_BAR.color}" stroke-width="2"/>`
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><line x1="${xs[0]}" y1="${mid}" x2="${xs.at(-1)}" y2="${mid}" stroke="${TRACK_BAR.color}" stroke-opacity="${TRACK_BAR.opacity}" stroke-width="2"/><line x1="${xs[0]}" y1="${mid}" x2="${xs[reach]}" y2="${mid}" stroke="${accent}" stroke-width="2"/>${dots.join('')}</svg>`
}

// A stretch of a timeline: the track, and the part from `from` to `to` (shares of the whole). One
// still running is drawn in dashes.
const svgSpan = (from: number, to: number, color: string, cells: number, height: number, running: boolean) => {
  const width = Math.max(1, cells) * PX_PER_CELL
  const x = Math.min(width - 3, Math.max(0, from) * width)
  const w = Math.max(3, Math.min(width - x, (to - from) * width))
  const fill = running
    ? Array.from({ length: Math.ceil(w / 6) }, (_, n) => `<rect x="${(x + n * 6).toFixed(1)}" y="0" width="${Math.min(4, w - n * 6).toFixed(1)}" height="${height}" fill="${color}"/>`).join('')
    : `<rect x="${x.toFixed(1)}" y="0" width="${w.toFixed(1)}" height="${height}" rx="${height / 2}" fill="${color}"/>`
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect x="0" y="0" width="${width}" height="${height}" rx="${height / 2}" fill="${TRACK_BAR.color}" fill-opacity="${TRACK_BAR.opacity}"/>${fill}</svg>`
}

// The same stretch in text: the track in rule characters, the stretch in heavy ones.
const textSpan = (from: number, to: number, cells: number, tone: string) => {
  const start = Math.min(cells - 1, Math.max(0, Math.round(from * cells)))
  const size = Math.max(1, Math.min(cells - start, Math.round((to - from) * cells)))
  return [
    { color: LINE, text: '─'.repeat(start) },
    { color: tone, text: '━'.repeat(size) },
    { color: LINE, text: '─'.repeat(Math.max(0, cells - start - size)) },
  ]
}

// One request's input and output as a column: read from cache at the bottom, then written to cache
// (striped), new input and output on top. A request still waiting is a dashed outline.
type Column = { read: number; written: number; fresh: number; out: number; running?: boolean }

const svgColumns = (columns: Column[], cells: number, height: number) => {
  const width = Math.max(1, cells) * PX_PER_CELL
  const count = Math.max(1, columns.length)
  const gap = Math.max(4, Math.min(16, Math.round(width / count / 5)))
  const size = (width - gap * (count - 1)) / count
  const top = Math.max(1, ...columns.map(one => one.read + one.written + one.fresh + one.out))
  const scale = (height - 2) / top
  const shapes = columns.map((one, n) => {
    const x = (n * (size + gap)).toFixed(1)
    if (one.running) {
      return `<rect x="${x}" y="${(height * 0.35).toFixed(1)}" width="${size.toFixed(1)}" height="${(height * 0.65 - 1).toFixed(1)}" rx="2" fill="none" stroke="${TRACK_BAR.color}" stroke-dasharray="4 3"/>`
    }
    let y = height
    const out: string[] = []
    const piece = (value: number, color: string, striped = false) => {
      if (value <= 0) return
      const tall = Math.max(1.5, value * scale)
      y -= tall
      out.push(`<rect x="${x}" y="${y.toFixed(1)}" width="${size.toFixed(1)}" height="${tall.toFixed(1)}" fill="${color}"/>`)
      if (striped) {
        for (let line = y + 1.5; line < y + tall - 1; line += 3) out.push(`<rect x="${x}" y="${line.toFixed(1)}" width="${size.toFixed(1)}" height="1" fill="#ffffff" fill-opacity="0.45"/>`)
      }
    }
    piece(one.read, REREAD_BAR)
    piece(one.written, NEW_BAR, true)
    piece(one.fresh, NEW_BAR)
    piece(one.out, OUT_BAR)
    return out.join('')
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${shapes.join('')}</svg>`
}

// Line icons for each kind of step, drawn on a 24-unit grid.
const ICONS: Record<StepKind, string> = {
  prompt: '<path d="M4 5h16v11H9l-5 4z"/>',
  context: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
  hook: '<path d="M6 3v8a5 5 0 0 0 5 5h7"/><path d="M15 12l4 4-4 4"/>',
  model: '<path d="M12 3l2.2 6.8L21 12l-6.8 2.2L12 21l-2.2-6.8L3 12l6.8-2.2z"/>',
  skill: '<path d="M4 4h6a2 2 0 0 1 2 2v14a2 2 0 0 0-2-2H4z"/><path d="M20 4h-6a2 2 0 0 0-2 2v14a2 2 0 0 1 2-2h6z"/>',
  tool: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3"/><path d="M13 15h4"/>',
  agent: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  compact: '<path d="M4 12a8 8 0 1 0 3-6.2"/><path d="M4 4v5h5"/>',
  done: '<path d="M5 12l5 5L19 7"/>',
}

// An icon on a tile tinted with its own color, so it reads on either theme.
// A step's tokens and cost as pills. Drawn as Svg so they are fully round on every surface: a Box's
// round border is barely rounded in VS Code. The grey reads on light and dark themes alike.
const PILL_PX = 18
const PILL_INK = '#6e7681'
const pillWidth = (text: string) => Math.round(text.length * 6.3) + 14
// How many cells a pill takes where a cell is drawn about 8px wide (VS Code, desktop).
const pillCells = (text: string) => Math.ceil(pillWidth(text) / 8)
const pillSvg = (text: string) => {
  const width = pillWidth(text)
  const safe = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${PILL_PX}" viewBox="0 0 ${width} ${PILL_PX}">` +
    `<rect x="0.5" y="0.5" width="${width - 1}" height="${PILL_PX - 1}" rx="${(PILL_PX - 1) / 2}" fill="none" stroke="${PILL_INK}" stroke-opacity="0.45"/>` +
    `<text x="${width / 2}" y="12.5" text-anchor="middle" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif" font-size="11" fill="${PILL_INK}">${safe}</text></svg>`
  )
}

const ICON_PX = 22
// The elbow from a request down to what it asked for, from filled rectangles at an exact size:
// box-drawing characters differ in width in a proportional font, which shifts the rows beside them.
const ELBOW_W = 20
const ELBOW_H = 26
const elbowSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${ELBOW_W}" height="${ELBOW_H}" viewBox="0 0 ${ELBOW_W} ${ELBOW_H}"><rect x="6" y="0" width="1.5" height="20" fill="#8b93a1"/><rect x="6" y="18.5" width="14" height="1.5" fill="#8b93a1"/></svg>`
// A hairline between a tray's rows; drawn wider than its slot, which scales it to fit.
const ruleSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1" viewBox="0 0 1600 1" preserveAspectRatio="none"><rect width="100%" height="1" fill="#8b93a1" fill-opacity="0.45"/></svg>`

const tileSvg = (kind: StepKind, color: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${ICON_PX}" height="${ICON_PX}" viewBox="0 0 ${ICON_PX} ${ICON_PX}">` +
  `<rect width="${ICON_PX}" height="${ICON_PX}" rx="6" fill="${color}" fill-opacity="0.16"/>` +
  `<g transform="translate(4 4) scale(0.5833)" fill="none" stroke="${color}" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">${ICONS[kind]}</g></svg>`

// How long a step took as a share of the whole prompt: the track is the prompt, the fill the step.
// A step still running is striped, so it never reads as finished.
const METER_CELLS = 20
const svgMeter = (color: string, share: number, height: number, running: boolean, cells = METER_CELLS) => {
  const width = cells * PX_PER_CELL
  const fill = share > 0 ? Math.max(height, Math.round(share * width)) : 0
  const stripes = running
    ? `<defs><pattern id="run" width="${height * 2}" height="${height * 2}" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">` +
      `<rect width="${height}" height="${height * 2}" fill="${color}"/><rect x="${height}" width="${height}" height="${height * 2}" fill="${color}" fill-opacity="0.4"/></pattern></defs>`
    : ''
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${stripes}` +
    `<rect x="0" y="0" width="${width}" height="${height}" rx="${height / 2}" fill="${TRACK_BAR.color}" fill-opacity="${TRACK_BAR.opacity}"/>` +
    (fill ? `<rect x="0" y="0" width="${fill}" height="${height}" rx="${height / 2}" fill="${running ? 'url(#run)' : color}"/>` : '') +
    '</svg>'
  )
}

// The Tokens stat's lean bar: re-read from cache, output and new input.
const NEW_BAR = '#d97706'
const REREAD_BAR = '#aab4c3'
const OUT_BAR = '#4a7fdc'

const textMeter = (tone: string, share: number, running: boolean, cells = METER_CELLS) => {
  const fill = share > 0 ? Math.max(1, Math.round(share * cells)) : 0
  return [
    { color: tone, text: (running ? '┅' : '━').repeat(fill) },
    { color: LINE, text: '─'.repeat(cells - fill) },
  ].filter(part => part.text)
}

const MODES: { id: ViewMode; label: string }[] = [
  { id: 'inspect', label: 'Inspect' },
  { id: 'context', label: 'Context' },
  { id: 'agents', label: 'Agents' },
  { id: 'story', label: 'Story' },
  { id: 'runs', label: 'Prompts' },
  { id: 'analytics', label: 'Analytics' },
]

const FILTERS: { id: StepFilter; label: string; kinds?: StepKind[] }[] = [
  { id: 'all', label: 'All' },
  { id: 'problems', label: 'Problems' },
  { id: 'model', label: 'Model', kinds: ['model'] },
  { id: 'tool', label: 'Tools', kinds: ['tool', 'skill'] },
  { id: 'agent', label: 'Agents', kinds: ['agent'] },
  { id: 'hook', label: 'Hooks', kinds: ['hook'] },
]

// The route a row came in by, as session.append names it, in plain words.
const DOORS: Record<string, string> = {
  prompt: 'Your prompts',
  command: 'Slash commands',
  response: 'Model replies',
  'tool-result': 'Tool results',
  'tool-message': 'Tool messages',
  delivery: 'Delivered messages',
  attachment: 'Attachments',
  'hook-context': 'Hook context',
  note: 'Plugin notes',
  compaction: 'Compaction summary',
  notice: 'Notices',
  queue: 'Queued prompts',
}

// Each subagent's share of the cost bar; the main agent takes the model color.
const AGENT_BARS = ['#b47ad9', '#5a9fc2', '#2aa58a', '#d59a2c', '#9b7be3', '#d9534f']

// The most that ran at once, from each one's start and end.
const peakOf = (spans: { from: number; to: number }[]) => {
  const marks = spans.flatMap(span => [
    { at: span.from, by: 1 },
    { at: span.to, by: -1 },
  ])
  marks.sort((a, b) => a.at - b.at || a.by - b.by)
  let now = 0
  let peak = 0
  for (const mark of marks) {
    now += mark.by
    peak = Math.max(peak, now)
  }
  return peak
}

const signed = (value: number) => (value > 0 ? `+${formatTokens(value)}` : value < 0 ? `−${formatTokens(-value)}` : '')

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

// A cost that leaves out requests with no known price says so rather than reading as complete.
const costText = (cost: number | undefined, unpriced = 0) =>
  unpriced ? (cost ? `${formatCost(cost)} + ${unpriced} unpriced` : 'price unknown') : formatCost(cost ?? 0)

// Problems a subagent met inside its run: failed or blocked calls, nested subagents that stopped.
const innerOf = (step: Step) => ({ failed: step.agent?.failed ?? 0, blocked: step.agent?.blocked ?? 0 })
const hasInner = (step: Step) => (step.agent?.problems ?? 0) > 0

const innerNote = (step: Step) => {
  const { failed, blocked } = innerOf(step)
  return [failed ? `${plural(failed, 'step')} inside it failed` : '', blocked ? `${blocked} call${blocked === 1 ? ' was' : 's were'} blocked inside it` : '']
    .filter(Boolean)
    .join(' and ')
}

// A step's name without its free text: the tool or check, the skill, the hook, the kind.
const nameOf = (step: Step) =>
  step.kind === 'prompt' ? 'Your prompt' : step.kind === 'context' ? 'Context loaded' : (step.title.split(' · ')[0] ?? step.title)

// One sentence of the story: when it happened, what kind of step, in plain words.
type Beat = { id: string; at: number; kind: StepKind; text: string; problem?: 'failed' | 'blocked' }

const listOf = (names: string[]) => (names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`)

// "Bash · git status" reads as "Bash (git status)" in a sentence.
const callName = (step: Step) => {
  const [name, ...rest] = step.title.split(' · ')
  return rest.length ? `${name} (${rest.join(' · ')})` : (name ?? step.title)
}

const why = (step: Step) => step.details.find(detail => detail.key === 'Why')?.value

const lower = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)

// Claude Code's wall time for the answer. A background subagent can run on after it.
const answerOf = (turn: Turn, flow: Step[]) => turn.durationMs ?? (turn.end ?? flow.at(-1)?.end ?? flow.at(-1)?.at ?? turn.at) - turn.at

// The prompt's whole time: to its answer, or to its last background subagent's end if that is later.
const spanOf = (turn: Turn, flow: Step[]) => Math.max(answerOf(turn, flow), (turn.agentsEnd ?? turn.at) - turn.at)

// A finished prompt whose background subagents are still working.
const runsOn = (turn: Turn, flow: Step[]) => turn.status !== 'running' && flow.some(step => (step.kind === 'agent' || step.background) && step.status === 'running')
// What a finished prompt is still waiting on, in a few words.
const runsOnLabel = (flow: Step[]) => (flow.some(step => step.kind === 'agent' && step.status === 'running') ? 'subagents' : 'background tasks')

// The prompt told as sentences, from the recorded steps alone: no model writes it.
// Calls that succeeded one after another share a sentence. `safe` leaves out the
// free text a step carries (commands, error messages, a subagent's task), for an export.
const storyOf = (turn: Turn, flow: Step[], safe = false): Beat[] => {
  const beats: Beat[] = []
  let calls: Step[] = []
  const named = safe ? nameOf : callName
  const reason = (step: Step) => (safe ? undefined : why(step))
  const flush = () => {
    const first = calls[0]
    if (!first) return
    const took = (step: Step) => (step.end !== undefined && step.end > step.at ? ` in ${duration(step.end - step.at)}` : '')
    beats.push({
      id: first.id,
      at: first.at - turn.at,
      kind: 'tool',
      text: calls.length === 1 ? `It ran ${named(first)}${took(first)}.` : `It ran ${calls.length} tools: ${listOf(calls.map(named))}.`,
    })
    calls = []
  }
  flow.forEach((step, index) => {
    const at = step.at - turn.at
    const took = step.end !== undefined && step.end > step.at ? ` in ${duration(step.end - step.at)}` : ''
    if (step.kind === 'tool' && step.status === 'ok') {
      calls.push(step)
      return
    }
    flush()
    const beat = (text: string, problem?: 'failed' | 'blocked') => beats.push({ id: step.id, at, kind: step.kind, text, problem })
    const problem = step.status === 'failed' || step.status === 'blocked' ? step.status : undefined
    switch (step.kind) {
      case 'prompt':
        beat(`You asked “${turn.title}”.`)
        break
      case 'context':
        beat(`Claude Code sent ${formatTokens(step.added ?? 0)} tokens of context with it: ${lower(step.sub ?? 'the system prompt')}.`)
        break
      case 'model': {
        const model = (step.model ?? '').replace(/^claude-/, '')
        if (step.status === 'running') {
          beat(`Claude (${model}) is working on ${lower(step.title.split(' · ')[0] ?? 'a request')}…`)
          break
        }
        if (problem) {
          beat(`The request to Claude ${step.label === 'Refused' ? 'was refused' : 'failed'}${safe ? '.' : `: ${step.sub ?? ''}`}`, problem)
          break
        }
        const t = step.tokens
        const tIn = t ? t.input + t.cacheRead + t.cacheWrite : 0
        let asked = 0
        for (const next of flow.slice(index + 1)) {
          if (next.kind === 'model' || next.kind === 'done') break
          if (next.kind === 'tool' || next.kind === 'skill' || next.kind === 'agent') asked += 1
        }
        const read = t ? ` read ${formatTokens(tIn)} tokens (${tIn ? Math.round((t.cacheRead / tIn) * 100) : 0}% from cache) and` : ''
        beat(`Claude (${model})${read} ${asked ? `asked for ${asked} tool call${asked === 1 ? '' : 's'}` : 'wrote the answer'}${took}.`)
        break
      }
      case 'skill':
        beat(`It loaded the ${step.title.replace(/^Loaded skill: /, '')} skill.`)
        break
      case 'tool':
        if (step.status === 'running') beat(`It is running ${named(step)}…`)
        else if (step.status === 'blocked') beat(safe ? `A hook blocked ${named(step)}.` : `A hook blocked ${named(step)}: ${reason(step) ?? 'no reason given'}`, 'blocked')
        else beat(safe ? `${named(step)} failed${took}.` : `${named(step)} failed${took}: ${reason(step) ?? step.sub ?? ''}`, 'failed')
        break
      case 'agent': {
        const task = safe ? undefined : step.details.find(detail => detail.key === 'Task')?.value
        const who = `a ${step.agent?.type ?? 'general'} subagent`
        const handed = task ? `It handed “${task}” to ${who}` : `It started ${who}`
        // Claude Code counts the call a subagent reports through among its tool calls; the story says so.
        const reportCall = step.agent?.callLog?.some(call => call.name === 'SubagentHandback')
        const did = step.agent ? `${plural(step.agent.requests, 'request')} and ${plural(step.agent.calls, 'tool call')}${reportCall ? ' (the last one handing its report back)' : ''}` : ''
        // Its own run as Claude Code timed it; the card's wall time also counts the lead-in from the Agent call.
        const span = step.agent?.ranMs ?? (step.end !== undefined ? step.end - step.at : 0)
        const ran = span > 0 ? ` in ${duration(span)}` : ''
        // A subagent can finish well after meeting a problem: both are said, neither hides the other.
        const inner = innerNote(step)
        const met = inner ? (innerOf(step).failed ? 'failed' : 'blocked') : undefined
        if (step.status === 'running')
          beat(`${handed}, which is still working${step.agent?.launched ? ' in the background' : ''}${inner ? `; so far ${inner}` : ''}.`, met)
        else if (problem) beat(`${handed}, which ${step.label === 'Subagent stopped' ? 'was stopped before it finished' : 'failed'}${inner ? `; ${inner}` : ''}.`, problem)
        else beat(`${handed}, which made ${did}${ran} and reported back${inner ? `, though ${inner}` : ''}.`, met)
        break
      }
      case 'hook':
        beat(problem ? `The ${step.title} reported an error.` : `The ${step.title} added text to the context.`, problem)
        break
      case 'compact':
        beat(`${step.title}: ${step.sub ?? ''}.`)
        break
      case 'done': {
        const files = turn.outcome ?? []
        if (files.length) {
          const names = files.slice(0, 4).map(file => file.path.split('/').pop() ?? file.path)
          const more = files.length > 4 ? [`${files.length - 4} more`] : []
          beats.push({ id: step.id, at, kind: 'tool', text: `It changed ${files.length} file${files.length === 1 ? '' : 's'}: ${listOf([...names, ...more])}.` })
        }
        const answer = answerOf(turn, flow)
        if (problem) beat(`It stopped before the answer, after ${duration(answer)}.`, problem)
        else {
          // Claude Code times the answer from the prompt's submission; this log starts when the turn did.
          const seen = (turn.end ?? step.at) - turn.at
          beat(
            Math.abs(answer - seen) > 1000
              ? `The answer was ready after ${duration(answer)} by Claude Code's timing (${duration(seen)} on this log, which starts when the turn did).`
              : `The answer was ready after ${duration(answer)}.`,
          )
        }
        const last = (turn.agentsEnd ?? turn.at) - turn.at
        if (last > answer) beats.push({ id: step.id, at: last, kind: 'agent', text: `Its last background subagent finished after ${duration(last)}.` })
        break
      }
    }
  })
  flush()
  return beats
}

// The prompt's figures in a line, from its own totals: they hold even after old steps are dropped.
// `whole`: the export's totals over the prompt, its subagents and the hand-backs that delivered their reports.
type WholeRun = { requests: number; calls: string; cost: number; unpriced: number; durationMs: number; handBacks: number }

const storySummary = (turn: Turn, flow: Step[], elapsed: number, whole?: WholeRun) => {
  const sum = summaryOf(turn, flow)
  if (whole) elapsed = whole.durationMs
  return [
    turn.status === 'running'
      ? `Running for ${duration(elapsed)}`
      : runsOn(turn, flow)
        ? `Answered in ${duration(answerOf(turn, flow))}, background ${runsOnLabel(flow).replace('background ', '')} still running`
        : `${turn.status === 'failed' ? 'Stopped after' : 'Done in'} ${duration(elapsed)}${elapsed > answerOf(turn, flow) ? ` (answer at ${duration(answerOf(turn, flow))})` : ''}`,
    plural(whole?.requests ?? sum.requests, 'model request'),
    whole ? whole.calls : plural(sum.calls, 'tool call'),
    sum.subagents ? plural(sum.subagents, 'subagent') : '',
    sum.problems ? plural(sum.problems, 'problem') : '',
    (whole?.cost ?? sum.cost) || (whole?.unpriced ?? sum.unpriced)
      ? `${costText(whole?.cost ?? sum.cost, whole?.unpriced ?? sum.unpriced)} at API rates${whole?.handBacks ? ` (incl. ${plural(whole.handBacks, 'hand-back')})` : ''}`
      : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

// The story as Markdown: the same words the pane draws. `safe` drops commands, error text and tasks.
const storyMarkdown = (turn: Turn, flow: Step[], elapsed: number, ctx: FlowContext, safe = false, whole?: WholeRun) =>
  [
    `### ${turn.title}`,
    '',
    `${storySummary(turn, flow, elapsed, whole)}${ctx.branch ? ` · ${ctx.branch}${ctx.commit ? ` @ ${ctx.commit}` : ''}` : ''}`,
    ...(turn.evicted ? ['', `_${plural(turn.evicted, 'earlier step')} of this prompt were dropped to bound memory; the figures above still count them._`] : []),
    '',
    ...storyOf(turn, flow, safe).map((beat, at) => `${at + 1}. \`+${duration(beat.at)}\` ${beat.problem ? '**' : ''}${beat.text}${beat.problem ? '**' : ''}`),
    '',
    '_Times observed; tokens as the API reported them; costs are API-rate estimates, not what a Claude plan bills. From agent-trace._',
  ].join('\n')

const EXPORT_PRIVACY =
  "Left out: commands, tool input and output, error messages, subagent tasks and reports. Kept: the prompt's title, the changed files' paths, the git branch and commit, and model, tool, skill and subagent names, " +
  'with secrets, emails and home folders masked by pattern matching. Masking is best effort, not a guarantee: read the files before sharing them.'

// One step as an export carries it: what kind, how it went, its time, tokens and cost,
// and the ids that tie it to the rest. No free text beyond the step's name.
const exportedStep = (step: Step, turn: Turn, asker: string | undefined) => ({
  id: step.id,
  kind: step.kind,
  name: nameOf(step),
  status: step.status,
  label: step.label,
  requestedBy: asker,
  startMs: step.at - turn.at,
  durationMs: step.end !== undefined ? step.end - step.at : undefined,
  runMs: step.runMs,
  askedPermission: step.asked || undefined,
  model: step.model,
  effort: step.effort,
  stopReason: step.stopReason,
  tokens: step.tokens,
  addedTokens: step.added,
  contextTokens: step.ctx,
  // null, not 0, when no price is known.
  cost: step.cost ?? (step.unpriced || (step.kind === 'model' && step.tokens) ? null : undefined),
  costSplit: step.split,
  unpricedRequests: step.unpriced,
  quality: step.q,
  agent: step.agent && {
    id: step.agent.id,
    type: step.agent.type,
    requests: step.agent.requests,
    calls: step.agent.calls,
    problems: step.agent.problems,
    failed: step.agent.failed,
    blocked: step.agent.blocked,
    background: step.agent.background,
    launched: step.agent.launched,
    ended: step.agent.ended,
    nestedAgents: step.agent.children?.map(child => ({ id: child.id, type: child.type, state: child.state })),
    // Estimated from the task's text; the task itself stays out of the export.
    handoffTokens: step.agent.handoff,
    // Sizes by part only: the items' names can carry commands and paths.
    firstRequest: step.agent.loaded && {
      inputTokens: step.agent.loaded.total,
      byPart: Object.fromEntries(
        PART_ORDER.map(part => [PARTS[part].label, partTokens(step.agent?.loaded?.parts[part])]).filter(([, tokens]) => tokens),
      ),
      notExposed: step.agent.loaded.hidden,
      quality: { inputTokens: 'observed', byPart: 'estimated', notExposed: 'inferred' },
    },
    requestLog: step.agent.log?.map(request => ({
      startMs: request.at - turn.at,
      durationMs: request.end - request.at,
      model: request.model,
      messages: request.messages,
      tokens: request.tokens,
      cost: request.cost ?? null,
      costSplit: request.split,
      nested: request.nested,
    })),
    requestsNotLogged: Math.max(0, step.agent.requests - (step.agent.log?.length ?? 0)) || undefined,
  },
})

// A share-safe copy of one prompt in the project's .claude/traces/: the story as
// Markdown and the steps as JSON, in a fixed shape that leaves free text out.
type ExportFormat = 'csv' | 'md' | 'json'

// The prompt's whole run copied to the clipboard: the requests as CSV, the run as Markdown or as
// JSON. All three come from one report, so their figures agree. Share-safe leaves free text out;
// detailed keeps commands, output previews, tasks, reports and the answer, masked as a copy is.
const exportTrace = async ($: EngineInterface, turn: Turn, flow: Step[], elapsed: number, format: ExportFormat, surface: string, detailed: boolean) => {
  const saved = await read($, archive)
  const ctx = saved?.context ?? (await read($, context))
  const all = saved?.turns ?? (await read($, turns))
  const everything = saved?.steps ?? (await read($, steps))
  const backs = handBacksOf(turn, all, everything, ctx).map(one => ({ turn: one, flow: everything.filter(step => step.turnId === one.id) }))
  const mode = detailed ? 'detailed' : 'share-safe'
  const text = () => {
    const report = buildReport({ turn, flow, handBacks: backs, mode, nameOf, redact, branch: ctx.branch, commit: ctx.commit })
    if (format === 'csv') return reportCsv(report)
    if (format === 'md') {
      const t = report.run.totals
      const whole =
        report.run.complete.steps && report.run.complete.requests
          ? {
              requests: t.requests.all,
              calls: `${plural(t.toolCalls.all, 'tool call')}${t.toolCalls.byRole.delegation || t.toolCalls.byRole.handback ? ` (${t.toolCalls.byRole.tool + t.toolCalls.byRole.skill} tools, ${plural(t.toolCalls.byRole.delegation, 'delegation')}, ${plural(t.toolCalls.byRole.handback, 'hand-back report')})` : ''}`,
              cost: t.costUsd,
              unpriced: t.unpricedRequests,
              durationMs: report.run.durationMs ?? elapsed,
              handBacks: backs.length,
            }
          : undefined
      return redact(reportMarkdown(report, storyMarkdown(turn, flow, elapsed, ctx, !detailed, whole)))
    }
    // The summary covers the same run as the report, so its figures equal the report's totals. When
    // steps were dropped the records are partial: it keeps the prompt's running totals, which outlive
    // them, and the checks show the gap.
    const t = report.run.totals
    const whole = report.run.complete.steps && report.run.complete.requests
    const summary = whole
      ? {
          ...summaryOf(turn, flow, ctx.branch),
          scope: report.run.scope,
          durationMs: report.run.durationMs ?? spanOf(turn, flow),
          requests: t.requests.all,
          calls: t.toolCalls.all,
          cost: t.costUsd,
          unpriced: t.unpricedRequests,
          tokensIn: t.tokens.totalInput,
          tokensOut: t.tokens.output,
          cacheRead: t.tokens.cacheRead,
        }
      : { ...summaryOf(turn, flow, ctx.branch), scope: "This prompt's running totals: some of its steps were dropped to bound memory, so the records below are partial." }
    let asker: string | undefined
    const record = {
      ...report,
      privacy: `${report.privacy} ${EXPORT_PRIVACY}`,
      // Kept where earlier exports put it.
      complete: { steps: report.run.complete.steps, cost: report.run.complete.cost },
      summary,
      outcome: turn.outcome ?? [],
      // This prompt's steps in the shape earlier exports gave them.
      steps: flow.map(step => {
        if (step.kind === 'model') asker = step.id
        return exportedStep(step, turn, isCall(step) ? asker : undefined)
      }),
    }
    return JSON.stringify(redactDeep(record), null, 2)
  }
  try {
    const body = text()
    const done = await $.ui.copy({ text: body, surface: surface as never })
    const what =
      format === 'csv'
        ? `${plural(body.trim().split('\n').length - 2, 'request')} as CSV, costs estimated at API rates`
        : `the run as ${format === 'md' ? 'Markdown' : 'JSON'}, ${detailed ? 'detailed, with commands and output previews' : 'share-safe, without commands or tool output'}; secrets masked (best effort)`
    await $.ui.toast(done.isCopied ? `Copied ${what}.` : `Couldn't copy: ${done.reason ?? 'not supported here'}`)
  } catch (error) {
    await $.ui.toast(`Couldn't copy the trace: ${clip(String(error), 120)}`)
  }
}

const isProblem = (step: Step) => step.status === 'failed' || step.status === 'blocked'
const isProblemStatus = (status: StepStatus | undefined) => status === 'failed' || status === 'blocked'

// The first sentence says what went wrong; the rest is usually advice.
const firstSentence = (text: string) => clip((text.trim().split(/(?<=[.!?])\s|\n/)[0] ?? '').trim(), 200)

const detailOf = (raw: Record<string, unknown>): string => {
  if (typeof raw.command === 'string') return tidyCommand(raw.command)
  if (typeof raw.file_path === 'string') return raw.file_path.split('/').pop() ?? raw.file_path
  for (const field of ['pattern', 'skill', 'description', 'url', 'query']) {
    if (typeof raw[field] === 'string') return raw[field] as string
  }
  return ''
}

// The first lines of a call's input or output, for the inspector; kept in session state only.
const preview = (text: string | undefined) => {
  if (!text) return undefined
  const lines = text.split('\n')
  const head = lines.slice(0, PREVIEW_LINES).join('\n')
  const clipped = head.length > PREVIEW_CHARS ? `${head.slice(0, PREVIEW_CHARS - 1)}…` : head
  return lines.length > PREVIEW_LINES ? `${clipped}\n… ${lines.length - PREVIEW_LINES} more lines` : clipped
}

// A tool call's arguments, less the fields the engine adds to every call.
const argsOf = (raw: Record<string, unknown>) => {
  const { tool: _tool, tool_use_id: _id, agentId: _agent, ...args } = raw
  try {
    return JSON.stringify(args, null, 2)
  } catch {
    return undefined
  }
}

const addTokens = (a: Tokens | undefined, b: Tokens): Tokens => ({
  input: (a?.input ?? 0) + b.input,
  output: (a?.output ?? 0) + b.output,
  cacheRead: (a?.cacheRead ?? 0) + b.cacheRead,
  cacheWrite: (a?.cacheWrite ?? 0) + b.cacheWrite,
})

const addSplit = (a: CostSplit | undefined, b: CostSplit): CostSplit => ({
  input: (a?.input ?? 0) + b.input,
  cacheRead: (a?.cacheRead ?? 0) + b.cacheRead,
  cacheWrite: (a?.cacheWrite ?? 0) + b.cacheWrite,
  output: (a?.output ?? 0) + b.output,
})

const tokensFrom = (usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }): Tokens => ({
  input: usage.input_tokens,
  output: usage.output_tokens,
  cacheRead: usage.cache_read_input_tokens,
  cacheWrite: usage.cache_creation_input_tokens,
})

// The window and the session's cost as Claude Code reports them, kept for the pane.
// With `breakdown`, also /context's own categories: the `summary` count, from the last
// response and local estimates, never the token-count API that `full` would call.
const refreshUsage = async ($: EngineInterface, breakdown = false): Promise<AtlasSnapshot['native']> => {
  try {
    const usage = breakdown ? await $.session.usage({ breakdown: 'summary' }) : await $.session.usage()
    await update($, context, ctx => ({ ...ctx, window: usage.context.window, sessionCost: usage.cost?.usd }))
    const native = usage.context.breakdown
    if (!native) return undefined
    const rows = native.categories.filter(row => row.kind === 'used' && row.tokens > 0).map(row => ({ name: row.name, tokens: Math.round(row.tokens) }))
    return { model: native.model, total: Math.round(native.totalTokens), rows }
  } catch {
    // Without it the pane says the window is unknown, and the atlas keeps its own estimate.
    return undefined
  }
}

// The tool schemas in /context's own rows; the categories carry no kind for them, so by name.
const nativeTools = (native: AtlasSnapshot['native']) => native?.rows.filter(row => /tool/i.test(row.name)).reduce((sum, row) => sum + row.tokens, 0)

// The text a conversation row carries, for its size only.
const charsOf = (content: unknown): number => {
  if (typeof content === 'string') return content.length
  if (!Array.isArray(content)) return 0
  return content.reduce((sum: number, block: Record<string, unknown>) => {
    if (typeof block?.text === 'string') return sum + block.text.length
    if (block?.type === 'tool_result') return sum + charsOf(block.content)
    return sum
  }, 0)
}

const originName = (origin: Record<string, unknown>) => {
  for (const field of ['tool', 'name', 'hook', 'plugin', 'model', 'event']) {
    if (typeof origin[field] === 'string') return origin[field] as string
  }
  return undefined
}

// Today covers every session, including requests made before this mod loaded,
// so it is summed from Claude Code's own session logs rather than counted here.
const refreshToday = async ($: EngineInterface) => {
  try {
    // The script prices with this mod's own table, so the two never disagree.
    const { exitCode, stdout } = await $.process.run(['python3', '-I', `${$.plugin.root}/scripts/today_cost.py`, PRICES_JSON])
    if (exitCode !== 0) return
    const { day, total, unpriced } = JSON.parse(stdout) as { day: string; total: number; unpriced?: number }
    if (typeof day !== 'string' || typeof total !== 'number') return
    await update($, today, () => ({ day, total, unpriced }))
  } catch {
    // The daily total is a convenience; the flow works without it.
  }
}

const git = async ($: EngineInterface, args: string[]): Promise<string | undefined> => {
  try {
    const { exitCode, stdout } = await $.process.run(['git', ...args])
    return exitCode === 0 ? stdout.trim() || undefined : undefined
  } catch {
    return undefined
  }
}

// The branch, its short commit, and a ticket key (ABC-123) in the branch name.
const readRepo = async ($: EngineInterface) => {
  const branch = await git($, ['rev-parse', '--abbrev-ref', 'HEAD'])
  const commit = await git($, ['rev-parse', '--short', 'HEAD'])
  return { branch, commit, story: branch?.match(/[A-Z][A-Z0-9]+-\d+/)?.[0] }
}

// Each tracked file's changed lines against the last commit: path -> "added removed".
// Undefined outside a git repository, so the pane can say so rather than show "none".
const numstat = async ($: EngineInterface): Promise<Record<string, string> | undefined> => {
  try {
    const { exitCode, stdout } = await $.process.run(['git', 'diff', '--numstat', 'HEAD'])
    if (exitCode !== 0) return undefined
    const files: Record<string, string> = {}
    for (const line of stdout.split('\n')) {
      const [added, removed, ...path] = line.split('\t')
      if (path.length) files[path.join('\t')] = `${added} ${removed}`
    }
    return files
  } catch {
    return undefined
  }
}

// What changed between the prompt's start and end, plus files an edit tool wrote
// that git doesn't count (untracked, or back to where they began).
const outcomeOf = (before: Record<string, string>, after: Record<string, string>, touched: string[], root?: string): FileChange[] => {
  const count = (value: string | undefined) => (value === undefined || value === '-' ? undefined : Number(value))
  const changes: FileChange[] = []
  for (const [path, now] of Object.entries(after)) {
    if (before[path] === now) continue
    const [added, removed] = now.split(' ')
    changes.push({ path, added: count(added), removed: count(removed) })
  }
  for (const path of Object.keys(before)) if (!(path in after)) changes.push({ path, added: 0, removed: 0 })
  for (const full of touched) {
    const path = root && full.startsWith(`${root}/`) ? full.slice(root.length + 1) : full
    if (!changes.some(change => change.path === path)) changes.push({ path })
  }
  return changes
}

// A credential's value masked, its key and quoting kept. Token counts (`input_tokens: 12`) are figures, not secrets.
const maskValue = (match: string, quote: string, key: string, between: string, value: string) => {
  if (/tokens$|tokenizer/i.test(key)) return match
  const mark = value[0] === '"' || value[0] === "'" ? value[0] : ''
  return `${quote}${key}${quote}${between}${mark}<secret>${mark}`
}

// Best-effort masking of what shouldn't leave the session: key shapes, credentials in URLs,
// key=value, JSON "key": "value" and command flags whose key names a credential, emails and
// home folders. Pattern matching: it can't promise arbitrary text is safe to share.
const SECRETS: [RegExp, string | ((...parts: string[]) => string)][] = [
  [/\b(?:sk|pk|rk|ghp|gho|ghu|ghs|github_pat|xox[abpr])[-_][-_A-Za-z0-9]{12,}|\bAKIA[A-Z0-9]{12,}/g, '<secret>'],
  [/\b(Bearer|Basic)\s+[-._~+/A-Za-z0-9]+=*/gi, '$1 <secret>'],
  // scheme://user:password@host, as URLs and connection strings carry them.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/:@'"]+:[^\s/@'"]+@/gi, '$1<secret>@'],
  [
    /(["']?)\b([\w.-]*(?:token|secret|password|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key|credentials?)[\w.-]*)\1(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;&'"}\]]+)/gi,
    maskValue,
  ],
  [/(--?(?:token|password|passwd|secret|api-?key|access-token|auth-token|client-secret))([ =])("[^"]*"|'[^']*'|\S+)/gi, '$1$2<secret>'],
  [/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>'],
  [/\/(?:Users|home)\/[^/\s"']+/g, '~'],
]

const redact = (text: string) => SECRETS.reduce((out, [pattern, swap]) => out.replace(pattern, swap as (...parts: string[]) => string), text)

const redactDeep = (value: unknown): unknown =>
  typeof value === 'string'
    ? redact(value)
    : Array.isArray(value)
      ? value.map(redactDeep)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([key, one]) => [key, redactDeep(one)]))
        : value

const isCall = (step: Step) => step.kind === 'tool' || step.kind === 'skill' || step.kind === 'agent'

// Every request's counters in these steps, the main agent's and its subagents'.
const tokensIn = (flow: Step[]) => flow.reduce<Tokens>((sum, step) => (step.tokens ? addTokens(sum, step.tokens) : sum), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

// A prompt's figures: the Prompts view's rows, the story's summary and an export's.
// They come from the prompt's own totals, which outlive dropped steps; a prompt
// recorded before those totals existed falls back to counting its steps.
const summaryOf = (turn: Turn, flow: Step[], branch?: string): RunSummary => {
  const tokens = turn.tokens ?? tokensIn(flow)
  const files = turn.outcome ?? []
  const problems =
    turn.failed !== undefined
      ? turn.failed + (turn.blocked ?? 0) + (turn.nested ?? 0)
      : flow.filter(isProblem).length + flow.reduce((sum, step) => sum + (step.agent?.problems ?? 0), 0)
  return {
    id: turn.id,
    at: turn.at,
    title: redact(turn.title),
    durationMs: spanOf(turn, flow),
    answerMs: answerOf(turn, flow),
    requests: turn.requests,
    calls: turn.calls ?? flow.filter(isCall).length,
    subagents: turn.subagents ?? flow.filter(step => step.kind === 'agent').length,
    problems,
    cost: turn.cost,
    unpriced: turn.unpriced ?? 0,
    evicted: turn.evicted ?? 0,
    tokensIn: tokens.input + tokens.cacheRead + tokens.cacheWrite,
    tokensOut: tokens.output,
    cacheRead: tokens.cacheRead,
    models: turn.models ?? [...new Set(flow.filter(step => step.kind === 'model' && step.model).map(step => (step.model ?? '').replace(/^claude-/, '')))],
    branch,
    files: files.length,
    added: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
    removed: files.reduce((sum, file) => sum + (file.removed ?? 0), 0),
  }
}

// The cost categories in the order the API bills them, by name.
// "22.1k in: 2 new · 52.2k cache reads · 21.5k cache writes · 597 out"
const tokenLine = (t: Tokens) =>
  `${formatTokens(t.input + t.cacheRead + t.cacheWrite)} in: ${formatTokens(t.input)} new · ${formatTokens(t.cacheRead)} read · ${formatTokens(t.cacheWrite)} written · ${formatTokens(t.output)} out`

const SPLIT_NAMES: [keyof CostSplit, string][] = [
  ['input', 'new input'],
  ['cacheRead', 'cache reads'],
  ['cacheWrite', 'cache writes'],
  ['output', 'output'],
]

const splitSum = (split: CostSplit) => split.input + split.cacheRead + split.cacheWrite + split.output

// "cache writes $0.225 (53%) · output $0.079 (19%) · …", largest first.
const splitText = (split: CostSplit) => {
  const total = splitSum(split)
  return [...SPLIT_NAMES]
    .sort((a, b) => split[b[0]] - split[a[0]])
    .filter(([key]) => split[key] > 0)
    .map(([key, name]) => `${name} ${formatCost(split[key])}${total ? ` (${Math.round((split[key] / total) * 100)}%)` : ''}`)
    .join(' · ')
}

// The prompts that delivered a background subagent's report back: later turns of their own.
const handBacksOf = (turn: Turn, all: Turn[], steps: Step[], ctx: FlowContext) =>
  all.filter(one => one.id !== turn.id && (one.handsBack ?? []).some(id => (ctx.agentTurns?.[id] ?? steps.find(step => step.id === ctx.agents[id])?.turnId) === turn.id))

// Where a prompt's cost went: its own requests, each subagent's, and the hand-backs after it.
// Every figure is an API-rate estimate from the counters the API reported.
const costsOf = (turn: Turn, flow: Step[], all: Turn[], steps: Step[], ctx: FlowContext) => {
  const agents = flow.filter(step => step.kind === 'agent')
  const agentCost = agents.reduce((sum, step) => sum + (step.cost ?? 0), 0)
  const handBacks = handBacksOf(turn, all, steps, ctx)
  const back = handBacks.reduce((sum, one) => sum + one.cost, 0)
  const split = turn.split && handBacks.every(one => one.split) ? handBacks.reduce((sum, one) => addSplit(sum, one.split as CostSplit), turn.split) : undefined
  return {
    main: Math.max(0, turn.cost - agentCost),
    agents,
    agentCost,
    handBacks,
    back,
    total: turn.cost + back,
    split: split && splitSum(split) > 0 ? split : undefined,
    unpriced: (turn.unpriced ?? 0) + handBacks.reduce((sum, one) => sum + (one.unpriced ?? 0), 0),
  }
}

// An edit tool's path, kept for the prompt's outcome once the call succeeded.
const noteEdit = async ($: EngineInterface, tool: string, raw: Record<string, unknown>, ran: { deny?: string; isError?: boolean }) => {
  const path = raw.file_path ?? raw.notebook_path
  if (!EDIT_TOOLS.includes(tool) || typeof path !== 'string' || ran.deny !== undefined || ran.isError) return
  await update($, context, ctx => ({ ...ctx, touched: [...new Set([...(ctx.touched ?? []), path])] }))
}

const readMessages = async ($: EngineInterface): Promise<readonly Message[] | null> => {
  try {
    return (await $.session.messages({ as: 'api' })) as readonly Message[]
  } catch {
    return null
  }
}

// A subagent's own conversation, or null where the session can't read it.
const readAgentMessages = async ($: EngineInterface, agentId: string): Promise<readonly Message[] | null> => {
  try {
    const found = await $.session.messages({ agentId, as: 'api' })
    return Array.isArray(found) ? (found as readonly Message[]) : null
  } catch {
    return null
  }
}

// The ledger names rows from the main agent's side ("Your messages"); in a subagent's
// conversation the first message is the main agent's task and the replies are its own.
const subagentParts = (parts: Record<PartKey, LedgerItem[]>): Record<PartKey, LedgerItem[]> => {
  const names: Record<string, string> = {
    'conversation:yours': 'Task from the main agent, and later messages to it',
    'conversation:mine': "The subagent's replies",
    'conversation:tool-inputs': "The subagent's tool requests",
  }
  return Object.fromEntries(
    PART_ORDER.map(part => [part, (parts[part] ?? []).map(item => (names[item.key] ? { ...item, name: names[item.key] ?? item.name } : item))]),
  ) as Record<PartKey, LedgerItem[]>
}

const patchTurn = ($: EngineInterface, id: string, change: (turn: Turn) => Turn) =>
  update($, turns, list => list.map(turn => (turn.id === id ? change(turn) : turn)))

// A step that turns failed or blocked (or stops being so) moves its prompt's problem totals.
const countStatus = async ($: EngineInterface, turnId: string, before: StepStatus | undefined, after: StepStatus | undefined) => {
  if (before === after || (!isProblemStatus(before) && !isProblemStatus(after))) return
  const failed = Number(after === 'failed') - Number(before === 'failed')
  const blocked = Number(after === 'blocked') - Number(before === 'blocked')
  await patchTurn($, turnId, turn => (turn.failed === undefined ? turn : { ...turn, failed: turn.failed + failed, blocked: (turn.blocked ?? 0) + blocked }))
}

// Past MAX_STEPS the oldest finished steps are dropped; a running one (a background
// agent) stays, so its later figures still land. Each prompt counts what it lost.
const addStep = async ($: EngineInterface, step: Step) => {
  const dropped: Record<string, number> = {}
  await update($, steps, list => {
    const next = [...list, step]
    let excess = next.length - MAX_STEPS
    for (const key of Object.keys(dropped)) delete dropped[key]
    if (excess <= 0) return next
    return next.filter(one => {
      if (excess <= 0 || one.status === 'running' || one === step) return true
      dropped[one.turnId] = (dropped[one.turnId] ?? 0) + 1
      excess -= 1
      return false
    })
  })
  await countStatus($, step.turnId, undefined, step.status)
  if (Object.keys(dropped).length) {
    await update($, turns, list => list.map(turn => (dropped[turn.id] ? { ...turn, evicted: (turn.evicted ?? 0) + (dropped[turn.id] ?? 0) } : turn)))
  }
}

const patchStep = async ($: EngineInterface, id: string, change: (step: Step) => Step) => {
  let before: StepStatus | undefined
  let after: Step | undefined
  await update($, steps, list =>
    list.map(step => {
      if (step.id !== id) return step
      before = step.status
      after = change(step)
      return after
    }),
  )
  const changed = after as Step | undefined
  if (changed) await countStatus($, changed.turnId, before, changed.status)
}

// The prompt an agent was started in: its work is counted there, whichever prompt runs now.
const ownerOf = async ($: EngineInterface, ctx: FlowContext, agentId: string) =>
  ctx.agentTurns?.[agentId] ?? (await read($, steps)).find(step => step.id === ctx.agents[agentId])?.turnId

// A problem inside a subagent, named in its card's details so the filter can show which call it was.
const withInner = (details: Detail[], text: string) =>
  details.filter(detail => detail.key === 'Problem inside').length >= MAX_INNER ? details : [...details, { key: 'Problem inside', value: clip(text, 160) }]

// How long the tool itself ran, without permission prompts or hooks.
const ranFor = async ($: EngineInterface, id: string | undefined, ms: number | undefined) => {
  if (!id || typeof ms !== 'number') return
  await update($, steps, list =>
    list.map(step =>
      step.id === id
        ? { ...step, runMs: ms }
        : step.agent?.callLog?.some(call => call.id === id)
          ? { ...step, agent: { ...step.agent, callLog: step.agent.callLog.map(call => (call.id === id ? { ...call, runMs: ms } : call)) } }
          : step,
    ),
  )
}

// One logged call on a subagent's card.
const patchCall = ($: EngineInterface, card: string, id: string, change: (call: AgentCall) => AgentCall) =>
  patchStep($, card, step => (step.agent ? { ...step, agent: { ...step.agent, callLog: step.agent.callLog?.map(call => (call.id === id ? change(call) : call)) } } : step))

const clearAll = async ($: EngineInterface) => {
  await update($, steps, () => [])
  await update($, turns, () => [])
  await update($, origins, () => [])
  await update($, atlas, () => [])
  await update($, view, () => ({ selected: null, open: [] }))
}

// A command that started in the background before its card tracked it: its output says so.
const untrackedBackground = (step: Step) => !step.background && step.kind === 'tool' && /^Command running in background with ID/.test(step.preview?.output ?? '')

// A turn that only delivers a background task's result is titled by the task's own summary.
const taskTitle = (text: string) => {
  const summary = text.match(/<task-notification>[\s\S]*?<summary>([^<]+)<\/summary>/)?.[1]?.trim()
  return summary ? clip(summary, 60) : undefined
}

// A task notification names the call that started a background command and how it ended.
const settleBackground = async ($: EngineInterface, text: string) => {
  if (!text.includes('<task-notification>')) return
  const at = await $.clock.now()
  for (const [block] of text.matchAll(/<task-notification>[\s\S]*?<\/task-notification>/g)) {
    const id = block.match(/<tool-use-id>([^<]+)<\/tool-use-id>/)?.[1]
    const ended = block.match(/<status>([^<]+)<\/status>/)?.[1]
    if (!id) continue
    await patchStep($, id, step => {
      if (!(step.background && step.status === 'running') && !untrackedBackground(step)) return step
      const ok = ended === 'completed'
      return {
        ...step,
        background: true,
        status: ok ? 'ok' : 'failed',
        end: at,
        label: ok ? step.label : ended === 'killed' ? 'Stopped' : 'Tool failed',
        sub: ok ? 'Finished in the background' : ended === 'killed' ? 'Stopped while running in the background' : 'Failed in the background',
      }
    })
  }
}

// Saved sessions live in one file each under the user's Claude Code folder; the store lists them.
let lastSaved = 0

const historyFile = async ($: EngineInterface, id: string) => {
  const home = await $.env.get('HOME')
  return home && /^[\w-]+$/.test(id) ? { dir: `${home}/.claude/agent-trace/history`, path: `${home}/.claude/agent-trace/history/${id}.json` } : undefined
}

const removeSaved = async ($: EngineInterface, id: string) => {
  const file = await historyFile($, id)
  if (file) await $.process.run(['rm', '-f', file.path])
}

const savedList = async ($: EngineInterface) => {
  const list = await $.store.get(SESSIONS_KEY)
  return Array.isArray(list) ? (list as HistoryEntry[]) : []
}

const setSavedList = async ($: EngineInterface, list: HistoryEntry[]) => {
  await $.store.set(SESSIONS_KEY, list)
  await update($, history, () => list)
}

// Writes the session's trace, masked, and lists it. A failed save never touches the session.
const saveTrace = async ($: EngineInterface, force = false) => {
  try {
    const now = await $.clock.now()
    if (!force && now - lastSaved < SAVE_EVERY_MS) return
    const allTurns = await read($, turns)
    const first = allTurns[0]
    if (!first) return
    const ctx = await read($, context)
    const id = ctx.historyId ?? (await $.session.id())
    const file = await historyFile($, id)
    if (!file) return
    lastSaved = now
    const allSteps = await read($, steps)
    const trace = redactDeep({ v: 1, id, savedAt: now, turns: allTurns, steps: allSteps, atlas: await read($, atlas), origins: await read($, origins), context: ctx }) as SavedTrace
    const text = fitTrace(trace)
    if (!text) return
    await $.process.run(['mkdir', '-p', '-m', '700', file.dir])
    await $.fs.write(file.path, text)
    const entry: HistoryEntry = {
      id,
      at: first.at,
      savedAt: now,
      title: redact(first.title),
      project: ctx.root?.split('/').pop(),
      prompts: allTurns.length,
      cost: allTurns.reduce((sum, one) => sum + one.cost, 0),
      unpriced: allTurns.reduce((sum, one) => sum + (one.unpriced ?? 0), 0) || undefined,
      problems: allTurns.reduce((sum, one) => sum + summaryOf(one, allSteps.filter(step => step.turnId === one.id)).problems, 0),
      ...entryFigures(allTurns, allSteps),
    }
    const others = (await savedList($)).filter(one => one.id !== id)
    await setSavedList($, [...others, entry].slice(-MAX_SESSIONS))
  } catch {
    // History is an extra; the live trace stands without it.
  }
}

// A saved file's trace, ready to draw: what was running when the session closed didn't finish.
const readSaved = async ($: EngineInterface, id: string): Promise<SavedTrace | undefined> => {
  const file = await historyFile($, id)
  if (!file) return undefined
  const trace = JSON.parse(String(await $.fs.read(file.path))) as SavedTrace
  if (!Array.isArray(trace.turns) || !Array.isArray(trace.steps) || trace.turns.length === 0) return undefined
  return {
    ...trace,
    atlas: trace.atlas ?? [],
    origins: trace.origins ?? [],
    turns: trace.turns.map(turn => (turn.status === 'running' ? { ...turn, status: 'failed', end: turn.end ?? trace.savedAt } : turn)),
    steps: trace.steps.map(step =>
      step.status === 'running'
        ? {
            ...step,
            status: 'failed',
            end: step.end ?? trace.savedAt,
            label: 'Not finished',
            sub: 'The session closed before this finished',
            agent: step.agent ? { ...step.agent, asking: undefined } : step.agent,
          }
        : step,
    ),
  }
}

// Entries saved before Analytics lack its figures: each file is opened once to fill them, one
// pass at a time. A file that won't open is given empty figures, so it isn't tried again.
let filling = false
const fillFigures = async ($: EngineInterface) => {
  if (filling) return
  filling = true
  try {
    const list = await savedList($)
    const missing = list.filter(needsFigures)
    if (missing.length === 0) return
    const filled = new Map<string, HistoryEntry>()
    for (const entry of missing) {
      const trace = await readSaved($, entry.id).catch(() => undefined)
      filled.set(entry.id, { ...entry, ...(trace ? entryFigures(trace.turns, trace.steps) : { models: {} }) })
    }
    // Read again, so a save made meanwhile is kept.
    await setSavedList($, (await savedList($)).map(one => filled.get(one.id) ?? one))
  } catch {
    // Analytics shows what it has; the next visit tries again.
  } finally {
    filling = false
  }
}

// At the start: older sessions go, the list loads, and a reopened session gets its own trace back.
const startHistory = async ($: EngineInterface) => {
  try {
    const now = await $.clock.now()
    const oldest = now - HISTORY_DAYS * 86_400_000
    const list = await savedList($)
    const kept = list.filter(one => one.savedAt >= oldest)
    for (const one of list) if (one.savedAt < oldest) await removeSaved($, one.id)
    if (kept.length !== list.length) await $.store.set(SESSIONS_KEY, kept)
    await update($, history, () => kept)
    const known = await read($, context)
    const id = known.historyId ?? (await $.session.id())
    await update($, context, ctx => ({ ...ctx, historyId: id }))
    if ((await read($, turns)).length > 0 || !kept.some(one => one.id === id)) return
    const own = await readSaved($, id)
    if (!own) return
    await update($, turns, () => own.turns)
    await update($, steps, () => own.steps)
    await update($, atlas, () => own.atlas)
    await update($, origins, () => own.origins)
    await update($, context, ctx => ({ ...own.context, ...ctx, agents: { ...own.context.agents, ...ctx.agents }, agentTurns: own.context.agentTurns, turnId: undefined, live: [] }))
  } catch {
    // A missing or damaged file leaves this session starting empty.
  }
}

const clearHistory = async ($: EngineInterface) => {
  const ctx = await read($, context)
  const ids = new Set([...(await savedList($)).map(one => one.id), ...(ctx.historyId ? [ctx.historyId] : [])])
  for (const id of ids) await removeSaved($, id)
  await $.store.delete(SESSIONS_KEY)
  await update($, history, () => [])
  await update($, archive, () => null)
  lastSaved = 0
}

// The starting context as rows: each part, then its largest items.
const contextFields = (parts: Record<PartKey, LedgerItem[]>, measured?: number): Partial<Step> => {
  const order = PART_ORDER.filter(part => partTokens(parts[part]) > 0).sort((a, b) => partTokens(parts[b]) - partTokens(parts[a]))
  const items: Row[] = []
  for (const part of order) {
    items.push({ name: PARTS[part].label, value: formatTokens(partTokens(parts[part])) })
    const top = [...parts[part]].sort((a, b) => b.tokens - a.tokens).slice(0, ITEMS_PER_PART)
    for (const item of top) {
      items.push({ name: `   ${item.name}${item.count ? ` ×${item.count}` : ''}`, value: formatTokens(item.tokens), status: item.status })
    }
  }
  const files = [...parts.instructions, ...parts.memory].map(item => item.name)
  const named = [...files, parts.skills.length > 0 ? 'skill list' : '', 'tool definitions'].filter(Boolean)
  const total = measured ?? PART_ORDER.reduce((sum, part) => sum + partTokens(parts[part]), 0)
  return { items, sub: clip(`System prompt, ${named.join(', ')}`, 90), added: total, ctx: measured }
}

// A hook shows as a step each time its text lands in the context again.
const addHookSteps = async ($: EngineInterface, turnId: string, parts: Record<PartKey, LedgerItem[]>, before: string) => {
  const counts = (await read($, context)).hookCounts
  const at = await $.clock.now()
  const next: Record<string, number> = {}
  for (const item of parts.hooks) {
    const times = item.count ?? 1
    next[item.key] = times
    if (times <= (counts[item.key] ?? 0)) continue
    const status = item.status
    await addStep($, {
      id: `hook-${before}-${item.key}`,
      turnId,
      kind: 'hook',
      title: item.name,
      sub: status ? 'The hook reported an error' : 'Text added to the context by a hook',
      status: status ?? 'ok',
      label: status ? 'Hook failed' : undefined,
      added: Math.round(item.tokens / times),
      details: [
        { key: 'Hook', value: item.name },
        { key: 'Seen', value: `${times} time${times > 1 ? 's' : ''} in this session` },
      ],
      at,
      end: at,
      q: { added: 'estimated' },
    })
  }
  await update($, context, ctx => ({ ...ctx, hookCounts: next }))
}

const kindOfTool = (tool: string): StepKind => (tool === 'Skill' ? 'skill' : tool === 'Agent' || tool === 'Task' ? 'agent' : 'tool')

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'agent-trace', description: 'Open the agent trace (/agent-trace clear resets it)' })
    const repo = await readRepo($)
    const root = await git($, ['rev-parse', '--show-toplevel'])
    await update($, context, ctx => ({ ...ctx, ...repo, root, agents: ctx.agents ?? {}, hookCounts: ctx.hookCounts ?? {} }))
    void refreshToday($)
    void refreshUsage($)
    await startHistory($)
    void $.ui.open({ id: PANE, title: TITLE })

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    await saveTrace($, true)
    return next(e)
  })

  on('command.run', { command: 'agent-trace' }, async ($, e) => {
    const args = String((e as { args?: string }).args ?? '').trim()
    if (args === 'clear') {
      await clearAll($)
      await clearHistory($)
    }
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: args === 'clear' ? 'Agent trace and its saved sessions cleared.' : 'Agent trace opened.' }
  })

  // A workflow command names the prompt it starts. Kept in state, not a module
  // variable, so a reload between submit and start doesn't lose it.
  on('prompt.submit', async ($, e, next) => {
    const pendingTitle = e.command ? clip(`/${e.command.name} ${e.command.args ?? ''}`.trim(), 60) : undefined
    await update($, context, ctx => ({ ...ctx, pendingTitle }))

    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.start', async ($, e, next) => {
    await settleBackground($, String(e.text ?? ''))
    // A subagent's turns aren't prompts: its work nests under its Agent step.
    if (!e.agentId) {
      const known = await read($, context)
      const pendingTitle = known.pendingTitle
      const title = pendingTitle ?? handBackTitle(e.text, known, await read($, steps)) ?? taskTitle(e.text) ?? cleanTitle(e.text)
      const at = await $.clock.now()
      const fresh: Turn = {
        id: e.turnId,
        title,
        status: 'running',
        requests: 0,
        cost: 0,
        at,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        calls: 0,
        subagents: 0,
        agentRequests: 0,
        failed: 0,
        blocked: 0,
        nested: 0,
        models: [],
        unpriced: 0,
        split: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
        handsBack: handBackIds(e.text).length ? handBackIds(e.text) : undefined,
      }
      await update($, turns, list => [...list, fresh].slice(-MAX_TURNS))
      const baseline = await numstat($)
      // An agent whose card has settled isn't running, even if its end was never heard: only
      // those still running keep holding the system prompt's snapshot back.
      const settled = new Set((await read($, steps)).filter(step => step.kind === 'agent' && step.status !== 'running').map(step => step.id))
      await update($, context, ctx => ({
        ...ctx,
        turnId: e.turnId,
        pendingTitle: undefined,
        baseline,
        touched: [],
        live: (ctx.live ?? []).filter(id => !settled.has(ctx.agents[id] ?? '')),
      }))
      await addStep($, {
        id: `prompt-${e.turnId}`,
        turnId: e.turnId,
        kind: 'prompt',
        title: `You sent “${title}”`,
        sub: pendingTitle !== undefined ? 'Slash command expands into its instructions' : 'Your message',
        added: tokensOf(e.text),
        details: [{ key: 'Tokens', value: `≈${formatTokens(tokensOf(e.text))}` }],
        at,
        end: at,
        q: { added: 'estimated' },
      })
    }

    return next(e)
  }).catch(($, e, next) => next(e))

  // Read-only: the sections pass through untouched; only their sizes are kept.
  // A composition doesn't say which loop it is for, so while a subagent runs it may be
  // the subagent's and is left alone; the main loop's last one stands, tagged by model.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    if ((await read($, context)).live?.length) return composed
    const at = await $.clock.now()
    await update($, prompt, () => ({
      model: e.model,
      at,
      sections: composed.sections.map(section => ({ id: section.id, scope: section.scope, tokens: Math.ceil(section.text.length / 4) })),
    }))

    return composed
  }).catch(($, e, next) => next(e))

  on('turn.step', async function* ($, e, next) {
    const ctx = await read($, context)
    const model = e.model.replace(/^claude-/, '')

    if (e.agentId) {
      const agentId = e.agentId
      const parent = ctx.agents[agentId]
      const nested = (ctx.nestedAgents ?? []).includes(agentId)
      const card = parent ? (await read($, steps)).find(step => step.id === parent) : undefined
      // Each request's messages are read before it goes out, as the main loop's are.
      const first = Boolean(card?.agent && !nested && !card.agent.log?.length)
      const messages = card?.agent ? await readAgentMessages($, agentId) : null
      const at = await $.clock.now()
      // In flight until its reply arrives, so the lifecycle can show it as it runs.
      if (parent) await patchStep($, parent, step => (step.agent ? { ...step, agent: { ...step.agent, asking: [...(step.agent.asking ?? []), at].slice(-MAX_LOG) } } : step))
      const settled = (asking: number[] | undefined) => {
        const left = (asking ?? []).filter(one => one !== at)
        return left.length ? left : undefined
      }
      let firstToken: number | undefined
      let result: TurnStepResult
      try {
        const stream = next(e)
        for await (const chunk of stream) {
          if (firstToken === undefined && chunk.kind !== 'engine') firstToken = await $.clock.now()
          yield chunk
        }
        result = await stream.result
      } catch (error) {
        // A request that failed is still one of its requests, with no counters to show.
        const end = await $.clock.now()
        if (parent) {
          const failed: AgentRequest = { at, end, model: e.model, messages: e.messageCount, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, failed: true, nested: nested || undefined }
          await patchStep($, parent, step => ({
            ...step,
            agent: step.agent
              ? { ...step.agent, requests: step.agent.requests + 1, log: [...(step.agent.log ?? []), failed].slice(-MAX_LOG), asking: settled(step.agent.asking) }
              : step.agent,
          }))
        }
        throw error
      }
      const end = await $.clock.now()
      const usage = result.usage
      // Unknown stays unknown: a request with no price adds nothing and is counted as unpriced.
      const split = usage ? costSplitOf(usage.model, usage) : undefined
      const cost = usage ? costOf(usage.model, usage) : undefined
      const unpriced = usage && cost === undefined ? 1 : 0
      const tokens = usage ? tokensFrom(usage) : undefined
      const tokensIn = tokens ? tokens.input + tokens.cacheRead + tokens.cacheWrite : 0
      // Sized from its messages' text and scaled to the measured input; the rest is what the
      // text can't show: its system prompt and tool definitions, never exposed per subagent.
      const sized = messages && tokensIn ? calibrate(subagentParts(classify(messages, new Map(), null)), tokensIn) : undefined
      const shown = sized && Object.fromEntries(Object.entries(condense(sized)).filter(([part, items]) => part !== 'other' && items.length))
      const sizes = shown && Object.fromEntries(Object.entries(shown).map(([part, items]) => [part, partTokens(items)]))
      // The rest of the measured input, so the parts and it always add up to what the API reported.
      const hidden = sizes ? Math.max(0, tokensIn - Object.values(sizes).reduce((sum, value) => sum + value, 0)) : undefined
      const loaded = first && shown && hidden !== undefined ? { total: tokensIn, parts: shown, hidden } : undefined
      const request: AgentRequest | undefined = tokens && {
        at,
        end,
        model: usage?.model ?? e.model,
        messages: e.messageCount,
        tokens,
        cost,
        split,
        nested: nested || undefined,
        firstToken,
        stopReason: result.stopReason ?? undefined,
        parts: sizes,
        hidden,
      }
      if (parent) {
        await patchStep($, parent, step => ({
          ...step,
          cost: cost === undefined ? step.cost : (step.cost ?? 0) + cost,
          unpriced: (step.unpriced ?? 0) + unpriced || undefined,
          tokens: tokens ? addTokens(step.tokens, tokens) : step.tokens,
          split: split ? addSplit(step.split, split) : step.split,
          agent: step.agent
            ? {
                ...step.agent,
                requests: step.agent.requests + 1,
                log: request ? [...(step.agent.log ?? []), request].slice(-MAX_LOG) : step.agent.log,
                loaded: step.agent.loaded ?? loaded,
                asking: settled(step.agent.asking),
              }
            : step.agent,
        }))
      }
      // The prompt that started the agent pays for it, even once a later prompt is running.
      const owner = await ownerOf($, ctx, agentId)
      if (owner && tokens) {
        await patchTurn($, owner, turn => ({
          ...turn,
          cost: turn.cost + (cost ?? 0),
          unpriced: (turn.unpriced ?? 0) + unpriced,
          tokens: turn.tokens ? addTokens(turn.tokens, tokens) : turn.tokens,
          agentRequests: turn.agentRequests === undefined ? undefined : turn.agentRequests + 1,
          split: split && turn.split ? addSplit(turn.split, split) : turn.split,
        }))
      }
      void saveTrace($)
      return result
    }

    const turnId = ctx.turnId ?? e.turnId
    const number = ((await read($, turns)).find(turn => turn.id === turnId)?.requests ?? 0) + 1
    const id = `model-${e.turnId}-${e.index}`
    // Read before the request goes out: these are the messages it sends. The system prompt's
    // snapshot counts only when it was composed for this request's model.
    const messages = await readMessages($)
    const system = await read($, prompt)
    const parts = messages ? classify(messages, new Map(), system && system.model === e.model ? system : null) : null
    const contextId = number === 1 && parts ? `context-${id}` : undefined
    const at = await $.clock.now()
    if (parts && contextId) {
      await addStep($, {
        id: contextId,
        turnId,
        kind: 'context',
        title: 'Claude Code packed the context',
        details: [{ key: 'What this is', value: 'Everything sent with your prompt before the model starts' }],
        at,
        end: at,
        q: { added: 'estimated' },
        ...contextFields(parts),
      })
      await update($, context, value => ({
        ...value,
        hookCounts: Object.fromEntries(parts.hooks.map(item => [item.key, item.count ?? 1])),
      }))
    } else if (parts) {
      await addHookSteps($, turnId, parts, id)
    }
    await addStep($, {
      id,
      turnId,
      kind: 'model',
      title: `Request ${number} · ${model}`,
      sub: 'Waiting for the model',
      status: 'running',
      details: [],
      at,
      model: e.model,
      effort: e.effort,
      q: { time: 'observed', tokens: 'observed', cost: 'estimated', added: 'observed' },
    })
    const short = e.model.replace(/^claude-/, '')
    await patchTurn($, turnId, turn => ({ ...turn, requests: number, models: turn.models && !turn.models.includes(short) ? [...turn.models, short] : turn.models }))

    try {
      // Each chunk passes on as it came; the mod only notes when the first one with content arrived.
      const stream = next(e)
      let first: number | undefined
      for await (const chunk of stream) {
        if (first === undefined && chunk.kind !== 'engine') first = await $.clock.now()
        yield chunk
      }
      const result = await stream.result
      const end = await $.clock.now()
      const usage = result.usage
      const tokens = usage ? tokensFrom(usage) : undefined
      const tokensIn = tokens ? tokens.input + tokens.cacheRead + tokens.cacheWrite : 0
      const cached = tokensIn ? Math.round(((tokens?.cacheRead ?? 0) / tokensIn) * 100) : 0
      const out = tokens?.output ?? 0
      const cost = usage ? costOf(usage.model, usage) : undefined
      const split = usage ? costSplitOf(usage.model, usage) : undefined
      const unpriced = usage && cost === undefined ? 1 : 0
      const calls = result.toolUses.length
      const outcome = calls > 0 ? `asked for ${calls} tool call${calls > 1 ? 's' : ''}` : 'wrote the answer'
      const server = result.serverToolUses ?? []
      await patchStep($, id, step => ({
        ...step,
        sub: `${formatTokens(tokensIn)} in (${cached}% cached) · ${formatTokens(out)} out · ${outcome}`,
        status: result.stopReason === 'refusal' ? 'failed' : 'ok',
        label: result.stopReason === 'refusal' ? 'Refused' : undefined,
        cost,
        split,
        unpriced: unpriced || undefined,
        q: { ...step.q, cost: unpriced ? 'unavailable' : 'estimated' },
        // What it wrote joins the context; its own measure (ctx) already holds what it read.
        added: out,
        ctx: tokensIn,
        end,
        firstToken: first,
        tokens,
        stopReason: result.stopReason ?? undefined,
        model: usage?.model ?? step.model,
        details: [
          { key: 'Input', value: `${formatTokens(tokensIn)} tokens: ${formatTokens(tokens?.input ?? 0)} new, ${formatTokens(tokens?.cacheRead ?? 0)} from cache, ${formatTokens(tokens?.cacheWrite ?? 0)} written to cache` },
          { key: 'Output', value: `${formatTokens(out)} tokens` },
          { key: 'Cost', value: cost === undefined ? `Not available: no API price is known for ${usage?.model ?? e.model}` : `${formatCost(cost)} (API-rate estimate)` },
          ...(e.effort !== undefined ? [{ key: 'Effort', value: String(e.effort) }] : []),
          ...(result.stopReason ? [{ key: 'Stopped', value: result.stopReason }] : []),
          ...server.map(use => ({ key: 'Server tool', value: `${use.name}${use.endedAt ? ` · ${duration(use.endedAt - use.startedAt)}` : ''}` })),
        ],
      }))
      // Claude Code's own /context categories, once per request (a local estimate, never a
      // token count), size the tool definitions the text can't show; the rest stays unattributed.
      const native = await refreshUsage($, true)
      const sized = parts && tokensIn ? calibrate(parts, tokensIn, nativeTools(native)) : undefined
      if (contextId && sized) {
        await patchStep($, contextId, step => ({ ...step, ...contextFields(sized, tokensIn) }))
      }
      if (sized) {
        const parts = Object.fromEntries(PART_ORDER.map(part => [part, partTokens(sized[part])]).filter(([, tokens]) => tokens))
        await patchStep($, id, step => ({ ...step, parts }))
      }
      // The atlas keeps each prompt's latest request, and how big each part was the request before.
      if (sized) {
        await update($, atlas, list => {
          const last = list.at(-1)
          const before = last ? Object.fromEntries(PART_ORDER.map(part => [part, partTokens(last.parts[part])])) : undefined
          const snapshot: AtlasSnapshot = {
            turnId,
            stepId: id,
            at: end,
            total: tokensIn,
            cacheRead: tokens?.cacheRead ?? 0,
            cacheWrite: tokens?.cacheWrite ?? 0,
            parts: condense(sized),
            before,
            native,
          }
          return [...list.filter(one => one.turnId !== turnId), snapshot].slice(-MAX_TURNS)
        })
      }
      await patchTurn($, turnId, turn => ({
        ...turn,
        cost: turn.cost + (cost ?? 0),
        unpriced: (turn.unpriced ?? 0) + unpriced,
        tokens: turn.tokens && tokens ? addTokens(turn.tokens, tokens) : turn.tokens,
        split: turn.split && split ? addSplit(turn.split, split) : turn.split,
      }))
      void saveTrace($)

      return result
    } catch (error) {
      const end = await $.clock.now()
      await patchStep($, id, step => ({ ...step, status: 'failed', label: 'Request failed', sub: clip(String(error), 120), end }))
      throw error
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    if (spawned.agentId) {
      const agentId = spawned.agentId
      const known = await read($, context)
      // A subagent's own subagent rolls up into the top-level card that started the chain.
      const ancestor = e.parentAgentId ? known.agents[e.parentAgentId] : undefined
      const card = (await read($, steps)).find(step => step.id === e.tool_use_id)
      // The prompt that started the chain keeps its cost, whichever prompt is running when it ends.
      const owner = (e.parentAgentId ? known.agentTurns?.[e.parentAgentId] : undefined) ?? card?.turnId
      // Only agents with a card here are tracked as running (a workflow's or a plugin's has none).
      const tracked = Boolean(ancestor ?? card)
      const recent = (list: string[] | undefined, id: string) => [...(list ?? []).filter(one => one !== id), id].slice(-MAX_AGENTS)
      await update($, context, ctx => ({
        ...ctx,
        agents: Object.fromEntries([...Object.entries(ctx.agents), [agentId, ancestor ?? e.tool_use_id]].slice(-MAX_AGENTS)),
        agentTurns: owner ? Object.fromEntries([...Object.entries(ctx.agentTurns ?? {}), [agentId, owner]].slice(-MAX_AGENTS)) : ctx.agentTurns,
        nestedAgents: ancestor ? recent(ctx.nestedAgents, agentId) : ctx.nestedAgents,
        live: tracked ? recent(ctx.live, agentId) : ctx.live,
      }))
      if (ancestor) {
        await patchStep($, ancestor, step => ({
          ...step,
          agent: step.agent
            ? { ...step.agent, children: [...(step.agent.children ?? []), { id: agentId, type: e.subagentType, task: clip(e.description, 80), state: 'running' as const }] }
            : step.agent,
        }))
      } else {
        await patchStep($, e.tool_use_id, step => {
          // Heard after its Agent call returned: a background agent is launched, not finished.
          const relaunch = Boolean(e.background && step.status === 'ok' && step.agent && !step.agent.ended)
          return {
            ...step,
            model: spawned.model,
            agent: step.agent
              ? { ...step.agent, id: agentId, background: e.background || undefined, launched: relaunch || step.agent.launched, handoff: tokensOf(e.prompt) }
              : step.agent,
            preview: { ...step.preview, input: preview(e.prompt) },
            ...(relaunch ? { status: 'running' as const, end: undefined, sub: 'Running in the background' } : {}),
          }
        })
      }
    }

    return spawned
  }).catch(($, e, next) => next(e))

  // Observing only: the verdict passes through as it was reached.
  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const id = e.tool_use_id
    if (verdict.decision === 'ask' && id) {
      await update($, context, ctx => ({ ...ctx, asked: [...(ctx.asked ?? []), id].slice(-MAX_ASKED) }))
    }

    return verdict
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUse', async ($, e, next) => {
    const result = await next(e)
    await ranFor($, e.tool_use_id, e.duration_ms)

    return result
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUseFailure', async ($, e, next) => {
    const result = await next(e)
    await ranFor($, e.tool_use_id, e.duration_ms)

    return result
  }).catch(($, e, next) => next(e))

  on('tool.call', async ($, e, next) => {
    const raw = e as unknown as Record<string, unknown>
    const tool = String(e.tool)
    const detail = detailOf(raw)
    const ctx = await read($, context)

    // A subagent's calls are listed inside its card. A failed or blocked one is a problem the
    // subagent met: counted once on its card and once in its prompt's totals, whatever the
    // subagent's own outcome turns out to be.
    if (e.agentId) {
      const parent = ctx.agents[e.agentId]
      const nested = (ctx.nestedAgents ?? []).includes(e.agentId)
      // Logged as it starts, so the tool's own run time (PostToolUse) finds it.
      const callId = e.tool_use_id ?? `${tool}-${await $.clock.now()}`
      const started: AgentCall = { id: callId, at: await $.clock.now(), name: tool, status: 'running', nested: nested || undefined, detail: detail || undefined }
      if (parent) {
        await patchStep($, parent, step => (step.agent ? { ...step, agent: { ...step.agent, callLog: [...(step.agent.callLog ?? []), started].slice(-MAX_LOG) } } : step))
      }
      let ran: Awaited<ReturnType<typeof next>>
      try {
        ran = await next(e)
      } catch (error) {
        const end = await $.clock.now()
        if (parent) await patchCall($, parent, callId, call => ({ ...call, end, status: 'failed' }))
        throw error
      }
      await noteEdit($, tool, raw, ran)
      const status: 'failed' | 'blocked' | undefined = ran.deny !== undefined ? 'blocked' : ran.isError ? 'failed' : undefined
      if (parent) {
        const end = await $.clock.now()
        const asked = ((await read($, context)).asked ?? []).includes(callId)
        await patchStep($, parent, step => ({
          ...step,
          agent: step.agent
            ? {
                ...step.agent,
                callLog: step.agent.callLog?.map(call =>
                  call.id === callId ? { ...call, end, status: status ?? 'ok', added: ran.deny === undefined ? tokensOf(ran.text) : undefined, asked: asked || undefined } : call,
                ),
                calls: step.agent.calls + 1,
                problems: step.agent.problems + (status ? 1 : 0),
                failed: (step.agent.failed ?? 0) + Number(status === 'failed') || undefined,
                blocked: (step.agent.blocked ?? 0) + Number(status === 'blocked') || undefined,
              }
            : step.agent,
          nest: [...(step.nest ?? []), { name: clip(`${tool} ${detail}`.trim(), 60), value: status ?? formatTokens(tokensOf(ran.text)), status }].slice(-MAX_NEST),
          details: status
            ? withInner(step.details, `${tool}${detail ? ` ${detail}` : ''} ${status === 'blocked' ? 'was blocked' : 'failed'}: ${firstSentence(ran.deny ?? ran.text ?? '')}`)
            : step.details,
        }))
      }
      if (status) {
        const owner = await ownerOf($, ctx, e.agentId)
        if (owner) await patchTurn($, owner, turn => (turn.nested === undefined ? turn : { ...turn, nested: turn.nested + 1 }))
      }
      return ran
    }
    if (!ctx.turnId) return next(e)

    const kind = kindOfTool(tool)
    const check = tool === 'Bash' ? CHECK_PATTERNS.find(([pattern]) => pattern.test(detail))?.[1] : undefined
    const at = await $.clock.now()
    const id = e.tool_use_id ?? `${tool}-${at}`
    const title =
      kind === 'skill'
        ? `Loaded skill: ${detail || 'skill'}`
        : kind === 'agent'
          ? `Subagent · ${String(raw.subagent_type ?? 'general')}`
          : `${check ?? tool} · ${clip(detail, 60)}`
    await addStep($, {
      id,
      turnId: ctx.turnId,
      kind,
      title,
      sub: kind === 'agent' ? clip(detail, 80) || 'Working in its own context' : 'Running',
      status: 'running',
      // A Bash command keeps its own line breaks and is laid out one chained command to a line; it is drawn as a code block.
      details:
        detail && kind !== 'skill'
          ? [
              kind === 'tool'
                ? { key: 'Command', value: tool === 'Bash' && typeof raw.command === 'string' ? formatCommand(raw.command) : detail, code: true, language: tool === 'Bash' ? 'bash' : undefined }
                : { key: 'Task', value: detail },
            ]
          : [],
      at,
      preview: { input: kind === 'agent' ? undefined : preview(argsOf(raw)) },
      agent: kind === 'agent' ? { type: String(raw.subagent_type ?? 'general'), requests: 0, calls: 0, problems: 0 } : undefined,
      q: { time: 'observed', added: 'estimated', cost: 'estimated' },
    })
    await patchTurn($, ctx.turnId, turn => ({
      ...turn,
      calls: turn.calls === undefined ? undefined : turn.calls + 1,
      subagents: turn.subagents === undefined ? undefined : turn.subagents + Number(kind === 'agent'),
    }))

    // Closing fields every outcome shares: when it ended, whether a permission check asked first.
    const closing = async () => {
      const end = await $.clock.now()
      const asked = ((await read($, context)).asked ?? []).includes(id)
      return { end, asked }
    }

    try {
      const ran = await next(e)
      await noteEdit($, tool, raw, ran)
      const added = tokensOf(ran.text)
      const close = await closing()
      const output = kind === 'agent' ? undefined : preview(ran.deny ?? ran.text)
      if (ran.deny !== undefined) {
        await patchStep($, id, step => ({
          ...step,
          ...close,
          status: 'blocked',
          label: 'Blocked by hook',
          sub: 'Stopped before it ran',
          preview: { ...step.preview, output },
          details: [...step.details, { key: 'Why', value: firstSentence(ran.deny ?? '') }],
        }))
      } else if (ran.isError) {
        await patchStep($, id, step => ({
          ...step,
          ...close,
          status: 'failed',
          label: check ? 'Check failed' : kind === 'agent' ? 'Subagent failed' : 'Tool failed',
          sub: firstSentence(ran.text ?? 'Failed'),
          added,
          preview: { ...step.preview, output },
          details: [...step.details, { key: 'Why', value: firstSentence(ran.text ?? '') }, { key: 'Tokens', value: `≈${formatTokens(added)}` }],
        }))
      } else if (kind === 'agent') {
        // The call's end is not always the agent's: a background agent's call returns once it
        // has started (`async_launched`), and its run ends with its own turn.complete.
        const record = (ran.result ?? {}) as { status?: string }
        const remote = record.status === 'remote_launched'
        await patchStep($, id, step => {
          const launched = !remote && !step.agent?.ended && (record.status === 'async_launched' || raw.run_in_background === true || Boolean(step.agent?.background))
          return {
            ...step,
            asked: close.asked,
            // A known failure (the agent stopped) is never overwritten by the call's success.
            status: isProblem(step) ? step.status : launched ? 'running' : 'ok',
            end: launched ? step.end : Math.max(close.end, step.end ?? 0),
            sub: isProblem(step)
              ? step.sub
              : remote
                ? 'Started in a cloud session; its run is not traced here'
                : launched
                  ? 'Running in the background'
                  : 'Report returned to you',
            added,
            agent: step.agent ? { ...step.agent, launched: launched || undefined } : step.agent,
            details: [
              ...step.details,
              launched
                ? { key: 'Launched', value: `The call returned once the agent started (≈${formatTokens(added)} added to your context); its run goes on` }
                : { key: 'Report', value: `≈${formatTokens(added)} added to your context` },
            ],
          }
        })
      } else if (kind === 'tool' && (raw.run_in_background === true || (ran.result as { backgroundTaskId?: string } | undefined)?.backgroundTaskId)) {
        // A background command's call returns once it has started; a task notification ends it.
        await patchStep($, id, step => ({
          ...step,
          background: true,
          sub: 'Running in the background',
          added,
          preview: { ...step.preview, output: output ?? step.preview?.output },
          details: [...step.details, { key: 'Started', value: `The call returned once the command started (≈${formatTokens(added)} added to your context); it goes on` }],
        }))
      } else {
        await patchStep($, id, step => ({
          ...step,
          ...close,
          status: 'ok',
          sub: kind === 'skill' ? 'Skill instructions are now in the context' : 'Result added to the context',
          added,
          preview: { ...step.preview, output: output ?? step.preview?.output },
          details: [...step.details, { key: 'Tokens', value: `≈${formatTokens(added)} added to your context` }],
        }))
      }

      return ran
    } catch (error) {
      const close = await closing()
      await patchStep($, id, step => ({ ...step, ...close, status: 'failed', label: kind === 'agent' ? 'Subagent failed' : 'Tool failed', sub: clip(String(error), 120) }))
      throw error
    }
    // A tracer that fails open: a broken trace never blocks a tool.
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    const at = await $.clock.now()
    if (e.agentId) {
      // A subagent's run ended: here, not when its Agent call returned, for one in the background.
      const agentId = e.agentId
      const ctx = await read($, context)
      const parent = ctx.agents[agentId]
      const ended = e.isAborted || e.reason === 'error'
      await update($, context, value => ({ ...value, live: (value.live ?? []).filter(one => one !== agentId) }))
      if (parent && (ctx.nestedAgents ?? []).includes(agentId)) {
        // A nested subagent: its state shows under the chain's card; one that stopped is a problem met inside.
        await patchStep($, parent, step => {
          const child = step.agent?.children?.find(one => one.id === agentId)
          return {
            ...step,
            agent: step.agent
              ? {
                  ...step.agent,
                  children: step.agent.children?.map(one => (one.id === agentId ? { ...one, state: ended ? ('stopped' as const) : ('done' as const) } : one)),
                  reported: e.usage ? addTokens(step.agent.reported, tokensFrom(e.usage)) : step.agent.reported,
                  problems: step.agent.problems + Number(ended),
                  failed: (step.agent.failed ?? 0) + Number(ended) || undefined,
                }
              : step.agent,
            details: ended ? withInner(step.details, `${child?.type ?? 'nested'} subagent ${e.isAborted ? 'was stopped' : 'ended with an error'}`) : step.details,
          }
        })
        if (ended) {
          const owner = await ownerOf($, ctx, agentId)
          if (owner) await patchTurn($, owner, turn => (turn.nested === undefined ? turn : { ...turn, nested: turn.nested + 1 }))
        }
      } else if (parent) {
        await patchStep($, parent, step => {
          const known = isProblem(step)
          // A background agent finishing settles its card; a foreground one's call returns next and settles it.
          const settles = !ended && step.status === 'running' && Boolean(step.agent?.launched)
          return {
            ...step,
            end: Math.max(step.end ?? at, at),
            status: ended ? (known ? step.status : 'failed') : settles ? 'ok' : step.status,
            label: ended && !known ? (e.isAborted ? 'Subagent stopped' : 'Subagent failed') : step.label,
            sub: ended && !known ? (e.isAborted ? 'Stopped before it finished' : 'Ended with an error') : settles ? `Finished in the background; its ≈${formatTokens(tokensOf(e.answer))}-token report was delivered to you in a later prompt` : step.sub,
            agent: step.agent
              ? {
                  ...step.agent,
                  ended: true,
                  reported: e.usage ? addTokens(step.agent.reported, tokensFrom(e.usage)) : step.agent.reported,
                  report: ended ? step.agent.report : tokensOf(e.answer),
                  ranMs: e.durationMs,
                  asking: undefined,
                }
              : step.agent,
            preview: { ...step.preview, output: preview(e.answer) },
            details: [...step.details.filter(detail => detail.key !== 'Ran for'), { key: 'Ran for', value: duration(e.durationMs) }],
          }
        })
        // The prompt that started it runs until its last subagent ends, not only until its answer.
        const owner = await ownerOf($, ctx, agentId)
        if (owner) await patchTurn($, owner, turn => ({ ...turn, agentsEnd: Math.max(turn.agentsEnd ?? at, at) }))
      }
      return result
    }

    const turn = (await read($, turns)).find(one => one.id === e.turnId)
    await patchTurn($, e.turnId, one => ({
      ...one,
      status: e.isAborted ? 'failed' : 'done',
      end: at,
      durationMs: e.durationMs,
      reason: e.reason,
      reported: e.usage ? tokensFrom(e.usage) : undefined,
      answer: preview(e.answer),
    }))
    await addStep($, {
      id: `done-${e.turnId}`,
      turnId: e.turnId,
      kind: 'done',
      title: e.isAborted ? 'Stopped before the answer' : 'Answer ready',
      sub: `${plural(turn?.requests ?? 0, 'model request')} · ${costText(turn?.cost, turn?.unpriced)} for this prompt`,
      status: e.isAborted ? 'failed' : 'ok',
      label: e.isAborted ? 'Stopped' : undefined,
      details: [{ key: 'Prompt total', value: `${costText(turn?.cost, turn?.unpriced)} including subagents so far` }],
      at,
      end: at,
    })
    await refreshToday($)
    await refreshUsage($)

    // What the prompt changed in the repository.
    try {
      const ctx = await read($, context)
      const after = ctx.baseline ? await numstat($) : undefined
      if (ctx.baseline && after) {
        const outcome = outcomeOf(ctx.baseline, after, ctx.touched ?? [], ctx.root)
        await patchTurn($, e.turnId, one => ({ ...one, outcome }))
      }
    } catch {
      // The outcome is an extra; the trace stands without it.
    }
    await saveTrace($, true)

    return result
  })

  // A compaction shows as a step with the sizes Claude Code reports before and after.
  on('session.compact', async ($, e, next) => {
    const at = await $.clock.now()
    const done = await next(e)
    const turnId = (await read($, context)).turnId
    if (!e.agentId && e.trigger !== 'precompute' && done.messages && turnId) {
      const end = await $.clock.now()
      const sizes =
        done.tokensBefore !== undefined && done.tokensAfter !== undefined
          ? `${formatTokens(done.tokensBefore)} → ${formatTokens(done.tokensAfter)}`
          : 'Sizes not reported'
      await addStep($, {
        id: `compact-${turnId}-${at}`,
        turnId,
        kind: 'compact',
        title: e.trigger === 'manual' ? 'You compacted the conversation' : 'Claude Code compacted the conversation',
        sub: sizes,
        status: 'ok',
        ctx: done.tokensAfter,
        at,
        end,
        details: [
          { key: 'Trigger', value: e.trigger },
          ...(done.tokensBefore !== undefined ? [{ key: 'Before', value: `${formatTokens(done.tokensBefore)} tokens` }] : []),
          ...(done.tokensAfter !== undefined ? [{ key: 'After', value: `${formatTokens(done.tokensAfter)} tokens` }] : []),
          ...(done.usage ? [{ key: 'Summary request', value: `${formatTokens(done.usage.input_tokens + done.usage.cache_read_input_tokens)} in · ${formatTokens(done.usage.output_tokens)} out` }] : []),
        ],
        q: { time: 'observed', tokens: 'observed' },
      })
    }

    return done
  }).catch(($, e, next) => next(e))

  // Read-only: each row passes untouched. Only its route, who caused it and its
  // size are kept, for the context atlas.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    await settleBackground($, JSON.stringify(e.message.content ?? ''))
    // Only rows a request carries; a notice never reaches the model.
    const type = e.message.type
    if (e.message.role || type === 'user' || type === 'assistant') {
      const origin = (e.origin ?? {}) as unknown as Record<string, unknown>
      const row: Origin = {
        at: await $.clock.now(),
        turnId: (await read($, context)).turnId,
        agentId: e.agentId,
        // A plugin's own append is filed as a note beneath the hooks, so it may arrive without a door.
        door: e.door ?? 'note',
        by: String(origin.kind ?? 'unknown'),
        name: e.message.name ?? originName(origin),
        tokens: Math.ceil(charsOf(e.message.content) / 4),
      }
      await update($, origins, list => [...list, row].slice(-MAX_ORIGINS))
    }

    return stored
  }).catch(($, e, next) => next(e))


  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Text, Button, Code } = elements
    // The terminal has no Svg; it draws the bars as text. Mobile has no fields yet.
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined
    const Input = 'Input' in elements ? elements.Input : undefined
    // A border takes a whole cell in the terminal and a hairline elsewhere, so offsets that line up with a card's content differ.
    const edge = e.surface === 'terminal' ? 1 : 0
    // VS Code draws every Button as a native bordered button, so a segment there is not boxed again.
    const native = e.surface === 'vscode'
    // Elsewhere a Box with no border color takes the editor's own hairline, quieter than any theme key.
    const hairline = edge ? LINE : undefined
    // Cards are rounded with the editor's hairline. No background fills: VS Code's theme keys for
    // backgrounds (background, userMessageBackground) come out tinted in some themes.
    const surface = edge ? { borderStyle: 'round', borderColor: LINE } : { borderStyle: 'round' }
    const page = { paddingX: 1, paddingY: 0 }
    // A step card's inset: whole cells in the terminal, half a line and a cell and a half elsewhere.
    const inset = edge ? { paddingX: 1, paddingY: 0 } : { paddingX: 1.5, paddingY: 0.5 }
    // Every Box with paddingX also states paddingY: VS Code otherwise pads it top and bottom as well.
    // A status pill: rounded where the surface can round it, a filled label in the terminal.
    const pill = (key: string, text: string, bg: string) =>
      edge ? (
        <Text key={key} bold color={BADGE} backgroundColor={bg}>
          {` ${text.trim()} `}
        </Text>
      ) : (
        <Box key={key} flexShrink={0} borderStyle="round" borderColor={bg} backgroundColor={bg} paddingX={1} paddingY={0}>
          <Text bold color={BADGE}>
            {text.trim()}
          </Text>
        </Box>
      )
    // Every status label (Done, Failed, Blocked by hook…) is drawn as the header's status is: an
    // outlined, rounded pill in its own color off the terminal, a filled label on it.
    const badge = (key: string, text: string, color: string) =>
      edge ? (
        <Text key={key} bold color={BADGE} backgroundColor={color}>
          {` ${text.trim()} `}
        </Text>
      ) : (
        <Box key={key} flexShrink={0} borderStyle="round" borderColor={color} paddingX={0.5} paddingY={0}>
          <Text bold color={color}>
            {text.trim()}
          </Text>
        </Box>
      )
    // An opened earlier session stands in for the live one everywhere the pane draws from.
    const saved = await read($, archive)
    const liveCtx = await read($, context)
    const ctx = saved ? { ...liveCtx, ...saved.context } : liveCtx
    const state = await read($, view)
    const allTurns = saved?.turns ?? (await read($, turns))
    const allSteps = saved?.steps ?? (await read($, steps))
    const day = await read($, today)

    const turn = allTurns.find(one => one.id === state.selected) ?? allTurns.at(-1)
    const setView = (change: Partial<FlowView>) => void update($, view, value => ({ ...value, ...change }))

    const openSaved = async (id: string) => {
      try {
        const trace = await readSaved($, id)
        if (!trace) throw new Error('empty')
        await update($, archive, () => trace)
        await update($, view, value => ({ ...value, selected: null, open: [], mode: 'inspect' }))
      } catch (error) {
        // Only a file that has gone leaves the list; any other failure says why and keeps the session.
        const file = await historyFile($, id)
        if (file && !(await $.fs.exists(file.path))) {
          await setSavedList($, (await savedList($)).filter(one => one.id !== id))
          await $.ui.toast('That saved session\'s file is gone, so it was removed from the list.')
        } else {
          await $.ui.toast(clip(`Couldn't open that saved session: ${String(error)}`, 160))
        }
      }
    }
    const closeSaved = async () => {
      await update($, archive, () => null)
      await update($, view, value => ({ ...value, selected: null, open: [], mode: 'runs' }))
    }

    // Earlier sessions, newest first, by day: the Prompts view's second card, and all there is to
    // show before a new session's first prompt.
    // Read fresh, so another session's save shows on the next redraw; the atom redraws on this session's own.
    await read($, history)
    const earlierList = (await savedList($).catch(() => [])).filter(one => one.id !== liveCtx.historyId && one.id !== saved?.id).sort((a, b) => b.at - a.at)
    const historyNow = await $.clock.now()
    const dayLabel = (ms: number) => {
      const date = new Date(ms).toLocaleDateString('en', { month: 'short', day: 'numeric' })
      if (dayOf(ms) === dayOf(historyNow)) return `Today · ${date}`
      return dayOf(ms) === dayOf(historyNow - 86_400_000) ? `Yesterday · ${date}` : date
    }
    const historyNarrow = e.props.bodyColumns < 40
    const earlierCard =
      earlierList.length > 0 ? (
        <Box key="history:card" flexDirection="column" marginTop={1} {...surface} paddingX={2} paddingY={1}>
          <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" columnGap={2}>
            <Text bold color={INK}>
              Earlier sessions
            </Text>
            <Text color={MUTED}>{`${plural(earlierList.length, 'session')} · kept ${HISTORY_DAYS} days`}</Text>
          </Box>
          <Box flexDirection="column" marginTop={1} rowGap={edge ? 0 : 0.5}>
            {earlierList.map((one, at) => {
              const heading = at === 0 || dayLabel(one.at) !== dayLabel(earlierList[at - 1]?.at ?? 0) ? dayLabel(one.at) : ''
              const meta = [clock(one.at), one.project, plural(one.prompts, 'prompt'), historyNarrow ? costText(one.cost, one.unpriced) : '', one.problems ? plural(one.problems, 'problem') : ''].filter(Boolean).join(' · ')
              return (
                <Box key={`history-row:${one.id}`} flexDirection="column">
                  {heading ? (
                    <Text bold color={MUTED}>
                      {heading}
                    </Text>
                  ) : null}
                  <Box flexDirection="row" flexWrap="nowrap" alignItems="center" gap={1}>
                    <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                      <Text color={INK} wrap="truncate-end">
                        {one.title}
                      </Text>
                      <Text color={MUTED} wrap="truncate-end">
                        {meta}
                      </Text>
                    </Box>
                    {historyNarrow ? null : (
                      <Box flexShrink={0}>
                        <Text color={INK}>{costText(one.cost, one.unpriced)}</Text>
                      </Box>
                    )}
                    <Button key={`history:${one.id}`} plain dimColor onPress={() => void openSaved(one.id)}>
                      ›
                    </Button>
                  </Box>
                </Box>
              )
            })}
          </Box>
        </Box>
      ) : null

    if (!turn) {
      return (
        <Box flexDirection="column" {...page}>
          <Text bold>{`${ctx.story ? `${ctx.story} · ` : ''}Agent trace`}</Text>
          <Text color={MUTED}>Nothing yet. Send a prompt and each step shows here as it happens.</Text>
          {earlierCard}
        </Box>
      )
    }

    const mode = state.mode ?? 'inspect'
    const filter = state.filter ?? 'all'
    const query = (state.query ?? '').trim().toLowerCase()
    const flow = allSteps.filter(step => step.turnId === turn.id)
    const earlier = allSteps.filter(step => step.turnId !== turn.id && step.at < turn.at && step.ctx)
    // The context now: the last measured total plus what was added since.
    let running = earlier.at(-1)?.ctx ?? 0
    for (const step of flow) running = step.ctx ?? running + (step.kind === 'context' ? 0 : (step.added ?? 0))
    const measured = [...flow].reverse().find(step => step.kind === 'model' && step.ctx)?.ctx ?? running
    // Problems include those met inside a subagent, counted once each on the card that holds them.
    const failed = flow.filter(step => step.status === 'failed').length + flow.reduce((sum, step) => sum + innerOf(step).failed, 0)
    const blocked = flow.filter(step => step.status === 'blocked').length + flow.reduce((sum, step) => sum + innerOf(step).blocked, 0)
    const position = allTurns.findIndex(one => one.id === turn.id)
    // Stepping onto the newest prompt follows it live again.
    const go = (direction: number) => {
      const target = allTurns[position + direction]
      if (target) setView({ selected: target === allTurns.at(-1) ? null : target.id, open: [] })
    }

    // Wide panes show the details beside the list, one step at a time.
    const body = e.props.bodyColumns
    const wide = body >= WIDE
    const toggle = (id: string) =>
      wide
        ? setView({ open: state.open.at(-1) === id ? [] : [id] })
        : setView({ open: state.open.includes(id) ? state.open.filter(one => one !== id) : [...state.open, id] })
    const show = (id: string) => setView({ open: wide ? [id] : [...new Set([...state.open, id])] })
    const setTab = (id: string, tab: DetailTab) => setView({ tabs: { ...(state.tabs ?? {}), [id]: tab } })

    const bar = (key: string, segments: Segment[], cells: number, height: number, alt: string) => {
      const parts = segments.some(segment => segment.value > 0) ? segments : [{ ...TRACK_BAR, value: 1 }]
      return Svg ? (
        <Box key={key} width="100%">
          <Svg source={svgBar(parts, cells, height)} alt={alt} />
        </Box>
      ) : (
        <Box key={key}>
          <Text wrap="truncate-end">
            {textBar(parts, cells).map((part, at) => (
              <Text key={`${key}:${at}`} color={part.color}>
                {part.text}
              </Text>
            ))}
          </Text>
        </Box>
      )
    }

    const now = await $.clock.now()
    const live = turn.status === 'running'
    // The clock while the prompt or a background subagent it started still runs; then Claude Code's
    // own wall time, carried on to the last background subagent's end.
    const ranOn = runsOn(turn, flow)
    const elapsed = live || ranOn ? now - turn.at : spanOf(turn, flow)
    // The waterfall's axis runs on the mod's clock, from the prompt to the last step's end.
    const endOf = (step: Step) => step.end ?? (step.status === 'running' ? now : step.at)
    // Calls ran in parallel when their run times overlap, or when one request asked for them and they
    // started together: a call that fails at once ends before its partner starts, yet both went out as one.
    const callCount = flow.filter(isCall).length
    const batchOf = new Map<string, { size: number; place: number }>()
    {
      const askerOf = new Map<string, string>()
      let asker = ''
      for (const step of flow) {
        if (step.kind === 'model') asker = step.id
        else if (isCall(step)) askerOf.set(step.id, asker)
      }
      let batch: Step[] = []
      let reach = 0
      const close = () => batch.forEach((one, at) => batchOf.set(one.id, { size: batch.length, place: at + 1 }))
      for (const call of flow.filter(isCall).sort((a, b) => a.at - b.at)) {
        const first = batch[0]
        const together = first !== undefined && askerOf.get(call.id) === askerOf.get(first.id) && call.at - first.at < TOGETHER_MS
        if (first !== undefined && call.at >= reach && !together) {
          close()
          batch = []
        }
        reach = batch.length > 0 ? Math.max(reach, endOf(call)) : endOf(call)
        batch.push(call)
      }
      close()
    }
    const inParallel = [...batchOf.values()].filter(one => one.size > 1)
    const parallelBatches = inParallel.filter(one => one.place === 1).length
    const span = Math.max(1, Math.max(live ? now : turn.at, ...flow.map(endOf)) - turn.at)
    // The cards the Problems filter lists: a failed or blocked step, or a subagent that met one inside.
    const problems = flow.filter(step => isProblem(step) || hasInner(step)).map(step => step.id)
    // The prompt's time rides in its status, where it is seen first; it counts up while anything runs.
    const status = saved && turn.status !== 'failed'
      ? { text: ` Saved · ${duration(elapsed)} `, bg: 'inactive' }
      : live
      ? { text: ` ● Live · ${duration(elapsed)} `, bg: 'suggestion' }
      : ranOn
        ? { text: ` ✓ Answered · ${runsOnLabel(flow)} running · ${duration(elapsed)} `, bg: 'suggestion' }
        : turn.status === 'failed'
          ? { text: ` Stopped after ${duration(elapsed)} `, bg: 'error' }
          : { text: ` ✓ Done in ${duration(elapsed)} `, bg: 'success' }
    const window = ctx.window
    const short = (model: string) => model.replace(/^claude-/, '')
    const models = [...new Set(flow.filter(step => step.kind === 'model' && step.model).map(step => short(step.model ?? '')))]
    const efforts = [...new Set(flow.filter(step => step.kind === 'model' && step.effort !== undefined).map(step => String(step.effort)))]
    // Every request's counters, the main agent's and its subagents'.
    // The prompt's own totals, which still count steps dropped to bound memory.
    const totals = turn.tokens ?? tokensIn(flow)
    const totalIn = totals.input + totals.cacheRead + totals.cacheWrite
    const totalRequests = turn.requests + (turn.agentRequests ?? flow.reduce((sum, step) => sum + (step.agent?.requests ?? 0), 0))
    // Four stats to a row on a wide pane, two on a narrow one, one when it's very narrow.
    const perRow = body >= 72 ? 4 : body >= 40 ? 2 : 1
    const quarter = Math.max(4, Math.floor((body - 10) / perRow) - 2)

    // Off the terminal each stat's label is in its own color.
    const STAT_TONE: Record<string, string> = { Context: KINDS.context.bar, Tokens: KINDS.model.bar, 'This prompt': KINDS.done.bar, Today: KINDS.hook.bar }
    const stat = (label: string, value: string, sub: string, extra?: ReturnType<typeof bar>) => (
      <Box
        key={`stat:${label}`}
        flexDirection="column"
        width={perRow === 4 ? '24%' : perRow === 2 ? '48%' : '100%'}
      >
        <Text color={edge ? MUTED : (STAT_TONE[label] ?? MUTED)} wrap="truncate-end">
          {label}
        </Text>
        <Text bold color={INK} wrap="truncate-end">
          {value}
        </Text>
        {extra}
        <Text color={MUTED} wrap="truncate-end">
          {sub}
        </Text>
      </Box>
    )

    // A key, its value and, where it isn't plain, where the figure came from.
    const kv = (key: string, id: string, value: string, quality?: Quality) => (
      <Box key={id} flexDirection="row" flexWrap="nowrap" gap={2}>
        {/* flexShrink 0: a long value would otherwise squeeze the label to nothing and run over it. */}
        <Box width={16} flexShrink={0}>
          <Text color={MUTED}>{key}</Text>
        </Box>
        <Box flexGrow={1} flexShrink={1}>
          <Text color={INK} wrap="wrap">
            {value}
          </Text>
        </Box>
        {quality ? (
          <Text color={MUTED} italic>
            {quality}
          </Text>
        ) : null}
      </Box>
    )

    // The request that asked for a call, or the calls a request asked for.
    const relatedOf = (step: Step): { label: string; steps: Step[] } => {
      const at = flow.indexOf(step)
      // A request's own calls are on the tree beneath it, so its details needn't list them again.
      if (step.kind === 'tool' || step.kind === 'skill' || step.kind === 'agent') {
        const asker = flow
          .slice(0, at)
          .reverse()
          .find(one => one.kind === 'model')
        return { label: 'Requested by', steps: asker ? [asker] : [] }
      }
      return { label: '', steps: [] }
    }

    const summary = (step: Step) => (
      <Box key={`summary:${step.id}`} flexDirection="column">
        {(step.items ?? []).map((row, at) => (
          <Box key={`item:${step.id}:${at}`} flexDirection="row" flexWrap="nowrap" justifyContent="space-between">
            <Text color={row.status ? TONE[row.status].text : INK} bold={!row.name.startsWith(' ')} wrap="truncate-end">
              {row.name}
            </Text>
            <Text color={MUTED}>{row.value}</Text>
          </Box>
        ))}
        {(step.nest ?? []).map((row, at) => (
          <Box key={`nest:${step.id}:${at}`} flexDirection="row" flexWrap="nowrap" justifyContent="space-between">
            <Text color={row.status ? TONE[row.status].text : INK} wrap="truncate-end">
              {`  ┆ ${row.name}`}
            </Text>
            <Text color={row.status ? TONE[row.status].text : MUTED}>{row.value}</Text>
          </Box>
        ))}
        {step.details.map((detail, at) =>
          detail.code ? (
            // A command is a code block under its label, the full width, not a value beside it.
            <Box key={`detail:${step.id}:${at}`} flexDirection="column" marginTop={edge ? 0 : 0.25}>
              <Text color={MUTED}>{detail.key}</Text>
              <Code source={detail.value} language={detail.language} />
            </Box>
          ) : (
            kv(detail.key, `detail:${step.id}:${at}`, detail.value)
          ),
        )}
      </Box>
    )

    const io = (step: Step) => (
      <Box key={`io:${step.id}`} flexDirection="column" gap={1}>
        {(['input', 'output'] as const).map(side =>
          step.preview?.[side] ? (
            <Box key={`io:${step.id}:${side}`} flexDirection="column">
              <Text bold color={INK}>
                {side === 'input' ? (step.kind === 'agent' ? 'Task' : 'Input') : step.kind === 'agent' ? 'Report' : 'Output'}
              </Text>
              <Code source={step.preview[side] ?? ''} language={side === 'input' && step.kind !== 'agent' ? 'json' : undefined} />
            </Box>
          ) : null,
        )}
        <Text color={MUTED}>First 20 lines, kept in this session only.</Text>
      </Box>
    )

    const tokensTab = (step: Step) => {
      const t = step.tokens
      const tIn = t ? t.input + t.cacheRead + t.cacheWrite : 0
      const q = step.q ?? {}
      return (
        <Box key={`tokens:${step.id}`} flexDirection="column">
          {t ? kv('New input', `tk:${step.id}:in`, formatTokens(t.input), 'observed') : null}
          {t ? kv('Read from cache', `tk:${step.id}:cr`, formatTokens(t.cacheRead), 'observed') : null}
          {t ? kv('Written to cache', `tk:${step.id}:cw`, formatTokens(t.cacheWrite), 'observed') : null}
          {t ? kv('Output', `tk:${step.id}:out`, formatTokens(t.output), 'observed') : null}
          {t && tIn ? kv('Cache hit', `tk:${step.id}:hit`, `${Math.round((t.cacheRead / tIn) * 100)}% of input`, 'observed') : null}
          {step.added && step.kind !== 'model' ? kv('Added to context', `tk:${step.id}:add`, `≈${formatTokens(step.added)}`, q.added ?? 'estimated') : null}
          {step.cost ? kv('Cost', `tk:${step.id}:cost`, `${formatCost(step.cost)} at API rates`, 'estimated') : null}
          {step.cost && step.split ? kv('Cost by type', `tk:${step.id}:split`, splitText(step.split), 'estimated') : null}
          {step.unpriced
            ? kv('Not priced', `tk:${step.id}:unpriced`, `${plural(step.unpriced, 'request')} with no known API price, left out of the cost`, 'unavailable')
            : null}
          {step.kind === 'agent' && t ? <Text color={MUTED}>Summed over the subagent's own requests.</Text> : null}
        </Box>
      )
    }

    // In a subagent's first request the conversation part is its task plus the notes Claude Code adds around it.
const childLabel = (part: PartKey) => (part === 'conversation' ? 'Task and Claude Code notes' : PARTS[part].label)

// What the main agent handed a subagent, and what its first request carried: its messages sized
    // from their text, and the measured rest it can't show (system prompt, tool definitions).
    const handover = (step: Step) => {
      const agent = step.agent
      const loaded = agent?.loaded
      const first = agent?.log?.find(request => !request.nested)
      const row = (key: string, name: string, tokens: number, quality?: Quality) => (
        <Box key={key} flexDirection="row" flexWrap="nowrap" justifyContent="space-between" gap={2}>
          <Text color={INK} wrap="truncate-end">{`  ${name}`}</Text>
          <Text color={MUTED}>{`≈${formatTokens(tokens)}${quality ? ` · ${quality}` : ''}`}</Text>
        </Box>
      )
      return (
        <Box key={`handover:${step.id}`} flexDirection="column">
          {agent?.handoff !== undefined ? kv('Handed over', `ho:${step.id}:task`, `≈${formatTokens(agent.handoff)} tokens of task text`, 'estimated') : null}
          {first ? kv('First request', `ho:${step.id}:first`, tokenLine(first.tokens), 'observed') : null}
          {loaded
            ? PART_ORDER.filter(part => partTokens(loaded.parts[part]) > 0).map(part => row(`ho:${step.id}:${part}`, childLabel(part), partTokens(loaded.parts[part]), 'estimated'))
            : null}
          {loaded ? row(`ho:${step.id}:hidden`, 'Unattributed (its system prompt and tools are in here)', loaded.hidden, 'inferred') : null}
          {loaded ? (
            <Text color={MUTED} wrap="wrap">
              Its messages are sized from their text. The rest of the measured input is unattributed: Claude Code doesn't expose a subagent's system prompt or tool definitions, so they can't be sized apart.
            </Text>
          ) : first ? (
            <Text color={MUTED} wrap="wrap">
              Claude Code didn't let the mod read this subagent's messages, so what its first request carried can't be split.
            </Text>
          ) : null}
        </Box>
      )
    }

    // Each of a subagent's requests: its input as the API split it, its output and its cost.
    const requestList = (step: Step) => {
      const log = step.agent?.log ?? []
      const all = (state.more ?? []).includes(step.id)
      const shown = all ? log : log.slice(0, REQUESTS_SHOWN)
      const missing = (step.agent?.requests ?? 0) - log.length
      return (
        <Box key={`requests:${step.id}`} flexDirection="column">
          {shown.map((request, n) => (
            <Box key={`rq:${step.id}:${n}`} flexDirection="row" flexWrap="nowrap" justifyContent="space-between" gap={2}>
              <Text color={INK} wrap="truncate-end">
                {`${n + 1}. ${tokenLine(request.tokens)}${request.nested ? ' · nested' : ''}`}
              </Text>
              <Text color={MUTED}>{request.cost === undefined ? 'price unknown' : formatCost(request.cost)}</Text>
            </Box>
          ))}
          {log.length > REQUESTS_SHOWN ? (
            <Button key={`more:${step.id}`} plain dimColor onPress={() => setView({ more: all ? (state.more ?? []).filter(id => id !== step.id) : [...(state.more ?? []), step.id] })}>
              {all ? 'Show fewer' : `Show all ${log.length} requests`}
            </Button>
          ) : null}
          {missing > 0 ? <Text color={MUTED}>{`${plural(missing, 'earlier request')} not listed; the totals count them.`}</Text> : null}
        </Box>
      )
    }

    const related = (step: Step) => {
      const { label, steps: list } = relatedOf(step)
      return (
        <Box key={`related:${step.id}`} flexDirection="column">
          <Text bold color={INK}>
            {label}
          </Text>
          {list.map(one => (
            <Box key={`rel:${step.id}:${one.id}`} flexDirection="row" flexWrap="nowrap" gap={1}>
              <Text color={KINDS[one.kind].tone}>{KINDS[one.kind].icon}</Text>
              <Button key={`rel:${step.id}:${one.id}`} dimColor onPress={() => show(one.id)}>
                {`${String(flow.indexOf(one) + 1)}. ${clip(one.title, 60)}`}
              </Button>
            </Box>
          ))}
        </Box>
      )
    }

    // The raw record, less the previews (Input and output shows those).
    const recordOf = (step: Step) => {
      const { preview: _preview, ...rest } = step
      return JSON.stringify(rest, null, 2)
    }
    // A copy can be pasted anywhere, so it is masked as an export is (best effort); it keeps the
    // commands and details an export leaves out, since it is copied on purpose, one step at a time.
    const copyRecord = async (step: Step) => {
      const done = await $.ui.copy({ text: redact(recordOf(step)), surface: e.surface as never })
      await $.ui.toast(done.isCopied ? 'Step copied as JSON, secrets masked (best effort).' : `Couldn't copy: ${done.reason ?? 'not supported here'}`)
    }

    // A step opened: its sections stacked in one tinted panel, no tabs. Inputs and outputs (file
    // text, command output, reports) and the raw record stay a link away, drawn only when asked for;
    // which one is open is kept per step as the tab once was.
    const section = (title: string, key: string, children: unknown) => (
      <Box key={key} flexDirection="column">
        <Text bold color={MUTED}>
          {title}
        </Text>
        {children}
      </Box>
    )
    // `lean`: opened under a subagent's lifecycle, which already shows its hand-over, requests, tokens and cost.
    const inspect = (step: Step, lean = false) => {
      const showRaw = state.tabs?.[step.id] === 'raw'
      const showIo = state.tabs?.[step.id] === 'io'
      const hasDetails = Boolean(step.items?.length || step.nest?.length || step.details.length)
      const hasTokens = Boolean(step.tokens || step.cost || step.added)
      const hasPreview = Boolean(step.preview?.input || step.preview?.output)
      const rel = relatedOf(step)
      const inset = edge
        ? { marginTop: 1, rowGap: 1 }
        : { marginTop: 0.5, rowGap: 0.75, backgroundColor: TRAY, borderStyle: 'round', borderColor: TRAY, paddingX: 2, paddingY: 1 }
      return (
        <Box key={`inspect:${step.id}`} flexDirection="column" {...inset}>
          {hasDetails ? section('Details', `sec:${step.id}:details`, summary(step)) : null}
          {hasTokens && !lean ? section('Tokens & cost', `sec:${step.id}:tokens`, tokensTab(step)) : null}
          {!lean && (step.agent?.handoff !== undefined || step.agent?.loaded) ? section('Handed over and loaded', `sec:${step.id}:handover`, handover(step)) : null}
          {!lean && step.agent?.log?.length ? section(`Requests (${step.agent.requests})`, `sec:${step.id}:requests`, requestList(step)) : null}
          {hasPreview && showIo ? section('Input and output', `sec:${step.id}:io`, io(step)) : null}
          {rel.steps.length ? related(step) : null}
          <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={2} rowGap={edge ? 0 : 0.25}>
            {hasPreview ? (
              <Button key={`io:${step.id}`} plain dimColor onPress={() => setTab(step.id, showIo ? 'summary' : 'io')}>
                {showIo ? 'Hide input and output' : 'Show input and output'}
              </Button>
            ) : null}
            <Button key={`raw:${step.id}`} plain dimColor onPress={() => setTab(step.id, showRaw ? 'summary' : 'raw')}>
              {showRaw ? 'Hide raw record' : 'Show raw record'}
            </Button>
            <Button key={`copy:${step.id}`} plain dimColor onPress={() => void copyRecord(step)}>
              Copy as JSON
            </Button>
          </Box>
          {showRaw ? <Code key={`rawcode:${step.id}`} source={recordOf(step)} language="json" /> : null}
        </Box>
      )
    }

    // Shared by both headers: the arrows between prompts, the four stats and the problems callout.
    const nav = (
      <Box flexDirection="row" flexWrap="nowrap" alignItems="center" gap={1} flexShrink={0}>
        <Button key="prev" dimColor onPress={() => go(-1)}>
          ‹
        </Button>
        <Text color={MUTED}>{`${position + 1} of ${allTurns.length}`}</Text>
        <Button key="next" dimColor onPress={() => go(1)}>
          ›
        </Button>
        {position < allTurns.length - 1 ? (
          <Button key="latest" dimColor onPress={() => setView({ selected: null, open: [] })}>
            Latest »
          </Button>
        ) : null}
      </Box>
    )
    // The status carries the time; the facts add the answer's own time when background subagents ran past it.
    const answerNote = !live && !ranOn && elapsed > answerOf(turn, flow) ? `answer at ${duration(answerOf(turn, flow))}` : ''
    const statItems = [
      window
        ? stat(
            'Context',
            formatTokens(measured),
            `${((measured / window) * 100).toFixed(1)}% of ${formatTokens(window)} window`,
            bar(
              'bar:header-context',
              [
                { color: KINDS.context.bar, tone: KINDS.context.tone, value: Math.min(measured, window) },
                { ...TRACK_BAR, value: window - Math.min(measured, window) },
              ],
              quarter,
              6,
              `Context ${formatTokens(measured)} of ${formatTokens(window)}`,
            ),
          )
        : stat('Context', formatTokens(measured), 'window not reported yet'),
      // The input summed over requests: each one re-sends the whole conversation, mostly from the cache,
      // so this runs far past Context, the latest request alone. The count says so; it wraps rather than cuts off.
      <Box key="stat:Tokens" flexDirection="column" width={perRow === 4 ? '24%' : perRow === 2 ? '48%' : '100%'}>
        <Text color={edge ? MUTED : STAT_TONE.Tokens} wrap="truncate-end">
          Tokens
        </Text>
        <Text bold color={INK} wrap="wrap">
          {totalIn ? `${formatTokens(totalIn)} in across ${plural(totalRequests, 'request')}` : '–'}
        </Text>
        {totalIn
          ? bar(
              'bar:header-tokens',
              [
                { color: REREAD_BAR, tone: MUTED, value: totals.cacheRead },
                { color: OUT_BAR, tone: OUT_BAR, value: totals.output },
                { color: NEW_BAR, tone: NEW_BAR, value: totals.input + totals.cacheWrite },
              ],
              quarter,
              6,
              `Tokens: ${formatTokens(totals.cacheRead)} re-read from cache, ${formatTokens(totals.output)} out, ${formatTokens(totals.input + totals.cacheWrite)} new`,
            )
          : null}
        {/* Wraps rather than cutting off: the three figures are the stat's point. */}
        <Text color={MUTED} wrap="wrap">
          {totalIn ? `re-read ${formatTokens(totals.cacheRead)} · out ${formatTokens(totals.output)} · new ${formatTokens(totals.input + totals.cacheWrite)}` : 'none reported yet'}
        </Text>
      </Box>,
      stat('This prompt', costText(turn.cost, turn.unpriced), plural(turn.requests, 'model request')),
      stat('Today', day.day === dayOf(now) ? formatCost(day.total) : '–', day.day === dayOf(now) && day.unpriced ? `all sessions · ${day.unpriced} unpriced` : 'all sessions'),
    ]
    // Problems are part of the prompt's status: a small chip beside it that lists only the problem steps, opened.
    const problemNote = [failed ? `${failed} failed` : '', blocked ? `${blocked} blocked` : ''].filter(Boolean).join(', ')
    const problemChip =
      problems.length > 0 ? (
        <Box key="problems-chip" flexShrink={0}>
          <Button key="problems" dimColor onPress={() => setView({ filter: 'problems', open: wide ? problems.slice(-1) : [...new Set([...state.open, ...problems])] })}>
            <Text bold color={TONE.failed.text}>
              {`✕ ${problemNote} ›`}
            </Text>
          </Button>
        </Box>
      ) : null
    const storyChip = ctx.story ? (
      <Text bold color={INK} backgroundColor={LINE}>
        {` ${ctx.story} `}
      </Text>
    ) : null
    const modelNote = models.length > 0 ? `${models.join(', ')}${efforts.length ? ` · ${efforts.join(', ')} effort` : ''}` : ''
    const branchNote = ctx.branch ? `${ctx.branch}${ctx.commit ? ` @ ${ctx.commit}` : ''}` : ''
    // The terminal: status and model, then the title and its figures over a rule, then the stats.
    // Elsewhere: an outlined status beside the title, the facts under it, and the stats in one bordered row.
    const headerCard = edge ? (
      <Box flexDirection="column" {...surface} paddingX={2} paddingY={1}>
        <Box flexDirection="row" flexWrap="nowrap" justifyContent="space-between" alignItems="center">
          <Box flexDirection="row" flexWrap="nowrap" alignItems="center" gap={1} flexShrink={1}>
            {storyChip}
            {pill('status', status.text, status.bg)}
            {problemChip}
            {modelNote ? (
              <Text color={MUTED} wrap="truncate-end">
                {`${KINDS.model.icon} ${modelNote}`}
              </Text>
            ) : null}
          </Box>
          {nav}
        </Box>
        <Box marginTop={1}>
          <Text bold color={INK} wrap="truncate-end">
            {turn.title}
          </Text>
        </Box>
        <Text color={MUTED} wrap="truncate-end">
          {[clock(turn.at), answerNote, `${flow.length} step${flow.length === 1 ? '' : 's'}`, branchNote].filter(Boolean).join(' · ')}
        </Text>
        <Text color={LINE} wrap="truncate-end">
          {'─'.repeat(Math.max(1, body - 8))}
        </Text>
        <Box flexDirection="row" flexWrap="wrap" rowGap={1} justifyContent="space-between">
          {statItems}
        </Box>
      </Box>
    ) : (
      <Box flexDirection="column" {...surface} paddingX={0} paddingY={0}>
        <Box flexDirection="column" paddingX={2} paddingY={1}>
          <Box flexDirection="row" flexWrap="nowrap" justifyContent="space-between" alignItems="center" gap={2}>
            <Box flexDirection="row" flexWrap="nowrap" alignItems="center" gap={1} flexShrink={1}>
              {storyChip}
              <Box key="status" flexShrink={0} borderStyle="round" borderColor={status.bg} paddingX={0.5} paddingY={0}>
                <Text bold color={status.bg}>
                  {status.text.trim()}
                </Text>
              </Box>
              {problemChip}
              <Text bold color={INK} wrap="truncate-end">
                {turn.title}
              </Text>
            </Box>
            {nav}
          </Box>
          <Text color={MUTED} wrap="truncate-end">
            {[clock(turn.at), answerNote, modelNote, branchNote].filter(Boolean).join(' · ')}
          </Text>
        </Box>
        <Box flexDirection="row" flexWrap="wrap" rowGap={1} justifyContent="space-between" paddingX={2} paddingY={0} paddingBottom={1}>
          {statItems}
        </Box>
      </Box>
    )

    // One pane, five views: underline tabs over a rule, the active one bold.
    // Each view's tab carries what is in it: steps, context, subagents, this session's prompts.
    const tabCount: Record<ViewMode, string> = {
      inspect: String(flow.length),
      context: measured ? formatTokens(measured) : '',
      agents: String(flow.filter(step => step.kind === 'agent').length),
      story: '',
      runs: String(allTurns.length),
      analytics: '',
    }
    const tabLabel = (one: (typeof MODES)[number], active: boolean) => [
      <Text key={`tab:${one.id}:label`} bold={active} underline={active && (Boolean(edge) || native)} color={active ? INK : MUTED}>
        {one.label}
      </Text>,
      ...(tabCount[one.id] ? [<Text key={`tab:${one.id}:count`} color={MUTED}>{`  ${tabCount[one.id]}`}</Text>] : []),
    ]
    // The terminal underlines the active tab over a rule; elsewhere the tabs are a segmented control in
    // one hairline tray, the active segment outlined. No fills: VS Code tints theme backgrounds, and a
    // Button without dimColor is drawn as a solid native button. VS Code's buttons carry their own
    // border, so there each tab is just its button, the active one bold and underlined.
    const modes = edge ? (
      <Box flexDirection="column" marginTop={1}>
        <Box flexDirection="row" columnGap={3} flexWrap="wrap" paddingX={1} paddingY={0}>
          {MODES.map(one => (
            <Button key={`mode:${one.id}`} plain dimColor={one.id !== mode} onPress={() => setView({ mode: one.id })}>
              {tabLabel(one, one.id === mode)}
            </Button>
          ))}
        </Box>
        <Text color={LINE} wrap="truncate-end">
          {'─'.repeat(Math.max(1, body - 2))}
        </Text>
      </Box>
    ) : (
      <Box flexDirection="row" flexWrap="wrap" marginTop={1}>
        <Box
          flexDirection="row"
          flexWrap="wrap"
          flexShrink={1}
          {...(native ? { columnGap: 0.5, rowGap: 0.5, paddingX: 0, paddingY: 0 } : { columnGap: 0.25, rowGap: 0.25, paddingX: 0.25, paddingY: 0.25, borderStyle: 'round' })}
        >
          {MODES.map(one => {
            const active = one.id === mode
            return (
              <Box key={`seg:${one.id}`} {...(active && !native ? { borderStyle: 'round', borderColor: MUTED } : {})} paddingX={native ? 0 : 1} paddingY={0}>
                <Button key={`mode:${one.id}`} plain dimColor onPress={() => setView({ mode: one.id })}>
                  {tabLabel(one, active)}
                </Button>
              </Box>
            )
          })}
        </Box>
      </Box>
    )

    const header = saved ? (
      <Box flexDirection="column" rowGap={edge ? 0 : 0.5}>
        <Box key="history:banner" flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" columnGap={2} borderStyle="round" borderColor={INK} paddingX={1} paddingY={0}>
          <Text wrap="wrap">
            <Text bold color={INK}>
              Earlier session
            </Text>
            <Text color={MUTED}>{` · ${[new Date(allTurns[0]?.at ?? saved.savedAt).toLocaleDateString('en', { month: 'short', day: 'numeric' }), clock(allTurns[0]?.at ?? saved.savedAt)].join(', ')}${saved.context.root ? ` · ${saved.context.root.split('/').pop()}` : ''}`}</Text>
            <Text color={MUTED}> · read-only</Text>
          </Text>
          <Button key="history:back" dimColor onPress={() => void closeSaved()}>
            Back to this session
          </Button>
        </Box>
        {headerCard}
      </Box>
    ) : (
      headerCard
    )
    const footer = (
      <Box flexDirection="row" marginTop={1} justifyContent="space-between" columnGap={2} rowGap={1} flexWrap="wrap">
        <Box flexShrink={1} flexGrow={1} minWidth={20}>
          <Text color={MUTED} wrap="wrap">
            Times observed · tokens reported · costs estimated at API rates
          </Text>
        </Box>
        <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={2} flexShrink={0}>
          <Text color={MUTED}>Copy</Text>
          <Button key="export-csv" dimColor onPress={() => void exportTrace($, turn, flow, elapsed, 'csv', e.surface, Boolean(state.detailed))}>
            CSV
          </Button>
          <Button key="export-md" dimColor onPress={() => void exportTrace($, turn, flow, elapsed, 'md', e.surface, Boolean(state.detailed))}>
            Markdown
          </Button>
          <Button key="export-json" dimColor onPress={() => void exportTrace($, turn, flow, elapsed, 'json', e.surface, Boolean(state.detailed))}>
            JSON
          </Button>
          <Button key="export-mode" dimColor onPress={() => setView({ detailed: !state.detailed })}>
            {state.detailed ? 'Detailed' : 'Share-safe'}
          </Button>
          <Text color={LINE}>|</Text>
          {saved ? null : (
            <Button key="clear" dimColor onPress={() => void clearAll($)}>
              Clear
            </Button>
          )}
        </Box>
      </Box>
    )

    if (mode === 'context') {
      const snap = (saved?.atlas ?? (await read($, atlas))).find(one => one.turnId === turn.id)
      const rows = (saved?.origins ?? (await read($, origins))).filter(one => one.turnId === turn.id && !one.agentId)
      const opened = state.parts ?? []
      const section = (label: string, children: unknown, key: string) => (
        <Box key={key} flexDirection="column" marginTop={1} {...surface} paddingX={2} paddingY={1}>
          <Text bold color={INK}>
            {label}
          </Text>
          {children}
        </Box>
      )

      if (!snap) {
        return (
          <Box flexDirection="column" {...page}>
            {header}
            {modes}
            {section('Context', <Text color={MUTED}>No model request in this prompt yet. The atlas fills in after the first one.</Text>, 'atlas:empty')}
            {footer}
          </Box>
        )
      }

      const order = PART_ORDER.filter(part => partTokens(snap.parts[part]) > 0).sort((a, b) => partTokens(snap.parts[b]) - partTokens(snap.parts[a]))
      const pct = window ? (snap.total / window) * 100 : undefined
      const warn =
        pct === undefined || pct < 60
          ? undefined
          : pct >= 80
            ? { tone: TONE.failed.text, text: `Context is ${pct.toFixed(0)}% full. Claude Code compacts on its own near the limit; run /compact to do it now, or /clear to start fresh.` }
            : { tone: TONE.blocked.text, text: `Context is ${pct.toFixed(0)}% full. The largest parts are listed first below.` }
      const request = flow.find(step => step.id === snap.stepId)
      const share = (tokens: number) => (window ? `${((tokens / window) * 100).toFixed(1)}%` : `${((tokens / snap.total) * 100).toFixed(0)}%`)
      const cells = Math.max(8, body - 10)
      // The funnel follows the header's breakpoints: a bar on each part's row down to 40 columns,
      // then one small funnel above the list. Figures drop as the bars lose room.
      const funnelRows = body >= 40
      const showGrowth = body >= 72
      const grewBy = (part: PartKey) => (snap.before ? Math.round(partTokens(snap.parts[part]) - (snap.before[part] ?? 0)) : 0)
      const figures = (part: PartKey) => {
        const tokens = partTokens(snap.parts[part])
        if (!funnelRows) return `${formatTokens(tokens)} · ${share(tokens)}`
        return showGrowth ? [formatTokens(tokens), share(tokens), signed(grewBy(part))].filter(Boolean).join(' · ') : formatTokens(tokens)
      }
      const widest = Math.max(1, ...order.map(part => partTokens(snap.parts[part])))
      const labelCells = Math.min(showGrowth ? 24 : 18, Math.max(0, ...order.map(part => PARTS[part].label.length)) + 4)
      const figureCells = Math.max(0, ...order.map(part => figures(part).length))
      const funnelCells = Math.max(4, cells - labelCells - figureCells - 2)
      const doors = new Map<string, { tokens: number; count: number; names: Map<string, number> }>()
      for (const row of rows) {
        const door = doors.get(row.door) ?? { tokens: 0, count: 0, names: new Map<string, number>() }
        door.tokens += row.tokens
        door.count += 1
        if (row.name) door.names.set(row.name, (door.names.get(row.name) ?? 0) + 1)
        doors.set(row.door, door)
      }
      const compactions = flow.filter(step => step.kind === 'compact')
      // Closes a list of parts: a rule across the card, then the total in bold on the right.
      const totalRow = (key: string, tokens: number) => (
        <Box key={key} flexDirection="column" marginTop={edge ? 0 : 0.5} rowGap={edge ? 0 : 0.25}>
          {Svg ? (
            <Box width="100%">
              <Svg
                source={`<svg xmlns="http://www.w3.org/2000/svg" width="${cells * PX_PER_CELL}" height="1" viewBox="0 0 ${cells * PX_PER_CELL} 1" preserveAspectRatio="none"><rect width="100%" height="1" fill="currentColor" fill-opacity="0.2"/></svg>`}
                height={1}
                alt=""
              />
            </Box>
          ) : (
            <Text color={LINE} wrap="truncate-end">
              {'─'.repeat(cells)}
            </Text>
          )}
          <Box flexDirection="row" flexWrap="nowrap" justifyContent="space-between" gap={1}>
            <Text bold color={INK}>
              Total
            </Text>
            <Box flexShrink={0}>
              <Text bold color={INK}>
                {formatTokens(tokens)}
              </Text>
            </Box>
          </Box>
        </Box>
      )

      return (
        <Box flexDirection="column" {...page}>
          {header}
          {modes}
          {warn ? (
            <Box marginTop={1} paddingX={1} paddingY={0} borderStyle="round" borderColor={warn.tone}>
              <Text bold color={warn.tone} wrap="wrap">
                {warn.text}
              </Text>
            </Box>
          ) : null}
          {section(
            `Context sent with ${request ? lower(request.title) : 'the latest request'}`,
            <Box flexDirection="column">
              <Text wrap="truncate-end">
                <Text bold color={INK}>
                  {formatTokens(snap.total)}
                </Text>
                <Text color={MUTED}>{window ? `  of ${formatTokens(window)} window · ${share(snap.total)} used` : '  window not reported yet'}</Text>
              </Text>
              {funnelRows ? null : Svg ? (
                <Box key="funnel:atlas" width="100%" marginTop={edge ? 0 : 0.5}>
                  <Svg
                    source={svgFunnel(order.map(part => ({ color: PARTS[part].color, value: partTokens(snap.parts[part]) })), widest, cells)}
                    height={funnelHeight(order.length)}
                    alt={`Context ${formatTokens(snap.total)} by part, largest first`}
                  />
                </Box>
              ) : (
                <Box key="funnel:atlas" flexDirection="column">
                  {order.map(part => (
                    <Text key={`funnel:atlas:${part}`} color={PARTS[part].color} wrap="truncate-end">
                      {textFunnel(partTokens(snap.parts[part]), widest, cells)}
                    </Text>
                  ))}
                </Box>
              )}
              <Box flexDirection="column" marginTop={1} rowGap={edge ? 0 : funnelRows ? 0.1 : 0.5}>
                {order.map(part => {
                  const tokens = partTokens(snap.parts[part])
                  const isOpen = opened.includes(part)
                  const flip = () => setView({ parts: isOpen ? opened.filter(one => one !== part) : [...opened, part] })
                  return (
                    <Box key={`part:${part}`} flexDirection="column">
                      {/* The label is text, the toggle beside it the one control: a row of full-width buttons reads as a stack of pills in VS Code. */}
                      <Box flexDirection="row" flexWrap="nowrap" justifyContent="space-between" alignItems="center" gap={1}>
                        <Box flexDirection="row" flexWrap="nowrap" alignItems="center" gap={1} flexShrink={funnelRows ? 0 : 1} width={funnelRows ? labelCells : undefined}>
                          <Button key={`part:${part}`} plain dimColor label={isOpen ? '▾' : '▸'} onPress={flip} />
                          <Text wrap="truncate-end">
                            {funnelRows ? null : <Text color={PARTS[part].color}>{'■ '}</Text>}
                            <Text color={INK} bold={isOpen}>
                              {PARTS[part].label}
                            </Text>
                          </Text>
                        </Box>
                        {funnelRows ? (
                          <Box key={`funnel:${part}`} width={funnelCells} flexGrow={1} flexShrink={1}>
                            {Svg ? (
                              <Svg source={svgFunnel([{ color: PARTS[part].color, value: tokens }], widest, funnelCells)} height={FUNNEL_BAR_PX} alt={`${PARTS[part].label}: ${formatTokens(tokens)}`} />
                            ) : (
                              <Text color={PARTS[part].color} wrap="truncate-end">
                                {textFunnel(tokens, widest, funnelCells)}
                              </Text>
                            )}
                          </Box>
                        ) : null}
                        <Box flexDirection="row" flexWrap="nowrap" justifyContent="flex-end" flexShrink={0} width={funnelRows ? figureCells : undefined}>
                          <Text color={MUTED}>{figures(part)}</Text>
                        </Box>
                      </Box>
                      {isOpen ? (
                        <Box flexDirection="column" paddingLeft={6} marginTop={edge ? 0 : 0.25} rowGap={edge ? 0 : 0.25}>
                          <Text color={MUTED} italic>
                            {PARTS[part].hint}
                          </Text>
                          {snap.parts[part].map((item, at) => (
                            <Box key={`atlas:${part}:${at}`} flexDirection="column">
                              <Box flexDirection="row" flexWrap="nowrap" justifyContent="space-between" gap={1}>
                                <Text color={item.status ? TONE[item.status].text : INK} wrap="truncate-end">
                                  {`${item.name}${item.count ? ` ×${item.count}` : ''}`}
                                </Text>
                                <Box flexShrink={0}>
                                  <Text color={MUTED}>{formatTokens(item.tokens)}</Text>
                                </Box>
                              </Box>
                              {item.note && item.note !== 'listed' && item.note !== 'loaded' ? (
                                <Text color={MUTED} wrap="wrap">
                                  {item.note}
                                </Text>
                              ) : null}
                            </Box>
                          ))}
                        </Box>
                      ) : null}
                    </Box>
                  )
                })}
              </Box>
              {totalRow('total:atlas:parts', snap.total)}
              {showGrowth && order.some(part => grewBy(part) > 0) ? (
                <Box marginTop={edge ? 0 : 0.5}>
                  <Text color={MUTED} italic wrap="wrap">
                    + is the growth since the last request.
                  </Text>
                </Box>
              ) : null}
            </Box>,
            'atlas:parts',
          )}
          {section(
            'Cache',
            <Text color={INK} wrap="wrap">
              {`${snap.total ? Math.round((snap.cacheRead / snap.total) * 100) : 0}% of this request was read from cache (${formatTokens(snap.cacheRead)}); ${formatTokens(snap.cacheWrite)} was written to it.`}
            </Text>,
            'atlas:cache',
          )}
          {snap.native && snap.native.rows.length > 0
            ? section(
                "Claude Code's own estimate",
                <Box flexDirection="column">
                  {snap.native.rows.map(row => (
                    <Box key={`native:${row.name}`} flexDirection="row" flexWrap="nowrap" justifyContent="space-between" gap={1}>
                      <Text color={INK} wrap="truncate-end">
                        {row.name}
                      </Text>
                      <Box flexShrink={0}>
                        <Text color={MUTED}>{formatTokens(row.tokens)}</Text>
                      </Box>
                    </Box>
                  ))}
                  {totalRow('total:atlas:native', snap.native.total)}
                  <Text color={MUTED} italic wrap="wrap">
                    {`/context's categories for ${snap.native.model.replace(/^claude-/, '')} just after this request: ${formatTokens(snap.native.total)} in all, its own estimate.`}
                  </Text>
                </Box>,
                'atlas:native',
              )
            : null}
          {section(
            'Added during this prompt',
            doors.size === 0 ? (
              <Text color={MUTED}>No rows recorded yet.</Text>
            ) : (
              <Box flexDirection="column">
                {[...doors.entries()]
                  .sort((a, b) => b[1].tokens - a[1].tokens)
                  .map(([door, sum]) => (
                    <Box key={`door:${door}`} flexDirection="column">
                      <Box flexDirection="row" flexWrap="nowrap" justifyContent="space-between" gap={1}>
                        <Text color={INK}>{`${DOORS[door] ?? door} ×${sum.count}`}</Text>
                        <Text color={MUTED}>{`≈${formatTokens(sum.tokens)}`}</Text>
                      </Box>
                      {sum.names.size > 0 ? (
                        <Text color={MUTED} wrap="truncate-end">
                          {`  ${[...sum.names.entries()]
                            .sort((a, b) => b[1] - a[1])
                            .map(([name, count]) => `${name}${count > 1 ? ` ×${count}` : ''}`)
                            .join(', ')}`}
                        </Text>
                      ) : null}
                    </Box>
                  ))}
                <Text color={MUTED} italic>
                  Rows Claude Code appended, by the route they came in; sizes estimated from their text.
                </Text>
              </Box>
            ),
            'atlas:added',
          )}
          {compactions.length > 0
            ? section(
                'Compactions',
                <Box flexDirection="column">
                  {compactions.map(step => (
                    <Text key={`atlas:${step.id}`} color={INK} wrap="truncate-end">
                      {`${KINDS.compact.icon} ${clock(step.at)} · ${step.sub ?? ''} · ${step.title}`}
                    </Text>
                  ))}
                </Box>,
                'atlas:compact',
              )
            : null}
          <Box marginTop={1}>
            <Text color={MUTED} wrap="wrap">
              The total is the input count the API reported (observed). Parts are estimated: sized from their text, then scaled to that total. Tool definitions are sized from Claude Code's own /context estimate where it reports one; what the text can't account for beyond that is shown as unattributed, not guessed.
            </Text>
          </Box>
          {footer}
        </Box>
      )
    }

    if (mode === 'story') {
      const beats = storyOf(turn, flow)
      const summaryLine = storySummary(turn, flow, elapsed)
      // The copy keeps the commands and reasons the pane shows (an export leaves them out), with
      // secrets, emails and home folders masked as an export's are: best effort, not a guarantee.
      const markdown = redact(storyMarkdown(turn, flow, elapsed, ctx))
      const copy = async (surface: string) => {
        const done = await $.ui.copy({ text: markdown, surface: surface as never })
        await $.ui.toast(done.isCopied ? 'Story copied as Markdown, secrets masked (best effort).' : `Couldn't copy: ${done.reason ?? 'not supported here'}`)
      }

      return (
        <Box flexDirection="column" {...page}>
          {header}
          {modes}
          <Box flexDirection="column" marginTop={1} {...surface} paddingX={2} paddingY={1}>
            <Box flexDirection="row" flexWrap="nowrap" justifyContent="space-between" gap={1}>
              <Text bold color={INK}>
                What happened
              </Text>
              <Button key="copy-story" dimColor onPress={press => void copy(press.surface)}>
                Copy as Markdown
              </Button>
            </Box>
            <Text color={INK} wrap="wrap">
              {summaryLine}
            </Text>
          </Box>
          <Box flexDirection="column" marginTop={1}>
            {beats.map((beat, at) => {
              const kind = KINDS[beat.kind]
              const tone = beat.problem ? TONE[beat.problem] : undefined
              return (
                <Box key={`beat:${at}`} flexDirection="column">
                  {at > 0 ? (
                    <Box paddingLeft={9}>
                      <Text color={LINE}>│</Text>
                    </Box>
                  ) : null}
                  <Box flexDirection="row" flexWrap="nowrap" gap={1}>
                    <Box width={7} justifyContent="flex-end">
                      <Text color={MUTED}>{`+${duration(beat.at)}`}</Text>
                    </Box>
                    <Text color={tone ? tone.text : kind.tone}>{kind.icon}</Text>
                    <Box flexGrow={1} flexShrink={1}>
                      <Text color={tone ? tone.text : INK} bold={Boolean(tone)} wrap="wrap">
                        {beat.text}
                      </Text>
                    </Box>
                    <Button key={`story:${at}`} dimColor onPress={() => setView({ mode: 'inspect', open: wide ? [beat.id] : [...new Set([...state.open, beat.id])] })}>
                      ›
                    </Button>
                  </Box>
                </Box>
              )
            })}
          </Box>
          <Box marginTop={1}>
            <Text color={MUTED} wrap="wrap">
              Written from the recorded steps alone, without asking a model. › opens a step in the inspector.
            </Text>
          </Box>
          {footer}
        </Box>
      )
    }

    // Patterns across the session's prompts, or across the saved sessions: what stands out first,
    // then where the money, context, time and problems went. Each card says how its figures are known.
    if (mode === 'analytics') {
      const scope = state.scope ?? 'session'
      const range = state.range ?? 14
      const inner = Math.max(10, body - 8)
      const pct = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : '–')
      const tilesPerRow = body >= 72 ? 3 : body >= 40 ? 2 : 1
      const tile = (label: string, value: string, sub: string, warn = false, action?: { label: string; press: () => void }) => (
        <Box key={`tile:${label}`} flexDirection="column" width={tilesPerRow === 3 ? '32%' : tilesPerRow === 2 ? '48%' : '100%'}>
          <Text color={warn ? TONE.blocked.text : MUTED} wrap="truncate-end">
            {label}
          </Text>
          <Text bold color={INK} wrap="truncate-end">
            {value}
          </Text>
          <Text color={MUTED} wrap="truncate-end">
            {sub}
          </Text>
          {action ? (
            <Button key={`tile:${label}:action`} dimColor onPress={action.press}>
              {action.label}
            </Button>
          ) : null}
        </Box>
      )
      const tiles = (key: string, items: ReturnType<typeof tile>[]) => (
        <Box key={key} flexDirection="row" flexWrap="wrap" rowGap={1} justifyContent="space-between" marginTop={1} {...surface} paddingX={2} paddingY={1}>
          {items}
        </Box>
      )
      // A card with its title and, on the right, how its figures are known or a short count.
      const card = (key: string, title: string, note: string, children: unknown, quality = false) => (
        <Box key={key} flexDirection="column" marginTop={1} {...surface} paddingX={2} paddingY={1}>
          <Box flexDirection="row" flexWrap="nowrap" justifyContent="space-between" gap={2}>
            <Text bold color={INK} wrap="truncate-end">
              {title}
            </Text>
            {note ? (
              <Text color={MUTED} italic={quality} wrap="truncate-end">
                {note}
              </Text>
            ) : null}
          </Box>
          <Box flexDirection="column" marginTop={1} rowGap={edge ? 0 : 0.25}>
            {children as never}
          </Box>
        </Box>
      )
      const legend = (key: string, items: { color: string; text: string }[]) => (
        <Box key={key} flexDirection="row" flexWrap="wrap" columnGap={2}>
          {items.map((one, at) => (
            <Text key={`${key}:${at}`} wrap="truncate-end">
              <Text color={one.color}>■ </Text>
              <Text color={MUTED}>{one.text}</Text>
            </Text>
          ))}
        </Box>
      )
      const meter = (key: string, color: string, share: number, cells: number, alt: string) =>
        Svg ? (
          <Svg key={key} source={svgMeter(color, share, 6, false, cells)} alt={alt} />
        ) : (
          <Text key={key} wrap="truncate-end">
            {textMeter(color, share, false, cells).map((part, at) => (
              <Text key={`${key}:${at}`} color={part.color}>
                {part.text}
              </Text>
            ))}
          </Text>
        )
      const muted = (key: string, text: string) => (
        <Text key={key} color={MUTED} wrap="wrap">
          {text}
        </Text>
      )
      // Under a chart: ‹ › step through its points, and the line says the picked one's figures.
      // The editor draws a chart as an image with no hover, so this is how its numbers are read there.
      const readout = (key: string, text: string, at: number, count: number, pick: (n: number) => void) => (
        <Box key={key} flexDirection="row" flexWrap="nowrap" alignItems="center" gap={1}>
          <Button key={`${key}:prev`} dimColor onPress={() => pick(Math.max(0, at - 1))}>
            ‹
          </Button>
          <Button key={`${key}:next`} dimColor onPress={() => pick(Math.min(count - 1, at + 1))}>
            ›
          </Button>
          <Box flexGrow={1} flexShrink={1}>
            <Text color={INK} wrap="truncate-end">
              {text}
            </Text>
          </Box>
        </Box>
      )
      // The two scopes, and the range under All sessions, in the same segmented control as the views.
      const segments = (prefix: string, items: { id: string; label: string }[], active: string, pick: (id: string) => void) => (
        <Box
          key={`${prefix}:tray`}
          flexDirection="row"
          flexWrap="wrap"
          flexShrink={0}
          {...(edge || native ? { columnGap: edge ? 2 : 0.5, rowGap: 0, paddingX: 0, paddingY: 0 } : { columnGap: 0.25, rowGap: 0.25, paddingX: 0.25, paddingY: 0.25, borderStyle: 'round' })}
        >
          {items.map(one => (
            <Box key={`${prefix}seg:${one.id}`} {...(one.id === active && !native && !edge ? { borderStyle: 'round', borderColor: MUTED } : {})} paddingX={native || edge ? 0 : 1} paddingY={0}>
              <Button key={`${prefix}:${one.id}`} plain dimColor onPress={() => pick(one.id)}>
                <Text bold={one.id === active} underline={one.id === active && (Boolean(edge) || native)} color={one.id === active ? INK : MUTED}>
                  {one.label}
                </Text>
              </Button>
            </Box>
          ))}
        </Box>
      )
      const SPLIT_BARS: { key: keyof CostSplit; label: string; color: string }[] = [
        { key: 'cacheRead', label: 'Cache read', color: REREAD_BAR },
        { key: 'cacheWrite', label: 'Cache write', color: KINDS.skill.bar },
        { key: 'input', label: 'New input', color: NEW_BAR },
        { key: 'output', label: 'Output', color: OUT_BAR },
      ]

      const runs = allTurns.map(one => summaryOf(one, allSteps.filter(step => step.turnId === one.id), ctx.branch))
      const s = sessionStats(allTurns, allSteps, runs, window)
      const scopeNote =
        scope === 'session'
          ? [plural(allTurns.length, 'prompt'), plural(s.requests, 'request'), duration(s.wallMs)].join(' · ')
          : `last ${range} days`
      const top = (
        <Box key="an:top" flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" columnGap={2} rowGap={edge ? 0 : 0.5} marginTop={1}>
          {segments('scope', [{ id: 'session', label: saved ? 'Saved session' : 'This session' }, { id: 'all', label: 'All sessions' }], scope, id => setView({ scope: id as 'session' | 'all' }))}
          <Text color={MUTED} wrap="truncate-end">
            {scopeNote}
          </Text>
        </Box>
      )

      let cards: unknown[] = []
      if (scope === 'session') {
        const insights =
          s.insights.length > 0 ? (
            <Box key="an:insights" flexDirection="column" marginTop={1} {...surface} paddingX={2} paddingY={1} rowGap={edge ? 0 : 0.25}>
              {s.insights.map((one, at) => (
                <Box key={`insight:${at}`} flexDirection="row" flexWrap="nowrap" gap={1}>
                  <Text color={one.tone === 'warn' ? TONE.blocked.text : KINDS.context.tone}>●</Text>
                  <Box flexGrow={1} flexShrink={1}>
                    <Text wrap="wrap">
                      {one.runs.map((run, n) => (
                        <Text key={`insight:${at}:${n}`} bold={run.bold} color={INK}>
                          {run.text}
                        </Text>
                      ))}
                    </Text>
                  </Box>
                </Box>
              ))}
            </Box>
          ) : null

        const sessionTiles = tiles('an:tiles', [
          tile('Cost', costText(s.cost, s.unpriced), s.unpriced ? `API-rate estimate · ${s.unpriced} unpriced` : 'API-rate estimate'),
          tile('Tokens', s.totalIn ? `${formatTokens(s.totalIn)} in` : '–', `${formatTokens(s.tokens.output)} out`),
          tile('Cache hit', s.totalIn ? pct(s.tokens.cacheRead, s.totalIn) : '–', 'of input tokens'),
          tile('Wall time', duration(s.wallMs), plural(allTurns.length, 'prompt')),
          tile('Tool calls', String(s.calls), s.failed || s.blocked ? `${s.failed} failed · ${s.blocked} blocked` : 'none failed'),
          tile(
            'Duplicate calls',
            `${s.dupes.count} of ${s.dupes.calls}`,
            s.dupes.count ? `≈${formatTokens(s.dupes.tokens)} tokens re-added` : 'none repeated',
            s.dupes.count > 0,
            s.dupes.rows[0] ? { label: 'Review ›', press: () => review(s.dupes.rows[0] as RepeatRow) } : undefined,
          ),
        ])

        // Cost by prompt: each prompt's bar as long as its share of the costliest, split by what was billed.
        const most = Math.max(0.0001, ...s.prompts.map(one => one.cost))
        const costRows = s.prompts.map(one => {
          const width = Math.max(2, Math.round((one.cost / most) * 100))
          const parts: Segment[] = one.split ? SPLIT_BARS.map(part => ({ color: part.color, tone: part.color, value: one.split?.[part.key] ?? 0 })) : [{ color: KINDS.model.bar, tone: KINDS.model.bar, value: one.cost }]
          return (
            <Box key={`cost:${one.id}`} flexDirection="row" flexWrap="nowrap" alignItems="center" gap={2}>
              <Box width={3} flexShrink={0}>
                <Text color={MUTED}>{String(one.n)}</Text>
              </Box>
              <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                <Text wrap="truncate-end">
                  <Text color={INK}>{one.title}</Text>
                  {one.times && one.times >= 3 ? <Text color={TONE.blocked.text}>{`  ${one.times.toFixed(1)}× median`}</Text> : null}
                </Text>
                <Box width={`${width}%`}>{bar(`costbar:${one.id}`, parts, Math.max(1, Math.round(((inner - 14) * width) / 100)), 6, `${one.title}: ${costText(one.cost, one.unpriced)}`)}</Box>
              </Box>
              <Box width={8} flexShrink={0} flexDirection="row" flexWrap="nowrap" justifyContent="flex-end">
                <Text color={INK} bold>
                  {costText(one.cost, one.unpriced)}
                </Text>
              </Box>
            </Box>
          )
        })
        const costCard = card(
          'an:cost',
          'Cost by prompt',
          'estimated',
          [
            legend('an:cost:legend', SPLIT_BARS.map(part => ({ color: part.color, text: part.label }))),
            ...costRows,
            s.saved > 0.005 ? muted('an:saved', `Cache saved about ${formatCost(s.saved)}: ${formatCost(s.cost)} against ${formatCost(s.cost + s.saved)} with nothing cached.`) : null,
          ],
          true,
        )

        // Context after each request against the window.
        const peak = s.peak !== undefined ? s.points[s.peak] : undefined
        const compactions = s.points.filter(one => one.compact).length
        const ctxNote = [
          peak ? `Peak ${formatTokens(peak.tokens)}${window ? ` (${pct(peak.tokens, window)} of the window)` : ''} at request ${(s.peak ?? 0) + 1}.` : '',
          compactions ? `${plural(compactions, 'compaction')}.` : '',
        ]
          .filter(Boolean)
          .join(' ')
        const point = Math.min(s.points.length - 1, Math.max(0, state.point ?? s.points.length - 1))
        const ctxChart =
          s.points.length < 2
            ? muted('an:ctx:none', 'Shows once the session has made two requests.')
            : Svg
              ? (
                  <Box key="an:ctx:chart" width="100%">
                    <Svg
                      source={contextChart(s.points, window, s.jump, inner * PX_PER_CELL, { line: KINDS.context.bar, warn: NEW_BAR, ok: KINDS.done.bar }, point)}
                      alt={`Context after each of ${s.points.length} requests${window ? ` against a ${formatTokens(window)} window` : ''}. ${ctxNote}`}
                    />
                  </Box>
                )
              : (
                  <Box key="an:ctx:spark">
                    <Text color={KINDS.context.tone} wrap="truncate-end">
                      {sparkline(s.points.map(one => one.tokens), inner, Math.max(window ?? 0, ...s.points.map(one => one.tokens)))}
                    </Text>
                  </Box>
                )
        const ctxCard = card(
          'an:ctx',
          'Context over the session',
          'observed',
          [
            ctxChart,
            s.points.length >= 2 ? readout('ctxpick', pointText(s.points, point, window), point, s.points.length, n => setView({ point: n })) : null,
            ctxNote ? muted('an:ctx:note', ctxNote) : null,
          ],
          true,
        )

        // Repeated calls: the same tool and input again with no successful edit between, most
        // re-added first. A prompt number opens that prompt in Inspect, searched for the call.
        const promptOf = (turnId: string) => allTurns.findIndex(turn => turn.id === turnId)
        const review = (row: RepeatRow) => {
          const at = row.turns.map(promptOf).filter(n => n >= 0)
          const id = allTurns[at[0] ?? -1]?.id
          // Without a search box (a mobile app that did not ask for Input) a query could not be seen or cleared, so it only opens the prompt.
          if (id) setView({ mode: 'inspect', selected: id === allTurns.at(-1)?.id ? null : id, open: [], filter: 'all', query: Input ? row.search : '' })
        }
        const repeatsShown = s.dupes.rows.slice(0, 6)
        const repeatMost = Math.max(1, ...repeatsShown.map(one => one.tokens))
        const narrowRepeats = body < 50
        const repeatCell = (key: string, width: number, text: string, color = INK, bold = false) => (
          <Box key={key} width={width} flexShrink={0} flexDirection="row" flexWrap="nowrap" justifyContent="flex-end">
            <Text color={color} bold={bold}>
              {text}
            </Text>
          </Box>
        )
        const repeatsCard = !s.dupes.rows.length
          ? card('an:repeats', 'Repeated calls', QUALITY_OF.dupes, [muted('repeats:none', `No call was repeated with the same input${s.dupes.calls ? ` across ${plural(s.dupes.calls, 'tool call')}` : ''}.`)], true)
          : card(
              'an:repeats',
              'Repeated calls',
              QUALITY_OF.dupes,
              [
                muted('repeats:what', 'The same tool with the same input, run again with no successful edit in between.'),
                <Box key="repeats:head" flexDirection="row" flexWrap="nowrap" gap={1}>
                  <Box flexGrow={1} flexShrink={1}>
                    <Text color={MUTED}>Call</Text>
                  </Box>
                  {repeatCell('rh:times', 6, 'Times', MUTED)}
                  {repeatCell('rh:prompt', 8, 'Prompt', MUTED)}
                  {narrowRepeats ? null : repeatCell('rh:added', 9, 'Re-added', MUTED)}
                </Box>,
                ...repeatsShown.map((one, n) => {
                  const prompts = one.turns.map(promptOf).filter(at => at >= 0)
                  return (
                    <Box key={`repeat:${n}`} flexDirection="row" flexWrap="nowrap" alignItems="center" gap={1}>
                      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                        <Text bold color={INK} wrap="truncate-end">
                          {one.label}
                        </Text>
                        {narrowRepeats ? null : meter(`repeatbar:${n}`, NEW_BAR, one.tokens / repeatMost, Math.max(4, Math.min(METER_CELLS, inner - 30)), `${one.label}: ≈${formatTokens(one.tokens)} re-added`)}
                      </Box>
                      {repeatCell(`rt:${n}`, 6, `×${one.times}`, TONE.blocked.text, true)}
                      <Box key={`rp:${n}`} width={8} flexShrink={0} flexDirection="row" flexWrap="nowrap" justifyContent="flex-end">
                        {prompts.length ? (
                          <Button key={`repeat:${n}:open`} dimColor onPress={() => review(one)}>
                            {`#${prompts[0] + 1}${prompts.length > 1 ? ` +${prompts.length - 1}` : ''}`}
                          </Button>
                        ) : (
                          <Text color={MUTED}>–</Text>
                        )}
                      </Box>
                      {narrowRepeats ? null : repeatCell(`ra:${n}`, 9, `≈${formatTokens(one.tokens)}`)}
                    </Box>
                  )
                }),
                s.dupes.rows.length > repeatsShown.length ? muted('repeats:more', `${plural(s.dupes.rows.length - repeatsShown.length, 'more repeated call')}`) : null,
                muted('repeats:note', Input ? 'Bars show tokens re-added. A prompt number opens that prompt with its steps searched for the call.' : 'Bars show tokens re-added. A prompt number opens that prompt.'),
              ],
              true,
            )

        // Tools, by what they added to the context.
        const narrowTools = body < 50
        const toolsShown = s.tools.slice(0, 8)
        const toolMost = Math.max(1, ...toolsShown.map(one => one.added))
        const toolCell = (key: string, width: number, text: string, color = INK) => (
          <Box key={key} width={width} flexShrink={0} flexDirection="row" flexWrap="nowrap" justifyContent="flex-end">
            <Text color={color}>{text}</Text>
          </Box>
        )
        const toolHead = (
          <Box key="tools:head" flexDirection="row" flexWrap="nowrap" gap={1}>
            <Box flexGrow={1} flexShrink={1}>
              <Text color={MUTED}>Tool</Text>
            </Box>
            {toolCell('th:calls', 6, 'Calls', MUTED)}
            {narrowTools ? null : toolCell('th:run', 8, 'Avg run', MUTED)}
            {toolCell('th:added', 7, 'Added', MUTED)}
            {toolCell('th:fail', 6, 'Fail', MUTED)}
          </Box>
        )
        const toolRows = toolsShown.map(one => {
          const bad = one.failed + one.blocked
          const rate = one.calls ? bad / one.calls : 0
          return (
            <Box key={`tool:${one.name}`} flexDirection="row" flexWrap="nowrap" alignItems="center" gap={1}>
              <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                <Text bold color={INK} wrap="truncate-end">
                  {one.name}
                </Text>
                {narrowTools ? null : meter(`toolbar:${one.name}`, KINDS.tool.bar, one.added / toolMost, Math.max(4, Math.min(METER_CELLS, inner - 34)), `${one.name}: ≈${formatTokens(one.added)} added`)}
              </Box>
              {toolCell(`tc:${one.name}`, 6, String(one.calls))}
              {narrowTools ? null : toolCell(`tr:${one.name}`, 8, one.timed ? duration(one.runMs / one.timed) : '–', MUTED)}
              {toolCell(`ta:${one.name}`, 7, `≈${formatTokens(one.added)}`)}
              {toolCell(`tf:${one.name}`, 6, bad ? `${Math.round(rate * 100)}%` : '0%', rate >= 0.05 ? TONE.failed.text : MUTED)}
            </Box>
          )
        })
        const moreTools = s.tools.slice(8)
        const toolsCard = card(
          'an:tools',
          'Tools',
          'by tokens added',
          s.tools.length
            ? [
                toolHead,
                ...toolRows,
                moreTools.length ? muted('tools:more', `${plural(moreTools.length, 'more tool')} · ${moreTools.reduce((sum, one) => sum + one.calls, 0)} calls · ≈${formatTokens(moreTools.reduce((sum, one) => sum + one.added, 0))} added`) : null,
              ]
            : [muted('tools:none', 'No tool calls yet.')],
        )

        // Where the time went, summed over steps.
        const TIME_BARS: Record<string, string> = { model: KINDS.model.bar, tools: KINDS.tool.bar, agents: KINDS.agent.bar, waiting: KINDS.hook.bar, overhead: TRACK_BAR.color }
        const timeTotal = s.time.reduce((sum, one) => sum + one.ms, 0)
        const timeCard = card(
          'an:time',
          'Where the time went',
          'observed',
          timeTotal
            ? [
                bar('an:time:bar', s.time.map(one => ({ color: TIME_BARS[one.key] ?? TRACK_BAR.color, tone: TIME_BARS[one.key], value: one.ms })), inner, 10, s.time.map(one => `${one.label} ${duration(one.ms)}`).join(', ')),
                legend('an:time:legend', s.time.map(one => ({ color: TIME_BARS[one.key] ?? TRACK_BAR.color, text: `${one.label} ${pct(one.ms, timeTotal)} · ${duration(one.ms)}` }))),
                muted('an:time:note', 'Summed over steps, so calls that ran together each count their own time. Hooks and checks is a call\'s time outside the tool itself.'),
              ]
            : [muted('an:time:none', 'No finished steps yet.')],
          true,
        )

        // What went wrong, by tool and reason.
        const wrongCard = card(
          'an:wrong',
          'What went wrong',
          s.failed || s.blocked ? `${s.failed} failed · ${s.blocked} blocked` : '',
          s.problems.length
            ? s.problems.slice(0, 8).map((one, at) => (
                <Box key={`wrong:${at}`} flexDirection="row" flexWrap="nowrap" justifyContent="space-between" gap={2}>
                  <Box flexGrow={1} flexShrink={1}>
                    <Text wrap="truncate-end">
                      <Text bold color={INK}>
                        {one.tool}
                      </Text>
                      <Text color={MUTED}>{`  ${one.reason}`}</Text>
                    </Text>
                  </Box>
                  <Box flexShrink={0}>
                    <Text color={TONE[one.status].text}>{`${one.count} ${one.status}`}</Text>
                  </Box>
                </Box>
              ))
            : [muted('wrong:none', 'Nothing failed or was blocked.')],
        )

        // What it produced: the files changed, and the cost per hundred lines.
        const added = s.files.reduce((sum, one) => sum + one.added, 0)
        const removed = s.files.reduce((sum, one) => sum + one.removed, 0)
        const producedCard = card(
          'an:produced',
          'What it produced',
          s.files.length ? `${plural(s.files.length, 'file')} · +${added} −${removed}` : '',
          s.files.length
            ? [
                ...s.files.slice(0, 8).map(one => (
                  <Box key={`file:${one.path}`} flexDirection="row" flexWrap="nowrap" justifyContent="space-between" gap={2}>
                    <Box flexGrow={1} flexShrink={1}>
                      <Text color={INK} wrap="truncate-start">
                        {one.path}
                      </Text>
                    </Box>
                    <Box flexShrink={0}>
                      {one.tracked ? (
                        <Text>
                          <Text color={KINDS.done.tone}>{`+${one.added}`}</Text>
                          <Text color={TONE.failed.text}>{` −${one.removed}`}</Text>
                        </Text>
                      ) : (
                        <Text color={MUTED}>edited</Text>
                      )}
                    </Box>
                  </Box>
                )),
                s.files.length > 8 ? muted('files:more', `${plural(s.files.length - 8, 'more file')}`) : null,
                s.lines > 0 ? muted('files:rate', `About ${formatCost((s.cost / s.lines) * 100)} per 100 lines changed.`) : null,
              ]
            : [muted('files:none', 'No files changed yet.')],
        )

        // Who spent it: the main agent, then each subagent type.
        const spendMost = Math.max(0.0001, ...s.spenders.map(one => one.cost))
        const whoCard = card(
          'an:who',
          'Who spent it',
          'estimated',
          s.spenders.map(one => (
            <Box key={`who:${one.name}`} flexDirection="row" flexWrap="nowrap" alignItems="center" gap={2}>
              <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                <Text color={INK} wrap="truncate-end">
                  {one.main ? one.name : `${one.name}${one.runs > 1 ? ` ×${one.runs}` : ''}`}
                </Text>
                {meter(`whobar:${one.name}`, one.main ? KINDS.model.bar : KINDS.agent.bar, one.cost / spendMost, Math.max(4, Math.min(METER_CELLS * 2, inner - 18)), `${one.name}: ${formatCost(one.cost)}`)}
              </Box>
              <Box width={14} flexShrink={0} flexDirection="row" flexWrap="nowrap" justifyContent="flex-end">
                <Text>
                  <Text color={INK}>{formatCost(one.cost)}</Text>
                  <Text color={MUTED}>{`  ${pct(one.cost, s.cost)}`}</Text>
                </Text>
              </Box>
            </Box>
          )),
          true,
        )
        cards = [insights, sessionTiles, repeatsCard, costCard, ctxCard, toolsCard, timeCard, wrongCard, producedCard, whoCard]
      } else {
        // All sessions: the saved list, with this session's own figures as they are now.
        const liveTurns = await read($, turns)
        const liveSteps = await read($, steps)
        const list = (await savedList($).catch(() => [] as HistoryEntry[])).filter(one => one.id !== liveCtx.historyId)
        const liveFirst = liveTurns[0]
        const liveEntry: HistoryEntry | undefined =
          liveFirst && liveCtx.historyId
            ? {
                id: liveCtx.historyId,
                at: liveFirst.at,
                savedAt: now,
                title: redact(liveFirst.title),
                project: liveCtx.root?.split('/').pop(),
                prompts: liveTurns.length,
                cost: liveTurns.reduce((sum, one) => sum + one.cost, 0),
                unpriced: liveTurns.reduce((sum, one) => sum + (one.unpriced ?? 0), 0) || undefined,
                problems: liveTurns.reduce((sum, one) => sum + summaryOf(one, liveSteps.filter(step => step.turnId === one.id)).problems, 0),
                ...entryFigures(liveTurns, liveSteps),
              }
            : undefined
        const entries = liveEntry ? [...list, liveEntry] : list
        if (list.some(needsFigures)) void fillFigures($)
        const a = allStats(entries, now, range)
        const filling = entries.filter(needsFigures).length
        const rangeRow = segments(
          'range',
          [
            { id: '7', label: '7 days' },
            { id: '14', label: '14 days' },
            { id: '30', label: '30 days' },
          ],
          String(range),
          id => setView({ range: Number(id) as 7 | 14 | 30, day: undefined }),
        )
        const dayName = (ms: number) => new Date(ms).toLocaleDateString('en', { month: 'short', day: 'numeric' })
        const allTiles = tiles('an:alltiles', [
          tile('Spend', costText(a.spend, a.unpriced), 'API-rate estimate'),
          tile('Sessions', String(a.sessions), plural(a.prompts, 'prompt')),
          tile('Per prompt', a.prompts ? formatCost(a.perPrompt) : '–', 'average'),
          tile('Cache hit', a.hit !== undefined ? `${Math.round(a.hit * 100)}%` : '–', 'of input tokens'),
          tile('Problems', a.problemRate !== undefined ? `${(a.problemRate * 100).toFixed(1)}%` : '–', 'of tool calls'),
          tile('Busiest day', a.busiest ? dayName(a.busiest.at) : '–', a.busiest ? formatCost(a.busiest.cost) : 'no spend yet'),
        ])
        const todayAt = a.bars.findIndex(one => one.day === dayOf(now))
        const dayAt = Math.min(a.bars.length - 1, Math.max(0, state.day ?? (todayAt >= 0 ? todayAt : a.bars.length - 1)))
        const dayCard = card(
          'an:days',
          'Spend per day',
          'estimated',
          [
            Svg ? (
              <Box key="an:days:chart" width="100%">
                <Svg
                  source={dayChart(a.bars, dayOf(now), inner * PX_PER_CELL, { bar: REREAD_BAR, today: KINDS.context.bar }, dayAt)}
                  alt={`Spend per day over ${range} days${a.busiest ? `; the busiest was ${dayName(a.busiest.at)} at ${formatCost(a.busiest.cost)}` : ''}`}
                />
              </Box>
            ) : (
              <Box key="an:days:spark">
                <Text color={KINDS.context.tone} wrap="truncate-end">
                  {sparkline(a.bars.map(one => one.cost), inner)}
                </Text>
              </Box>
            ),
            readout('daypick', dayText(a.bars[dayAt]), dayAt, a.bars.length, n => setView({ day: n })),
            edge ? muted('an:days:range', `${dayName(a.from)} to today`) : null,
          ],
          true,
        )
        const topCard = card(
          'an:topcost',
          'Costliest sessions',
          'opens the saved trace',
          a.top.length
            ? a.top.map(one => {
                const own = one.id === liveEntry?.id
                return (
                  <Box key={`topcost:${one.id}`} flexDirection="row" flexWrap="nowrap" alignItems="center" gap={1}>
                    <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                      <Text color={INK} wrap="truncate-end">
                        {one.title}
                      </Text>
                      <Text color={MUTED} wrap="truncate-end">
                        {[own ? 'This session' : dayName(one.at), one.project, plural(one.prompts, 'prompt')].filter(Boolean).join(' · ')}
                      </Text>
                    </Box>
                    <Box flexShrink={0}>
                      <Text bold color={INK}>
                        {costText(one.cost, one.unpriced)}
                      </Text>
                    </Box>
                    {own || one.id === saved?.id ? (
                      <Button key={`topcost:${one.id}`} plain dimColor onPress={() => setView({ scope: 'session' })}>
                        ›
                      </Button>
                    ) : (
                      <Button key={`topcost:${one.id}`} plain dimColor onPress={() => void openSaved(one.id)}>
                        ›
                      </Button>
                    )}
                  </Box>
                )
              })
            : [muted('topcost:none', 'No sessions in this range.')],
        )
        const PROJECT_BARS = [KINDS.model.bar, KINDS.tool.bar, KINDS.hook.bar, KINDS.agent.bar, KINDS.compact.bar, REREAD_BAR]
        const projects = a.projects.length > 5 ? [...a.projects.slice(0, 5), { name: 'Other', cost: a.projects.slice(5).reduce((sum, one) => sum + one.cost, 0) }] : a.projects
        const projectCard = card(
          'an:projects',
          'By project',
          '',
          projects.length
            ? [
                bar('an:projects:bar', projects.map((one, at) => ({ color: PROJECT_BARS[at] ?? REREAD_BAR, tone: PROJECT_BARS[at], value: one.cost })), inner, 10, projects.map(one => `${one.name} ${formatCost(one.cost)}`).join(', ')),
                legend('an:projects:legend', projects.map((one, at) => ({ color: PROJECT_BARS[at] ?? REREAD_BAR, text: `${one.name} ${formatCost(one.cost)}` }))),
              ]
            : [muted('projects:none', 'No spend in this range.')],
        )
        const modelMost = Math.max(0.0001, ...a.models.map(one => one.cost))
        const modelTotal = a.models.reduce((sum, one) => sum + one.cost, 0)
        const modelCard = card(
          'an:models',
          'By model',
          'estimated',
          [
            ...a.models.map(one => (
              <Box key={`model:${one.name}`} flexDirection="row" flexWrap="nowrap" alignItems="center" gap={2}>
                <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                  <Text color={INK} wrap="truncate-end">
                    {one.name}
                  </Text>
                  {meter(`modelbar:${one.name}`, OUT_BAR, one.cost / modelMost, Math.max(4, Math.min(METER_CELLS * 2, inner - 18)), `${one.name}: ${formatCost(one.cost)}`)}
                </Box>
                <Box width={14} flexShrink={0} flexDirection="row" flexWrap="nowrap" justifyContent="flex-end">
                  <Text>
                    <Text color={INK}>{formatCost(one.cost)}</Text>
                    <Text color={MUTED}>{`  ${pct(one.cost, modelTotal)}`}</Text>
                  </Text>
                </Box>
              </Box>
            )),
            a.models.length === 0 && !filling ? muted('models:none', 'No priced requests in this range.') : null,
            filling ? muted('models:filling', `Reading ${plural(filling, 'saved session')} once for the model and cache figures…`) : null,
          ],
          true,
        )
        cards = [
          <Box key="an:range" flexDirection="row" flexWrap="wrap" marginTop={1}>
            {rangeRow}
          </Box>,
          allTiles,
          dayCard,
          topCard,
          projectCard,
          modelCard,
        ]
      }
      return (
        <Box flexDirection="column" {...page}>
          {header}
          {modes}
          {top}
          {cards as never}
          <Box marginTop={1}>
            <Text color={MUTED} wrap="wrap">
              {scope === 'session' ? 'Rolled up from the recorded steps. Costs are API-rate estimates, not a bill.' : `From the sessions saved on this computer (kept ${HISTORY_DAYS} days) and this one.`}
            </Text>
          </Box>
          {footer}
        </Box>
      )
    }

    // This session's prompts, newest first: what each cost and took, and which had problems.
    // Nothing here is kept after the session; a row opens its prompt in Inspect.
    if (mode === 'runs') {
      const rows = [...allTurns].reverse().map(one => summaryOf(one, allSteps.filter(step => step.turnId === one.id), ctx.branch))
      const totalCost = rows.reduce((sum, one) => sum + one.cost, 0)
      const totalMs = rows.reduce((sum, one) => sum + one.durationMs, 0)
      const troubled = rows.filter(one => one.problems > 0).length
      const open = (id: string) => setView({ mode: 'inspect', selected: id === allTurns.at(-1)?.id ? null : id, open: [] })
      const unpricedAll = rows.reduce((sum, one) => sum + one.unpriced, 0)
      return (
        <Box flexDirection="column" {...page}>
          {header}
          {modes}
          <Box flexDirection="column" marginTop={1} {...surface} paddingX={2} paddingY={1}>
            <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" columnGap={2}>
              <Box flexDirection="column">
                <Text bold color={INK}>
                  {saved ? 'Saved session' : 'This session'}
                </Text>
                <Text color={MUTED}>{[plural(rows.length, 'prompt'), `${duration(totalMs)} of work`, troubled ? `${troubled} had problems` : 'no problems'].join(' · ')}</Text>
              </Box>
              <Box flexDirection="column" alignItems="flex-end">
                <Text bold color={INK}>
                  {formatCost(totalCost)}
                </Text>
                <Text color={MUTED}>{unpricedAll ? `API-rate estimate · ${unpricedAll} unpriced` : 'API-rate estimate'}</Text>
              </Box>
            </Box>
            <Box flexDirection="column" marginTop={1} rowGap={edge ? 0 : 0.25}>
              {rows.map(one => {
                const self = one.id === turn.id
                const share = totalCost ? one.cost / totalCost : 0
                return (
                  <Box key={`prompt:${one.id}`} flexDirection="row" flexWrap="nowrap" alignItems="center" gap={2}>
                    <Box width={5} flexShrink={0}>
                      <Text color={self ? INK : MUTED} bold={self}>
                        {clock(one.at)}
                      </Text>
                    </Box>
                    <Box flexGrow={1} flexShrink={1}>
                      <Text wrap="truncate-end">
                        <Text color={INK} bold={self}>
                          {one.title}
                        </Text>
                        {one.problems ? <Text color={TONE.failed.text}>{`  ${plural(one.problems, 'problem')}`}</Text> : null}
                        {one.evicted ? <Text color={MUTED}>{'  · older steps trimmed'}</Text> : null}
                      </Text>
                    </Box>
                    {body < 64 ? null : (
                      <Box key={`share:${one.id}`} width={METER_CELLS} flexShrink={0}>
                        {Svg ? (
                          <Svg source={svgMeter(KINDS.model.bar, share, 6, false)} alt={`${Math.round(share * 100)}% of the session's cost`} />
                        ) : (
                          <Text wrap="truncate-end">
                            {textMeter(KINDS.model.tone, share, false).map((part, at) => (
                              <Text key={`share:${one.id}:${at}`} color={part.color}>
                                {part.text}
                              </Text>
                            ))}
                          </Text>
                        )}
                      </Box>
                    )}
                    <Box width={8} flexShrink={0} flexDirection="row" flexWrap="nowrap" justifyContent="flex-end">
                      <Text color={INK} bold={share >= 0.2}>
                        {costText(one.cost, one.unpriced)}
                      </Text>
                    </Box>
                    <Box width={7} flexShrink={0} flexDirection="row" flexWrap="nowrap" justifyContent="flex-end">
                      <Text color={MUTED}>{duration(one.durationMs)}</Text>
                    </Box>
                    <Button key={`prompt:${one.id}`} plain dimColor onPress={() => open(one.id)}>
                      ›
                    </Button>
                  </Box>
                )
              })}
            </Box>
          </Box>
          {earlierCard}
          <Box marginTop={1}>
            <Text color={MUTED} wrap="wrap">
              {`Press › to open a prompt or session · saved on this computer for ${HISTORY_DAYS} days`}
            </Text>
          </Box>
          {footer}
        </Box>
      )
    }

    const matches = (step: Step) => {
      if (filter === 'problems' && !isProblem(step) && !hasInner(step)) return false
      const kinds = FILTERS.find(one => one.id === filter)?.kinds
      if (kinds && !kinds.includes(step.kind)) return false
      if (!query) return true
      const text = [step.title, step.sub ?? '', ...step.details.map(detail => `${detail.key} ${detail.value}`), ...(step.nest ?? []).map(row => row.name)]
      return text.join(' ').toLowerCase().includes(query)
    }
    const shown = flow.map((step, index) => ({ step, index })).filter(({ step }) => matches(step))
    const countOf = (one: (typeof FILTERS)[number]) => (one.id === 'problems' ? problems.length : one.kinds ? flow.filter(step => one.kinds?.includes(step.kind)).length : flow.length)

    const filterList = FILTERS.filter(one => one.id === 'all' || one.id === filter || countOf(one) > 0)
    const search = Input ? (
      <Input key="search" placeholder="Search steps" value={state.query ?? ''} onInput={value => setView({ query: value })} onSubmit={value => setView({ query: value })} />
    ) : null
    // The terminal lists the filters as underlined labels under the search. Elsewhere the search
    // stretches across one row with the filters beside it, in the same segmented control as the views;
    // a narrow pane wraps the filters below.
    // The order the steps are listed in: oldest first unless the toggle has flipped it. A Button, so VS Code draws it plain.
    const newestFirst = state.order === 'newest'
    const orderToggle = (
      <Button key="order" plain dimColor onPress={() => setView({ order: newestFirst ? 'oldest' : 'newest' })}>
        <Text color={MUTED}>{newestFirst ? '↓ Newest first' : '↑ Oldest first'}</Text>
      </Button>
    )
    const toolbar = (
      <Box flexDirection="column" marginTop={1}>
        {edge ? (
          <Box flexDirection="column">
            {search ? (
              <Box width="100%" marginBottom={1}>
                <Box flexGrow={1}>{search}</Box>
              </Box>
            ) : null}
            <Box flexDirection="row" columnGap={3} flexWrap="wrap" alignItems="center" paddingX={1} paddingY={0}>
              {filterList.map(one => {
                const active = one.id === filter
                const tone = one.id === 'problems' ? TONE.failed.text : INK
                return (
                  <Button key={`filter:${one.id}`} plain dimColor={!active} onPress={() => setView({ filter: one.id })}>
                    <Text bold={active} underline={active} color={active ? tone : MUTED}>
                      {`${one.label} ${countOf(one)}`}
                    </Text>
                  </Button>
                )
              })}
              {orderToggle}
            </Box>
          </Box>
        ) : (
          <Box flexDirection="row" flexWrap="wrap" alignItems="center" columnGap={2} rowGap={0.5}>
            {search ? (
              // A column, not a row: VS Code's field only stretches to its slot's width when the slot stacks it.
              <Box flexDirection="column" flexGrow={1} flexShrink={1} minWidth={24}>
                {search}
              </Box>
            ) : null}
            <Box
              flexDirection="row"
              flexWrap="wrap"
              flexShrink={0}
              {...(native ? { columnGap: 0.5, rowGap: 0.5, paddingX: 0, paddingY: 0 } : { columnGap: 0.25, rowGap: 0.25, paddingX: 0.25, paddingY: 0, borderStyle: 'round' })}
            >
              {filterList.map(one => {
                const active = one.id === filter
                const tone = one.id === 'problems' && countOf(one) > 0 ? TONE.failed.text : INK
                return (
                  <Box key={`fseg:${one.id}`} {...(active && !native ? { borderStyle: 'round', borderColor: MUTED } : {})} paddingX={native ? 0 : 1} paddingY={0}>
                    <Button key={`filter:${one.id}`} plain dimColor onPress={() => setView({ filter: one.id })}>
                      <Text bold={active} underline={active && native} color={active ? tone : MUTED}>
                        {one.label}
                      </Text>
                      <Text color={MUTED}>{`  ${countOf(one)}`}</Text>
                    </Button>
                  </Box>
                )
              })}
            </Box>
            {orderToggle}
          </Box>
        )}
        {turn.evicted ? (
          <Box marginTop={1}>
            <Text color={MUTED} wrap="wrap">
              {`${plural(turn.evicted, 'older step')} of this prompt ${turn.evicted === 1 ? 'was' : 'were'} dropped to keep memory bounded; the figures above still count ${turn.evicted === 1 ? 'it' : 'them'}.`}
            </Text>
          </Box>
        ) : null}
        {filter !== 'all' || query ? (
          <Box flexDirection="row" flexWrap="nowrap" gap={2} marginTop={1}>
            <Text color={MUTED}>{`Showing ${shown.length} of ${flow.length} steps`}</Text>
            <Button key="clear-filters" dimColor onPress={() => setView({ filter: 'all', query: '' })}>
              Clear filters
            </Button>
          </Box>
        ) : null}
      </Box>
    )

    // Beside each card: how long the step took over a bar of its share of the prompt. A step card puts its
    // tokens and cost as pills on the time's line, right-aligned; a subagent's card names the share there.
    const meter = (step: Step, color: string, tone: string, chips?: string[], cells = METER_CELLS) => {
      const took = endOf(step) - step.at
      const running = step.status === 'running'
      const share = Math.min(1, took / span)
      const key = `bar:${step.id}`
      const percent = share < 0.01 ? '<1%' : `${Math.round(share * 100)}%`
      const pills = chips ? (
        <Box key={`pills:${step.id}`} flexDirection="row" flexWrap="nowrap" alignItems="center" columnGap={Svg ? 0.5 : 2} flexShrink={0}>
          {chips.map((text, at) =>
            Svg ? (
              <Box key={`pill:${step.id}:${at}`} flexShrink={0}>
                <Svg source={pillSvg(text)} alt={text} />
              </Box>
            ) : (
              <Text key={`pill:${step.id}:${at}`} color={MUTED}>
                {text}
              </Text>
            ),
          )}
        </Box>
      ) : (
        <Text color={MUTED}>{running ? 'running…' : `${percent} of prompt`}</Text>
      )
      return (
        <Box key={key} width={cells} flexShrink={0} flexDirection="column" rowGap={edge ? 0 : 0.5}>
          <Box flexDirection="row" flexWrap="nowrap" justifyContent="space-between" alignItems="center" columnGap={1}>
            <Text bold color={INK}>
              {running ? `${duration(took)}…` : duration(took)}
            </Text>
            {pills}
          </Box>
          {Svg ? (
            <Box width="100%">
              <Svg source={svgMeter(color, share, 6, running, cells)} alt={`${duration(took)}, ${percent} of the prompt's ${duration(span)}`} />
            </Box>
          ) : (
            <Text wrap="truncate-end">
              {textMeter(tone, share, running, cells).map((part, at) => (
                <Text key={`${key}:${at}`} color={part.color}>
                  {part.text}
                </Text>
              ))}
            </Text>
          )}
        </Box>
      )
    }

    // A subagent's lifecycle, read from its events as they arrive: the task handed over (agent.spawn),
    // its first request's reply (turn.step), its run, its report back (its turn.complete, then the
    // Agent call or a later prompt), and what it cost. Nothing here is made up: a stage not reached shows as to come.
    const STAGES = ['Delegate', 'Initialize', 'Run', 'Hand back', 'Cost'] as const
    const DOT: Record<StageState, { glyph: string; color: string }> = {
      done: { glyph: '●', color: KINDS.agent.tone },
      now: { glyph: '◉', color: 'suggestion' },
      next: { glyph: '○', color: MUTED },
      failed: { glyph: '✕', color: TONE.failed.text },
    }
    const backs = handBacksOf(turn, allTurns, allSteps, ctx)
    const inOf = (t?: Tokens) => (t ? t.input + t.cacheRead + t.cacheWrite : 0)
    const lifeOf = (step: Step) => {
      const agent = step.agent
      const own = (agent?.log ?? []).filter(request => !request.nested)
      const asking = agent?.asking ?? []
      const failed = step.status === 'failed' || step.status === 'blocked'
      const ended = Boolean(agent?.ended) || (step.status !== 'running' && !agent?.launched)
      const delivered = backs.filter(one => agent?.id && one.handsBack?.includes(agent.id))
      const later = Boolean(agent?.background || agent?.launched)
      const handed = ended && !failed && (!later || delivered.length > 0)
      const states: StageState[] = [
        agent?.id || own.length || ended ? 'done' : 'now',
        own.length ? 'done' : failed && ended ? 'failed' : agent?.id ? 'now' : 'next',
        ended && own.length ? (failed ? 'failed' : 'done') : own.length ? 'now' : 'next',
        handed ? 'done' : ended && !failed ? 'now' : 'next',
        // Its cost shows as it grows, but the stage is only reached once the rest is done.
        ended && (handed || failed) ? 'done' : 'next',
      ]
      const at = states.findIndex(state => state === 'now' || state === 'failed')
      const current = at < 0 ? STAGES.length - 1 : at
      const report = agent?.report ?? (later ? undefined : step.added)
      return { agent, own, asking, failed, ended, delivered, later, handed, states, current, report }
    }
    // A line for each stage's state: what the Inspect card's strip and the rail both say.
    const stageNote = (step: Step, life: ReturnType<typeof lifeOf>) => {
      const { agent, own, asking, failed, ended, handed, current } = life
      if (failed && ended) return step.label ?? 'Stopped'
      if (handed) return `done · ${costText(step.cost, step.unpriced)}`
      if (current === 0) return 'starting'
      if (current === 1) return 'waiting for its first reply'
      if (current === 2) return asking.length ? `request ${(agent?.requests ?? own.length) + 1} in flight` : `${plural(agent?.requests ?? own.length, 'request')} so far`
      return 'report ready, waiting to be delivered'
    }
    const dots = (key: string, states: StageState[]) =>
      states.map((state, n) => (
        <Text key={`${key}:${n}`} color={DOT[state].color}>
          {`${n ? ' ' : ''}${DOT[state].glyph}`}
        </Text>
      ))
    const since = (ms: number) => `+${duration(Math.max(0, ms - turn.at))}`
    const exact = (value: number) => value.toLocaleString('en-US')
    // Inside a subagent's card in the Agents view: the tree's indent, the card's border and its inset.
    const cardCells = Math.max(16, body - 14)

    const stage = (step: Step, n: number, state: StageState, right: string, lines: RenderChildren[]) => (
      <Box key={`stage:${step.id}:${n}`} flexDirection="column" marginTop={edge ? 0 : 0.5}>
        <Box flexDirection="row" flexWrap="nowrap" justifyContent="space-between" gap={2}>
          <Text wrap="truncate-end">
            <Text color={DOT[state].color}>{`${DOT[state].glyph} `}</Text>
            <Text bold={state !== 'next'} color={state === 'next' ? MUTED : INK}>
              {STAGES[n]}
            </Text>
          </Text>
          {right ? (
            <Text color={MUTED} wrap="truncate-end">
              {right}
            </Text>
          ) : null}
        </Box>
        <Box flexDirection="column" paddingLeft={2} paddingY={0}>
          {lines}
        </Box>
      </Box>
    )
    const line = (key: string, text: string, tone: string = MUTED) => (
      <Text key={key} color={tone} wrap="wrap">
        {text}
      </Text>
    )

    // The rail, then the five stages, each with its figures in view: no stage needs opening to be read.
    const lifecycle = (step: Step) => {
      const life = lifeOf(step)
      const { agent, own, asking, failed, ended, delivered, later, handed, states, current, report } = life
      const first = own[0]
      const tool = (key: string) => `${key}:${step.id}`

      const rail = Svg ? (
        <Box key={tool('rail')} flexDirection="column" marginTop={0.5}>
          <Box width="100%">
            <Svg source={svgRail(states, cardCells, KINDS.agent.bar)} alt={`Lifecycle: ${STAGES[current]}, ${stageNote(step, life)}`} />
          </Box>
          <Box flexDirection="row" flexWrap="nowrap">
            {STAGES.map((name, n) => (
              <Box key={tool(`rail-label-${n}`)} width="20%" justifyContent="center" flexShrink={1}>
                <Text bold={n === current} color={states[n] === 'next' ? MUTED : INK} wrap="truncate-end">
                  {name}
                </Text>
              </Box>
            ))}
          </Box>
        </Box>
      ) : (
        <Text key={tool('rail')} wrap="truncate-end">
          {STAGES.map((name, n) => (
            <Text key={tool(`rail-${n}`)}>
              {n ? <Text color={LINE}> ─ </Text> : null}
              <Text color={DOT[states[n] ?? 'next'].color}>{`${DOT[states[n] ?? 'next'].glyph} `}</Text>
              <Text bold={n === current} color={states[n] === 'next' ? MUTED : INK}>
                {name}
              </Text>
            </Text>
          ))}
        </Text>
      )

      // Delegate: what the main agent handed over, and from which of its requests.
      const asker = [...flow].reverse().find(one => one.kind === 'model' && one.at <= step.at)
      const askerNo = asker ? flow.filter(one => one.kind === 'model').indexOf(asker) + 1 : 0
      const delegate = stage(step, 0, states[0] ?? 'next', since(step.at), [
        agent?.handoff !== undefined
          ? line(tool('d1'), `≈${formatTokens(agent.handoff)} tokens of task text handed over · est.`, INK)
          : line(tool('d1'), 'Waiting for Claude Code to start it'),
        line(
          tool('d2'),
          [`${agent?.type ?? step.title}${step.model ? ` on ${short(step.model)}` : ''}`, later ? 'background' : 'foreground', askerNo ? `from main request ${askerNo}` : ''].filter(Boolean).join(' · '),
        ),
      ])

      // Initialize: what its first request carried, measured, and the part its messages can't explain.
      const loaded = agent?.loaded
      const initialize = stage(step, 1, states[1] ?? 'next', first ? since(first.at) : '', [
        ...(first
          ? [
              line(
                tool('i1'),
                `Started with ${formatTokens(inOf(first.tokens))} tokens · ${formatTokens(first.tokens.cacheWrite)} written to cache${first.tokens.cacheRead ? ` · ${formatTokens(first.tokens.cacheRead)} read from a cache made before it` : ''}`,
                INK,
              ),
              ...(loaded
                ? [
                    bar(
                      tool('i-bar'),
                      [
                        ...PART_ORDER.filter(part => partTokens(loaded.parts[part]) > 0).map(part => ({ color: PARTS[part].color, value: partTokens(loaded.parts[part]) })),
                        { color: PARTS.other.color, value: loaded.hidden },
                      ],
                      cardCells - 2,
                      6,
                      `First request: ${formatTokens(loaded.total)} tokens`,
                    ),
                    line(
                      tool('i2'),
                      `${PART_ORDER.filter(part => partTokens(loaded.parts[part]) > 0)
                        .map(part => `${childLabel(part)} ≈${formatTokens(partTokens(loaded.parts[part]))}`)
                        .join(' · ')}${PART_ORDER.some(part => partTokens(loaded.parts[part]) > 0) ? ' · ' : ''}${formatTokens(loaded.hidden)} its system prompt, tool definitions and overhead (inferred: not exposed per subagent)`,
                    ),
                  ]
                : [line(tool('i2'), "Its messages couldn't be read, so this isn't split by part.")]),
            ]
          : asking.length
            ? [line(tool('i1'), `Request 1 sent ${duration(now - (asking[0] ?? now))} ago · its size shows when the reply reports usage`, INK)]
            : [line(tool('i1'), ended ? 'It made no request.' : 'No request yet')]),
      ])

      // Run: how far it has got, and its input request by request: how the context grows and how much comes from cache.
      const read = own.reduce((sum, one) => sum + one.tokens.cacheRead, 0)
      const input = own.reduce((sum, one) => sum + inOf(one.tokens), 0)
      const running = (agent?.callLog ?? []).filter(call => call.status === 'running').length
      const columns: Column[] = [
        ...own.map(one => ({ read: one.tokens.cacheRead, written: one.tokens.cacheWrite, fresh: one.tokens.input, out: one.tokens.output })),
        ...(ended ? [] : asking.map(() => ({ read: 0, written: 0, fresh: 0, out: 0, running: true }))),
      ].slice(-30)
      const sizes = own.map(one => formatTokens(inOf(one.tokens)))
      const run = stage(step, 2, states[2] ?? 'next', ended ? duration(endOf(step) - step.at) : own.length || asking.length ? 'live' : '', [
        line(
          tool('r1'),
          [
            plural(agent?.requests ?? 0, 'request'),
            plural(agent?.calls ?? 0, 'tool call'),
            agent?.problems ? plural(agent.problems, 'problem') : '',
            input ? `${Math.round((read / input) * 100)}% of input read from cache` : '',
          ]
            .filter(Boolean)
            .join(' · '),
          INK,
        ),
        ...(!ended && (asking.length || running)
          ? [line(tool('r2'), [asking.length ? `request ${(agent?.requests ?? 0) + 1} in flight · ${duration(now - (asking.at(-1) ?? now))}` : '', running ? `${plural(running, 'tool call')} running` : ''].filter(Boolean).join(' · '), 'suggestion')]
          : []),
        ...(Svg && columns.length
          ? [
              <Box key={tool('r-chart')} width="100%" marginTop={0.25}>
                <Svg source={svgColumns(columns, cardCells - 2, 56)} alt={`Input per request: ${sizes.join(', ')}`} />
              </Box>,
              <Text key={tool('r-legend')} wrap="wrap">
                <Text color={REREAD_BAR}>■</Text>
                <Text color={MUTED}> read from cache  </Text>
                <Text color={NEW_BAR}>▤</Text>
                <Text color={MUTED}> written to cache  </Text>
                <Text color={NEW_BAR}>■</Text>
                <Text color={MUTED}> new  </Text>
                <Text color={OUT_BAR}>■</Text>
                <Text color={MUTED}> out</Text>
              </Text>,
            ]
          : []),
        ...(sizes.length ? [line(tool('r3'), `Input per request: ${sizes.length > 6 ? '… → ' : ''}${sizes.slice(-6).join(' → ')}`)] : []),
      ])

      // Hand back: its report, and where the main agent took it in.
      const taker = later ? undefined : flow.find(one => one.kind === 'model' && step.end !== undefined && one.at >= step.end)
      const takerNo = taker ? flow.filter(one => one.kind === 'model').indexOf(taker) + 1 : 0
      const handBack = stage(step, 3, states[3] ?? 'next', ended && step.end !== undefined && !failed ? since(step.end) : '', [
        ...(failed && ended
          ? [line(tool('h1'), `${step.sub ?? 'Stopped before it finished'}: no report`, TONE.failed.text)]
          : !ended
            ? [line(tool('h1'), 'Waiting for its report')]
            : [
                line(tool('h1'), report !== undefined ? `Report ≈${formatTokens(report)} tokens · est.` : 'Report returned', INK),
                ...(taker
                  ? [
                      line(
                        tool('h2'),
                        taker.tokens ? `Main request ${takerNo} took it in: ${formatTokens(taker.tokens.input + taker.tokens.cacheWrite)} new tokens (inferred)` : `Main request ${takerNo} is reading it`,
                      ),
                    ]
                  : []),
                ...(later && !handed ? [line(tool('h2'), 'Waiting for Claude Code to deliver it')] : []),
                ...delivered.map(one =>
                  line(tool(`back-${one.id}`), `  ↩ Report handed back in “${one.title}” · ${[plural(one.requests, 'request'), one.cost || one.unpriced ? costText(one.cost, one.unpriced) : ''].filter(Boolean).join(' · ')}`),
                ),
              ]),
      ])

      // Cost: what was billed for, whether its requests add up to what Claude Code reported, and what the cache saved.
      const split = step.split
      const reported = agent?.reported
      const t = step.tokens
      const gap = reported && t ? Math.abs(inOf(reported) - inOf(t)) + Math.abs(reported.output - t.output) : 0
      const covered = (agent?.log?.length ?? 0) === (agent?.requests ?? 0)
      const saved = covered
        ? own.reduce((sum, one) => {
            const rate = rateOf(one.model)
            return rate ? sum + one.tokens.cacheRead * (rate.input - rate.cacheRead) : sum
          }, 0)
        : 0
      const cost = stage(step, 4, states[4] ?? 'next', ended ? '' : own.length ? 'so far' : '', [
        line(tool('c1'), step.cost || step.unpriced ? `${costText(step.cost, step.unpriced)} at API rates · est.` : '$0 so far', INK),
        ...(split && splitSum(split) > 0
          ? [
              bar(
                tool('c-bar'),
                [
                  { color: NEW_BAR, tone: NEW_BAR, value: split.cacheWrite },
                  { color: NEW_BAR, tone: NEW_BAR, opacity: 0.55, value: split.input },
                  { color: REREAD_BAR, tone: MUTED, value: split.cacheRead },
                  { color: OUT_BAR, tone: OUT_BAR, value: split.output },
                ],
                cardCells - 2,
                6,
                `Cost by type: ${splitText(split)}`,
              ),
              line(tool('c2'), splitText(split)),
            ]
          : []),
        ...(ended && reported && t
          ? [
              gap === 0
                ? line(tool('c3'), '✓ Its requests add up to the usage Claude Code reported at its end', 'success')
                : line(tool('c3'), `Its requests differ from the usage Claude Code reported at its end by ${formatTokens(gap)} tokens`, TONE.blocked.text),
            ]
          : []),
        ...(saved >= 0.0005 ? [line(tool('c4'), `Reading from cache saved ≈${formatCost(saved)} against sending that input uncached · est.`)] : []),
      ])

      return (
        <Box key={`lifecycle:${step.id}`} flexDirection="column">
          {rail}
          {delegate}
          {initialize}
          {run}
          {handBack}
          {cost}
        </Box>
      )
    }

    // Opened from the card: every request and tool call on the subagent's own timeline, each request
    // opening to its times, counters, cost and cache.
    const timeline = (step: Step) => {
      const agent = step.agent
      const log = agent?.log ?? []
      const calls = agent?.callLog ?? []
      const missing = Math.max(0, (agent?.requests ?? 0) - log.length)
      const from = step.at
      const whole = Math.max(1, endOf(step) - from)
      const share = (ms: number) => Math.min(1, Math.max(0, (ms - from) / whole))
      const labelCells = Math.min(30, Math.max(12, Math.floor(cardCells * 0.45)))
      const spanCells = Math.max(6, cardCells - labelCells - 6)
      type Line = { key: string; at: number; end: number; running: boolean; label: string; color: string; tone: string; open?: string; detail?: () => RenderChildren }
      const overlaps = (call: AgentCall) => calls.some(other => other.id !== call.id && other.at < (call.end ?? now) && call.at < (other.end ?? now))
      const requestDetail = (one: AgentRequest, prev: AgentRequest | undefined, prevNo: number) => () => {
        const t = one.tokens
        const cached = prev ? prev.tokens.cacheRead + prev.tokens.cacheWrite : 0
        const lineage = one.nested
          ? 'Made by a subagent it started.'
          : !prev
            ? t.cacheRead
              ? `Read ${exact(t.cacheRead)} tokens another loop had cached: which prefix isn't reported.`
              : 'Nothing read from cache: its first request writes the cache the next ones read.'
            : t.cacheRead >= cached
              ? `✓ Re-read all ${exact(cached)} tokens request ${prevNo} cached${t.cacheRead > cached ? `, and ${exact(t.cacheRead - cached)} cached elsewhere` : ''}.`
              : `Re-read ${exact(t.cacheRead)} of the ${exact(cached)} tokens request ${prevNo} cached: ${exact(cached - t.cacheRead)} were sent again (cache missed or expired).`
        return (
          <Box key={`rq-detail:${step.id}:${one.at}`} flexDirection="column" paddingLeft={2} paddingY={0} marginBottom={edge ? 0 : 0.5}>
            {kv('Time', `rqd:${one.at}:time`, `${since(one.at)} → ${since(one.end)}${one.firstToken ? ` · first token after ${duration(one.firstToken - one.at)}` : ''}`, 'observed')}
            {kv('Stopped', `rqd:${one.at}:stop`, `${one.failed ? 'failed before a reply' : (one.stopReason ?? 'no reason reported')} · ${plural(one.messages, 'message')}`)}
            {one.failed
              ? null
              : kv('Input', `rqd:${one.at}:in`, `${exact(inOf(t))} = ${exact(t.cacheRead)} read from cache + ${exact(t.cacheWrite)} written to cache + ${exact(t.input)} new`, 'observed')}
            {one.failed ? null : kv('Output', `rqd:${one.at}:out`, `${exact(t.output)} (thinking included)`, 'observed')}
            {one.failed
              ? null
              : kv('Cost', `rqd:${one.at}:cost`, one.cost === undefined ? `No known price for ${short(one.model)}` : `≈${formatCost(one.cost)}${one.split ? ` · ${splitText(one.split)}` : ''}`, 'estimated')}
            {one.parts && one.hidden !== undefined
              ? kv(
                  'Carried',
                  `rqd:${one.at}:parts`,
                  `${Object.entries(one.parts)
                    .filter(([, value]) => (value ?? 0) > 0)
                    .map(([part, value]) => `${PARTS[part as PartKey].label} ≈${formatTokens(value ?? 0)}`)
                    .join(' · ')} · the rest ${formatTokens(one.hidden)}`,
                  'estimated',
                )
              : null}
            {one.failed ? null : kv('Cache', `rqd:${one.at}:cache`, lineage, prev || t.cacheRead ? 'inferred' : undefined)}
          </Box>
        )
      }
      let prev: AgentRequest | undefined
      let prevNo = 0
      const lines: Line[] = [
        ...log.map((one, index) => {
          const n = missing + index + 1
          const entry: Line = {
            key: `rq:${step.id}:${n}`,
            at: one.at,
            end: one.end,
            running: false,
            label: `✦ Request ${n}${one.nested ? ' (nested)' : ''} · ${duration(one.end - one.at)}`,
            color: one.failed ? TONE.failed.bar : KINDS.model.bar,
            tone: one.failed ? TONE.failed.text : KINDS.model.tone,
            open: `${step.id}#${n}`,
            detail: requestDetail(one, one.nested ? undefined : prev, prevNo),
          }
          if (!one.nested) {
            prev = one
            prevNo = n
          }
          return entry
        }),
        ...(agent?.asking ?? []).map((at, index) => ({
          key: `rq-live:${step.id}:${at}`,
          at,
          end: now,
          running: true,
          label: `✦ Request ${(agent?.requests ?? 0) + index + 1} · ${duration(now - at)}…`,
          color: KINDS.model.bar,
          tone: KINDS.model.tone,
        })),
        ...calls.map(call => {
          const problem = call.status === 'failed' || call.status === 'blocked'
          return {
            key: `call:${step.id}:${call.id}`,
            at: call.at,
            end: call.end ?? now,
            running: call.status === 'running',
            label: `  ▸ ${call.name}${call.detail ? ` ${call.detail}` : ''} · ${duration((call.end ?? now) - call.at)}${call.end === undefined ? '…' : ''}${overlaps(call) ? ' ∥' : ''}`,
            color: problem ? TONE.failed.bar : KINDS.tool.bar,
            tone: problem ? TONE.failed.text : KINDS.tool.tone,
          }
        }),
      ].sort((a, b) => a.at - b.at)
      const all = (state.more ?? []).includes(step.id)
      const listed = all ? lines : lines.slice(0, REQUESTS_SHOWN * 2)
      return (
        <Box key={`timeline:${step.id}`} flexDirection="column" marginTop={edge ? 1 : 0.5}>
          <Text bold color={MUTED}>
            Requests and tool calls
          </Text>
          <Box flexDirection="row" flexWrap="nowrap" gap={1}>
            <Box width={labelCells} flexShrink={0} />
            <Box flexDirection="row" flexWrap="nowrap" justifyContent="space-between" flexGrow={1}>
              <Text color={MUTED}>0s</Text>
              <Text color={MUTED}>{duration(whole)}</Text>
            </Box>
          </Box>
          {listed.map(one => {
            const opened = one.open ? state.open.includes(one.open) : false
            const toggleOne = () => one.open && setView({ open: opened ? state.open.filter(id => id !== one.open) : [...state.open, one.open] })
            return (
              <Box key={one.key} flexDirection="column">
                <Box flexDirection="row" flexWrap="nowrap" alignItems="center" gap={1}>
                  <Box width={labelCells} flexShrink={0}>
                    <Text color={one.label.startsWith('  ') ? MUTED : INK} wrap="truncate-end">
                      {one.label}
                    </Text>
                  </Box>
                  <Box flexGrow={1} flexShrink={1}>
                    {Svg ? (
                      <Box width="100%">
                        <Svg source={svgSpan(share(one.at), share(one.end), one.color, spanCells, 6, one.running)} alt={one.label.trim()} />
                      </Box>
                    ) : (
                      <Text wrap="truncate-end">
                        {textSpan(share(one.at), share(one.end), spanCells, one.tone).map((part, at) => (
                          <Text key={`${one.key}:${at}`} color={part.color}>
                            {part.text}
                          </Text>
                        ))}
                      </Text>
                    )}
                  </Box>
                  {one.open ? (
                    <Box flexShrink={0}>
                      <Button key={`open:${one.open}`} plain dimColor onPress={toggleOne}>
                        {opened ? '▾' : '›'}
                      </Button>
                    </Box>
                  ) : null}
                </Box>
                {opened && one.detail ? one.detail() : null}
              </Box>
            )
          })}
          {lines.length > REQUESTS_SHOWN * 2 ? (
            <Button key={`more:${step.id}`} plain dimColor onPress={() => setView({ more: all ? (state.more ?? []).filter(id => id !== step.id) : [...(state.more ?? []), step.id] })}>
              {all ? 'Show fewer' : `Show all ${lines.length}`}
            </Button>
          ) : null}
          {missing > 0 ? <Text color={MUTED}>{`${plural(missing, 'earlier request')} not listed; the totals count them.`}</Text> : null}
          <Text color={MUTED} wrap="wrap">
            ∥ ran at the same time as another call · ≈ estimated · inferred: worked out from reported counts · the rest is reported
          </Text>
        </Box>
      )
    }

    // On a subagent's card in Inspect: its five stages as dots and where it is, a press away from the whole lifecycle.
    const strip = (step: Step) => {
      const life = lifeOf(step)
      return (
        <Box key={`strip:${step.id}`} flexDirection="row" flexWrap="nowrap" justifyContent="space-between" alignItems="center" gap={1} marginTop={edge ? 0 : 0.25}>
          <Text wrap="truncate-end">
            {dots(`strip:${step.id}`, life.states)}
            <Text bold color={INK}>{`  ${STAGES[life.current]}`}</Text>
            <Text color={MUTED}>{` · ${stageNote(step, life)}`}</Text>
          </Text>
          <Box flexShrink={0}>
            <Button key={`lifecycle:${step.id}`} dimColor onPress={() => setView({ mode: 'agents', open: [...new Set([...state.open, step.id])] })}>
              Lifecycle ›
            </Button>
          </Box>
        </Box>
      )
    }

    const focus = wide ? flow.find(step => step.id === state.open.at(-1)) : undefined

    if (mode === 'agents') {
      const agents = flow.filter(step => step.kind === 'agent')
      const mainModels = flow.filter(step => step.kind === 'model')
      const mainTokens = mainModels.reduce<Tokens>((sum, step) => (step.tokens ? addTokens(sum, step.tokens) : sum), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
      const mainCost = mainModels.reduce((sum, step) => sum + (step.cost ?? 0), 0)
      const mainCalls = flow.filter(step => step.kind === 'tool' || step.kind === 'skill' || step.kind === 'agent').length
      const figures = (parts: string[]) => parts.filter(Boolean).join(' · ')
      const running = agents.filter(step => step.status === 'running').length
      const peak = peakOf(agents.map(step => ({ from: step.at, to: endOf(step) })))
      const run = costsOf(turn, flow, allTurns, allSteps, ctx)
      const costs = [
        { name: 'Main agent', color: KINDS.model.bar, value: mainCost },
        ...agents.map((step, at) => ({ name: `Subagent ${at + 1} · ${step.agent?.type ?? step.title}`, color: AGENT_BARS[at % AGENT_BARS.length] ?? KINDS.agent.bar, value: step.cost ?? 0 })),
        ...(run.handBacks.length ? [{ name: `Hand-backs (${plural(run.handBacks.length, 'prompt')})`, color: KINDS.prompt.bar, value: run.back }] : []),
      ]
      const costTotal = costs.reduce((sum, one) => sum + one.value, 0)
      // Inspect opens a subagent's details here, under its card, rather than in another view.
      const opened = (id: string) => state.open.includes(id)
      const openStep = (id: string) => setView({ open: opened(id) ? state.open.filter(one => one !== id) : [...state.open, id] })

      const badgeOf = (step: Step) =>
        step.status === 'running'
          ? { text: ' ● Running ', bg: 'suggestion' }
          : isProblem(step)
            ? { text: ` ${step.label ?? 'Failed'} `, bg: TONE[step.status as 'failed' | 'blocked'].text }
            : { text: ' ✓ Done ', bg: 'success' }

      // Background commands, this prompt's first, then the rest of the session's: its history of them.
      const tasks = allSteps.filter(step => step.background || untrackedBackground(step)).sort((a, b) => b.at - a.at)
      const taskGroups = [
        { label: 'This prompt', rows: tasks.filter(step => step.turnId === turn.id) },
        { label: 'Earlier in this session', rows: tasks.filter(step => step.turnId !== turn.id) },
      ].filter(group => group.rows.length > 0)
      const taskState = (step: Step) =>
        untrackedBackground(step)
          ? { text: 'End not recorded', color: MUTED }
          : step.status === 'running'
          ? { text: 'Running', color: 'suggestion' }
          : step.status === 'ok'
            ? { text: 'Done', color: 'success' }
            : { text: step.label === 'Stopped' ? 'Stopped' : step.label === 'Not finished' ? 'Not finished' : 'Failed', color: TONE.failed.text }
      const backgroundCard = (
        <Box key="tasks:card" flexDirection="column" marginTop={1} {...surface} paddingX={2} paddingY={1}>
          <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" columnGap={2}>
            <Text bold color={INK}>
              Background tasks
            </Text>
            {tasks.length > 0 ? <Text color={MUTED}>{figures([plural(tasks.length, 'task'), tasks.some(step => step.status === 'running') ? `${tasks.filter(step => step.status === 'running').length} running` : ''])}</Text> : null}
          </Box>
          {tasks.length === 0 ? (
            <Text color={MUTED} wrap="wrap">
              No background commands in this session. When Claude starts one, it shows here while it runs and stays here afterwards.
            </Text>
          ) : (
            <Box flexDirection="column" marginTop={1} rowGap={edge ? 0 : 0.5}>
              {taskGroups.map(group => (
                <Box key={`tasks:${group.label}`} flexDirection="column" rowGap={edge ? 0 : 0.25}>
                  <Text bold color={MUTED}>
                    {group.label}
                  </Text>
                  {group.rows.map(step => {
                    const state = taskState(step)
                    const from = allTurns.find(one => one.id === step.turnId)
                    return (
                      <Box key={`task-row:${step.id}`} flexDirection="row" flexWrap="nowrap" alignItems="center" gap={1}>
                        <Box flexDirection="column" flexGrow={1} flexShrink={1}>
                          <Text color={INK} wrap="truncate-end">
                            {step.title.replace(/^Bash · /, '')}
                          </Text>
                          <Text color={MUTED} wrap="truncate-end">
                            {figures([clock(step.at), untrackedBackground(step) ? '' : duration(endOf(step) - step.at), step.turnId === turn.id ? '' : from?.title ?? ''])}
                          </Text>
                        </Box>
                        <Box flexShrink={0}>
                          <Text bold color={state.color}>
                            {state.text}
                          </Text>
                        </Box>
                        <Button key={`task:${step.id}`} plain dimColor onPress={() => setView({ mode: 'inspect', selected: step.turnId === allTurns.at(-1)?.id ? null : step.turnId, open: [step.id], filter: 'all', query: '' })}>
                          ›
                        </Button>
                      </Box>
                    )
                  })}
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )

      return (
        <Box flexDirection="column" {...page}>
          {header}
          {modes}
          <Box flexDirection="column" marginTop={1} {...surface} paddingX={2} paddingY={1}>
            <Text bold color={INK}>
              Agent topology
            </Text>
            <Text color={INK} wrap="wrap">
              {agents.length === 0
                ? 'No subagents in this prompt. When Claude starts one, it shows here with its task, model, requests, tool calls, time and cost.'
                : figures([plural(agents.length, 'subagent'), running ? `${running} running` : '', agents.length > 1 ? `up to ${peak} at once` : ''])}
            </Text>
          </Box>
          {backgroundCard}

          <Box flexDirection="row" flexWrap="nowrap" alignItems="center" gap={1} marginTop={1} {...surface} {...inset}>
            {/* The same tile as a model request's card in Inspect. */}
            {Svg ? (
              <Box key="icon:main-agent" flexShrink={0}>
                <Svg source={tileSvg('model', KINDS.model.bar)} alt="Main agent" />
              </Box>
            ) : null}
            <Box flexDirection="column" flexShrink={1} flexGrow={1}>
            <Text wrap="truncate-end">
              {Svg ? null : <Text color={KINDS.model.tone}>{`${KINDS.model.icon} `}</Text>}
              <Text bold color={INK}>
                Main agent
              </Text>
              <Text color={MUTED}>{models.length ? `  ${models.join(', ')}${efforts.length ? ` · ${efforts.join(', ')} effort` : ''}` : ''}</Text>
            </Text>
            <Text color={MUTED} wrap="truncate-end">
              {figures([
                // The main agent stands for the whole prompt, background subagents included; each subagent shows its own run.
                `${live || ranOn ? 'running' : 'took'} ${duration(elapsed)}`,
                plural(turn.requests, 'request'),
                plural(mainCalls, 'tool call'),
                inOf(mainTokens) ? `${formatTokens(inOf(mainTokens))} in · ${formatTokens(mainTokens.output)} out` : '',
                mainCost ? formatCost(mainCost) : '',
              ])}
            </Text>
            </Box>
          </Box>

          {agents.map((step, at) => {
            const last = at === agents.length - 1
            const look = badgeOf(step)
            const color = AGENT_BARS[at % AGENT_BARS.length] ?? KINDS.agent.bar
            const tone = isProblem(step) ? TONE[step.status as 'failed' | 'blocked'] : undefined
            const ran = step.end !== undefined && step.end > step.at ? duration(step.end - step.at) : step.status === 'running' ? `${duration(now - step.at)} so far` : ''
            return (
              <Box key={`agent:${step.id}`} flexDirection="column">
                <Box paddingLeft={2}>
                  <Text color={LINE}>│</Text>
                </Box>
                <Box flexDirection="row" flexWrap="nowrap">
                  <Box width={5} flexShrink={0} paddingLeft={2}>
                    <Text color={LINE}>{last ? '└─' : '├─'}</Text>
                  </Box>
                  <Box flexDirection="column" flexGrow={1} borderStyle="round" borderColor={tone ? tone.edge : hairline} {...inset}>
                    <Box flexDirection="row" flexWrap="nowrap" justifyContent="space-between" gap={1}>
                      <Box flexDirection="row" flexWrap="nowrap" alignItems="center" gap={1} flexShrink={1}>
                        {/* The same tile as the subagent's card in Inspect. */}
                        {Svg ? (
                          <Box key={`icon:agent:${step.id}`} flexShrink={0}>
                            <Svg source={tileSvg('agent', tone ? tone.bar : KINDS.agent.bar)} alt={KINDS.agent.label} />
                          </Box>
                        ) : null}
                        <Text wrap="truncate-end">
                          {Svg ? null : <Text color={tone ? tone.text : KINDS.agent.tone}>{`${KINDS.agent.icon} `}</Text>}
                          <Text bold color={INK}>
                            {step.agent?.type ?? step.title}
                          </Text>
                        </Text>
                        {badge(`agent-badge:${step.id}`, look.text, look.bg)}
                        <Text color={MUTED} wrap="truncate-end">{`${step.model ? short(step.model) : ''}${step.agent?.background ? ' · background' : ''}`}</Text>
                      </Box>
                      <Button key={`inspect:${step.id}`} dimColor onPress={() => openStep(step.id)}>
                        {opened(step.id) ? 'Hide ‹' : 'Inspect ›'}
                      </Button>
                    </Box>
                    <Text color={MUTED} wrap="truncate-end">
                      {step.details.find(detail => detail.key === 'Task')?.value ?? step.sub ?? ''}
                    </Text>
                    <Text color={INK} wrap="truncate-end">
                      {figures([
                        ran,
                        plural(step.agent?.requests ?? 0, 'request'),
                        plural(step.agent?.calls ?? 0, 'tool call'),
                        step.agent?.problems ? plural(step.agent.problems, 'problem') : '',
                        inOf(step.tokens) ? `${formatTokens(inOf(step.tokens))} in · ${formatTokens(step.tokens?.output ?? 0)} out` : '',
                        step.cost || step.unpriced ? costText(step.cost, step.unpriced) : '',
                      ])}
                    </Text>
                    <Box flexDirection="row" flexWrap="nowrap" marginTop={edge ? 0 : 0.25}>
                      {meter(step, tone ? tone.bar : color, tone ? tone.text : KINDS.agent.tone)}
                    </Box>
                    {(step.agent?.children ?? []).map((child, index) => (
                      <Text key={`child:${step.id}:${index}`} color={MUTED} wrap="truncate-end">
                        {`  ↳ ${KINDS.agent.icon} ${child.type} · ${child.task}`}
                      </Text>
                    ))}
                    {lifecycle(step)}
                    {opened(step.id) ? timeline(step) : null}
                    {opened(step.id) ? inspect(step, true) : null}
                  </Box>
                </Box>
              </Box>
            )
          })}

          {agents.length > 0 && costTotal > 0 ? (
            <Box flexDirection="column" marginTop={1} {...surface} paddingX={2} paddingY={1}>
              <Text bold color={INK}>
                Cost by agent
              </Text>
              {bar('bar:agents-cost', costs, Math.max(8, body - 10), 8, `Cost by agent, ${formatCost(costTotal)} in all`)}
              {costs.map((one, at) => (
                <Box key={`cost:${at}`} flexDirection="row" flexWrap="nowrap" justifyContent="space-between" gap={1}>
                  <Text wrap="truncate-end">
                    <Text color={one.color}>■ </Text>
                    <Text color={INK}>{one.name}</Text>
                  </Text>
                  <Text color={MUTED}>{`${formatCost(one.value)} · ${Math.round((one.value / costTotal) * 100)}%`}</Text>
                </Box>
              ))}
              {run.handBacks.length ? (
                <Text color={MUTED} wrap="wrap">
                  {`Run total ${formatCost(costTotal)} = this prompt ${formatCost(turn.cost)} + ${plural(run.handBacks.length, 'hand-back prompt')} ${formatCost(run.back)}`}
                </Text>
              ) : null}
              {run.split ? (
                <Text color={MUTED} wrap="wrap">
                  {`By type: ${splitText(run.split)}`}
                </Text>
              ) : null}
            </Box>
          ) : null}

          <Box marginTop={1}>
            <Text color={MUTED} wrap="wrap">
              Requests, calls and tokens are counted as Claude Code reports them; costs are API-rate estimates. A subagent's own subagents are counted in its figures.
            </Text>
          </Box>
          {footer}
        </Box>
      )
    }

    // Steps run oldest first, as the prompt ran; the toggle beside the filters flips them. Below 64
    // columns the meter moves under the step's text rather than squeezing it.
    // The step meter always sits on the card's right. It grows and shrinks with the list, never narrower than the
    // time plus the widest pills; a narrow list keeps only the cost pill (the tokens are on the card's left) so the bar keeps its room.
    const listCols = wide ? Math.floor(body * 0.55) : body
    const costOnly = listCols < 80
    const pillsNeed = Math.max(
      0,
      ...flow.map(step => {
        const out = step.tokens && (step.kind === 'model' || step.kind === 'agent') ? `${formatTokens(step.tokens.output)} out` : step.added ? `+${formatTokens(step.added)} tok` : ''
        const cost = step.cost ? formatCost(step.cost) : '$0'
        if (costOnly) return Svg ? pillCells(cost) : cost.length
        return Svg ? pillCells(out) + pillCells(cost) + 1 : out.length + cost.length + 2
      }),
    )
    const meterCells = Math.max(pillsNeed + 8, Math.min(40, Math.round(listCols * 0.3)))
    // Each request with what followed it, so newest first keeps a request above its calls.
    const stepGroups: (typeof shown)[] = []
    for (const one of shown) {
      const head = stepGroups.at(-1)?.[0]?.step
      if (head?.kind === 'model' && (isCall(one.step) || one.step.kind === 'hook')) stepGroups.at(-1)?.push(one)
      else stepGroups.push([one])
    }
    // Hangs a tray of calls, or a subagent's card, off the request above it by one elbow.
    const onElbow = (key: string, content: unknown) => (
      <Box key={key} flexDirection="row" flexWrap="nowrap" alignItems="flex-start" gap={0} paddingLeft={edge ? 1 : 0.5}>
        <Box key={`elbow:${key}`} flexShrink={0}>
          {Svg ? <Svg source={elbowSvg} width={ELBOW_W} height={ELBOW_H} alt="Asked for by the request above" /> : <Text color={LINE}>└─</Text>}
        </Box>
        <Box flexDirection="column" flexGrow={1} flexShrink={1} marginTop={edge ? 0 : 0.5}>
          {content}
        </Box>
      </Box>
    )
    const list = (
      <Box flexDirection="column" marginTop={1} rowGap={edge ? 0 : 1} width={wide ? '55%' : undefined}>
        {shown.length === 0 ? (
          <Box marginTop={edge}>
            <Text color={MUTED}>No steps match.</Text>
          </Box>
        ) : null}
        {(newestFirst ? [...stepGroups].reverse() : stepGroups).map(group => {
          const underRequest = group[0]?.step.kind === 'model'
          const drawn = group.map(({ step }) => {
          const kind = KINDS[step.kind]
          const tone = isProblem(step) ? TONE[step.status as 'failed' | 'blocked'] : undefined
          const isOpen = wide ? focus?.id === step.id : state.open.includes(step.id)
          // Every request and subagent shows what it read and wrote on a line of its own.
          const t = step.tokens
          const tIn = t ? t.input + t.cacheRead + t.cacheWrite : 0
          const tokens =
            t && (step.kind === 'model' || step.kind === 'agent') && tIn + t.output > 0
              ? [
                  { label: 'In', value: formatTokens(tIn) },
                  { label: 'Out', value: formatTokens(t.output) },
                  ...(tIn ? [{ label: 'Cached', value: `${Math.round((t.cacheRead / tIn) * 100)}%` }] : []),
                ]
              : undefined
          const sub = tokens ? (step.sub ?? '').replace(TOKENS_SUB, '') : (step.sub ?? '')
          // Under the title: what kind of step it is, then what it did, added and cost. Time is in the meter.
          const note = [
            sub,
            step.added && step.kind !== 'model' ? `${formatTokens(step.added)} token${step.added === 1 ? '' : 's'}` : '',
            step.cost || step.unpriced ? costText(step.cost, step.unpriced) : '',
          ]
            .filter(Boolean)
            .join(' · ')
          const iconColor = tone ? tone.bar : kind.bar
          // On the meter's top line: what a request or subagent wrote, or what another step added to the context, then its cost.
          const priced = step.kind === 'model' || step.kind === 'agent' || step.kind === 'tool' || step.kind === 'skill'
          const chips = [
            t && (step.kind === 'model' || step.kind === 'agent') ? `${formatTokens(t.output)} out` : step.added ? `+${formatTokens(step.added)} tok` : '',
            step.unpriced ? 'price ?' : step.cost ? formatCost(step.cost) : priced ? '$0' : '',
          ]
            .filter(Boolean)
            .slice(costOnly ? -1 : 0)
          const timing = meter(step, iconColor, tone ? tone.text : kind.tone, chips, meterCells)
          // The step's title line. A pill is a Box and can't sit inside a Text, so off the terminal a
          // step with a label (Check failed, Blocked by hook…) is a row: title, pill, parallel note.
          // The terminal keeps the label inline, filled.
          const batch = batchOf.get(step.id)
          const parallel =
            batch && callCount > 1 ? <Text color={MUTED}>{batch.size > 1 ? `  ⇉ parallel ${batch.place} of ${batch.size}` : '  → in sequence'}</Text> : null
          const named = (
            <Text wrap="truncate-end">
              {Svg ? null : <Text color={tone ? tone.text : kind.tone}>{`${kind.icon} `}</Text>}
              <Text bold color={tone ? tone.text : INK}>
                {step.title}
              </Text>
            </Text>
          )
          const headline =
            !edge && step.label && tone ? (
              <Box flexDirection="row" flexWrap="nowrap" alignItems="center" gap={1}>
                <Box flexShrink={1}>{named}</Box>
                {badge(`label:${step.id}`, step.label, tone.text)}
                {parallel ? <Box flexShrink={0}>{parallel}</Box> : null}
              </Box>
            ) : (
              <Text wrap="truncate-end">
                {Svg ? null : <Text color={tone ? tone.text : kind.tone}>{`${kind.icon} `}</Text>}
                <Text bold color={tone ? tone.text : INK}>
                  {step.title}
                </Text>
                {step.label && tone ? <Text> </Text> : null}
                {step.label && tone ? badge(`label:${step.id}`, step.label, tone.text) : null}
                {parallel}
              </Text>
            )
          // A tool call is one line under its request: what ran, how long, what it added. A problem or a
          // call still running in the background says so beneath; › opens the rest.
          if (step.kind === 'tool' || step.kind === 'skill') {
            const took = step.end !== undefined ? duration(step.end - step.at) : 'running'
            const facts = [took, ...(body < 40 ? [] : chips.filter(chip => chip !== '$0'))].join(' · ')
            return (
              <Box key={`slim:${step.id}`} flexDirection="column" paddingX={underRequest ? 0 : edge ? 0 : 0.5} paddingY={edge ? 0 : 0.45}>
                <Box flexDirection="row" flexWrap="nowrap" alignItems="center" gap={1}>
                  {Svg ? (
                    <Box key={`icon:${step.id}`} flexShrink={0}>
                      <Svg source={tileSvg(step.kind, iconColor)} alt={kind.label} />
                    </Box>
                  ) : null}
                  <Box flexGrow={1} flexShrink={1}>
                    <Text wrap="truncate-end">
                      {Svg ? null : <Text color={tone ? tone.text : kind.tone}>{`${kind.icon} `}</Text>}
                      <Text bold={Boolean(tone)} color={tone ? tone.text : INK}>
                        {step.title.replace(/\s*·\s*$/, '')}
                      </Text>
                      {edge && step.label && tone ? <Text> </Text> : null}
                      {edge && step.label && tone ? badge(`label:${step.id}`, step.label, tone.text) : null}
                    </Text>
                  </Box>
                  {!edge && step.label && tone ? <Box flexShrink={0}>{badge(`label:${step.id}`, step.label, tone.text)}</Box> : null}
                  {batch && batch.size > 1 && callCount > 1 ? (
                    <Box flexShrink={0}>
                      <Text color={MUTED}>{`  ⇉ parallel ${batch.place} of ${batch.size}`}</Text>
                    </Box>
                  ) : null}
                  <Box flexShrink={0}>
                    <Text color={MUTED}>{facts}</Text>
                  </Box>
                  <Box flexShrink={0}>
                    <Button key={`open:${step.id}`} plain dimColor onPress={() => toggle(step.id)}>
                      {isOpen ? (wide ? '◂' : '▾') : '›'}
                    </Button>
                  </Box>
                </Box>
                {tone || step.background ? (
                  <Text color={tone ? tone.text : MUTED} wrap="truncate-end">
                    {step.sub ?? ''}
                  </Text>
                ) : null}
                {isOpen && !wide ? inspect(step) : null}
              </Box>
            )
          }
          const stepCard = (
            <Box
              key={`step:${step.id}`}
              flexDirection="column"
              marginTop={edge}
              borderStyle="round"
              borderColor={tone ? tone.edge : isOpen && wide ? INK : hairline}
              {...inset}
            >
              <Box flexDirection="row" flexWrap="nowrap" justifyContent="space-between" alignItems="center" gap={2}>
                <Box flexDirection="row" flexWrap="nowrap" alignItems="center" gap={1} flexShrink={1} flexGrow={1}>
                  {Svg ? (
                    <Box key={`icon:${step.id}`} flexShrink={0}>
                      <Svg source={tileSvg(step.kind, iconColor)} alt={kind.label} />
                    </Box>
                  ) : null}
                  <Box flexDirection="column" flexShrink={1} flexGrow={1}>
                    {headline}
                    {tokens ? (
                      <Text wrap="truncate-end">
                        {tokens.map((one, at) => (
                          <Text key={`tok:${step.id}:${one.label}`}>
                            <Text color={MUTED}>{`${at ? '   ' : ''}${one.label} `}</Text>
                            <Text bold color={INK}>
                              {one.value}
                            </Text>
                          </Text>
                        ))}
                      </Text>
                    ) : null}
                    <Text color={MUTED} wrap="truncate-end">
                      <Text color={MUTED}>{kind.label}</Text>
                      {note ? <Text color={MUTED}>{` · ${note}`}</Text> : null}
                    </Text>
                  </Box>
                </Box>
                <Box flexDirection="row" flexWrap="nowrap" alignItems="center" gap={1} flexShrink={0}>
                  {timing}
                  {/* In its own box: VS Code pins a native button to the row's top, off centre. */}
                  <Box flexShrink={0}>
                    <Button key={`open:${step.id}`} plain dimColor onPress={() => toggle(step.id)}>
                      {isOpen ? (wide ? '◂' : '▾') : '›'}
                    </Button>
                  </Box>
                </Box>
              </Box>
              {step.kind === 'agent' ? strip(step) : null}
              {isOpen && !wide ? inspect(step) : null}
            </Box>
          )
          return underRequest && step.kind === 'agent' ? onElbow(`agent-tree:${step.id}`, stepCard) : stepCard
          })
          // Runs of slim rows under a request share one tray, hung off it by one elbow.
          const parts: unknown[] = []
          let tray: { id: string; rows: unknown[] } | undefined
          const closeTray = () => {
            if (!tray) return
            parts.push(
              onElbow(
                `tray-tree:${tray.id}`,
                <Box key={`tray:${tray.id}`} flexDirection="column" borderStyle="round" {...(edge ? { borderColor: LINE } : {})} paddingX={1} paddingY={0}>
                  {tray.rows}
                </Box>,
              ),
            )
            tray = undefined
          }
          group.forEach(({ step }, at) => {
            if (underRequest && (step.kind === 'tool' || step.kind === 'skill')) {
              tray ??= { id: step.id, rows: [] }
              if (tray.rows.length > 0 && Svg) {
                tray.rows.push(
                  <Box key={`rule:${step.id}`} width="100%">
                    <Svg source={ruleSvg} height={1} alt="" />
                  </Box>,
                )
              }
              tray.rows.push(drawn[at])
            } else {
              closeTray()
              parts.push(drawn[at])
            }
          })
          closeTray()
          return (
            <Box key={`group:${group[0]?.step.id}`} flexDirection="column">
              {parts}
            </Box>
          )
        })}
      </Box>
    )

    // What stands out in this prompt, each a link to its step.
    const longest = (list: Step[], of: (step: Step) => number) => list.reduce<Step | undefined>((best, step) => (of(step) > (best ? of(best) : 0) ? step : best), undefined)
    const tookOf = (step: Step) => (step.end !== undefined ? step.end - step.at : 0)
    const slowest = longest(
      flow.filter(step => step.kind === 'model' || isCall(step)),
      tookOf,
    )
    const costliest = longest(
      flow.filter(step => step.kind === 'model' || step.kind === 'agent'),
      step => step.cost ?? 0,
    )
    const biggest = longest(
      flow.filter(step => isCall(step) || step.kind === 'hook'),
      step => step.added ?? 0,
    )
    const waited = flow.reduce((sum, step) => {
      const asked = step.asked || (ctx.asked ?? []).includes(step.id)
      return asked && step.runMs !== undefined && step.end !== undefined ? sum + Math.max(0, step.end - step.at - step.runMs) : sum
    }, 0)
    const lowCache = flow.find(step => {
      const t = step.tokens
      const tIn = t ? t.input + t.cacheRead + t.cacheWrite : 0
      return step.kind === 'model' && t && tIn >= 5000 && t.cacheRead / tIn < 0.5
    })
    const files = turn.outcome ?? []
    const timedOps = flow.filter(step => step.kind === 'model' || isCall(step))
    const pricedOps = flow.filter(step => (step.kind === 'model' || step.kind === 'agent') && step.cost)
    const showSlowest = timedOps.length >= 2 && slowest !== undefined && tookOf(slowest) >= 1000
    const showCostliest = pricedOps.length >= 2 && Boolean(costliest?.cost)
    const showBiggest = Boolean(biggest?.added && (biggest.added ?? 0) >= 2000)
    const quiet = !showSlowest && !showCostliest && !showBiggest && !lowCache && waited < 100 && !files.length
    const insight = (label: string, step: Step | undefined, value: string) =>
      step ? (
        <Box key={`insight:${label}`} flexDirection="row" flexWrap="nowrap" alignItems="center" gap={1}>
          <Box width={16} flexShrink={0}>
            <Text color={MUTED}>{label}</Text>
          </Box>
          {/* The figure beside its label, then the step it points at: a short button, since VS Code draws
              every Button as a bordered box and a long one stretches the row. A narrow pane wraps the button below. */}
          <Box flexDirection="row" flexWrap="wrap" flexShrink={1} alignItems="center" columnGap={1.5} rowGap={edge ? 0 : 0.25}>
            <Box flexShrink={0}>
              <Text bold color={INK}>
                {value}
              </Text>
            </Box>
            <Box flexShrink={1}>
              <Button key={`insight:${label}`} dimColor onPress={() => show(step.id)}>
                {clip(step.title, 30)}
              </Button>
            </Box>
          </Box>
        </Box>
      ) : null
    // When nothing stands out, the tabs' row says so in a line; otherwise Insights is a card of its own.
    const quietCalls = flow.filter(isCall).length
    const quietNote = (
      <Box marginTop={1} flexShrink={1}>
        <Text color={MUTED} wrap="truncate-end">
          <Text color="success">✓ </Text>
          {`Nothing stands out · ${turn.requests} model request${turn.requests === 1 ? '' : 's'} · ${quietCalls || 'no'} tool call${quietCalls === 1 ? '' : 's'}`}
        </Text>
      </Box>
    )
    const insights = quiet && callCount < 2 ? null : (
      <Box flexDirection="column" marginTop={1} rowGap={edge ? 0 : 0.75} {...surface} paddingX={2} paddingY={1}>
        <Text bold color={INK}>
          Insights
        </Text>
        {insight('Slowest', showSlowest ? slowest : undefined, slowest ? duration(tookOf(slowest)) : '')}
        {insight(
          'Costliest',
          showCostliest ? costliest : undefined,
          costliest?.cost ? `${formatCost(costliest.cost)}${turn.cost ? ` · ${Math.round((costliest.cost / turn.cost) * 100)}% of prompt` : ''}` : '',
        )}
        {insight('Most context', showBiggest ? biggest : undefined, biggest?.added ? `+${formatTokens(biggest.added)}` : '')}
        {insight(
          'Low cache',
          lowCache,
          lowCache?.tokens
            ? `${Math.round((lowCache.tokens.cacheRead / (lowCache.tokens.input + lowCache.tokens.cacheRead + lowCache.tokens.cacheWrite)) * 100)}% from cache`
            : '',
        )}
        {waited >= 100 ? (
          <Box flexDirection="row" flexWrap="nowrap" gap={1}>
            <Box width={16} flexShrink={0}>
              <Text color={MUTED}>Waited for you</Text>
            </Box>
            <Text color={INK}>{`${duration(waited)} on permission prompts (inferred)`}</Text>
          </Box>
        ) : null}
        {callCount > 1 ? (
          <Box flexDirection="row" flexWrap="nowrap" gap={1}>
            <Box width={16} flexShrink={0}>
              <Text color={MUTED}>Tool calls</Text>
            </Box>
            <Text color={INK} wrap="wrap">
              {[
                inParallel.length ? `${inParallel.length} in parallel (${parallelBatches} batch${parallelBatches === 1 ? '' : 'es'})` : '',
                callCount - inParallel.length ? `${callCount - inParallel.length} one after another` : '',
              ]
                .filter(Boolean)
                .join(' · ')}
            </Text>
          </Box>
        ) : null}
        {files.length ? (
          <Box flexDirection="row" flexWrap="nowrap" gap={1}>
            <Box width={16} flexShrink={0}>
              <Text color={MUTED}>Changed files</Text>
            </Box>
            <Text color={INK} wrap="truncate-end">
              {`${files.length} file${files.length === 1 ? '' : 's'} · +${files.reduce((sum, file) => sum + (file.added ?? 0), 0)} −${files.reduce((sum, file) => sum + (file.removed ?? 0), 0)} against the last commit`}
            </Text>
          </Box>
        ) : null}
        {files.slice(0, 6).map(file => (
          <Box key={`file:${file.path}`} flexDirection="row" flexWrap="nowrap" justifyContent="space-between" gap={1} paddingLeft={17}>
            <Text color={INK} wrap="truncate-start">
              {file.path}
            </Text>
            <Text color={MUTED}>{file.added === undefined ? 'edited' : `+${file.added} −${file.removed ?? 0}`}</Text>
          </Box>
        ))}
        {files.length > 6 ? (
          <Box paddingLeft={17}>
            <Text color={MUTED}>{`${files.length - 6} more`}</Text>
          </Box>
        ) : null}
      </Box>
    )

    const panel = (
      <Box flexDirection="column" flexGrow={1} marginTop={1} {...surface} paddingX={2} paddingY={1}>
        {focus ? (
          <Box flexDirection="column">
            <Text wrap="truncate-end">
              <Text color={KINDS[focus.kind].tone}>{`${KINDS[focus.kind].icon} `}</Text>
              <Text bold color={INK}>
                {`${String(flow.indexOf(focus) + 1)}. ${KINDS[focus.kind].label}`}
              </Text>
            </Text>
            <Text bold color={INK} wrap="wrap">
              {focus.title}
            </Text>
            {focus.sub ? (
              <Text color={MUTED} wrap="wrap">
                {focus.sub}
              </Text>
            ) : null}
            {inspect(focus)}
          </Box>
        ) : (
          <Text color={MUTED}>Press › on a step to inspect it here.</Text>
        )}
      </Box>
    )

    return (
      <Box flexDirection="column" {...page}>
        {header}
        <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" alignItems="center" columnGap={2}>
          {modes}
          {insights ? null : quietNote}
        </Box>
        {insights}
        {toolbar}
        {wide ? (
          <Box flexDirection="row" flexWrap="nowrap" gap={1}>
            {list}
            {panel}
          </Box>
        ) : (
          list
        )}
        {footer}
      </Box>
    )
  })
}
