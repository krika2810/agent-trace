const MAX_LINES = 40
const MAX_CHARS = 4000

const clipLines = (lines: string[]) => {
  const kept = lines.slice(0, MAX_LINES)
  let text = kept.join('\n')
  if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS - 1)}…`
  const more = lines.length - kept.length
  return more > 0 ? `${text}\n… ${more} more line${more === 1 ? '' : 's'}` : text
}

// A shell command laid out to read in a code block. A chain (`&&`, `||`, `;`, `|`) is broken one link
// to a line, each continuation indented with its operator leading; quotes and `$( )` are left whole.
// A command that already runs over several lines (a heredoc, a script) is kept as written.
export const formatCommand = (raw: string): string => {
  const text = raw.trim()
  if (text.includes('\n')) return clipLines(text.split('\n').map(line => line.trimEnd()))

  const lines: string[] = []
  let current = ''
  let quote = ''
  let depth = 0
  const push = (next = '') => {
    if (current.trim()) lines.push(current.trim())
    current = next
  }
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at] ?? ''
    if (quote) {
      current += char
      if (char === '\\' && quote === '"') current += text[(at += 1)] ?? ''
      else if (char === quote) quote = ''
      continue
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char
      current += char
    } else if (char === '\\') {
      current += char + (text[(at += 1)] ?? '')
    } else if (char === '(') {
      depth += 1
      current += char
    } else if (char === ')') {
      depth = Math.max(0, depth - 1)
      current += char
    } else if (depth > 0) {
      current += char
    } else if ((char === '&' || char === '|') && text[at + 1] === char) {
      at += 1
      // One space after an operator: the command's own, or one added when it had none.
      push(`${char}${char}${/\s/.test(text[at + 1] ?? ' ') ? '' : ' '}`)
    } else if (char === '|') {
      push(/\s/.test(text[at + 1] ?? ' ') ? '|' : '| ')
    } else if (char === ';') {
      current += ';'
      push()
    } else {
      current += char
    }
  }
  push()
  // A link starts with its operator and a space after it; indent only those that begin with one.
  return clipLines(lines.map((line, index) => (index > 0 && /^(&&|\|\||\|)/.test(line) ? `  ${line}` : line)))
}
