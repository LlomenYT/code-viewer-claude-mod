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
export type Lang = 'js' | 'jsx' | 'python' | 'json' | 'yaml' | 'markdown' | CLang
type CLang = 'swift' | 'kotlin' | 'dart' | 'java' | 'c' | 'csharp' | 'go' | 'rust'

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
  swift: 'swift',
  kt: 'kotlin',
  kts: 'kotlin',
  dart: 'dart',
  java: 'java',
  // C, C++ and Objective-C share one tokenizer: a `.h` can be any of them.
  c: 'c',
  h: 'c',
  cc: 'c',
  cpp: 'c',
  cxx: 'c',
  hh: 'c',
  hpp: 'c',
  hxx: 'c',
  ipp: 'c',
  inl: 'c',
  ino: 'c',
  m: 'c',
  mm: 'c',
  cs: 'csharp',
  csx: 'csharp',
  go: 'go',
  rs: 'rust',
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
    case 'swift':
    case 'kotlin':
    case 'dart':
    case 'java':
    case 'c':
    case 'csharp':
    case 'go':
    case 'rust':
      return cFamilyLine(C_FAMILIES[language], line, state)
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

// --- C family: Swift, Kotlin, Dart, Java, C/C++/Objective-C, C#, Go, Rust ----

// What a string's `$name`, `${…}` or `\(…)` interpolates, if anything.
type Interpolation = '' | '$' | '\\'
type StringRule = { close: string; isRaw: boolean; interpolation: Interpolation; isMultiline: boolean }

type CFamily = {
  keywords: Set<string>
  /** Keywords only where another word follows, as in `data class`: elsewhere names. */
  softKeywords: Set<string>
  constants: Set<string>
  /** Lower-case built-in types: a capitalized word is a type in every one of these languages. */
  types: Set<string>
  /** Words that name the function or the type after them: `func`, `class`. */
  declaresFunction: Set<string>
  declaresType: Set<string>
  /** A string's opening, sticky, and the rule of the string it opens. */
  stringOpener: RegExp
  openString: (opener: string) => StringRule
  /** A character literal, sticky, where `'` opens one. */
  char?: RegExp
  /** The color of `@Name`, where it is an annotation or an attribute. */
  annotation?: Kind
  hasNestedComments: boolean
  /** `#include`, `#if`, `#region` at a line's start. */
  hasPreprocessor: boolean
  /** Swift's `#available`, `#Preview`. */
  hasHashKeywords: boolean
  /** Rust's `#[derive(…)]`, `println!(…)` and `'a`. */
  isRust: boolean
  /** `` `default` ``: a name in backticks. */
  hasQuotedNames: boolean
  /** `Text(…)` builds a type rather than calling a function. */
  constructsCapitalized: boolean
  /** `child: Text(…)`: a word before `:` at a line's start or after `(`, `,` or `[` is a label. */
  hasLabels: boolean
  /** `list.filter { … }` calls `filter` with a lambda. */
  hasTrailingLambdas: boolean
}

const words = (text: string) => new Set(text.split(/\s+/).filter(word => word !== ''))
const NO_WORDS = new Set<string>()

function family(spec: Partial<CFamily> & Pick<CFamily, 'keywords' | 'stringOpener' | 'openString'>): CFamily {
  return {
    softKeywords: NO_WORDS,
    constants: NO_WORDS,
    types: NO_WORDS,
    declaresFunction: NO_WORDS,
    declaresType: NO_WORDS,
    hasNestedComments: false,
    hasPreprocessor: false,
    hasHashKeywords: false,
    isRust: false,
    hasQuotedNames: false,
    constructsCapitalized: true,
    hasLabels: false,
    hasTrailingLambdas: false,
    ...spec,
  }
}

const stringRule = (close: string, isRaw = false, interpolation: Interpolation = '', isMultiline = false): StringRule => ({
  close,
  isRaw,
  interpolation,
  isMultiline,
})

// A string open at a line's end: `s`, `r` (raw) or `e` (escapes), its interpolation or `-`,
// then what closes it. A block comment open at a line's end: one `c` per level.
const encodeString = (rule: StringRule) => `s${rule.isRaw ? 'r' : 'e'}${rule.interpolation || '-'}${rule.close}`
const decodeString = (state: string) =>
  stringRule(state.slice(3), state[1] === 'r', (state[2] === '-' ? '' : state[2]) as Interpolation, true)

