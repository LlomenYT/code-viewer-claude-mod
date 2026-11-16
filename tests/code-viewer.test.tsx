import { expect, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import {
  branchesNamed,
  clean,
  findIn,
  fitHunks,
  hunksOf,
  isCode,
  mentionsOf,
  parsePatch,
  preferredBranch,
  rank,
  splitLocation,
} from '../hooks/files'
import { resolveSettings } from '../hooks/themes'
import { languageOf, stateAfter, tokenizeLine } from '../hooks/tokenize'

const PANE = {
  plugin: 'code-viewer',
  component: 'Pane',
  requestId: 'code-viewer',
  props: {
    title: 'Code',
    isFocused: false,
    bodyColumns: 80,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 30 },
    view: {},
  },
} as const

const kinds = (lang: Parameters<typeof tokenizeLine>[0], line: string, state = '') =>
  tokenizeLine(lang, line, state).spans.map(([kind, text]) => `${kind}:${text.trim()}`)

test('the tokenizer colors each language it knows', async () => {
  expect(languageOf('/a/b/App.tsx')).toBe('jsx')
  expect(languageOf('Makefile')).toBe(undefined)

  expect(kinds('js', 'const total = sum(items) // all')).toEqual([
    'keyword:const',
    'plain:total',
    'operator:=',
    'function:sum',
    'punctuation:(',
    'plain:items',
    'punctuation:)',
    'comment:// all',
  ])
  expect(kinds('jsx', 'return <Box gap={1}>')[2]).toBe('tag:Box')
  expect(kinds('python', 'def load(path): return None')).toEqual([
    'keyword:def',
    'function:load',
    'punctuation:(',
    'plain:path',
    'punctuation:)',
    'operator::',
    'keyword:return',
    'constant:None',
  ])
  expect(kinds('json', '"name": "viewer", "n": 3')).toEqual([
    'property:"name"',
    'punctuation::',
    'string:"viewer"',
    'punctuation:,',
    'property:"n"',
    'punctuation::',
    'number:3',
  ])
  expect(kinds('yaml', 'enabled: true # yes')).toEqual([
    'property:enabled',
    'punctuation::',
    'constant:true',
    'comment:# yes',
  ])
  expect(kinds('markdown', '## Install')).toEqual(['heading:## Install'])
})

test('a state is carried from one line to the next', async () => {
  expect(tokenizeLine('js', 'a /* open', '').state).toBe('c')
  expect(kinds('js', 'still */ b', 'c')).toEqual(['comment:still */', 'plain:b'])
  expect(stateAfter('python', ['x = """', 'text'])).toBe('"""')
  expect(stateAfter('markdown', ['```ts', 'const a = 1', '```'])).toBe('')
})

test('patches, locations and search read as written', async () => {
  const hunks = parsePatch('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -3,2 +3,3 @@ fn\n a\n-b\n+c\n+d\n')

  expect(hunks).toEqual([{ oldStart: 3, newStart: 3, lines: [' a', '-b', '+c', '+d'] }])
  expect(fitHunks(hunks, 2).isCut).toBe(true)
  expect(hunksOf({ structuredPatch: [{ oldStart: 1, newStart: 1, oldLines: 1, newLines: 1, lines: ['-a', '+b'] }] })).toEqual([
    { oldStart: 1, newStart: 1, lines: ['-a', '+b'] },
  ])
  expect(hunksOf({ stdout: '' })).toEqual([])
  expect(splitLocation('src/a.ts:42:7')).toEqual({ path: 'src/a.ts', line: 42 })
  expect(splitLocation('src/a.ts')).toEqual({ path: 'src/a.ts' })
  expect(rank(['src/button.tsx', 'docs/buttons.md', 'src/app.ts'], 'button', 10)).toEqual([
    'src/button.tsx',
    'docs/buttons.md',
  ])
})

test('an option overrides one color of the theme', async () => {
  const plain = resolveSettings({ theme: 'one-dark' })
  const custom = resolveSettings({ theme: 'no-such-theme', keywordColor: ' #ff0000 ', stringColor: 'bad\u0007' })

  expect(custom.theme.tokens.keyword?.color).toBe('#ff0000')
  expect(custom.theme.tokens.string?.color).toBe(plain.theme.tokens.string?.color)
  expect(resolveSettings({ highlighter: 'engine' }).isEngineOnly).toBe(true)
})

