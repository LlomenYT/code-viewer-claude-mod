// Line-based tokenizers for the languages the mod colors itself. Each takes a line and
// the state left by the previous one (open comment, template, fence) and returns both.
// Other languages are left to Claude Code's own highlighter.

export type Kind =
  | 'plain'
  | 'keyword'
  | 'string'
  | 'number'
  | 'comment'
  | 'function'
  | 'type'
  | 'constant'
  | 'operator'
  | 'punctuation'
  | 'property'
  | 'tag'
  | 'heading'
  | 'link'

export type Span = [kind: Kind, text: string]
export type Lexed = { spans: Span[]; state: string }
export type Lang = 'js' | 'jsx' | 'python' | 'json' | 'yaml' | 'markdown'

const EXTENSIONS: Record<string, Lang> = {
  js: 'js',
  mjs: 'js',
  cjs: 'js',
  ts: 'js',
  mts: 'js',
  cts: 'js',
  jsx: 'jsx',
  tsx: 'jsx',
  py: 'python',
  pyi: 'python',
  json: 'json',
  jsonc: 'json',
  json5: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
}

/** The language the mod themes a path in, or undefined when it has none for it. */
export function languageOf(path: string): Lang | undefined {
  const name = (path.split(/[\\/]/).pop() ?? '').toLowerCase()
  const dot = name.lastIndexOf('.')

  return dot < 0 ? undefined : EXTENSIONS[name.slice(dot + 1)]
}

export function tokenizeLine(language: Lang, line: string, state: string): Lexed {
  switch (language) {
    case 'js':
      return jsLine(line, state, false)
    case 'jsx':
      return jsLine(line, state, true)
    case 'python':
      return pythonLine(line, state)
    case 'json':
      return jsonLine(line, state)
    case 'yaml':
      return yamlLine(line)
    case 'markdown':
      return markdownLine(line, state)
  }
}

/** The state entering the line after `lines`, starting from a file's first line. */
export function stateAfter(language: Lang, lines: readonly string[]): string {
  let state = ''

  for (const line of lines) {
    state = tokenizeLine(language, line, state).state
  }

  return state
}

// --- shared pieces ---------------------------------------------------------

type SpanCollector = { spans: Span[]; push: (kind: Kind, text: string) => void }

function createCollector(): SpanCollector {
  const spans: Span[] = []

  return {
    spans,
    push(kind, text) {
      if (text === '') {
        return
      }

      const last = spans[spans.length - 1]

      // Blank text takes the color of what it follows: fewer spans to draw.
      if (last !== undefined && (last[0] === kind || text.trim() === '')) {
        last[1] += text
      } else {
        spans.push([kind, text])
      }
    },
  }
}

/** The text a sticky pattern matches exactly at `position`, if any. */
function matchAt(pattern: RegExp, line: string, position: number): string | undefined {
  pattern.lastIndex = position

  return pattern.exec(line)?.[0]
}

/** The index of the quote closing a string opened before `from`, or -1. */
function closing(line: string, from: number, quote: string): number {
  for (let position = from; position < line.length; position++) {
    if (line[position] === '\\') {
      position++
    } else if (line.startsWith(quote, position)) {
      return position
    }
  }

  return -1
}

// States carried to the next line.
const IN_BLOCK_COMMENT = 'c'
const IN_TEMPLATE_STRING = 't'
// What the previous token was, where only its kind matters.
const AFTER_WORD = 'a'
const AFTER_NUMBER = '0'

const SPACE = /\s+/y
const WORD = /[A-Za-z_$][\w$]*/y
const NUMBER =
  /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|\d[\d_]*(?:\.[\d_]+)?(?:[eE][+-]?\d+)?)[nNjJ]?/y