const C_CHAR = /'(?:\\(?:u\{[\da-fA-F]+\}|u[\da-fA-F]{4}|U[\da-fA-F]{8}|x[\da-fA-F]{1,4}|[0-7]{1,3}|.)|[^'\\])'/uy
const C_NUMBER =
  /(?:0[xX][\da-fA-F_']+(?:\.[\da-fA-F_]*)?(?:[pP][+-]?\d+)?|0[bB][01_']+|0[oO][0-7_]+|\d[\d_']*(?:\.\d[\d_']*)?(?:[eE][+-]?\d[\d_]*)?)(?:[A-Za-z_]\w*)?/y
const WORD_AHEAD = /[ \t]+[A-Za-z_@`]/y
const LABEL_AHEAD = /\s*:(?!:)/y
const LAMBDA_AHEAD = /\s*\{/y
const LABEL_POSITION = new Set(['', '(', ',', '['])

const C_FAMILIES: Record<CLang, CFamily> = {
  swift: family({
    keywords: words(`associatedtype class deinit enum extension fileprivate func import init inout internal let
      operator private precedencegroup protocol public rethrows static struct subscript typealias var break case
      catch continue default defer do else fallthrough for guard if in repeat return throw switch where while as
      is try throws async await get set willSet didSet`),
    softKeywords: words(`open some any package optional dynamic required lazy weak unowned convenience mutating
      nonmutating override final indirect nonisolated isolated consuming borrowing macro actor infix prefix postfix`),
    constants: words('true false nil self Self super'),
    declaresFunction: words('func'),
    declaresType: words('class struct enum protocol extension actor typealias associatedtype'),
    // `#"…"#` is raw; `"""` spans lines; both `"` and `"""` interpolate `\(…)`.
    stringOpener: /#+"(?:"")?|"""|"/y,
    openString: opener => {
      const hashes = opener.replace(/"+$/, '')
      const quotes = opener.slice(hashes.length)

      return stringRule(quotes + hashes, hashes !== '', hashes === '' ? '\\' : '', quotes.length === 3)
    },
    annotation: 'function',
    hasNestedComments: true,
    hasHashKeywords: true,
    hasQuotedNames: true,
    hasLabels: true,
  }),
  kotlin: family({
    keywords: words(`as break class continue do else for fun if in interface is object package return throw try
      typealias typeof val var when while catch finally import init constructor`),
    softKeywords: words(`abstract actual annotation by companion const crossinline data enum expect external final
      infix inline inner internal lateinit noinline open operator out override private protected public reified
      sealed suspend tailrec value vararg where`),
    constants: words('true false null this super'),
    declaresFunction: words('fun'),
    declaresType: words('class interface object typealias'),
    stringOpener: /"""|"/y,
    openString: opener => (opener === '"""' ? stringRule('"""', true, '$', true) : stringRule('"', false, '$')),
    char: C_CHAR,
    annotation: 'function',
    hasNestedComments: true,
    hasQuotedNames: true,
    hasTrailingLambdas: true,
  }),
  dart: family({
    keywords: words(`abstract as assert async await break case catch class const continue default do else enum
      export extends factory final finally for if implements import in is late new operator required rethrow
      return static switch throw try typedef var while with yield`),
    softKeywords: words('base covariant deferred extension external get hide interface library mixin on part sealed set show sync when'),
    constants: words('true false null this super'),
    types: words('int double num bool dynamic void'),
    declaresType: words('class enum mixin extension typedef'),
    // `r'…'` is raw; triple quotes span lines; the rest interpolate `$name` and `${…}`.
    stringOpener: /[rR]?(?:"""|'''|"|')/y,
    openString: opener => {
      const quote = opener.replace(/^[rR]/, '')
      const isRaw = quote !== opener

      return stringRule(quote, isRaw, isRaw ? '' : '$', quote.length === 3)
    },
    annotation: 'function',
    hasNestedComments: true,
    hasLabels: true,
  }),
  java: family({
    keywords: words(`abstract assert break case catch class const continue default do else enum extends final
      finally for goto if implements import instanceof interface native new package private protected public
      return static strictfp switch synchronized throw throws transient try volatile while`),
    softKeywords: words('record sealed permits var yield'),
    constants: words('true false null this super'),
    types: words('boolean byte char short int long float double void'),
    declaresType: words('class interface enum record'),
    stringOpener: /"""|"/y,
    openString: opener => (opener === '"""' ? stringRule('"""', false, '', true) : stringRule('"')),
    char: C_CHAR,
    annotation: 'function',
  }),
  c: family({
    keywords: words(`alignas alignof and asm auto break case catch class concept const consteval constexpr
      constinit const_cast continue co_await co_return co_yield decltype default delete do dynamic_cast else enum
      explicit export extern for friend goto if inline mutable namespace new noexcept not operator or private
      protected public register reinterpret_cast requires restrict return sizeof static static_assert static_cast
      struct switch template thread_local throw try typedef typeid typename union using virtual volatile while xor`),
    softKeywords: words('final override import module'),
    constants: words('true false nullptr NULL this nil Nil YES NO self super'),
    types: words(`void bool _Bool char short int long float double signed unsigned size_t ssize_t ptrdiff_t
      intptr_t uintptr_t int8_t int16_t int32_t int64_t uint8_t uint16_t uint32_t uint64_t char8_t char16_t
      char32_t wchar_t id instancetype`),
    declaresType: words('class struct enum union namespace'),
    // `R"tag(…)tag"` is raw and spans lines; `@"…"` is an Objective-C string.
    stringOpener: /(?:u8|[uUL])?R"[^\s()\\"]{0,16}\(|(?:u8|[uUL@])?"/y,
    openString: opener => {
      const raw = opener.indexOf('R"')

      return raw < 0 ? stringRule('"') : stringRule(`)${opener.slice(raw + 2, -1)}"`, true, '', true)
    },
    char: C_CHAR,
    // Objective-C's `@interface`, `@property`, `@end`.
    annotation: 'keyword',
    hasPreprocessor: true,
    constructsCapitalized: false,
  }),
  csharp: family({
    keywords: words(`abstract as base break case catch checked class const continue default delegate do else enum
      event explicit extern finally fixed for foreach goto if implicit in interface internal is lock namespace new
      operator out override params private protected public readonly ref return sealed sizeof stackalloc static
      struct switch throw try typeof unchecked unsafe using virtual volatile while get set init await`),
    softKeywords: words('async var record where yield when with and or not partial global required file scoped managed unmanaged'),
    constants: words('true false null this base'),
    types: words('bool byte sbyte char decimal double float int uint long ulong short ushort object string void nint nuint dynamic'),
    declaresType: words('class struct interface enum record namespace'),
    // `"""…"""` and `@"…"` are raw and span lines.
    stringOpener: /\$*"""|\$?@\$?"|\$?"/y,
    openString: opener =>
      opener.endsWith('"""')
        ? stringRule('"""', true, '', true)
        : opener.includes('@')
          ? stringRule('"', true, '', true)
          : stringRule('"'),
    char: C_CHAR,
    hasPreprocessor: true,
    constructsCapitalized: false,
  }),
  go: family({
    keywords: words(`break case chan const continue default defer else fallthrough for func go goto if import
      interface map package range return select struct switch type var`),
    constants: words('true false nil iota'),
    types: words(`bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint
      uint8 uint16 uint32 uint64 uintptr any comparable`),
    declaresFunction: words('func'),
    declaresType: words('type'),
    stringOpener: /[`"]/y,
    openString: opener => (opener === '`' ? stringRule('`', true, '', true) : stringRule('"')),
    char: C_CHAR,
    constructsCapitalized: false,
  }),
  rust: family({
    keywords: words(`as async await break const continue crate dyn else enum extern fn for if impl in let loop
      match mod move mut pub ref return static struct super trait type unsafe use where while yield macro_rules`),
    softKeywords: words('union'),
    constants: words('true false self Self'),
    types: words('i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64 bool char str'),
    declaresFunction: words('fn'),
    declaresType: words('struct enum trait type union mod'),
    // `r#"…"#` is raw; every Rust string may span lines.
    stringOpener: /b?r#*"|[bc]?"/y,
    openString: opener => {
      const raw = /r(#*)"$/.exec(opener)

      return raw === null ? stringRule('"', false, '', true) : stringRule(`"${raw[1]}`, true, '', true)
    },
    char: new RegExp(`b?${C_CHAR.source}`, 'uy'),
    hasNestedComments: true,
    isRust: true,
  }),
}

type CLexer = { family: CFamily; line: string; output: SpanCollector; indent: number; nesting: number }

/** Lexes a block comment's text from `from`, `depth` levels open. The index after it closes, or -1. */
function blockComment(lexer: CLexer, from: number, depth: number): { position: number; depth: number } {
  const { family, line, output } = lexer
  let open = depth

  for (let position = from; position < line.length; position++) {
    if (line.startsWith('*/', position)) {
      open -= 1
      position += 1

      if (open === 0) {
        output.push('comment', line.slice(from, position + 1))

        return { position: position + 1, depth: 0 }
      }
    } else if (family.hasNestedComments && line.startsWith('/*', position) && open < MAX_NESTING) {
      open += 1
      position += 1
    }
  }

  output.push('comment', line.slice(from))

  return { position: -1, depth: open }
}

/**
 * Lexes a string's body from `from`, its opening already pushed, and its interpolations as
 * code. The index after the closing quote, or -1 at the line's end.
 */
function cFamilyString(lexer: CLexer, from: number, rule: StringRule): number {
  const { line, output } = lexer
  const hasFields = rule.interpolation !== '' && lexer.nesting < PY_MAX_NESTING
  let start = from
  let position = from

  const field = (mark: string, closer: ')' | '}') => {
    output.push('string', line.slice(start, position))
    output.push('punctuation', mark)
    lexer.nesting += 1
    position = cFamilyCode(lexer, position + mark.length, closer).position
    lexer.nesting -= 1
    start = position
  }

  while (position < line.length) {
    const char = line[position]

    if (hasFields && rule.interpolation === '\\' && line.startsWith('\\(', position)) {
      field('\\(', ')')
      continue
    }

    if (hasFields && rule.interpolation === '$' && char === '$') {
      if (line[position + 1] === '{') {
        field('${', '}')
        continue
      }

      const name = matchAt(/[A-Za-z_]\w*/y, line, position + 1)

      if (name !== undefined) {
        output.push('string', line.slice(start, position))
        output.push('punctuation', char)
        output.push('plain', name)
        position += 1 + name.length
        start = position
        continue
      }
    }

    if (!rule.isRaw && char === '\\') {
      position += 2
    } else if (line.startsWith(rule.close, position)) {
      output.push('string', line.slice(start, position + rule.close.length))

      return position + rule.close.length
    } else {
      position += 1
    }
  }

  output.push('string', line.slice(start))

  return -1
}

/**
 * Lexes code from `from` to the line's end or, inside an interpolation, to its `closer`.
 * Where it stopped, and the comment or string left open at the line's end, if any.
 */
function cFamilyCode(lexer: CLexer, from: number, closer: '' | ')' | '}'): { position: number; state: string } {
  const { family, line, output } = lexer
  const opener = closer === ')' ? '(' : '{'
  let position = from
  let previous = closer === '' ? '' : '('
  let previousWord = ''
  // Brackets opened inside an interpolation, where its closer closes them instead.
  let depth = 0

  const step = (kind: Kind, text: string, after: string) => {
    output.push(kind, text)
    position += text.length
    previous = after
    previousWord = ''
  }

  while (position < line.length) {
    const char = line[position] ?? ''
    const space = matchAt(SPACE, line, position)

    if (space !== undefined) {
      output.push('plain', space)
      position += space.length
      continue
    }

    if (closer !== '' && depth === 0 && char === closer) {
      output.push('punctuation', char)

      return { position: position + 1, state: '' }
    }

    if (line.startsWith('//', position)) {
      output.push('comment', line.slice(position))
      break
    }

    if (line.startsWith('/*', position)) {
      output.push('comment', '/*')

      const comment = blockComment(lexer, position + 2, 1)

      if (comment.position < 0) {
        return { position: line.length, state: closer === '' ? IN_BLOCK_COMMENT.repeat(comment.depth) : '' }
      }

      position = comment.position
      continue
    }

    if (char === '#' && family.hasPreprocessor && position === lexer.indent) {
      const directive = matchAt(/#\s*\w*/y, line, position) ?? char

      step('keyword', directive, AFTER_WORD)

      const header = /include|import/.test(directive) ? matchAt(/\s*<[^>\n]*>/y, line, position) : undefined

      if (header !== undefined) {
        step('string', header, '"')
      }

      continue
    }

    if (char === '#' && family.isRust) {
      const attribute = matchAt(/#!?\[[\w:]*/y, line, position)

      if (attribute !== undefined) {
        step('function', attribute, AFTER_WORD)
        continue
      }
    }

    const string = matchAt(family.stringOpener, line, position)

    if (string !== undefined) {
      const rule = family.openString(string)

      output.push('string', string)

      const end = cFamilyString(lexer, position + string.length, rule)

      if (end < 0) {
        return { position: line.length, state: rule.isMultiline && closer === '' ? encodeString(rule) : '' }
      }

      position = end
      previous = '"'
      previousWord = ''
      continue
    }

    const literal = family.char === undefined ? undefined : matchAt(family.char, line, position)

    if (literal !== undefined) {
      step('string', literal, '"')
      continue
    }

    const special =
      char === '#' && family.hasHashKeywords
        ? (['keyword', matchAt(/#[A-Za-z_]\w*/y, line, position)] as const)
        : char === '@' && family.annotation !== undefined
          ? ([family.annotation, matchAt(/@[A-Za-z_][\w.]*/y, line, position)] as const)
          : char === "'" && family.isRust
            ? (['type', matchAt(/'[A-Za-z_]\w*/y, line, position)] as const)
            : char === '`' && family.hasQuotedNames
              ? (['plain', matchAt(/`[^`]+`/y, line, position)] as const)
              : undefined

    if (special?.[1] !== undefined) {
      step(special[0], special[1], AFTER_WORD)
      continue
    }

    if (char >= '0' && char <= '9') {
      step('number', matchAt(C_NUMBER, line, position) ?? char, AFTER_NUMBER)
      continue
    }

    const word = matchAt(WORD, line, position)

    if (word !== undefined) {
      const after = position + word.length

      if (family.isRust && line[after] === '!' && /[([{]/.test(line[after + 1] ?? '')) {
        step('function', `${word}!`, AFTER_WORD)
        continue
      }

      const isCalled = matchAt(CALL, line, after) !== undefined
      const isKeyword =
        family.keywords.has(word) || (family.softKeywords.has(word) && matchAt(WORD_AHEAD, line, after) !== undefined)
      let kind: Kind = 'plain'

      if (previous === '.' && !family.constants.has(word)) {
        kind = isCalled || (family.hasTrailingLambdas && matchAt(LAMBDA_AHEAD, line, after) !== undefined) ? 'function' : 'property'
      } else if (isKeyword) {
        kind = 'keyword'
      } else if (family.declaresFunction.has(previousWord)) {
        kind = 'function'
      } else if (family.declaresType.has(previousWord)) {
        kind = 'type'
      } else if (family.constants.has(word)) {
        kind = 'constant'
      } else if (family.hasLabels && LABEL_POSITION.has(previous) && matchAt(LABEL_AHEAD, line, after) !== undefined) {
        kind = 'property'
      } else if (/^[A-Z]/.test(word) && (!isCalled || family.constructsCapitalized)) {
        kind = ALL_CAPS.test(word) && !isCalled ? 'constant' : 'type'
      } else if (isCalled) {
        kind = 'function'
      } else if (family.types.has(word)) {
        kind = 'type'
      }

      output.push(kind, word)
      position = after
      previous = AFTER_WORD
      previousWord = word
      continue
    }

    const operator = matchAt(OPERATOR, line, position)

    if (operator !== undefined) {
      step('operator', operator, operator)
      continue
    }

    if (closer !== '' && char === opener) {
      depth += 1
    } else if (closer !== '' && char === closer) {
      depth -= 1
    }

    step('{}()[];,.#'.includes(char) ? 'punctuation' : 'plain', char, char)
  }

  return { position, state: '' }
}

function cFamilyLine(family: CFamily, line: string, entering: string): Lexed {
  const output = createCollector()
  const lexer: CLexer = { family, line, output, indent: line.length - line.trimStart().length, nesting: 0 }
  let position = 0

  if (entering.startsWith(IN_BLOCK_COMMENT)) {
    const comment = blockComment(lexer, 0, entering.length)

    if (comment.position < 0) {
      return { spans: output.spans, state: IN_BLOCK_COMMENT.repeat(comment.depth) }
    }

    position = comment.position
  } else if (entering.startsWith('s')) {
    const end = cFamilyString(lexer, 0, decodeString(entering))

    if (end < 0) {
      return { spans: output.spans, state: entering }
    }

    position = end
  }

  return { spans: output.spans, state: cFamilyCode(lexer, position, '').state }
}