test('a press under a Read row opens the file in the pane', async ($, on) => {
  // Nothing sits beneath the plugin: each hook here stands for the engine.
  on('session.cwd', () => ({ value: '/project' }))
  on('fs.read', () => ({ value: 'const answer = 42\nexport default answer\n' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.scroll', () => ({}))
  on('ui.render', ($, event) => {
    const { Text } = $.ui.resolve(event)

    return <Text>engine row</Text>
  })

  const row = await $.ui.mount({
    plugin: 'code-viewer',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'toolu_1',
    props: {
      tool_use_id: 'toolu_1',
      tool: 'Read',
      input: { file_path: '/project/src/answer.ts' },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
    },
  })

  expect(await row.find({ type: 'Text', text: /engine row/ })).toBeDefined()
  await row.press({ key: 'open' })
  await row.unmount()

  for (const surface of ['terminal', 'desktop'] as const) {
    const pane = await $.ui.mount({ ...PANE, surface })

    expect((await pane.find({ type: 'Text', text: /src\/answer\.ts/ }))?.text).toContain('lines 1-2 of 2')
    expect(await pane.find({ type: 'Text', text: /^const $/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /42/ })).toBeDefined()
    await pane.unmount()
  }
})

test('the pane with nothing opened says how to open something', async $ => {
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await pane.find({ type: 'Text', text: /view code/ })).toBeDefined()
  await pane.unmount()
})

test('paths are picked out of an answer', async () => {
  expect(
    mentionsOf('In /Users/me/repo/: I changed `src/a.ts:12` and README.md, on version 2.1.3. See src/a.ts.', 10),
  ).toEqual({ files: ['src/a.ts', 'README.md'], folders: ['/Users/me/repo'] })
  expect(mentionsOf('Fichero: /repo/app/main.py', 10)).toEqual({ files: ['/repo/app/main.py'], folders: ['/repo/app'] })
})

test('a path Claude names is found under the folder it names, and typing narrows the list', async ($, on) => {
  on('session.cwd', () => ({ value: '/project' }))
  on('fs.stat', ($, event) => {
    const path = String((event as { path?: unknown }).path)

    if (!path.startsWith('/sandbox/api/app/')) {
      throw new Error('missing')
    }

    return { value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', () => ({ value: 'x = 1\n' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.scroll', () => ({}))

  on('turn.complete', ($, event) => ({ text: event.answer }))

  await $.turn.complete({
    answer: 'En /sandbox/api/:\nFichero: app/comms/business.py\nFichero: app/comms/services.py\nnotas.txt',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await pane.find({ type: 'Button', key: 'touched-1' })).toBeDefined()
  expect(await pane.find({ type: 'Button', key: 'touched-2' })).toBe(undefined)
  // Part of the path, as Claude might shorten it, is enough.
  await pane.input({ key: 'search', text: 'comms/serv', kind: 'change' })
  expect(await pane.find({ type: 'Button', key: 'found-0' })).toBeDefined()
  expect(await pane.find({ type: 'Button', key: 'found-1' })).toBe(undefined)
  expect(await pane.find({ type: 'Button', key: 'touched-0' })).toBe(undefined)
  await pane.input({ key: 'search', text: 'comms/serv' })
  expect(await pane.find({ type: 'Text', text: /^services\.py$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /lines 1-1 of 1/ })).toBeDefined()
  await pane.unmount()
})

test('a shortened path finds the file in another repository Claude worked in', async ($, on) => {
  on('session.cwd', () => ({ value: '/project' }))
  on('clock.now', () => ({ value: 0 }))
  on('process.run', ($, event) => {
    const { argv } = event
    const cwd = event.init?.cwd
    const out = argv.includes('rev-parse')
      ? '/sandbox/api\n'
      : cwd === '/sandbox/api'
        ? 'app/modules/billing/utils/utils.py\napp/main.py\nnotes.txt\n'
        : 'src/other.ts\n'

    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.stat', () => {
    throw new Error('missing')
  })
  on('fs.read', () => ({ value: 'x = 1\n' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.scroll', () => ({}))
  on('turn.complete', ($, event) => ({ text: event.answer }))

  // The answer names the folder once and the file by the tail of its path.
  await $.turn.complete({
    answer: 'Trabajo en /sandbox/api/. El separador está en billing/utils/utils.py.',
    durationMs: 1,
    isAborted: false,
    turnId: 't1',
    reason: 'answer',
  })

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect((await pane.find({ type: 'Button', key: 'touched-0' }))).toBeDefined()
  await pane.input({ key: 'search', text: 'main', kind: 'change' })
  expect(await pane.find({ type: 'Button', key: 'found-0' })).toBeDefined()
  await pane.input({ key: 'search', text: 'billing/utils/utils.py' })
  expect(await pane.find({ type: 'Text', text: /^utils\.py$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /lines 1-1 of 1/ })).toBeDefined()
  await pane.unmount()
})

test('files opened become tabs, and the band opens the pane and steps aside while it is up', async ($, on) => {
  const opened: string[] = []
  let isUp = false

  on('session.cwd', () => ({ value: '/project' }))
  on('fs.read', ($, event) => ({ value: `// ${String((event as { path?: unknown }).path)}\n` }))
  on('ui.open', () => {
    isUp = true
    opened.push('open')

    return { value: { isPlaced: true } }
  })
  on('ui.close', () => {
    isUp = false
    opened.push('close')

    return { value: undefined }
  })
  on('ui.panes', () => ({
    value: isUp ? [{ id: 'code-viewer', title: 'Code', isShown: true, isFocused: false, isPlaced: true }] : [],
  }))
  on('ui.scroll', () => ({}))
  on('ui.focus', () => ({}))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } }))

  const band = await $.ui.mount({
    plugin: 'code-viewer',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isCollapsed: false,
      isWorking: false,
      maxRows: 10,
      bodyColumns: 80,
      scroll: { offset: 0, bodyRows: 9 },
      view: {},
    },
  })

  await band.press({ key: 'toggle' })
  expect(opened).toEqual(['open'])

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await pane.input({ key: 'search', text: '/project/src/one.ts' })
  await pane.input({ key: 'search', text: '/project/src/two.ts' })
  expect(await pane.find({ type: 'Button', key: 'tab-0' })).toBeDefined()
  expect(await pane.find({ type: 'Button', key: 'tab-1' })).toBeDefined()
  expect((await pane.find({ type: 'Text', text: /src\/two\.ts/ }))?.text).toContain('lines 1-1 of 1')

  await pane.press({ key: 'tab-0' })
  expect((await pane.find({ type: 'Text', text: /src\/one\.ts/ }))?.text).toContain('lines 1-1 of 1')

  // The × of a tab behind closes it and leaves the one in view; `w` closes the one in view.
  await pane.input({ key: 'search', text: '/project/src/three.ts' })
  await pane.press({ key: 'tab-close-2' })
  expect(await pane.find({ type: 'Button', key: 'tab-2' })).toBe(undefined)
  await pane.press({ key: 'tab-0' })
  await pane.press({ key: 'close-tab' })
  expect(await pane.find({ type: 'Button', key: 'tab-1' })).toBe(undefined)
  expect((await pane.find({ type: 'Text', text: /src\/two\.ts/ }))?.text).toContain('lines 1-1 of 1')

  // While the pane is up the band draws nothing, so ctrl+x tab lands on the pane, not on the band.
  expect(await band.find({ type: 'Button', key: 'toggle' })).toBe(undefined)

  await pane.press({ key: 'close' })
  expect(opened[opened.length - 1]).toBe('close')
  await pane.unmount()

  // Back with the pane gone (the engine redraws the band on the close; the harness is asked to).
  await band.redraw()
  expect(await band.find({ type: 'Button', key: 'toggle' })).toBeDefined()
  await band.unmount()
})

test('only code files count as the session\'s files', async () => {
  expect(['/p/src/a.ts', '/p/App.tsx', '/p/main.py', '/p/ci.yml'].every(isCode)).toBe(true)
  expect(['/p/notes.txt', '/p/PROGRESS.md', '/p/out.log', '/p/data.json'].some(isCode)).toBe(false)
  expect(isCode('/Users/x/.claude/projects/p/tool-results/abc.txt')).toBe(false)
  expect(isCode('/Users/x/.claude/skills/run.py')).toBe(false)
  expect(['/tmp/bench_orgchart/check_contracts.py', '/private/tmp/claude-501/x/a.ts', '/var/folders/ab/T/run.py'].some(isCode)).toBe(false)
  expect(isCode('/Users/x/tmp/app.py')).toBe(true)
})

test('the git diff asks for a branch, then shows only what the branch changed', async ($, on) => {
  const ran: string[] = []

  on('session.cwd', () => ({ value: '/project' }))
  on('clock.now', () => ({ value: 0 }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => ({ value: 'a = 1\n' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.scroll', () => ({}))
  on('ui.focus', () => ({}))
  on('process.run', ($, event) => {
    const args = event.argv.slice(1)
    const out =
      args[0] === 'for-each-ref'
        ? 'feature/x\norigin/dev\norigin/main\n'
        : args[0] === 'merge-base'
          ? 'abc123\n'
          : args[0] === 'diff'
            ? 'diff --git a/a.py b/a.py\n@@ -1,2 +1,2 @@\n-a = 0\n+a = 1\n b = 2\n'
            : ''

    ran.push(args.join(' '))

    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await pane.input({ key: 'search', text: '/project/a.py' })
  await pane.press({ key: 'mode-git' })
  // The usual bases lead the list, HEAD before them.
  expect(await pane.find({ type: 'Text', text: /^origin\/dev$/ })).toBeDefined()
  await pane.input({ key: 'base', text: 'dev' })
  expect(ran).toContain('merge-base origin/dev HEAD')
  expect(ran.some(line => line.startsWith('diff abc123 '))).toBe(true)
  expect(await pane.find({ type: 'Text', text: /your changes against origin\/dev/ })).toBeDefined()

  // The base is kept: the next git diff does not ask again.
  await pane.press({ key: 'mode-file' })
  await pane.press({ key: 'mode-git' })
  expect(await pane.find({ type: 'Text', text: /your changes against origin\/dev/ })).toBeDefined()
  await pane.unmount()
})

test('the densest file and the longest diff stay far inside a tree\'s 20,000 nodes', async ($, on) => {
  const dense = 'const a = f(b, c[1], { d: "e", g: 2 }) + h.i(j) * 3 // k l m n o p'
  const file = `${Array.from({ length: 3000 }, () => dense).join('\n')}\n`
  const patch = `diff --git a/a.ts b/a.ts\n@@ -1,1500 +1,1500 @@\n${Array.from({ length: 1500 }, () => `-${dense}\n+${dense}`).join('\n')}\n`

  on('session.cwd', () => ({ value: '/project' }))
  on('clock.now', () => ({ value: 0 }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => ({ value: file }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.scroll', () => ({}))
  on('ui.focus', () => ({}))
  on('process.run', ($, event) => {
    const verb = event.argv[1]
    const out = verb === 'diff' ? patch : verb === 'merge-base' ? 'abc\n' : verb === 'for-each-ref' ? 'origin/dev\n' : ''

    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  const count = (node: unknown): number => {
    if (Array.isArray(node)) {
      return node.reduce((sum: number, one) => sum + count(one), 0)
    }

    if (node === null || typeof node !== 'object') {
      return 1
    }

    const { props, children } = node as { props?: object; children?: unknown }

    return 1 + Object.keys(props ?? {}).length + count(children ?? [])
  }

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await pane.input({ key: 'search', text: '/project/a.ts' })
  expect(count(await pane.drawn())).toBeLessThan(12000)
  await pane.press({ key: 'mode-git' })
  await pane.input({ key: 'base', text: 'origin/dev' })
  expect(await pane.find({ type: 'Text', text: /your changes against origin\/dev/ })).toBeDefined()
  expect(count(await pane.drawn())).toBeLessThan(12000)
  await pane.unmount()
})

// Lexes `lines` in turn: each line's `kind:text` spans, and the state it leaves.
const lexAll = (lang: Parameters<typeof tokenizeLine>[0], lines: string[]) => {
  let state = ''

  return lines.map(line => {
    const lexed = tokenizeLine(lang, line, state)

    state = lexed.state

    return { kinds: lexed.spans.map(([kind, text]) => `${kind}:${text.trim()}`), state }
  })
}

test('a template literal lexes its ${} as code, across lines and nested', async () => {
  const [first, second, third] = lexAll('jsx', [
    "const label = `mode ${aiSearchMode ? 'a' : 'b'}",
    '  then ${count',
    '  + 1} end` + x',
  ])

  expect(first?.kinds).toEqual([
    'keyword:const',
    'plain:label',
    'operator:=',
    'string:`mode',
    'punctuation:${',
    'plain:aiSearchMode',
    'operator:?',
    "string:'a'",
    'operator::',
    "string:'b'",
    'punctuation:}',
  ])
  expect(first?.state).toBe('t')
  expect(second?.kinds).toEqual(['string:then', 'punctuation:${', 'plain:count'])
  expect(second?.state).toBe('ti')
  expect(third?.kinds).toEqual(['plain:', 'operator:+', 'number:1', 'punctuation:}', 'string:end`', 'operator:+', 'plain:x'])
  expect(third?.state).toBe('')
  expect(kinds('jsx', "`${cond ? ` x ${y}` : ''}`")).toEqual([
    'string:`',
    'punctuation:${',
    'plain:cond',
    'operator:?',
    'string:` x',
    'punctuation:${',
    'plain:y',
    'punctuation:}',
    'string:`',
    'operator::',
    "string:''",
    'punctuation:}',
    'string:`',
  ])
  // A brace inside the interpolation does not end it.
  expect(stateAfter('js', ['a = `${f({', '  b: 1 })} c'])).toBe('t')
})

test('attributes, keys and members named like keywords are properties', async () => {
  expect(kinds('jsx', '<button type=\'button\' class="a" for="b" aria-label="c">')).toEqual([
    'punctuation:<',
    'tag:button',
    'property:type',
    'operator:=',
    "string:'button'",
    'property:class',
    'operator:=',
    'string:"a"',
    'property:for',
    'operator:=',
    'string:"b"',
    'property:aria-label',
    'operator:=',
    'string:"c"',
    'punctuation:>',
  ])
  // A tag's attributes run over lines.
  expect(lexAll('jsx', ['<button', "  type='submit'", '  onClick={() => go(1)}', '>']).map(line => line.state)).toEqual([
    'j',
    'j',
    'j',
    '',
  ])
  expect(lexAll('jsx', ['<button', "  type='submit'"])[1]?.kinds).toEqual(['plain:', 'property:type', 'operator:=', "string:'submit'"])
  expect(kinds('js', "{ type: 'x', new: 1, default: 2 }").filter(span => span.startsWith('property'))).toEqual([
    'property:type',
    'property:new',
    'property:default',
  ])
  expect(kinds('js', 'obj.type + x.default + promise.catch(e)')).toEqual([
    'plain:obj',
    'punctuation:.',
    'property:type',
    'operator:+',
    'plain:x',
    'punctuation:.',
    'property:default',
    'operator:+',
    'plain:promise',
    'punctuation:.',
    'function:catch',
    'punctuation:(',
    'plain:e',
    'punctuation:)',
  ])
  expect(kinds('js', '  case x:')).toEqual(['plain:', 'keyword:case', 'plain:x', 'operator::'])
  expect(kinds('js', '  default:')).toEqual(['plain:', 'keyword:default', 'operator::'])
  expect(kinds('js', '  default: 3,')[1]).toBe('property:default')
  expect(kinds('js', 'return a ? b : c')).toEqual(['keyword:return', 'plain:a', 'operator:?', 'plain:b', 'operator::', 'plain:c'])
  expect(kinds('js', 'type Props = { type?: string }').slice(0, 2)).toEqual(['keyword:type', 'type:Props'])
  expect(kinds('js', 'type Props = { type?: string }')[4]).toBe('property:type')
})

test('a closing tag never opens a regex, and a value is divided', async () => {
  expect(kinds('jsx', 'foo</b> bar </i>')).toEqual([
    'plain:foo',
    'punctuation:</',
    'tag:b',
    'punctuation:>',
    'plain:bar',
    'punctuation:</',
    'tag:i',
    'punctuation:>',
  ])
  expect(kinds('jsx', 'x = (a) / 2 / arr[0] / n /1').filter(span => span.startsWith('string'))).toEqual([])
  expect(kinds('js', 'r = /[/]x/g.test(s)')[2]).toBe('string:/[/]x/g')
  expect(kinds('js', 'return /a/.test(s)')[1]).toBe('string:/a/')
})

test('a markdown fence closes only on a bare fence of its own mark', async () => {
  const lexed = lexAll('markdown', ['````md', '```python', 'x = 1', '```', '````', 'prose'])

  expect(lexed.map(line => line.state)).toEqual(['````', '````', '````', '````', '', ''])
  expect(lexed[1]?.kinds).toEqual(['string:```python'])
  expect(lexed[4]?.kinds).toEqual(['punctuation:````'])
  expect(lexed[5]?.kinds).toEqual(['plain:prose'])
  expect(stateAfter('markdown', ['```js', '```python', 'x'])).toBe('```')
  expect(stateAfter('markdown', ['   ~~~', '```', '~~~ info', '~~~~'])).toBe('')
  expect(stateAfter('markdown', ['```js``` is inline'])).toBe('')
})

test('python colors built-ins, and the fields of f-strings as code', async () => {
  expect(kinds('python', 'n = str(len(items)) if isinstance(x, dict) else None')).toEqual([
    'plain:n',
    'operator:=',
    'type:str',
    'punctuation:(',
    'function:len',
    'punctuation:(',
    'plain:items',
    'punctuation:))',
    'keyword:if',
    'function:isinstance',
    'punctuation:(',
    'plain:x',
    'punctuation:,',
    'type:dict',
    'punctuation:)',
    'keyword:else',
    'constant:None',
  ])
  expect(kinds('python', 'f(type=1, id=2)')).toEqual([
    'function:f',
    'punctuation:(',
    'plain:type',
    'operator:=',
    'number:1',
    'punctuation:,',
    'plain:id',
    'operator:=',
    'number:2',
    'punctuation:)',
  ])
  expect(kinds('python', "s = f'{name!r:>10} {{lit}} {a + 1}'")).toEqual([
    'plain:s',
    'operator:=',
    "string:f'",
    'punctuation:{',
    'plain:name',
    'string:!r:>10',
    'punctuation:}',
    'string:{{lit}}',
    'punctuation:{',
    'plain:a',
    'operator:+',
    'number:1',
    'punctuation:}',
    "string:'",
  ])

  const [open, field, close] = lexAll('python', ["t = f'''", '  total {count:,} and {{x}}', "  done''' # end"])

  expect(open?.state).toBe("f'''")
  expect(field?.kinds).toEqual(['string:total', 'punctuation:{', 'plain:count', 'string::,', 'punctuation:}', 'string:and {{x}}'])
  expect(field?.state).toBe("f'''")
  expect(close?.kinds).toEqual(["string:done'''", 'comment:# end'])
  expect(close?.state).toBe('')
  expect(kinds('python', 'p = r"\\d#x" + rb\'a#b\' # c')).toEqual([
    'plain:p',
    'operator:=',
    'string:r"\\d#x"',
    'operator:+',
    "string:rb'a#b'",
    'comment:# c',
  ])
  expect(kinds('python', '@app.get("/x")')[0]).toBe('function:@app.get')
  expect(kinds('python', 'async def run(): pass').slice(0, 2)).toEqual(['keyword:async def', 'function:run'])
  expect(kinds('python', 'match = re.match(p, s)')[0]).toBe('plain:match')
  expect(kinds('python', 'match command:')[0]).toBe('keyword:match')
})

test('generics, newer literals, comments and data files lex as written', async () => {
  expect(kinds('jsx', "const [tab, setTab] = useState<RoleTab>('members')").slice(7, 12)).toEqual([
    'plain:useState',
    'operator:<',
    'type:RoleTab',
    'operator:>',
    'punctuation:(',
  ])
  expect(stateAfter('jsx', ['const id = <T,>(x: T) => x'])).toBe('')
  expect(kinds('jsx', 'const id = <T,>(x: T) => x').includes('tag:T')).toBe(false)
  expect(kinds('js', 'a?.b ?? c')).toEqual(['plain:a', 'operator:?', 'punctuation:.', 'property:b', 'operator:??', 'plain:c'])
  expect(kinds('js', 'n = 1_000 + 10n')).toEqual(['plain:n', 'operator:=', 'number:1_000', 'operator:+', 'number:10n'])
  expect(lexAll('jsx', ['{/* a', 'b */}']).map(line => line.state)).toEqual(['c', ''])
  expect(lexAll('jsx', ['<a', '  /* note', '  */ href="x">']).map(line => line.state)).toEqual(['j', 'jc', ''])
  expect(kinds('json', '{"a \\"b\\"": "c \\" d"}')).toEqual([
    'punctuation:{',
    'property:"a \\"b\\""',
    'punctuation::',
    'string:"c \\" d"',
    'punctuation:}',
  ])

  const yaml = lexAll('yaml', ['run: |', '  echo # not a comment', '', '  key: text', 'next: >-', '"quoted key": 1 # note'])

  expect(yaml.map(line => line.state)).toEqual(['|0', '|0', '|0', '|0', '|0', ''])
  expect(yaml[1]?.kinds).toEqual(['string:echo # not a comment'])
  expect(yaml[3]?.kinds).toEqual(['string:key: text'])
  expect(yaml[4]?.kinds).toEqual(['property:next', 'punctuation::', 'operator:>-'])
  expect(yaml[5]?.kinds).toEqual(['property:"quoted key"', 'punctuation::', 'number:1', 'comment:# note'])
  expect(lexAll('yaml', ['- run: |', '    cmd', '- name: x']).map(line => line.state)).toEqual(['|2', '|2', ''])
})

test('a typed base names a branch by its whole name or a part of it, never loosely', async () => {
  const branches = ['dev-llomen-notifications', 'fix/pre-core-to-dev', 'origin/dev', 'dev', 'feature/main', 'origin/main', 'Release/2.1']

  // Letters in order are not a match: `prod` and `main` once fell on unrelated branches.
  expect(branchesNamed(['dev-llomen-notifications', 'fix/pre-core-to-dev'], 'prod')).toEqual([])
  expect(branchesNamed(['dev-llomen-notifications', 'fix/pre-core-to-dev'], 'main')).toEqual([])
  // The whole name, any case, before a part.
  expect(branchesNamed(branches, 'release/2.1')).toEqual(['Release/2.1'])
  expect(branchesNamed(branches, 'DEV')).toEqual(['dev'])
  // Then a name or a part after a slash that starts with it, then a name that holds it.
  expect(branchesNamed(branches, 'pre-core')).toEqual(['fix/pre-core-to-dev'])
  expect(branchesNamed(branches, 'llomen')).toEqual(['dev-llomen-notifications'])
  // Of several, origin/<typed> wins, then the one whose last part it is; else none is picked.
  expect(preferredBranch(branchesNamed(branches, 'main'), 'main')).toBe('origin/main')
  expect(preferredBranch(['fix/main', 'main-menu'], 'main')).toBe('fix/main')
  expect(preferredBranch(['fix/main-menu', 'feat/main-page'], 'main')).toBe(undefined)
})

test('a typed base is taken as git reads it, or matched against every branch, or asked again', async ($, on) => {
  const ran: string[] = []
  // `prod` sits far down the list: past the forty offered, still a branch git knows.
  const branches = [...Array.from({ length: 50 }, (_, index) => `topic-${index}`), 'prod', 'fix/main-menu', 'feat/main-page', 'my-branch']

  on('session.cwd', () => ({ value: '/project' }))
  on('clock.now', () => ({ value: 0 }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => ({ value: 'a = 1\n' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.scroll', () => ({}))
  on('ui.focus', () => ({}))
  on('process.run', ($, event) => {
    const args = event.argv.slice(1)
    const line = args.join(' ')
    const known = ['prod^{commit}', 'HEAD~1^{commit}', 'a-very-long-branch-name-for-the-label^{commit}']
    const answer = (stdout: string, exitCode = 0) => ({
      value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
    })

    ran.push(line)

    if (args[0] === 'for-each-ref') {
      return answer(`${branches.join('\n')}\n`)
    }

    if (line === 'rev-parse --abbrev-ref HEAD') {
      return answer('my-branch\n')
    }

    if (args[0] === 'rev-parse' && args[1] === '--verify') {
      return known.includes(args[3] ?? '') ? answer('abc123\n') : answer('', 1)
    }

    if (args[0] === 'rev-list' && args[1] === '--left-right') {
      return answer('2\t7\n')
    }

    return answer(args[0] === 'merge-base' ? 'abc123\n' : args[0] === 'diff' ? '@@ -1 +1 @@\n-a = 0\n+a = 1\n' : '')
  })

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await pane.input({ key: 'search', text: '/project/a.py' })
  await pane.press({ key: 'mode-git' })
  // The base field is the one the pane's ring starts on; the branch checked out is not offered.
  expect((await pane.find({ type: 'Input', key: 'base' }))?.props.autoFocus).toBe(true)
  expect((await pane.find({ type: 'Input', key: 'search' }))?.props.autoFocus).toBe(undefined)
  expect(await pane.find({ type: 'Text', text: /^my-branch$/ })).toBe(undefined)
  expect(await pane.find({ type: 'Text', text: /2 ahead, 7 behind/ })).toBeDefined()

  // A name git resolves is used as typed, wherever it sits in the list.
  await pane.input({ key: 'base', text: 'prod' })
  expect(ran).toContain('merge-base prod HEAD')
  expect(await pane.find({ type: 'Text', text: /your changes against prod/ })).toBeDefined()

  await pane.press({ key: 'mode-base' })
  await pane.input({ key: 'base', text: 'HEAD~1' })
  expect(ran).toContain('merge-base HEAD~1 HEAD')

  // Several branches fit: none is picked, they are offered.
  await pane.press({ key: 'mode-base' })
  await pane.input({ key: 'base', text: 'main' })
  expect(await pane.find({ type: 'Text', text: /"main" is ambiguous: 2 branches/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^fix\/main-menu$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^topic-1$/ })).toBe(undefined)
  expect(ran).not.toContain('merge-base fix/main-menu HEAD')

  // None fits: the picker stays, saying so.
  await pane.input({ key: 'base', text: 'origin/main' })
  expect(await pane.find({ type: 'Text', text: /No branch or commit named "origin\/main"/ })).toBeDefined()
  expect(await pane.find({ type: 'Input', key: 'base' })).toBeDefined()

  // A long base is cut with an ellipsis on its button.
  await pane.input({ key: 'base', text: 'a-very-long-branch-name-for-the-label' })
  expect(await pane.find({ type: 'Text', text: 'vs a-very-long-branch-name-for-t…' })).toBeDefined()
  await pane.unmount()
})

test('the empty git diff says why', async ($, on) => {
  on('session.cwd', () => ({ value: '/project' }))
  on('clock.now', () => ({ value: 0 }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => ({ value: 'a = 1\n' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.scroll', () => ({}))
  on('ui.focus', () => ({}))
  on('process.run', ($, event) => {
    const args = event.argv.slice(1)
    const out =
      args[0] === 'merge-base' || (args[0] === 'rev-parse' && args[1] !== '--abbrev-ref')
        ? 'head1\n'
        : args[0] === 'rev-list' && args[1] === '--count'
          ? '4\n'
          : ''

    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await pane.input({ key: 'search', text: '/project/a.py' })
  await pane.press({ key: 'mode-git' })
  await pane.input({ key: 'base', text: 'origin/dev' })
  const said = await pane.find({ type: 'Text', text: /No changes of yours against origin\/dev/ })

  expect(said?.text).toContain('already merged into origin/dev (4 commits behind it)')
  expect(said?.text).not.toContain('does not track')
  await pane.unmount()
})

test('the pane holds its own keys while their controls are not drawn', async ($, on) => {
  on('session.cwd', () => ({ value: '/project' }))
  on('clock.now', () => ({ value: 0 }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => ({ value: 'a = 1\n' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.scroll', () => ({}))
  on('ui.focus', () => ({}))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))

  const hotkeys = async (pane: { findAll: (query: { type: string }) => Promise<Array<{ props: Record<string, unknown> }>> }) =>
    (await pane.findAll({ type: 'Button' })).map(button => button.props.hotkey).filter(key => key !== undefined)
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // Nothing open: every key of the pane is still held, the search field takes the ring.
  for (const key of ['f', 'c', 'g', 'b', 'w', 'n', 'p', 's', 'l', 'm', 'x', '1', '9']) {
    expect(await hotkeys(pane)).toContain(key)
  }

  expect((await pane.find({ type: 'Input', key: 'search' }))?.props.autoFocus).toBe(true)
  // Only the pane's own: no other letter is taken from the prompt.
  expect(await hotkeys(pane)).not.toContain('a')
  await pane.press({ key: 'idle-g' })
  expect(await pane.find({ type: 'Text', text: /No file is open/ })).toBeDefined()

  // A one-page file: p and n are held, saying there is no other page; each key once.
  await pane.input({ key: 'search', text: '/project/a.py' })
  const held = await hotkeys(pane)

  expect(held.filter(key => key === 'n')).toHaveLength(1)
  expect(held.filter(key => key === '1')).toHaveLength(1)
  expect(await pane.find({ type: 'Button', key: 'idle-f' })).toBe(undefined)
  expect(await pane.find({ type: 'Button', key: 'idle-1' })).toBe(undefined)
  expect(await pane.find({ type: 'Button', key: 'idle-c' })).toBeDefined()
  await pane.press({ key: 'idle-n' })
  expect(await pane.find({ type: 'Text', text: /Already the last page/ })).toBeDefined()
  await pane.press({ key: 'idle-2' })
  expect(await pane.find({ type: 'Text', text: /Only 1 tab is open/ })).toBeDefined()
  await pane.unmount()
})

// Stands in for git: each answer by the verb and arguments it is asked with.
type Answer = { stdout?: string; exitCode?: number; stderr?: string }

const gitHooks = (on: Parameters<TestBody>[1], answer: (args: string[]) => Answer, ran: string[] = []) => {
  on('process.run', ($, event) => {
    const args = event.argv.slice(1)
    // The repository is /project: each folder below it is one `../` up.
    const depth = String(event.init?.cwd ?? '/project').split('/').length - 2
    const given = answer(args)
    const out =
      args.join(' ') === 'rev-parse --show-cdup' && given.exitCode === undefined
        ? { stdout: `${'../'.repeat(depth)}\n` }
        : given

    ran.push(args.join(' '))

    return {
      value: {
        exitCode: out.exitCode ?? 0,
        stdout: out.stdout ?? '',
        stderr: out.stderr ?? '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      },
    }
  })
}

const engineHooks = (on: Parameters<TestBody>[1], onDisk: Record<string, string>) => {
  on('session.cwd', () => ({ value: '/project' }))
  on('clock.now', () => ({ value: 0 }))
  on('fs.stat', ($, event) => {
    const path = String((event as { path?: unknown }).path)

    if (path === '/project' || path === '/project/app') {
      return { value: { kind: 'dir' as const, size: 1, mtimeMs: 0, isLink: false } }
    }

    if (onDisk[path] === undefined) {
      throw new Error('missing')
    }

    return { value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } }
  })
  on('fs.read', ($, event) => {
    const text = onDisk[String((event as { path?: unknown }).path)]

    if (text === undefined) {
      throw new Error('missing')
    }

    return { value: text }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.scroll', () => ({}))
  on('ui.focus', () => ({}))
}

const header = async (pane: { find: (query: object) => Promise<{ text?: string } | undefined> }) =>
  (await pane.find({ type: 'Text', text: /your changes against|changed against/ }))?.text ?? ''

test('a file deleted on the branch opens as a diff of every line removed', async ($, on) => {
  const ran: string[] = []

  engineHooks(on, {})
  gitHooks(
    on,
    args =>
      args[0] === 'for-each-ref'
        ? { stdout: 'origin/dev\n' }
        : args[0] === 'merge-base'
          ? { stdout: 'abc\n' }
          : args[0] === 'log'
            ? { stdout: 'f00\n' }
            : args[0] === 'diff' && args[1] === 'abc'
              ? { stdout: 'diff --git a/app/gone.py b/app/gone.py\ndeleted file mode 100644\n@@ -1,3 +0,0 @@\n-a = 1\n-b = 2\n-c = 3\n' }
              : {},
    ran,
  )

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // Not on disk, nor in the index: git's history knows it.
  await pane.input({ key: 'search', text: 'diff /project/app/gone.py' })
  await pane.input({ key: 'base', text: 'origin/dev' })
  expect(await header(pane)).toContain('deleted')
  expect(await header(pane)).toContain('+0 −3')
  expect(await pane.find({ type: 'Text', text: /Removed 3 lines/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /@ line 1/ })).toBeDefined()
  expect(ran).toContain('cat-file -e abc:app/gone.py')
  await pane.unmount()
})

test('a new file git does not track yet shows whole, as added', async ($, on) => {
  const ran: string[] = []

  engineHooks(on, { '/project/app/new.py': 'x = 1\ny = 2\n' })
  gitHooks(
    on,
    args =>
      args[0] === 'for-each-ref'
        ? { stdout: 'origin/dev\n' }
        : args[0] === 'merge-base'
          ? { stdout: 'abc\n' }
          : args[0] === 'cat-file' || args[0] === 'check-ignore'
            ? { exitCode: 1 }
            : args[0] === 'diff' && args[1] === '--no-index'
              ? { exitCode: 1, stdout: 'diff --git a/app/new.py b/app/new.py\nnew file mode 100644\n@@ -0,0 +1,2 @@\n+x = 1\n+y = 2\n' }
              : {},
    ran,
  )

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await pane.input({ key: 'search', text: 'diff /project/app/new.py' })
  await pane.input({ key: 'base', text: 'origin/dev' })
  expect(await header(pane)).toContain('new file, untracked')
  expect(await header(pane)).toContain('+2 −0')
  expect(await pane.find({ type: 'Text', text: /No changes/ })).toBe(undefined)
  expect(ran).toContain('diff --no-index --no-color --no-ext-diff -U3 -- /dev/null app/new.py')
  await pane.unmount()
})

test('a renamed file is diffed against its old path', async ($, on) => {
  const ran: string[] = []

  engineHooks(on, { '/project/app/tasks/business.py': 'def run():\n    return 2\n' })
  gitHooks(
    on,
    args =>
      args[0] === 'for-each-ref'
        ? { stdout: 'origin/dev\n' }
        : args[0] === 'merge-base'
          ? { stdout: 'abc\n' }
          : args[0] === 'cat-file'
            ? { exitCode: 128 }
            : args.join(' ').startsWith('diff -M --name-status -z --diff-filter=R')
              ? { stdout: 'R058\u0000app/cron/business.py\u0000app/tasks/business.py\u0000' }
              : args[0] === 'diff' && args[1] === 'abc'
                ? { stdout: 'diff --git a/app/cron/business.py b/app/tasks/business.py\nsimilarity index 58%\n@@ -1,2 +1,2 @@\n def run():\n-    return 1\n+    return 2\n' }
                : {},
    ran,
  )

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await pane.input({ key: 'search', text: 'diff /project/app/tasks/business.py' })
  await pane.input({ key: 'base', text: 'origin/dev' })
  expect(await header(pane)).toContain('renamed from app/cron/business.py')
  expect(await header(pane)).toContain('+1 −1')
  expect(ran.some(line => line.endsWith('-- :(literal)app/cron/business.py :(literal)app/tasks/business.py'))).toBe(true)
  // Two columns of numbers: the removed line has only its old one, the added only its new one.
  expect(await pane.find({ type: 'Text', text: /^2 {3}- $/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^ {2}2 \+ $/ })).toBeDefined()
  await pane.unmount()
})

test('a long diff counts every line and pages through all of them', async ($, on) => {
  const lines = Array.from({ length: 537 }, (_, index) => `+line_${index} = ${index}`)

  engineHooks(on, { '/project/app/big.py': `${lines.map(line => line.slice(1)).join('\n')}\n` })
  gitHooks(on, args =>
    args[0] === 'for-each-ref'
      ? { stdout: 'origin/dev\n' }
      : args[0] === 'merge-base'
        ? { stdout: 'abc\n' }
        : args[0] === 'diff' && args[1] === 'abc'
          ? { stdout: `diff --git a/app/big.py b/app/big.py\n@@ -0,0 +1,537 @@\n${lines.join('\n')}\n` }
          : {},
  )

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await pane.input({ key: 'search', text: 'diff /project/app/big.py' })
  await pane.input({ key: 'base', text: 'origin/dev' })
  expect(await header(pane)).toContain('+537 −0 · lines 1-400 of 537 of the diff')
  expect(await pane.find({ type: 'Text', text: /Added 537 lines/ })).toBeDefined()
  // Both keys are there on the first page: n and p never reach the prompt.
  expect(await pane.find({ type: 'Button', key: 'diff-previous' })).toBeDefined()
  await pane.press({ key: 'diff-next' })
  expect(await header(pane)).toContain('lines 401-537 of 537 of the diff')
  expect(await pane.find({ type: 'Text', text: /@ line 401 \(continued\)/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /line_536/ })).toBeDefined()
  expect(await pane.find({ type: 'Button', key: 'diff-next' })).toBeDefined()
  await pane.press({ key: 'diff-previous' })
  expect(await header(pane)).toContain('lines 1-400 of 537')
  await pane.unmount()
})

test('a hunk inside a docstring is colored from the lines before it', async ($, on) => {
  engineHooks(on, { '/project/app/doc.py': 'x = 1\n"""\ndef run(): return\nmore text\n"""\n' })
  gitHooks(on, args =>
    args[0] === 'for-each-ref'
      ? { stdout: 'origin/dev\n' }
      : args[0] === 'merge-base'
        ? { stdout: 'abc\n' }
        : args[0] === 'diff' && args[1] === 'abc'
          ? { stdout: 'diff --git a/app/doc.py b/app/doc.py\n@@ -3,1 +3,1 @@\n-still old\n+def run(): return\n' }
          : {},
  )

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await pane.input({ key: 'search', text: 'diff /project/app/doc.py' })
  await pane.input({ key: 'base', text: 'origin/dev' })
  // Inside the string, `def` is no keyword: the line is drawn as one string span.
  expect(await pane.find({ type: 'Text', text: /^def run\(\): return$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^def ?$/ })).toBe(undefined)
  await pane.unmount()
})

test('the changes list shows every file the branch changed, and opens its diff', async ($, on) => {
  const ran: string[] = []

  engineHooks(on, { '/project/app/new.py': 'a\nb\nc\n', '/project/app/kept.py': 'x\n' })
  gitHooks(
    on,
    args => {
      const line = args.join(' ')

      return args[0] === 'for-each-ref'
        ? { stdout: 'origin/dev\n' }
        : args[0] === 'merge-base'
          ? { stdout: 'abc\n' }
          : line === 'diff -M --name-status -z abc'
            ? { stdout: 'M\u0000app/kept.py\u0000D\u0000app/gone.py\u0000R058\u0000app/old.py\u0000app/moved.py\u0000' }
            : line === 'diff -M --numstat -z abc'
              ? { stdout: '2\t1\tapp/kept.py\u00000\t4\tapp/gone.py\u00005\t3\t\u0000app/old.py\u0000app/moved.py\u0000' }
              : args[0] === 'ls-files'
                ? { stdout: 'app/new.py\u0000' }
                : args[0] === 'diff' && args[1] === 'abc'
                  ? { stdout: 'diff --git a/app/kept.py b/app/kept.py\n@@ -1,1 +1,1 @@\n-y\n+x\n' }
                  : {}
    },
    ran,
  )

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // With no base yet the list asks for one first.
  await pane.press({ key: 'mode-changes' })
  expect(await pane.find({ type: 'Text', text: /pick the branch/ })).toBeDefined()
  await pane.input({ key: 'base', text: 'origin/dev' })
  expect(await header(pane)).toContain('4 files changed against origin/dev · +10 −8')
  expect(await pane.find({ type: 'Text', text: /← app\/old\.py/ })).toBeDefined()
  // Sorted by path: gone, kept, moved, new.
  expect((await pane.find({ type: 'Button', key: 'change-0' })) !== undefined).toBe(true)
  expect(await pane.find({ type: 'Button', key: 'change-4' })).toBe(undefined)
  expect(await pane.find({ type: 'Text', text: /^\? $/ })).toBeDefined()
  await pane.press({ key: 'change-1' })
  expect(await header(pane)).toContain('your changes against origin/dev')
  expect(ran.some(line => line.startsWith('diff abc -M') && line.endsWith(':(literal)app/kept.py'))).toBe(true)
  await pane.unmount()
})

test('a long changes list draws its first rows and counts the rest', async ($, on) => {
  const names = Array.from({ length: 1200 }, (_, index) => `src/f${String(index).padStart(4, '0')}.ts`)

  engineHooks(on, {})
  gitHooks(on, args => {
    const line = args.join(' ')

    return args[0] === 'for-each-ref'
      ? { stdout: 'origin/dev\n' }
      : args[0] === 'merge-base'
        ? { stdout: 'abc\n' }
        : line === 'diff -M --name-status -z abc'
          ? { stdout: names.map(name => `D\u0000${name}\u0000`).join('') }
          : line === 'diff -M --numstat -z abc'
            ? { stdout: names.map(name => `0\t10\t${name}\u0000`).join('') }
            : {}
  })

  const count = (node: unknown): number => {
    if (Array.isArray(node)) {
      return node.reduce((sum: number, one) => sum + count(one), 0)
    }

    if (node === null || typeof node !== 'object') {
      return 1
    }

    const { props, children } = node as { props?: object; children?: unknown }

    return 1 + Object.keys(props ?? {}).length + count(children ?? [])
  }

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await pane.press({ key: 'mode-changes' })
  await pane.input({ key: 'base', text: 'origin/dev' })
  expect(await header(pane)).toContain('1200 files changed against origin/dev · +0 −12000')
  expect(await pane.find({ type: 'Button', key: 'change-299' })).toBeDefined()
  expect(await pane.find({ type: 'Button', key: 'change-300' })).toBe(undefined)
  expect(await pane.find({ type: 'Text', text: /900 more files not listed/ })).toBeDefined()
  expect(count(await pane.drawn())).toBeLessThan(15000)
  await pane.unmount()
})

test('an empty file, a binary diff and a folder outside git each say what they are', async ($, on) => {
  let isRepo = true

  engineHooks(on, { '/project/app/empty.py': '', '/project/app/logo.png': 'x' })
  gitHooks(on, args =>
    !isRepo
      ? { exitCode: 128, stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' }
      : args[0] === 'for-each-ref'
        ? { stdout: 'origin/dev\n' }
        : args[0] === 'merge-base'
          ? { stdout: 'abc\n' }
          : args[0] === 'diff' && args[1] === 'abc'
            ? { stdout: 'diff --git a/app/logo.png b/app/logo.png\nBinary files a/app/logo.png and b/app/logo.png differ\n' }
            : {},
  )

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await pane.input({ key: 'search', text: '/project/app/empty.py' })
  expect(await pane.find({ type: 'Text', text: /empty file/ })).toBeDefined()
  await pane.input({ key: 'search', text: 'diff /project/app/logo.png' })
  await pane.input({ key: 'base', text: 'origin/dev' })
  expect(await pane.find({ type: 'Text', text: /^Binary file: it differs from origin\/dev/ })).toBeDefined()
  isRepo = false
  await pane.press({ key: 'mode-git' })
  expect(await pane.find({ type: 'Text', text: /^Not in a git repository/ })).toBeDefined()
  await pane.unmount()
})

const ok = (stdout: string) => ({
  value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
})

test('the session\'s files follow every prompt: the latest first, a file read again on top, a worktree\'s too', async ($, on) => {
  let isUp = false

  on('session.cwd', () => ({ value: '/project' }))
  on('clock.now', () => ({ value: 0 }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => ({ value: 'x = 1\n' }))
  on('ui.open', () => {
    isUp = true

    return { value: { isPlaced: true } }
  })
  on('ui.panes', () => ({
    value: isUp ? [{ id: 'code-viewer', title: 'Code', isShown: true, isFocused: false, isPlaced: true }] : [],
  }))
  on('ui.scroll', () => ({}))
  on('ui.focus', () => ({}))
  on('process.run', () => ok('/project\n'))
  on('tool.call', ($, event) => {
    const file = String((event as { file_path?: unknown }).file_path)

    return {
      result:
        event.tool === 'Edit'
          ? { filePath: file, structuredPatch: [{ oldStart: 1, newStart: 1, oldLines: 1, newLines: 2, lines: [' x = 1', '+y = 2'] }] }
          : { type: 'text', file: { filePath: file } },
    } as never
  })
  on('turn.start', ($, event) => ({ turnId: event.turnId }))
  on('turn.complete', ($, event) => ({ text: event.answer }))

  const band = await $.ui.mount({
    plugin: 'code-viewer',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 10, bodyColumns: 80, scroll: { offset: 0, bodyRows: 9 }, view: {} },
  })
  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = async () => {
    const names: string[] = []

    for (let index = 0; index < 8; index += 1) {
      const row = await pane.find({ type: 'Button', key: `touched-${index}` })
      const text = row === undefined ? undefined : /"text":"(?:[±▸·] )?([^" ]+\.(?:py|ts))/.exec(JSON.stringify(row))?.[1]

      if (text !== undefined) {
        names.push(text)
      }
    }

    return names
  }
  const read = (file: string) => $.tool.call({ tool: 'Read', file_path: file } as never)

  await $.turn.start({ text: 'Read a.py and b.py', turnId: 't1' })
  await read('/project/a.py')
  await read('/project/b.py')
  await $.turn.complete({ answer: 'OK', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(await band.find({ type: 'Text', text: /2 files/ })).toBeDefined()
  expect(await rows()).toEqual(['b.py', 'a.py'])

  // The second prompt works in a worktree Claude Code made under .claude/worktrees: its files count.
  await $.turn.start({ text: 'Read c.py and change a.py', turnId: 't2' })
  await read('/project/.claude/worktrees/wt1/c.py')
  await $.tool.call({ tool: 'Edit', file_path: '/project/a.py', old_string: 'x', new_string: 'y' } as never)
  // Named in the answer, b.py stays where it was.
  await $.turn.complete({ answer: 'Done; b.py is untouched.', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  expect(await rows()).toEqual(['a.py', 'c.py', 'b.py'])
  expect(await pane.find({ type: 'Text', text: /^± $/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /latest prompt/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /earlier/ })).toBeDefined()

  // With a file in view, `l` brings back the list as it stands now.
  await pane.input({ key: 'search', text: '/project/a.py' })
  expect(await pane.find({ type: 'Button', key: 'touched-0' })).toBe(undefined)
  await read('/project/d.py')
  await pane.press({ key: 'list' })
  expect(await rows()).toEqual(['d.py', 'a.py', 'c.py', 'b.py'])

  await pane.press({ key: 'clear-list' })
  expect(await pane.find({ type: 'Button', key: 'touched-0' })).toBe(undefined)
  expect(await pane.find({ type: 'Text', text: /No files yet/ })).toBeDefined()
  await pane.unmount()
  await band.redraw()
  isUp = false
  await band.redraw()
  expect(await band.find({ type: 'Text', text: /0 files/ })).toBeDefined()
  await band.unmount()
})

test('a tab comes back as it was left, and closing one shows its neighbour', async ($, on) => {
  on('session.cwd', () => ({ value: '/project' }))
  on('clock.now', () => ({ value: 0 }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => ({ value: 'a = 1\n' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.scroll', () => ({}))
  on('ui.focus', () => ({}))
  on('process.run', ($, event) => {
    const verb = event.argv[1]

    return ok(
      verb === 'diff'
        ? 'diff --git a/a.py b/a.py\n@@ -1,1 +1,1 @@\n-a = 0\n+a = 1\n'
        : verb === 'merge-base' || event.argv.includes('--verify')
          ? 'abc\n'
          : '',
    )
  })

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })

  for (const name of ['one', 'two', 'three']) {
    await pane.input({ key: 'search', text: `/project/${name}.py` })
  }

  // `two` left in its git diff comes back in it.
  await pane.press({ key: 'tab-1' })
  await pane.press({ key: 'mode-git' })
  await pane.input({ key: 'base', text: 'HEAD' })
  expect(await pane.find({ type: 'Text', text: /your changes against HEAD/ })).toBeDefined()
  await pane.press({ key: 'tab-0' })
  expect(await pane.find({ type: 'Text', text: /one\.py lines 1-1 of 1/ })).toBeDefined()
  await pane.press({ key: 'tab-1' })
  expect(await pane.find({ type: 'Text', text: /your changes against HEAD/ })).toBeDefined()

  // Closing the middle tab shows the one before it, not the last.
  await pane.press({ key: 'close-tab' })
  expect(await pane.find({ type: 'Button', key: 'tab-2' })).toBe(undefined)
  expect(await pane.find({ type: 'Text', text: /one\.py lines 1-1 of 1/ })).toBeDefined()
  await pane.unmount()
})

test('a tenth tab says which one closed, and tabs of one name show their folder', async ($, on) => {
  on('session.cwd', () => ({ value: '/project' }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => ({ value: 'a = 1\n' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.scroll', () => ({}))
  on('ui.focus', () => ({}))

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await pane.input({ key: 'search', text: '/project/Chat/index.tsx' })
  await pane.input({ key: 'search', text: '/project/Menu/index.tsx' })
  expect(await pane.find({ type: 'Text', text: /^Chat\/index\.tsx$/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^Menu\/index\.tsx$/ })).toBeDefined()

  for (let index = 3; index <= 10; index += 1) {
    await pane.input({ key: 'search', text: `/project/f${index}.ts` })
  }

  expect(await pane.find({ type: 'Text', text: /Tab index\.tsx closed/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /^index\.tsx$/ })).toBeDefined()
  await pane.unmount()
})

test('a file that cannot be read is no tab, and one outside the project says so', async ($, on) => {
  on('session.cwd', () => ({ value: '/project' }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } }))
  on('fs.read', ($, event) => {
    if (String((event as { path?: unknown }).path).includes('missing')) {
      throw new Error('missing')
    }

    return { value: '127.0.0.1 localhost\n' }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.scroll', () => ({}))
  on('ui.focus', () => ({}))

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await pane.input({ key: 'search', text: '/project/missing.ts' })
  expect(await pane.find({ type: 'Text', text: /cannot be read/ })).toBeDefined()
  expect(await pane.find({ type: 'Button', key: 'tab-0' })).toBe(undefined)
  await pane.input({ key: 'search', text: '/etc/hosts' })
  expect(await pane.find({ type: 'Text', text: /outside the project/ })).toBeDefined()
  expect(await pane.find({ type: 'Button', key: 'tab-0' })).toBeDefined()
  await pane.unmount()
})

test('a command finds a file by its exact name, keeps the line, and lists nothing for a path that matches none', async ($, on) => {
  on('session.cwd', () => ({ value: '/project' }))
  on('clock.now', () => ({ value: 0 }))
  on('fs.stat', () => {
    throw new Error('missing')
  })
  on('fs.read', () => ({ value: Array.from({ length: 30 }, (_, index) => `line${index + 1}`).join('\n') }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.scroll', () => ({}))
  on('ui.focus', () => ({}))
  on('process.run', ($, event) =>
    ok(event.argv.includes('rev-parse') ? '' : 'src/app/index.tsx\nsrc/menu/index.tsx\nsrc/app/button.tsx\nsrc/app/buttons.tsx\nlib/btn.ts\n'),
  )
  on('command.run', () => ({ text: '' }))

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const run = (args: string) => $.command.run({ command: 'code-viewer', args, presentation: { isFullscreen: false } } as never)

  await run('button.tsx:12')
  expect(await pane.find({ type: 'Text', text: /src\/app\/button\.tsx/ })).toBeDefined()
  expect(await pane.find({ type: 'Text', text: /lines 9-30 of 30/ })).toBeDefined()

  await run('index.tsx:5')
  expect(await pane.find({ type: 'Button', key: 'result-1' })).toBeDefined()
  await pane.press({ key: 'result-1' })
  expect(await pane.find({ type: 'Text', text: /lines 2-30 of 30/ })).toBeDefined()

  await run('src/nothing/zzz')
  expect(await pane.find({ type: 'Text', text: /No file matches/ })).toBeDefined()
  await pane.unmount()
})

test('search ranks tighter: folders typed must match, and the session wins a tie', async () => {
  const files = ['src/app/button.tsx', 'lib/btn.ts', 'docs/b/u/t/t/o/n.md', 'a/button.tsx']

  expect(rank(files, 'btn', 10)).toContain('lib/btn.ts')
  expect(rank(files, 'src/btn', 10)).toEqual(['src/app/button.tsx'])
  expect(rank(files, 'nothing/btn', 10)).toEqual([])
  expect(rank(files, 'button.tsx', 10)[0]).toBe('a/button.tsx')
  expect(rank(files, 'button.tsx', 10, new Set(['src/app/button.tsx']))[0]).toBe('src/app/button.tsx')
  expect(isCode('/repo/.claude/worktrees/wt1/src/a.ts')).toBe(true)
  expect(isCode('/repo/.claude/worktrees/wt1/.claude/plans/p.ts')).toBe(false)
  expect(clean('x'.repeat(5000), 4000)).toBe(`${'x'.repeat(4000)} … +1000 chars`)
  expect(clean('x'.repeat(500))).toBe(`${'x'.repeat(400)}…`)
})

test('files a shell command changes join the session\'s files, a submodule\'s too', async ($, on) => {
  // What git calls changed, by repository, and each file's last write.
  const dirty: Record<string, string[]> = { '/project': ['1 .M N... 100644 100644 100644 aaa bbb src/old.ts'], '/project/lib/ui': [] }
  const written: Record<string, number> = { '/project/src/old.ts': 1 }

  on('session.cwd', () => ({ value: '/project' }))
  on('clock.now', () => ({ value: 0 }))
  on('fs.stat', ($, event) => ({
    value: { kind: 'file' as const, size: 1, mtimeMs: written[event.path] ?? 0, isLink: false },
  }))
  on('ui.panes', () => ({ value: [] }))
  on('process.run', ($, event) => {
    const args = event.argv.slice(1)
    const cwd = String(event.init?.cwd ?? '/project')

    return ok(args[0] === 'status' ? (dirty[cwd] ?? []).join('\0') : `${cwd}\n`)
  })
  on('tool.call', ($, event) => {
    const command = String((event as { command?: unknown }).command)

    if (command.startsWith('sed')) {
      // Written again, a file already changed; and a new one, a renamed one, one in a submodule, a note.
      written['/project/src/old.ts'] = 2
      dirty['/project'] = [
        '1 M. N... 100644 100644 100644 aaa bbb src/old.ts',
        '2 R. N... 100644 100644 100644 aaa bbb R100 src/moved.ts',
        'src/before.ts',
        '1 .M S.M. 160000 160000 160000 aaa aaa lib/ui',
        '? src/new file.py',
        '? notes.md',
      ]
      dirty['/project/lib/ui'] = ['1 .M N... 100644 100644 100644 aaa bbb src/Button.tsx']
    }

    return { result: { stdout: '', stderr: '' } } as never
  })

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const rows = async () => {
    const names: string[] = []

    for (let index = 0; index < 8; index += 1) {
      const row = await pane.find({ type: 'Button', key: `touched-${index}` })
      const text = row === undefined ? undefined : /"text":"(?:[±▸·] )?([^"]+\.(?:py|tsx?|md))/.exec(JSON.stringify(row))?.[1]

      if (text !== undefined) {
        names.push(text)
      }
    }

    return names
  }

  // A command that writes nothing adds nothing: old.ts was changed before it ran.
  await $.tool.call({ tool: 'Bash', command: 'git status' } as never)
  expect(await rows()).toEqual([])

  await $.tool.call({ tool: 'Bash', command: 'sed -i "" s/a/b/ src/old.ts' } as never)
  expect(await rows()).toEqual(['old.ts src/old.ts', 'moved.ts src/moved.ts', 'Button.tsx lib/ui/src/Button.tsx', 'new file.py src/new file.py'])

  // Staged and nothing else, they are not written again.
  dirty['/project'] = ['1 M. N... 100644 100644 100644 aaa bbb src/new file.py']
  await $.tool.call({ tool: 'Bash', command: 'git add .' } as never)
  expect(await rows()).toEqual(['old.ts src/old.ts', 'moved.ts src/moved.ts', 'Button.tsx lib/ui/src/Button.tsx', 'new file.py src/new file.py'])
  await pane.unmount()
})

test('a search in the file walks its matches across pages, wraps, and closes on an empty Enter', async ($, on) => {
  const text = Array.from({ length: 500 }, (_, index) =>
    index === 4 ? 'const Needle = needle()' : index === 249 || index === 479 ? `  call(needle, ${index + 1})` : `line${index + 1}`,
  ).join('\n')

  on('session.cwd', () => ({ value: '/project' }))
  on('clock.now', () => ({ value: 0 }))
  on('fs.stat', () => ({ value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } }))
  on('fs.read', () => ({ value: text }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.scroll', () => ({}))
  on('ui.focus', () => ({}))
  on('process.run', () => ok(''))

  const pane = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const tally = (wanted: RegExp) => pane.find({ type: 'Text', text: wanted })

  // Without a file the key says so, and no field comes up.
  await pane.press({ key: 'idle-e' })
  expect(await pane.find({ type: 'Input', key: 'find-in-file' })).toBe(undefined)

  await pane.input({ key: 'search', text: '/project/src/app.ts' })
  await pane.press({ key: 'find-open' })
  expect(await pane.find({ type: 'Input', key: 'find-in-file' })).toBeDefined()

  await pane.input({ key: 'find-in-file', text: 'needle', kind: 'change' })
  expect(await tally(/^1 of 3$/)).toBeDefined()
  expect(await tally(/lines 2-201 of 500/)).toBeDefined()

  // Enter and the stop below go on, to the page that holds the next; the stop above goes back.
  await pane.input({ key: 'find-in-file', text: 'needle' })
  expect(await tally(/^2 of 3$/)).toBeDefined()
  expect(await tally(/lines 247-446 of 500/)).toBeDefined()
  // Enter on the field the surface emptied at the last Enter goes on too.
  await pane.input({ key: 'find-in-file', text: '' })
  expect(await tally(/^3 of 3$/)).toBeDefined()
  await pane.press({ key: 'find-down' })
  expect(await tally(/^1 of 3$/)).toBeDefined()
  expect(await tally(/lines 2-201 of 500/)).toBeDefined()
  await pane.press({ key: 'find-up' })
  expect(await tally(/^3 of 3$/)).toBeDefined()

  // A capital counts; what is nowhere says so.
  await pane.input({ key: 'find-in-file', text: 'Needle', kind: 'change' })
  expect(await tally(/^1 of 1$/)).toBeDefined()
  await pane.input({ key: 'find-in-file', text: 'nowhere', kind: 'change' })
  expect(await tally(/^no match$/)).toBeDefined()

  // Emptied, the field counts nothing; Enter on it empty takes it away.
  await pane.input({ key: 'find-in-file', text: 'needle', kind: 'change' })
  await pane.input({ key: 'find-in-file', text: '', kind: 'change' })
  expect(await tally(/^\d+ of \d+$/)).toBe(undefined)
  expect(await tally(/^no match$/)).toBe(undefined)
  await pane.input({ key: 'find-in-file', text: '' })
  expect(await pane.find({ type: 'Input', key: 'find-in-file' })).toBe(undefined)
  await pane.unmount()

  expect(findIn('const Needle = needle()', 'needle')).toEqual([[6, 12], [15, 21]])
  expect(findIn('const Needle = needle()', 'Needle')).toEqual([[6, 12]])
  expect(findIn('aaaa', 'aa')).toEqual([[0, 2], [2, 4]])
  expect(findIn('abc', '')).toEqual([])
})

/** A disk for the HTML export: the plugin's template, files to read, and what is written. */
const htmlDisk = (on: Parameters<TestBody>[1], onDisk: Record<string, string>, written: Map<string, string>) => {
  on('session.cwd', () => ({ value: '/project' }))
  on('session.id', () => ({ value: 's1' }))
  on('clock.now', () => ({ value: 0 }))
  on('fs.read', ($, event) => {
    const path = String((event as { path?: unknown }).path)
    const text = path.endsWith('/assets/diff-viewer.html')
      ? '<style>/*__CODE_VIEWER_THEME__*/</style><script>__CODE_VIEWER_DATA__</script>'
      : (written.get(path) ?? onDisk[path])

    if (text === undefined) {
      throw new Error('missing')
    }

    return { value: text }
  })
  on('fs.write', ($, event) => {
    written.set(String((event as { path?: unknown }).path), String((event as { text?: unknown }).text))

    return { value: undefined }
  })
  on('fs.stat', ($, event) => {
    const path = String((event as { path?: unknown }).path)

    if (path === '/project' || path === '/project/app') {
      return { value: { kind: 'dir' as const, size: 1, mtimeMs: 0, isLink: false } }
    }

    if (onDisk[path] === undefined) {
      throw new Error('missing')
    }

    return { value: { kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false } }
  })
}

const dataOf = (html: string | undefined) => JSON.parse(/<script>(.*)<\/script>/s.exec(html ?? '')?.[1] ?? 'null')

test('Claude writes the changes against a branch as an HTML page, colored, and opens it', async ($, on) => {
  const ran: string[] = []
  const written = new Map<string, string>()
  const file = Array.from({ length: 20 }, (_, index) => `x${index + 1} = ${index + 1}`).join('\n')

  htmlDisk(on, { '/project/app/kept.py': `${file}\n`, '/project/app/new.py': 'print("</script>")\n' }, written)
  gitHooks(
    on,
    args => {
      const line = args.join(' ')

      // `uname -s`, then `open <page>`: git's helper drops the command's own name.
      return args[0] === '-s'
        ? { stdout: 'Darwin\n' }
        : args[0] === 'rev-parse' && args[1] === '--verify'
        ? { stdout: 'abc\n' }
        : args[0] === 'rev-parse' && args[1] === '--abbrev-ref'
          ? { stdout: 'feature\n' }
          : args[0] === 'rev-parse' && args[1] === '--short'
            ? { stdout: 'abc\n' }
            : args[0] === 'merge-base'
              ? { stdout: 'abc\n' }
              : line === 'diff -M --name-status -z abc'
                ? { stdout: 'M\u0000app/kept.py\u0000' }
                : line === 'diff -M --numstat -z abc'
                  ? { stdout: '1\t1\tapp/kept.py\u0000' }
                  : args[0] === 'ls-files'
                    ? { stdout: 'app/new.py\u0000' }
                    : args[0] === 'diff' && args[1] === 'abc'
                      ? { stdout: '@@ -9,3 +9,3 @@\n x9 = 9\n-x10 = 0\n+x10 = 10\n x11 = 11\n' }
                      : args[0] === 'diff' && args[1] === '--no-index'
                        ? { stdout: '@@ -0,0 +1 @@\n+print("</script>")\n', exitCode: 1 }
                        : {}
    },
    ran,
  )

  const result = await $.tool.call({ tool: 'mcp__code-viewer__html_diff', base: 'origin/dev', language: 'es' } as never)
  const page = written.get('/tmp/code-viewer/changes-feature-vs-origin-dev.html')
  const data = dataOf(page)

  expect(String((result as { result?: unknown }).result)).toContain('2 files, +2 −1')
  expect(ran).toContain('/tmp/code-viewer/changes-feature-vs-origin-dev.html')
  expect(data.title).toBe('Cambios respecto a origin/dev')
  expect(data.files.map((entry: { p: string; m: string }) => `${entry.m} ${entry.p}`)).toEqual(['M app/kept.py', '? app/new.py'])
  // The file whole, colored, for the unchanged lines a click opens; removed lines carry their own.
  expect(data.files[0].l).toHaveLength(20)
  expect(data.files[0].l[9]).toBe('x10 <i class=p>= </i><i class=n>10</i>')
  expect(data.files[0].h[0].r[1]).toEqual(['-', 10, 0, 'x10 <i class=p>= </i><i class=n>0</i>'])
  expect(data.files[0].h[0].r[2]).toEqual(['+', 0, 10])
  // A closing tag in the code cannot end the page's script.
  expect(page?.includes('</script>")')).toBe(false)
  expect(page).toContain('i.k{color:#c678dd}')
})

test('the session page diffs each file against how it was before Claude first changed it', async ($, on) => {
  const ran: string[] = []
  const written = new Map<string, string>()
  const onDisk: Record<string, string> = { '/project/app/a.py': 'a = 1\n' }

  htmlDisk(on, onDisk, written)
  gitHooks(
    on,
    args =>
      args[0] === 'diff' && args[1] === '--no-index'
        ? { stdout: args.includes('/dev/null') ? '@@ -0,0 +1 @@\n+b = 1\n' : '@@ -1 +1 @@\n-a = 1\n+a = 2\n', exitCode: 1 }
        : {},
    ran,
  )
  on('tool.call', ($, event) => ({ result: { filePath: String((event as { file_path?: unknown }).file_path) } }) as never)
  on('command.run', () => ({ text: '' }))

  await $.tool.call({ tool: 'Edit', file_path: '/project/app/a.py', old_string: '1', new_string: '2' } as never)
  onDisk['/project/app/a.py'] = 'a = 2\n'
  await $.tool.call({ tool: 'Edit', file_path: '/project/app/a.py', old_string: '2', new_string: '3' } as never)
  await $.tool.call({ tool: 'Write', file_path: '/project/app/b.py', content: 'b = 1\n' } as never)
  onDisk['/project/app/b.py'] = 'b = 1\n'

  // The first snapshot stands: the second Edit keeps it.
  expect(written.get('/tmp/code-viewer-snapshots/s1/0-a.py')).toBe('a = 1\n')
  expect(JSON.parse(written.get('/tmp/code-viewer-snapshots/s1/index.json') ?? '{}')).toEqual({
    '/project/app/a.py': '0-a.py',
    '/project/app/b.py': null,
  })

  const { text } = await $.command.run({ command: 'code-viewer', args: 'html session', presentation: { isFullscreen: false } } as never)
  const data = dataOf(written.get('/tmp/code-viewer/session-project.html'))

  expect(text).toContain('2 files, +2 −1')
  expect(ran).toContain('diff --no-index --no-color --no-ext-diff -U3 -- /tmp/code-viewer-snapshots/s1/0-a.py /project/app/a.py')
  expect(data.source).toBe('session')
  expect(data.files.map((entry: { p: string; m: string }) => `${entry.m} ${entry.p}`)).toEqual(['M app/a.py', 'A app/b.py'])
})
