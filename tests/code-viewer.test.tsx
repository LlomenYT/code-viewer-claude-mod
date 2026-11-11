import { expect, test } from 'claude-code/testing'

import { fitHunks, hunksOf, isCode, mentionsOf, parsePatch, rank, splitLocation } from '../hooks/files'
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

test('files opened become tabs, and the band opens and closes the pane', async ($, on) => {
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
  await pane.unmount()

  await band.press({ key: 'toggle' })
  expect(opened[opened.length - 1]).toBe('close')
  await band.unmount()
})

test('only code files count as the session\'s files', async () => {
  expect(['/p/src/a.ts', '/p/App.tsx', '/p/main.py', '/p/ci.yml'].every(isCode)).toBe(true)
  expect(['/p/notes.txt', '/p/PROGRESS.md', '/p/out.log', '/p/data.json'].some(isCode)).toBe(false)
  expect(isCode('/Users/x/.claude/projects/p/tool-results/abc.txt')).toBe(false)
  expect(isCode('/Users/x/.claude/skills/run.py')).toBe(false)
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
