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
      return yamlLine(line, state)
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

// States carried to the next line. A JS state is a stack of these, innermost last, so a
// top-level block comment is `c` and a top-level template literal `t`.
const IN_BLOCK_COMMENT = 'c'
const IN_TEMPLATE_STRING = 't'
const IN_INTERPOLATION = 'i' // `${` … `}` inside a template literal
const IN_BRACES = 'b' // `{` … `}` inside one of the frames that must find its own `}`
const IN_JSX_TAG = 'j' // between `<Name` and `>`
const IN_JSX_EXPRESSION = 'e' // `attribute={` … `}` inside a JSX tag
const MAX_NESTING = 64
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
// A word followed by these is a key or a variable being assigned, never a keyword.
const KEY_AHEAD = /\s*\??:/y
const ASSIGN_AHEAD = /\s*=(?![=>])/y

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
const JSX_ATTRIBUTE = /[A-Za-z_$][\w$]*(?:[-:][\w$]+)*/y
// `<T,>` and `<T extends U>` open a generic arrow function in TSX, not a tag.
const GENERIC_AHEAD = /\s*(?:,|extends\s)/y
// `default:` ending its line, or followed by a statement, is a switch's default.
const SWITCH_DEFAULT = /\s*:\s*(?:$|\/[/*]|\{|(?:return|break|throw|continue|case)\b)/y
// Where a word followed by `:` is an object key: first on the line, or after `{` or `,`.
const KEY_POSITION = new Set(['', '{', ','])

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

/** The index of the `` ` `` or `${` ending a template literal's text from `from`, or -1. */
function templateEnd(line: string, from: number): number {
  for (let position = from; position < line.length; position++) {
    const char = line[position]

    if (char === '\\') {
      position++
    } else if (char === '`' || (char === '$' && line[position + 1] === '{')) {
      return position
    }
  }

  return -1
}

function jsLine(line: string, entering: string, isJsx: boolean): Lexed {
  const output = createCollector()
  const stack = entering === '' ? [] : entering.split('')
  let position = 0
  // After a value, `/` divides and `<` compares; otherwise they open a regex or a JSX tag.
  let isAfterValue = false
  let previous = ''
  // Once a `/` finds no closing slash, no later one on the line will.
  let canOpenRegex = true

  const enter = (frame: string) => {
    if (stack.length < MAX_NESTING) {
      stack.push(frame)
    }
  }

  while (position < line.length) {
    const frame = stack[stack.length - 1]
    const char = line[position] ?? ''

    if (frame === IN_BLOCK_COMMENT) {
      const end = line.indexOf('*/', position)
      const stop = end < 0 ? line.length : end + 2

      output.push('comment', line.slice(position, stop))
      position = stop

      if (end >= 0) {
        stack.pop()
      }

      continue
    }

    if (frame === IN_TEMPLATE_STRING) {
      const end = templateEnd(line, position)

      if (end < 0) {
        output.push('string', line.slice(position))
        break
      }

      if (line[end] === '`') {
        output.push('string', line.slice(position, end + 1))
        stack.pop()
        position = end + 1
        isAfterValue = true
        previous = '`'
      } else {
        output.push('string', line.slice(position, end))
        output.push('punctuation', '${')
        stack.push(IN_INTERPOLATION)
        position = end + 2
        isAfterValue = false
        previous = '{'
      }

      continue
    }

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
      output.push('comment', '/*')
      stack.push(IN_BLOCK_COMMENT)
      position += 2
      continue
    }

    if (frame === IN_JSX_TAG) {
      const attribute = matchAt(JSX_ATTRIBUTE, line, position)

      if (attribute !== undefined) {
        output.push('property', attribute)
        position += attribute.length
        previous = AFTER_WORD
      } else if (char === '=') {
        output.push('operator', char)
        position += 1
        previous = char
      } else if (char === '"' || char === "'") {
        // JSX attribute strings have no escapes.
        const end = line.indexOf(char, position + 1)
        const stop = end < 0 ? line.length : end + 1

        output.push('string', line.slice(position, stop))
        position = stop
        previous = char
      } else if (char === '{') {
        output.push('punctuation', char)
        enter(IN_JSX_EXPRESSION)
        position += 1
        isAfterValue = false
        previous = char
      } else if (char === '>' || line.startsWith('/>', position)) {
        const end = char === '>' ? '>' : '/>'

        output.push('punctuation', end)
        stack.pop()
        position += end.length
        // What follows a tag is text, where a `/` is no regex.
        isAfterValue = true
        previous = '>'
      } else {
        // Nothing a tag holds: the `<` was a comparison after all.
        stack.pop()
      }

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
      if (stack.length >= MAX_NESTING) {
        output.push('string', line.slice(position))
        break
      }

      output.push('string', char)
      stack.push(IN_TEMPLATE_STRING)
      position += 1
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
      const after = position + word.length
      const isCalled = matchAt(CALL, line, after) !== undefined
      const isKeyword = JS_KEYWORDS.has(word)
      // `{ type: 'x' }`, `default?: T`, but not `case x:` or a switch's `default:`.
      const isKey =
        (isKeyword || KEY_POSITION.has(previous)) &&
        matchAt(KEY_AHEAD, line, after) !== undefined &&
        !(word === 'default' && previous !== ',' && matchAt(SWITCH_DEFAULT, line, after) !== undefined)
      let kind: Kind = 'plain'

      if (previous === '.') {
        kind = isCalled ? 'function' : 'property'
      } else if (isKey) {
        kind = 'property'
      } else if (isKeyword && matchAt(ASSIGN_AHEAD, line, after) === undefined) {
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
      position = after
      isAfterValue = kind !== 'keyword'
      previous = AFTER_WORD
      continue
    }

    if (char === '{') {
      // Braces are counted only where a `}` would close something else.
      if (stack.length > 0) {
        enter(IN_BRACES)
      }

      output.push('punctuation', char)
      position += 1
      isAfterValue = false
      previous = char
      continue
    }

    if (char === '}') {
      const top = stack[stack.length - 1]

      if (top === IN_INTERPOLATION || top === IN_BRACES || top === IN_JSX_EXPRESSION) {
        stack.pop()
      }

      output.push('punctuation', char)
      position += 1
      isAfterValue = false
      previous = char
      continue
    }

    // A tag opens after anything but a word, a number or a bracket right against the `<`,
    // which make `useState<T>(…)` a generic and `a<b` a comparison; `</` always closes one.
    if (isJsx && char === '<') {
      const isClosing = line[position + 1] === '/'
      const tag =
        isClosing || !/[\w$)\]]/.test(line[position - 1] ?? '') ? matchAt(JSX_TAG, line, position) : undefined

      if (tag !== undefined && (isClosing || matchAt(GENERIC_AHEAD, line, position + tag.length) === undefined)) {
        const name = tag.replace(/^<\/?/, '')

        if (name === '>') {
          output.push('punctuation', tag)
        } else {
          output.push('punctuation', tag.slice(0, tag.length - name.length))
          output.push('tag', name)
          enter(IN_JSX_TAG)
        }

        position += tag.length
        isAfterValue = true
        previous = AFTER_WORD
        continue
      }
    }

    if (
      char === '/' &&
      !isAfterValue &&
      canOpenRegex &&
      line[position + 1] !== ' ' &&
      line[position + 1] !== '='
    ) {
      const end = regexEnd(line, position + 1)

      if (end > 0) {
        const flags = matchAt(/[a-z]*/y, line, end + 1) ?? ''

        output.push('string', line.slice(position, end + 1) + flags)
        position = end + 1 + flags.length
        isAfterValue = true
        previous = '/'
        continue
      }

      canOpenRegex = false
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
    previous = char === '.' && (previous === '.' || previous === '..') ? `${previous}.` : char
  }

  return { spans: output.spans, state: stack.join('') }
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
const PY_TYPES = new Set(
  'bool bytearray bytes complex dict float frozenset int list memoryview object set str tuple type'.split(' '),
)
const PY_BUILTINS = new Set(
  (
    'abs aiter all anext any ascii bin breakpoint callable chr classmethod compile delattr dir ' +
    'divmod enumerate eval exec filter format getattr globals hasattr hash help hex id input ' +
    'isinstance issubclass iter len locals map max min next oct open ord pow print property ' +
    'range repr reversed round setattr slice sorted staticmethod sum super vars zip'
  ).split(' '),
)
// `match` and `case` are keywords only when they start a statement: `match = …` is a name.
const PY_SOFT_KEYWORDS = new Set(['match', 'case'])
const PY_STATEMENT_AHEAD = /[ \t]+[^\s=.,)\]}:#]/y
const PY_STRING = /[rRbBfFuU]{0,2}("""|'''|"|')/y
const PY_DECORATOR = /@[\w.]+/y
const PY_ASSIGN_AHEAD = /\s*=(?!=)/y
const PY_ANNOTATION_AHEAD = /\s*:(?!=)/y
// f-strings nest inside f-strings' fields only this deep before being read as plain strings.
const PY_MAX_NESTING = 16

type PythonLexer = { line: string; output: SpanCollector; indent: number; nesting: number }

/**
 * Lexes a string's body from `from`, its opening quote already pushed, and an f-string's
 * `{fields}` as code. The index after the closing quote, or -1 at the line's end.
 */
function pythonString(lexer: PythonLexer, from: number, quote: string, isFormatted: boolean): number {
  const { line, output } = lexer
  const hasFields = isFormatted && lexer.nesting < PY_MAX_NESTING
  let start = from
  let position = from

  while (position < line.length) {
    const char = line[position]

    if (char === '\\') {
      position += 2
    } else if (line.startsWith(quote, position)) {
      output.push('string', line.slice(start, position + quote.length))

      return position + quote.length
    } else if (hasFields && char === '{' && line[position + 1] !== '{') {
      output.push('string', line.slice(start, position))
      output.push('punctuation', char)
      lexer.nesting += 1
      position = pythonCode(lexer, position + 1, true).position
      lexer.nesting -= 1
      start = position
    } else {
      // `{{` and `}}` are escaped braces: text.
      position += hasFields && (char === '{' || char === '}') && line[position + 1] === char ? 2 : 1
    }
  }

  output.push('string', line.slice(start))

  return -1
}

/** A field's `:format spec` from `from` to the field's closing brace, nested `{}` included. */
function pythonFormatSpec(lexer: PythonLexer, from: number): number {
  const { line, output } = lexer
  let depth = 0

  for (let position = from; position < line.length; position++) {
    const char = line[position]

    if (char === '{') {
      depth += 1
    } else if (char === '}' && depth > 0) {
      depth -= 1
    } else if (char === '}') {
      output.push('string', line.slice(from, position))
      output.push('punctuation', char)

      return position + 1
    }
  }

  output.push('string', line.slice(from))

  return line.length
}

/**
 * Lexes code from `from` to the line's end or, in an f-string's field, to the field's
 * closing brace. Where it stopped, and the triple quote left open at the line's end, if any.
 */
function pythonCode(lexer: PythonLexer, from: number, isField: boolean): { position: number; state: string } {
  const { line, output } = lexer
  let position = from
  let previous = isField ? '{' : ''
  let previousWord = ''
  // Brackets opened inside a field, where `}`, `:` and `!r` do not end the expression.
  let depth = 0

  while (position < line.length) {
    const char = line[position] ?? ''
    const space = matchAt(SPACE, line, position)

    if (space !== undefined) {
      output.push('plain', space)
      position += space.length
      continue
    }

    if (isField && depth === 0) {
      if (char === '}') {
        output.push('punctuation', char)

        return { position: position + 1, state: '' }
      }

      const next = line[position + 2]

      if (char === '!' && 'rsa'.includes(line[position + 1] ?? '=') && (next === '}' || next === ':')) {
        output.push('string', line.slice(position, position + 2))
        position += 2
        continue
      }

      if (char === ':' && line[position + 1] !== '=') {
        return { position: pythonFormatSpec(lexer, position), state: '' }
      }
    }

    if (char === '#' && !isField) {
      output.push('comment', line.slice(position))
      break
    }

    const opener = matchAt(PY_STRING, line, position)

    if (opener !== undefined) {
      const quote = opener.replace(/^[a-zA-Z]+/, '')
      const isFormatted = /[fF]/.test(opener.slice(0, opener.length - quote.length))

      output.push('string', opener)

      const end = pythonString(lexer, position + opener.length, quote, isFormatted)

      if (end < 0) {
        const state = quote.length === 3 && !isField ? `${isFormatted ? 'f' : ''}${quote}` : ''

        return { position: line.length, state }
      }

      position = end
      previous = quote
      previousWord = ''
      continue
    }

    if (char === '@' && position === lexer.indent && !isField) {
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
      const after = position + word.length
      const isCalled = matchAt(CALL, line, after) !== undefined
      // `type=`, `(id: int` and `input = …` name an argument, a parameter or a variable.
      const isName =
        (previous === '' || previous === '(' || previous === ',') &&
        (matchAt(PY_ASSIGN_AHEAD, line, after) !== undefined || matchAt(PY_ANNOTATION_AHEAD, line, after) !== undefined)
      const isKeyword =
        PY_KEYWORDS.has(word) &&
        (!PY_SOFT_KEYWORDS.has(word) ||
          (position === lexer.indent && matchAt(PY_STATEMENT_AHEAD, line, after) !== undefined))
      let kind: Kind = 'plain'

      if (previousWord === 'def') {
        kind = 'function'
      } else if (previousWord === 'class') {
        kind = 'type'
      } else if (previous === '.') {
        kind = isCalled ? 'function' : 'property'
      } else if (isKeyword) {
        kind = 'keyword'
      } else if (PY_CONSTANTS.has(word)) {
        kind = 'constant'
      } else if (ALL_CAPS.test(word)) {
        kind = 'constant'
      } else if (/^[A-Z]/.test(word) || (PY_TYPES.has(word) && !isName)) {
        kind = 'type'
      } else if (isCalled || (PY_BUILTINS.has(word) && !isName)) {
        kind = 'function'
      }

      output.push(kind, word)
      position = after
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

    if (isField && '([{'.includes(char)) {
      depth += 1
    } else if (isField && ')]}'.includes(char)) {
      depth = Math.max(0, depth - 1)
    }

    output.push('{}()[];,.'.includes(char) ? 'punctuation' : 'plain', char)
    position += 1
    previous = char
    previousWord = ''
  }

  return { position, state: '' }
}

function pythonLine(line: string, entering: string): Lexed {
  const output = createCollector()
  const lexer: PythonLexer = { line, output, indent: line.length - line.trimStart().length, nesting: 0 }
  let position = 0

  // Inside a triple-quoted string: `f"""` when its `{fields}` are code.
  if (entering !== '') {
    const quote = entering.replace(/^f/, '')
    const end = pythonString(lexer, 0, quote, quote !== entering)

    if (end < 0) {
      return { spans: output.spans, state: entering }
    }

    position = end
  }

  return { spans: output.spans, state: pythonCode(lexer, position, false).state }
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
const YAML_KEY = /(?:"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s#:"'&*!|>{}[\],-][^:#]*?|-[^\s:#][^:#]*?)(?=\s*:(?:\s|$))/y
const YAML_ANCHOR = /[&*!][^\s,\]}]*/y
const YAML_CONSTANT = /^(?:true|false|null|yes|no|on|off|~)$/i
// Inside a block scalar (`key: |`): `|` and the indentation of its key, deeper lines its text.
const IN_BLOCK_SCALAR = '|'
const YAML_BLOCK_SCALAR = /^([|>][-+\d]*)\s*(?:#.*)?$/
const YAML_NUMBER = /^[-+]?(?:\d[\d_]*(?:\.\d+)?(?:[eE][-+]?\d+)?|0x[\da-fA-F]+|\.inf|\.nan)$/i

function yamlLine(line: string, entering: string): Lexed {
  const output = createCollector()
  const indent = line.length - line.trimStart().length

  if (entering.startsWith(IN_BLOCK_SCALAR)) {
    if (line.trim() === '' || indent > Number(entering.slice(1))) {
      output.push('string', line)

      return { spans: output.spans, state: entering }
    }
  }

  let state = ''
  const lead = matchAt(YAML_LEAD, line, 0) ?? ''
  let position = lead.length
  let depth = 0

  if (lead !== '') {
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

    const indicator = char === '|' || char === '>' ? YAML_BLOCK_SCALAR.exec(line.slice(position)) : null

    if (indicator !== null) {
      output.push('operator', indicator[1] ?? char)
      position += (indicator[1] ?? char).length
      // Its text is every following line indented deeper than its key, or than its `-`.
      state = `${IN_BLOCK_SCALAR}${key === undefined ? indent : lead.length}`
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

  return { spans: output.spans, state }
}

// --- Markdown --------------------------------------------------------------

// Any indentation, not CommonMark's 3 spaces: a fence nested in a list item sits deeper.
const MD_FENCE = /^\s*(`{3,}|~{3,})/
const MD_LIST = /\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/y
const MD_INLINE = /`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|!?\[[^\]]*\]\([^)]*\)|<https?:[^>\s]+>|<\/?[A-Za-z][^>]*>/g

function markdownLine(line: string, entering: string): Lexed {
  const output = createCollector()
  const fence = MD_FENCE.exec(line)

  if (entering !== '') {
    // Inside a fence, the state its mark: it closes on a run of the same character, at least
    // as long, with nothing after it. A fence line with an info string is code.
    const mark = fence?.[1] ?? ''

    if (mark[0] === entering[0] && mark.length >= entering.length && line.slice(fence?.[0].length).trim() === '') {
      output.push('punctuation', line)

      return { spans: output.spans, state: '' }
    }

    output.push('string', line)

    return { spans: output.spans, state: entering }
  }

  // A backtick fence's info string holds no backtick: ```` ```a``` ```` is inline code.
  if (fence !== null && !(fence[1]?.startsWith('`') === true && line.includes('`', fence[0].length))) {
    const mark = fence[0]

    output.push('punctuation', mark)
    output.push('type', line.slice(mark.length))

    return { spans: output.spans, state: fence[1] ?? '```' }
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