const OPERATOR = /[+\-*/%=&|^!<>?:~@]+/y
const CALL = /\s*\(/y
const ALL_CAPS = /^[A-Z][A-Z0-9_]+$/

// --- JavaScript, TypeScript, JSX -------------------------------------------

const JS_KEYWORDS = new Set(
  (
    'abstract accessor as asserts async await break case catch class const continue ' +
    'debugger declare default delete do else enum export extends finally for from ' +
    'function get if implements import in infer instanceof interface is keyof let ' +
    'namespace new of out override package private protected public readonly return ' +
    'satisfies set static super switch throw try type typeof using var void while with yield'
  ).split(' '),
)
const JS_CONSTANTS = new Set(['true', 'false', 'null', 'undefined', 'this', 'NaN', 'Infinity'])
const JS_TYPES = new Set([
  'string',
  'number',
  'boolean',
  'any',
  'unknown',
  'never',
  'object',
  'symbol',
  'bigint',
])
const JSX_TAG = /<\/?[A-Za-z][\w.$-]*|<\/?>/y

/** The index of the slash closing a regex literal opened before `from`, or -1. */
function regexEnd(line: string, from: number): number {
  let isInClass = false

  for (let position = from; position < line.length; position++) {
    const char = line[position]

    if (char === '\\') {
      position++
    } else if (char === '[') {
      isInClass = true
    } else if (char === ']') {
      isInClass = false
    } else if (char === '/' && !isInClass) {
      return position
    }
  }

  return -1
}

function jsLine(line: string, entering: string, isJsx: boolean): Lexed {
  const output = createCollector()
  let state = ''
  let position = 0
  // After a value, `/` divides and `<` compares; otherwise they open a regex or a JSX tag.
  let isAfterValue = false
  let previous = ''

  if (entering === IN_BLOCK_COMMENT) {
    const end = line.indexOf('*/')

    if (end < 0) {
      output.push('comment', line)

      return { spans: output.spans, state: IN_BLOCK_COMMENT }
    }

    output.push('comment', line.slice(0, end + 2))
    position = end + 2
  } else if (entering === IN_TEMPLATE_STRING) {
    const end = closing(line, 0, '`')

    if (end < 0) {
      output.push('string', line)

      return { spans: output.spans, state: IN_TEMPLATE_STRING }
    }

    output.push('string', line.slice(0, end + 1))
    position = end + 1
    isAfterValue = true
  }

  while (position < line.length) {
    const char = line[position] ?? ''
    const space = matchAt(SPACE, line, position)

    if (space !== undefined) {
      output.push('plain', space)
      position += space.length
      continue
    }

    if (line.startsWith('//', position)) {
      output.push('comment', line.slice(position))
      break
    }

    if (line.startsWith('/*', position)) {
      const end = line.indexOf('*/', position + 2)

      if (end < 0) {
        output.push('comment', line.slice(position))
        state = IN_BLOCK_COMMENT
        break
      }

      output.push('comment', line.slice(position, end + 2))
      position = end + 2
      continue
    }

    if (char === '"' || char === "'") {
      const end = closing(line, position + 1, char)
      const stop = end < 0 ? line.length : end + 1

      output.push('string', line.slice(position, stop))
      position = stop
      isAfterValue = true
      previous = char
      continue
    }

    if (char === '`') {
      const end = closing(line, position + 1, '`')

      if (end < 0) {
        output.push('string', line.slice(position))
        state = IN_TEMPLATE_STRING
        break
      }

      output.push('string', line.slice(position, end + 1))
      position = end + 1
      isAfterValue = true
      previous = char
      continue
    }

    if (char >= '0' && char <= '9') {
      const number = matchAt(NUMBER, line, position) ?? char

      output.push('number', number)
      position += number.length
      isAfterValue = true
      previous = AFTER_NUMBER
      continue
    }

    const word = matchAt(WORD, line, position)

    if (word !== undefined) {
      const isCalled = matchAt(CALL, line, position + word.length) !== undefined
      let kind: Kind = 'plain'

      if (previous === '.') {
        kind = isCalled ? 'function' : 'property'
      } else if (JS_KEYWORDS.has(word)) {
        kind = 'keyword'
      } else if (JS_CONSTANTS.has(word)) {
        kind = 'constant'
      } else if (isCalled) {
        kind = 'function'
      } else if (ALL_CAPS.test(word)) {
        kind = 'constant'
      } else if (/^[A-Z]/.test(word) || JS_TYPES.has(word)) {
        kind = 'type'
      }

      output.push(kind, word)
      position += word.length
      isAfterValue = kind !== 'keyword'
      previous = AFTER_WORD
      continue
    }

    if (isJsx && char === '<' && !isAfterValue) {
      const tag = matchAt(JSX_TAG, line, position)

      if (tag !== undefined) {
        const name = tag.replace(/^<\/?/, '')

        output.push('punctuation', tag.slice(0, tag.length - name.length))
        output.push('tag', name)
        position += tag.length
        previous = AFTER_WORD
        continue
      }
    }

    if (char === '/' && !isAfterValue && line[position + 1] !== ' ' && line[position + 1] !== '=') {
      const end = regexEnd(line, position + 1)

      if (end > 0) {
        const flags = matchAt(/[a-z]*/y, line, end + 1) ?? ''

        output.push('string', line.slice(position, end + 1) + flags)
        position = end + 1 + flags.length
        isAfterValue = true
        previous = '/'
        continue
      }
    }

    const operator = matchAt(OPERATOR, line, position)

    if (operator !== undefined) {
      output.push('operator', operator)
      position += operator.length
      isAfterValue = false
      previous = operator
      continue
    }

    output.push('{}()[];,.#'.includes(char) ? 'punctuation' : 'plain', char)
    position += 1
    isAfterValue = char === ')' || char === ']'
    // `...` is a spread, not a member access.
    previous = char === '.' && previous === '.' ? '..' : char
  }

  return { spans: output.spans, state }
}

// --- Python ----------------------------------------------------------------

const PY_KEYWORDS = new Set(
  (
    'and as assert async await break case class continue def del elif else except ' +
    'finally for from global if import in is lambda match nonlocal not or pass raise ' +
    'return try while with yield'
  ).split(' '),
)
const PY_CONSTANTS = new Set(['True', 'False', 'None', 'self', 'cls', 'NotImplemented'])
const PY_STRING = /[rRbBfFuU]{0,2}("""|'''|"|')/y
const PY_DECORATOR = /@[\w.]+/y

function pythonLine(line: string, entering: string): Lexed {
  const output = createCollector()
  let state = ''
  let position = 0
  let previous = ''
  let previousWord = ''

  if (entering !== '') {
    const end = line.indexOf(entering)

    if (end < 0) {
      output.push('string', line)

      return { spans: output.spans, state: entering }
    }

    output.push('string', line.slice(0, end + 3))
    position = end + 3
  }

  while (position < line.length) {
    const char = line[position] ?? ''
    const space = matchAt(SPACE, line, position)

    if (space !== undefined) {
      output.push('plain', space)
      position += space.length
      continue
    }

    if (char === '#') {
      output.push('comment', line.slice(position))
      break
    }

    const opener = matchAt(PY_STRING, line, position)

    if (opener !== undefined) {
      const quote = opener.replace(/^[a-zA-Z]+/, '')
      const from = position + opener.length
      const end = quote.length === 3 ? line.indexOf(quote, from) : closing(line, from, quote)

      if (end < 0) {
        output.push('string', line.slice(position))
        state = quote.length === 3 ? quote : ''
        break
      }

      output.push('string', line.slice(position, end + quote.length))
      position = end + quote.length
      previous = quote
      continue
    }

    if (char === '@' && line.slice(0, position).trim() === '') {
      const decorator = matchAt(PY_DECORATOR, line, position) ?? char

      output.push('function', decorator)
      position += decorator.length
      continue
    }

    if (char >= '0' && char <= '9') {
      const number = matchAt(NUMBER, line, position) ?? char

      output.push('number', number)
      position += number.length
      previous = AFTER_NUMBER
      continue
    }

    const word = matchAt(WORD, line, position)

    if (word !== undefined) {
      const isCalled = matchAt(CALL, line, position + word.length) !== undefined
      let kind: Kind = 'plain'

      if (previousWord === 'def') {
        kind = 'function'
      } else if (previousWord === 'class') {
        kind = 'type'
      } else if (previous === '.') {
        kind = isCalled ? 'function' : 'property'
      } else if (PY_KEYWORDS.has(word)) {
        kind = 'keyword'
      } else if (PY_CONSTANTS.has(word)) {
        kind = 'constant'
      } else if (ALL_CAPS.test(word)) {
        kind = 'constant'
      } else if (/^[A-Z]/.test(word)) {
        kind = 'type'
      } else if (isCalled) {
        kind = 'function'
      }

      output.push(kind, word)
      position += word.length
      previous = AFTER_WORD
      previousWord = word
      continue
    }

    const operator = matchAt(OPERATOR, line, position)

    if (operator !== undefined) {
      output.push('operator', operator)
      position += operator.length
      previous = operator
      previousWord = ''
      continue
    }

    output.push('{}()[];,.'.includes(char) ? 'punctuation' : 'plain', char)
    position += 1
    previous = char
    previousWord = ''
  }

  return { spans: output.spans, state }
}

// --- JSON (with comments) --------------------------------------------------

const JSON_NUMBER = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y
const JSON_WORD = /[A-Za-z_$][\w$]*/y
const COLON_AHEAD = /\s*:/y

function jsonLine(line: string, entering: string): Lexed {
  const output = createCollector()
  let state = ''
  let position = 0

  if (entering === IN_BLOCK_COMMENT) {
    const end = line.indexOf('*/')

    if (end < 0) {
      output.push('comment', line)

      return { spans: output.spans, state: IN_BLOCK_COMMENT }
    }

    output.push('comment', line.slice(0, end + 2))
    position = end + 2
  }

  while (position < line.length) {
    const char = line[position] ?? ''
    const space = matchAt(SPACE, line, position)

    if (space !== undefined) {
      output.push('plain', space)
      position += space.length
      continue
    }

    if (line.startsWith('//', position)) {
      output.push('comment', line.slice(position))
      break
    }

    if (line.startsWith('/*', position)) {
      const end = line.indexOf('*/', position + 2)

      if (end < 0) {
        output.push('comment', line.slice(position))
        state = IN_BLOCK_COMMENT
        break
      }

      output.push('comment', line.slice(position, end + 2))
      position = end + 2
      continue
    }

    if (char === '"' || char === "'") {
      const end = closing(line, position + 1, char)
      const stop = end < 0 ? line.length : end + 1
      const isKey = matchAt(COLON_AHEAD, line, stop) !== undefined

      output.push(isKey ? 'property' : 'string', line.slice(position, stop))
      position = stop
      continue
    }

    const number = matchAt(JSON_NUMBER, line, position)

    if (number !== undefined) {
      output.push('number', number)
      position += number.length
      continue
    }

    const word = matchAt(JSON_WORD, line, position)

    if (word !== undefined) {
      const isKey = matchAt(COLON_AHEAD, line, position + word.length) !== undefined

      output.push(isKey ? 'property' : 'constant', word)
      position += word.length
      continue
    }

    output.push('{}[],:'.includes(char) ? 'punctuation' : 'plain', char)
    position += 1
  }

  return { spans: output.spans, state }
}

// --- YAML ------------------------------------------------------------------

const YAML_LEAD = /\s*(?:-\s+)*/y
const YAML_KEY = /(?:"[^"]*"|'[^']*'|[^\s#:"'&*!|>{}[\],-][^:#]*?|-[^\s:#][^:#]*?)(?=\s*:(?:\s|$))/y
const YAML_ANCHOR = /[&*!][^\s,\]}]*/y
const YAML_CONSTANT = /^(?:true|false|null|yes|no|on|off|~)$/i
const YAML_NUMBER = /^[-+]?(?:\d[\d_]*(?:\.\d+)?(?:[eE][-+]?\d+)?|0x[\da-fA-F]+|\.inf|\.nan)$/i

function yamlLine(line: string): Lexed {
  const output = createCollector()
  const lead = matchAt(YAML_LEAD, line, 0) ?? ''
  let position = lead.length
  let depth = 0

  if (lead !== '') {
    const indent = lead.length - lead.trimStart().length

    output.push('plain', lead.slice(0, indent))
    output.push('punctuation', lead.slice(indent))
  }

  if (/^(?:---|\.\.\.)\s*$/.test(line)) {
    output.push('punctuation', line.slice(position))

    return { spans: output.spans, state: '' }
  }

  const key = matchAt(YAML_KEY, line, position)

  if (key !== undefined) {
    output.push('property', key)
    position += key.length
  }

  while (position < line.length) {
    const char = line[position] ?? ''
    const space = matchAt(SPACE, line, position)

    if (space !== undefined) {
      output.push('plain', space)
      position += space.length
      continue
    }

    if (char === '#' && (position === 0 || /\s/.test(line[position - 1] ?? ''))) {
      output.push('comment', line.slice(position))
      break
    }

    if (char === '"' || char === "'") {
      const end = closing(line, position + 1, char)
      const stop = end < 0 ? line.length : end + 1

      output.push('string', line.slice(position, stop))
      position = stop
      continue
    }

    if ('{['.includes(char)) {
      depth += 1
      output.push('punctuation', char)
      position += 1
      continue
    }

    if ('}]'.includes(char)) {
      depth = Math.max(0, depth - 1)
      output.push('punctuation', char)
      position += 1
      continue
    }

    if (char === ':' || (char === ',' && depth > 0)) {
      output.push('punctuation', char)
      position += 1
      continue
    }

    const anchor = matchAt(YAML_ANCHOR, line, position)

    if (anchor !== undefined && anchor.length > 1) {
      output.push('type', anchor)
      position += anchor.length
      continue
    }

    if ((char === '|' || char === '>') && /^[|>][-+\d]*\s*(?:#.*)?$/.test(line.slice(position))) {
      output.push('operator', char)
      position += 1
      continue
    }

    // A bare scalar runs up to a comment, or to the next separator inside [] or {}.
    let stop = position

    while (stop < line.length) {
      const stopChar = line[stop] ?? ''

      if (stopChar === '#' && /\s/.test(line[stop - 1] ?? '')) {
        break
      }

      if (depth > 0 && ',]}'.includes(stopChar)) {
        break
      }

      if (stopChar === ':' && /^:(?:\s|$)/.test(line.slice(stop))) {
        break
      }

      stop += 1
    }

    stop = Math.max(stop, position + 1)

    const scalar = line.slice(position, stop)
    const bare = scalar.trim()

    output.push(
      YAML_CONSTANT.test(bare) ? 'constant' : YAML_NUMBER.test(bare) ? 'number' : 'string',
      scalar,
    )
    position = stop
  }

  return { spans: output.spans, state: '' }
}

// --- Markdown --------------------------------------------------------------

const MD_FENCE = /^\s*(```+|~~~+)/
const MD_LIST = /\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/y
const MD_INLINE = /`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|!?\[[^\]]*\]\([^)]*\)|<https?:[^>\s]+>|<\/?[A-Za-z][^>]*>/g

function markdownLine(line: string, entering: string): Lexed {
  const output = createCollector()
  const fence = MD_FENCE.exec(line)

  if (entering !== '') {
    // Inside a fence: it closes on a fence of the same mark.
    if (fence !== null && (fence[1] ?? '').startsWith(entering)) {
      output.push('punctuation', line)

      return { spans: output.spans, state: '' }
    }

    output.push('string', line)

    return { spans: output.spans, state: entering }
  }

  if (fence !== null) {
    const mark = fence[0]

    output.push('punctuation', mark)
    output.push('type', line.slice(mark.length))

    return { spans: output.spans, state: (fence[1] ?? '```').slice(0, 3) }
  }

  if (/^#{1,6}(?:\s|$)/.test(line)) {
    output.push('heading', line)

    return { spans: output.spans, state: '' }
  }

  if (/^\s*>/.test(line)) {
    output.push('comment', line)

    return { spans: output.spans, state: '' }
  }

  if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
    output.push('punctuation', line)

    return { spans: output.spans, state: '' }
  }

  let position = 0
  const marker = matchAt(MD_LIST, line, 0)

  if (marker !== undefined) {
    output.push('punctuation', marker)
    position = marker.length
  }

  MD_INLINE.lastIndex = position

  for (let found = MD_INLINE.exec(line); found !== null; found = MD_INLINE.exec(line)) {
    const text = found[0]

    output.push('plain', line.slice(position, found.index))

    if (text.startsWith('`')) {
      output.push('string', text)
    } else if (text.startsWith('**') || text.startsWith('__')) {
      output.push('keyword', text)
    } else if (text.startsWith('<') && !/^<https?:/.test(text)) {
      output.push('tag', text)
    } else {
      output.push('link', text)
    }

    position = found.index + text.length
  }

  output.push('plain', line.slice(position))

  return { spans: output.spans, state: '' }
}
