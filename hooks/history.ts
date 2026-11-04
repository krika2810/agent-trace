import type { SavedTrace } from '../types'

// One file's size: under the 4 MiB a read or write allows, with room for characters of more than one byte.
export const MAX_TRACE_CHARS = 3_000_000

// One file's worth: the oldest previews go first, then the oldest steps, counted as dropped on their
// prompts so the trace says it is partial. Undefined when even that won't fit.
export const fitTrace = (trace: SavedTrace) => {
  let fitted = trace
  let text = JSON.stringify(fitted)
  while (text.length > MAX_TRACE_CHARS) {
    const previews = fitted.steps.filter(step => step.preview)
    if (previews.length > 0) {
      const dropped = new Set(previews.slice(0, Math.ceil(previews.length / 2)).map(step => step.id))
      fitted = { ...fitted, steps: fitted.steps.map(step => (dropped.has(step.id) ? { ...step, preview: undefined } : step)) }
    } else if (fitted.steps.length > 0) {
      const cut = Math.ceil(fitted.steps.length / 4)
      const gone = fitted.steps.slice(0, cut)
      fitted = {
        ...fitted,
        steps: fitted.steps.slice(cut),
        origins: fitted.origins.slice(Math.ceil(fitted.origins.length / 4)),
        turns: fitted.turns.map(turn => {
          const lost = gone.filter(step => step.turnId === turn.id).length
          return lost ? { ...turn, evicted: (turn.evicted ?? 0) + lost } : turn
        }),
      }
    } else {
      return undefined
    }
    text = JSON.stringify(fitted)
  }
  return text
}
