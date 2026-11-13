// Code Viewer: a pane beside the chat that shows files and diffs with syntax highlighting.
// This module wires the hooks and draws the UI; ./actions.ts holds what each press does.

import { atom, read } from 'claude-code'
import type { Register, TextProps } from 'claude-code'

import {
  CHANGES,
  DIFF_LINES,
  EMPTY,
  FIND,
  FIND_DOWN,
  FIND_UP,
  PAGE,
  PANE,
  askBase,
  askBaseForChanges,
  chooseBase,
  clearList,
  clearSearch,
  closeFind,
  closeTab,
  dirtyFiles,
  find,
  findInFile,
  firstChange,
  headerHeight,
  note,
  noteMentions,
  noteRoot,
  noteShellChanges,
  openFind,
  say,
  showChanges,
  showDiff,
  showFile,
  showGitDiff,
  showList,
  showTab,
  scrolled,
  startTurn,
  stepFind,
  toggle,
  toggleCollapsed,
  turnDiffPage,
  turnPage,
  typing,
} from './actions'
import { basename, clean, dirname, findIn, hunksOf, mentionsOf, relative, shortOf, unified } from './files'
import { resolveSettings } from './themes'
import { languageOf, stateAfter, tokenizeLine } from './tokenize'
import type { Kind, Span } from './tokenize'
import type { Change, Tab, Touched } from '../types'

// The same atoms ./actions.ts declares: keep keys and shape tags identical in both files.
const view = atom({ plugin: 'code-viewer', key: 'view' } as const, EMPTY, { shape: 'view-2' })
const tabs = atom({ plugin: 'code-viewer', key: 'tabs' } as const, [] as Tab[], { shape: 'tabs-2' })
const touched = atom({ plugin: 'code-viewer', key: 'touched' } as const, [] as Touched[], { shape: 'touched-2' })
const roots = atom({ plugin: 'code-viewer', key: 'roots' } as const, [] as string[], { shape: 'roots-1' })
const query = atom({ plugin: 'code-viewer', key: 'query' } as const, '')
const suggestions = atom({ plugin: 'code-viewer', key: 'suggestions' } as const, [] as string[])
const diffBase = atom({ plugin: 'code-viewer', key: 'base' } as const, '')
const promptTurn = atom({ plugin: 'code-viewer', key: 'turn' } as const, 0)

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit'])
const SEARCH_TOOLS = new Set(['Grep', 'Glob'])
// A drawn tree may hold 20,000 nodes: past this many colored spans, lines are drawn plain.
const MAX_COLORED_SPANS = 2500
const FILE_MARKS = { edited: '±', read: '▸', named: '·' } as const
const CHANGE_COLORS = { A: 'success', M: 'warning', D: 'error', R: 'suggestion', '?': 'success' } as const

export const register: Register = (on, options) => {
  const settings = resolveSettings(options)
  const { theme } = settings
  // The pane's element the ring is on, as its moves tell; and the stop a move to which was
  // answered with a step through the search's hits, whose press (a click's) must not step again.
  let ringOn: string | undefined
  let steppedBy: string | undefined

  // One set of Text props per token kind, built once.
  const styles: Partial<Record<Kind, TextProps>> = {}

  for (const [kind, style] of Object.entries(theme.tokens) as Array<[Kind, (typeof theme.tokens)[Kind]]>) {
    if (style !== undefined) {
      styles[kind] = {
        ...(style.color === undefined ? {} : { color: style.color }),
        ...(style.isBold ? { weight: 'bold' as const } : {}),
        ...(style.isItalic ? { italic: true } : {}),
        ...(style.isUnderlined ? { underline: true } : {}),
      }
    }
  }

  on('session.start', async ($, event, next) => {
    await $.command.register({
      name: 'code-viewer',
      description: 'Open a file, or its diff, in the code pane',
      argumentHint: '[diff] [file[:line] | search words] | changes',
      immediate: true,
    })

    return next(event)
  })

  on('command.run', { command: 'code-viewer' }, async ($, event) => {
    const paneSettings = { ...settings, isFullscreen: event.presentation.isFullscreen }

    if (event.args.trim() === '') {
      return { text: (await toggle($, paneSettings)) ? 'Code viewer opened.' : 'Code viewer closed.' }
    }

    // Every file the branch changed against the base.
    if (event.args.trim() === 'changes') {
      return { text: await showChanges($, paneSettings) }
    }

    return { text: await find($, paneSettings, event.args) }
  })

  // The session's files: what Claude read or changed, as each call ends.
  on('tool.call', async ($, event, next) => {
    // A shell command names no file it writes: what git calls changed, before and after, tells them.
    const before = event.tool === 'Bash' ? await dirtyFiles($).catch(() => undefined) : undefined
    const result = await next(event)
    const file = (event as { file_path?: unknown }).file_path

    if (FILE_TOOLS.has(event.tool) && typeof file === 'string' && result.deny === undefined && result.isError !== true) {
      await note($, file, event.tool === 'Read' ? 'read' : 'edited', hunksOf(result.result)).catch(() => undefined)
    }

    // Where Claude searched is where the paths it names next are likely to hang from.
    const folder = (event as { path?: unknown }).path

    if (SEARCH_TOOLS.has(event.tool) && typeof folder === 'string') {
      await noteRoot($, folder).catch(() => undefined)
    }

    // And the folders a shell command names (`cd /repo/sandbox && ...`).
    const command = (event as { command?: unknown }).command

    if (event.tool === 'Bash' && typeof command === 'string') {
      for (const named of mentionsOf(command, 4).folders.slice(0, 3)) {
        await noteRoot($, named).catch(() => undefined)
      }
    }

    if (before !== undefined) {
      await noteShellChanges($, before).catch(() => undefined)
    }

    return result
  }).catch(($, event, next) => next(event))

  // Each prompt the person sends starts a group of the session's files: the latest prompt's are drawn first.
  on('turn.start', async ($, event, next) => {
    const started = await next(event)

    if (event.agentId === undefined && event.text.trim() !== '') {
      await startTurn($).catch(() => undefined)
    }

    return started
  })

  // Where the person scrolled the pane's body to, kept per tab: a tab shown again goes back near it.
  on('ui.scroll', { requestId: PANE }, async ($, event, next) => {
    const result = await next(event)

    if (result.deny === undefined) {
      scrolled(event.offset)
    }

    return result
  }).catch(($, event, next) => next(event))

  // The ring leaving the search field for anything but what it found (Tab, a click) empties it.
  on('ui.focus', { requestId: PANE }, async ($, event, next) => {
    // From the search-in-file field the arrows walk what it found, as an editor's do: the ring
    // would go to the stop above or below the field, and stays, while the hit before or after is shown.
    const isStop = event.element === FIND_UP || event.element === FIND_DOWN

    if (isStop && ringOn === FIND && event.origin.kind === 'person' && ((await read($, view)).hits?.length ?? 0) > 0) {
      steppedBy = event.element
      await stepFind($, settings, event.element === FIND_UP ? -1 : 1).catch(() => undefined)

      return { deny: 'the search field keeps the keyboard while it has matches' }
    }

    const result = await next(event)
    const element = event.element ?? ''

    if (result.deny === undefined) {
      ringOn = event.element
      steppedBy = undefined
    }

    if (result.deny === undefined && element !== 'search' && !element.startsWith('found-')) {
      await clearSearch($).catch(() => undefined)
    }

    return result
  }).catch(($, event, next) => next(event))

  // And the files its answer names.
  on('turn.complete', async ($, event, next) => {
    const completed = await next(event)

    await noteMentions($, `${event.answer}\n${completed.text === event.answer ? '' : completed.text}`).catch(() => undefined)

    return completed
  })

  // The band redraws as the pane opens and closes: it steps aside while the pane is up.
  on('ui.open', async ($, event, next) => {
    const result = await next(event)

    if (event.id === PANE) {
      $.ui.invalidate('ui.render')
    }

    return result
  })

  on('ui.close', async ($, event, next) => {
    const result = await next(event)

    if (event.id === PANE) {
      $.ui.invalidate('ui.render')
    }

    return result
  })

  // The row above the prompt: the button that opens the pane.
  on('ui.render', { component: 'AbovePrompt' }, async ($, event, next) => {
    if (event.props.hasSurvey) {
      return next(event)
    }

    // While the pane is up the band draws nothing, so ctrl+x tab lands on the pane and its
    // keys (g, f, s…) work at once, rather than on the band, which would let them reach the prompt.
    if ((await $.ui.panes()).some(pane => pane.id === PANE && pane.isPlaced)) {
      return next(event)
    }

    const { Box, Button, Text } = $.ui.resolve(event)
    const paneSettings = { ...settings, isFullscreen: event.viewport?.isFullscreen === true }
    const fileCount = (await read($, touched)).length
    const openTabCount = (await read($, tabs)).length

    return (
      <Box flexDirection="row" gap={2}>
        <Button
          key="toggle"
          plain
          onPress={async () => {
            await toggle($, paneSettings)
          }}
        >
          <Text color="suggestion">👁  </Text>
          <Text color="suggestion" weight="bold">
            code viewer
          </Text>
        </Button>
        <Text dimColor wrap="truncate-end">
          {fileCount} {fileCount === 1 ? 'file' : 'files'}
          {openTabCount > 0 ? ` · ${openTabCount} open` : ''}
        </Text>
      </Box>
    )
  })

  // A "view code" button under each tool row that names a file.
  on('ui.render', { component: 'ToolUse' }, async ($, event, next) => {
    const row = await next(event)
    const { input, isErrored, isInterrupted, isRunning, output, tool } = event.props
    const file = (input as { file_path?: unknown } | null | undefined)?.file_path

    if (!FILE_TOOLS.has(String(tool)) || isRunning || isErrored || isInterrupted || typeof file !== 'string') {
      return row
    }

    const { Box, Button, Text } = $.ui.resolve(event)
    const paneSettings = { ...settings, isFullscreen: event.viewport?.isFullscreen === true }
    const hunks = hunksOf(output)
    const offset = (input as { offset?: unknown }).offset
    const line = firstChange(hunks) ?? (typeof offset === 'number' && offset > 0 ? offset : undefined)

    return (
      <Box flexDirection="column">
        {row}
        <Box flexDirection="row" gap={2} paddingLeft={5}>
          <Button key="open" plain onPress={() => showFile($, paneSettings, file, line, hunks.length > 0 ? hunks : undefined)}>
            <Text color="suggestion">▸ view code</Text>
          </Button>
          {hunks.length > 0 && (
            <Button key="diff" plain onPress={() => showDiff($, paneSettings, file, 'claude', hunks)}>
              <Text color="suggestion">± view diff</Text>
            </Button>
          )}
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, event) => {
    const { Box, Button, Code, Input, Text } = $.ui.resolve(event)
    const current = await read($, view)
    const openTabs = await read($, tabs)
    const searchText = await read($, query)
    const sessionFiles = await read($, touched)
    const knownRoots = await read($, roots)
    const matches = await read($, suggestions)
    const baseBranch = await read($, diffBase)
    const latestTurn = await read($, promptTurn)
    // The view holds no directory until something was shown in it.
    const cwd = await $.session.cwd().catch(() => current.cwd)
    const displayPath = (file: string) => clean(shortOf(file, cwd, knownRoots))
    const isFullscreen = event.viewport?.isFullscreen === true
    const paneSettings = { ...settings, isFullscreen }
    const { path } = current
    const wrap = settings.isWrapping ? 'wrap' : 'truncate-end'
    const language = path === undefined || settings.isEngineOnly ? undefined : languageOf(path)

    let spanBudget = MAX_COLORED_SPANS

    // Neighbours drawn alike are one node: a run of plain words and spaces, say.
    const merged = (spans: readonly Span[]): Span[] => {
      const runs: Span[] = []

      for (const [kind, text] of spans) {
        const last = runs[runs.length - 1]

        if (last !== undefined && styles[last[0]] === styles[kind]) {
          runs[runs.length - 1] = [last[0], last[1] + text]
        } else {
          runs.push([kind, text])
        }
      }

      return runs
    }

    const paint = (spans: readonly Span[]) => {
      if (spans.length === 0) {
        return ' '
      }

      if (spanBudget < spans.length) {
        return spans.map(span => span[1]).join('')
      }

      spanBudget -= spans.length

      return merged(spans).map(([kind, text]) => {
        const style = styles[kind]

        return style === undefined ? text : <Text {...style}>{text}</Text>
      })
    }

    // A line with what the search in the file found on it: each match on the theme's match colors.
    const needle = current.mode === 'file' ? (current.needle ?? '') : ''
    const matched = (spans: readonly Span[], ranges: ReadonlyArray<readonly [number, number]>) => {
      const nodes: Array<string | ReturnType<typeof h>> = []
      let offset = 0
      let rangeAt = 0

      for (const [kind, text] of merged(spans)) {
        const style = styles[kind]
        let at = 0

        while (at < text.length) {
          const range = ranges[rangeAt]
          const isHit = range !== undefined && offset + at >= range[0]
          const end = Math.min(text.length, range === undefined ? text.length : (isHit ? range[1] : range[0]) - offset)
          const piece = text.slice(at, end)

          nodes.push(
            isHit ? (
              <Text backgroundColor={theme.match} color={theme.matchText}>
                {piece}
              </Text>
            ) : style === undefined ? (
              piece
            ) : (
              <Text {...style}>{piece}</Text>
            ),
          )

          if (isHit && range !== undefined && offset + end >= range[1]) {
            rangeAt += 1
          }

          at = end
        }

        offset += text.length
      }

      return nodes
    }

    const fileBody = () => {
      const lines = current.lines ?? []
      const first = current.firstLine ?? 1
      const last = first + lines.length - 1
      const total = current.totalLines ?? last
      const width = String(last).length
      let state = current.lexState ?? ''

      return (
        <Box flexDirection="column">
          {first > 1 && (
            <Button
              key="previous"
              plain
              hotkey="p"
              label={`▲ lines ${Math.max(1, first - PAGE)}-${first - 1}`}
              onPress={() => turnPage($, paneSettings, Math.max(1, first - PAGE))}
            />
          )}
          {(language === undefined || path === undefined) && needle === '' ? (
            <Code source={lines.join('\n')} path={path ?? ''} startLine={first} wrap={wrap} />
          ) : (
            lines.map((line, index) => {
              // A language left to the engine's highlighter is drawn plain while it is searched.
              const lexed = language === undefined ? { spans: [['plain', line]] as Span[], state } : tokenizeLine(language, line, state)
              const number = first + index
              const ranges = findIn(line, needle)

              state = lexed.state

              return (
                <Box
                  key={`line-${number}`}
                  flexDirection="row"
                  {...(number === current.focusLine ? { backgroundColor: theme.focusLine } : {})}
                >
                  <Box flexShrink={0}>
                    <Text color={theme.lineNumber}>{`${String(number).padStart(width)} `}</Text>
                  </Box>
                  <Text wrap={wrap}>{ranges.length > 0 ? matched(lexed.spans, ranges) : paint(lexed.spans)}</Text>
                </Box>
              )
            })
          )}
          {last < total && (
            <Button
              key="next"
              plain
              hotkey="n"
              label={`▼ lines ${last + 1}-${Math.min(total, last + PAGE)} of ${total}`}
              onPress={() => turnPage($, paneSettings, last + 1)}
            />
          )}
        </Box>
      )
    }

    // The pages of a git diff: both keys always drawn, so n and p never reach the prompt; dim where there is none.
    const diffPager = (isTop: boolean) => {
      const first = current.diffFirst ?? 0
      const total = current.diffTotal ?? 0
      const shown = (current.hunks ?? []).reduce((sum, hunk) => sum + hunk.lines.length, 0)
      const target = isTop ? Math.max(0, first - DIFF_LINES) : first + shown
      const isThere = isTop ? first > 0 : first + shown < total
      const label = isTop
        ? isThere
          ? `▲ lines ${target + 1}-${first} of the diff`
          : '▲ start of the diff'
        : isThere
          ? `▼ lines ${target + 1}-${Math.min(total, target + DIFF_LINES)} of ${total} of the diff`
          : '▼ end of the diff'

      return (
        <Button
          key={isTop ? 'diff-previous' : 'diff-next'}
          plain
          hotkey={isTop ? 'p' : 'n'}
          label={label}
          onPress={() => (isThere ? turnDiffPage($, paneSettings, target) : Promise.resolve())}
        >
          <Text {...(isThere ? {} : { dimColor: true })}>{label}</Text>
        </Button>
      )
    }

    const diffBody = () => {
      const hunks = current.hunks ?? []
      const isGit = current.diffKind === 'git'

      if (language === undefined) {
        return (
          <Box flexDirection="column">
            {isGit && diffPager(true)}
            <Code format="diff" source={unified(hunks)} path={path ?? ''} wrap={wrap} />
            {isGit && diffPager(false)}
          </Box>
        )
      }

      // Two narrow columns of numbers: the old file's, then the new one's, blank where a side has no line.
      const oldWidth = String(Math.max(1, ...hunks.map(hunk => hunk.oldStart + hunk.lines.length))).length
      const newWidth = String(Math.max(1, ...hunks.map(hunk => hunk.newStart + hunk.lines.length))).length

      return (
        <Box flexDirection="column">
          {isGit && diffPager(true)}
          {hunks.map((hunk, hunkIndex) => {
            const added = hunk.added ?? hunk.lines.filter(line => line.startsWith('+')).length
            const removed = hunk.removed ?? hunk.lines.filter(line => line.startsWith('-')).length
            const summary = [
              added > 0 ? ['Added', added] : undefined,
              removed > 0 ? [added > 0 ? 'removed' : 'Removed', removed] : undefined,
            ].filter((part): part is [string, number] => part !== undefined)
            // Each side of the change is tokenized with a state of its own, both from the lines before the hunk.
            let oldNumber = hunk.oldStart
            let newNumber = hunk.newStart
            let oldState = hunk.lexState ?? ''
            let newState = hunk.lexState ?? ''
            const at = hunk.newStart > 0 ? hunk.newStart : hunk.oldStart

            return (
              <Box flexDirection="column" {...(hunkIndex > 0 ? { marginTop: 1 } : {})}>
                <Text>
                  <Text color={theme.lineNumber}>{`@ line ${at}${hunk.isContinued === true ? ' (continued)' : ''} · `}</Text>
                  {summary.map(([word, count], index) => (
                    <Text>
                      {index > 0 ? ', ' : ''}
                      {word} <Text weight="bold">{String(count)}</Text> {count === 1 ? 'line' : 'lines'}
                    </Text>
                  ))}
                </Text>
                {hunk.lines.map(text => {
                  const mark = text.slice(0, 1)
                  const code = text.slice(1)
                  const isAdded = mark === '+'
                  const isRemoved = mark === '-'
                  const lexed = tokenizeLine(language, code, isRemoved ? oldState : newState)
                  const oldColumn = isAdded ? '' : String(oldNumber)
                  const newColumn = isRemoved ? '' : String(newNumber)
                  const tint = isAdded ? 'success' : isRemoved ? 'error' : undefined

                  if (isRemoved) {
                    oldState = lexed.state
                    oldNumber += 1
                  } else if (isAdded) {
                    newState = lexed.state
                    newNumber += 1
                  } else {
                    oldState = tokenizeLine(language, code, oldState).state
                    newState = lexed.state
                    oldNumber += 1
                    newNumber += 1
                  }

                  const background = isAdded ? theme.diffAdded : isRemoved ? theme.diffRemoved : undefined

                  return (
                    <Box flexDirection="row" {...(background === undefined ? {} : { backgroundColor: background })}>
                      <Box flexShrink={0}>
                        <Text color={tint ?? theme.lineNumber}>
                          {`${oldColumn.padStart(oldWidth)} ${newColumn.padStart(newWidth)} ${tint === undefined ? ' ' : mark} `}
                        </Text>
                      </Box>
                      <Text wrap={wrap}>{paint(lexed.spans)}</Text>
                    </Box>
                  )
                })}
              </Box>
            )
          })}
          {isGit && diffPager(false)}
          {!isGit && current.isCut === true && (
            <Text dimColor>The diff goes on: only its first {DIFF_LINES} lines are shown.</Text>
          )}
        </Box>
      )
    }

    // The files the branch changed: a press opens one's git diff.
    const changeRow = (change: Change, index: number) => (
      <Button
        key={`change-${index}`}
        plain
        // The ring starts on the first row: Enter opens it, Tab walks down the list.
        {...(index === 0 ? { autoFocus: true as const } : {})}
        onPress={() => showGitDiff($, paneSettings, change.path)}
      >
        <Text color={CHANGE_COLORS[change.mark]} weight="bold">
          {change.mark}{' '}
        </Text>
        <Text color="success">{change.added === undefined ? '' : `+${change.added} `}</Text>
        <Text color="error">{change.removed === undefined ? 'binary ' : `−${change.removed} `}</Text>
        <Text>{basename(change.path)}</Text>
        <Text dimColor>
          {' '}
          {displayPath(change.path)}
          {change.from === undefined ? '' : ` ← ${clean(change.from)}`}
        </Text>
      </Button>
    )

    const changesBody = () => {
      const changes = current.changes ?? []
      const left = (current.changeCount ?? changes.length) - changes.length

      return (
        <Box flexDirection="column">
          {changes.length > 0 && <Text dimColor>A added, M modified, D deleted, R renamed, ? untracked: a press opens its diff.</Text>}
          {changes.map(changeRow)}
          {left > 0 && (
            <Text dimColor>
              … and {String(left)} more {left === 1 ? 'file' : 'files'} not listed (only the first {String(CHANGES)} are).
            </Text>
          )}
        </Box>
      )
    }

    // The ring starts on the first result as the pane takes the keys: Enter opens it, Tab walks the rest.
    const resultsBody = () => (
      <Box flexDirection="column">
        {(current.results ?? []).map((file, index) => (
          <Button
            key={`result-${index}`}
            plain
            {...(index === 0 ? { autoFocus: true as const } : {})}
            onPress={() => showFile($, paneSettings, file, current.resultLine)}
          >
            <Text>{basename(file)}</Text>
            <Text dimColor> {displayPath(file)}</Text>
          </Button>
        ))}
      </Box>
    )

    const fileRow = (file: Touched, index: number) => (
      <Button
        key={`touched-${index}`}
        plain
        onPress={() => showFile($, paneSettings, file.path, firstChange(file.hunks ?? []), file.hunks)}
      >
        <Text {...(file.how === 'edited' ? { color: 'suggestion' as const } : { dimColor: true })}>
          {FILE_MARKS[file.how]}{' '}
        </Text>
        <Text>{basename(file.path)}</Text>
        <Text dimColor> {displayPath(file.path)}</Text>
      </Button>
    )

    // What the field found so far: the first is the one Enter opens.
    const foundBody = () => (
      <Box flexDirection="column">
        <Text dimColor>
          {matches.length === 0 ? `Nothing close to "${clean(searchText)}" yet.` : 'Enter opens the first:'}
        </Text>
        {matches.map((file, index) => {
          const sessionFile = sessionFiles.find(entry => entry.path === file)

          return (
            <Button
              key={`found-${index}`}
              plain
              onPress={async () => {
                await typing($, '')
                await showFile($, paneSettings, file, firstChange(sessionFile?.hunks ?? []), sessionFile?.hunks)
              }}
            >
              <Text {...(index === 0 ? { color: 'suggestion' as const } : { dimColor: true })}>
                {sessionFile === undefined ? ' ' : FILE_MARKS[sessionFile.how]}{' '}
              </Text>
              <Text {...(index === 0 ? { weight: 'bold' as const } : {})}>{basename(file)}</Text>
              <Text dimColor> {displayPath(file)}</Text>
            </Button>
          )
        })}
      </Box>
    )

    // The branches to compare with: a press picks one, the field takes any other.
    const basesBody = (file: string) => (
      <Box flexDirection="column">
        <Input
          key="base"
          autoFocus
          label="Diff against"
          placeholder="a branch (part of its name is enough) or a commit, then Enter"
          submitLabel="diff"
          onSubmit={value => {
            void chooseBase($, paneSettings, file, value)
          }}
        />
        <Text dimColor>Only your changes are shown: what differs from where your branch left it.</Text>
        {['HEAD', ...(current.bases ?? [])].map((name, index) => (
          <Button key={`base-${index}`} plain onPress={() => chooseBase($, paneSettings, file, name)}>
            <Text {...(name === baseBranch ? { color: 'suggestion' as const } : { dimColor: true })}>
              {name === baseBranch ? '●' : '○'}{' '}
            </Text>
            <Text>{clean(name)}</Text>
            {name === 'HEAD' && <Text dimColor> uncommitted changes only</Text>}
            {current.baseCounts?.[name] !== undefined && (
              <Text dimColor>
                {' '}
                {current.baseCounts[name][0]} ahead, {current.baseCounts[name][1]} behind
              </Text>
            )}
          </Button>
        ))}
      </Box>
    )

    // The latest prompt's files first, then a dim line, then the earlier ones; a "clear" empties the list.
    const listBody = () => {
      if (sessionFiles.length === 0) {
        return (
          <Text dimColor>
            No files yet this session. Press "view code" under a Read, Edit or Write row, type a file name above,
            or run /code-viewer &lt;file&gt;.
          </Text>
        )
      }

      const isLatest = (file: Touched) => latestTurn > 0 && file.turn === latestTurn
      const latestCount = sessionFiles.filter(isLatest).length
      const earlierAt = sessionFiles.findIndex(file => !isLatest(file))

      return (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={2} flexWrap="wrap">
            <Text dimColor>This session's files, the latest first (± changed, ▸ read, · named):</Text>
            {choice('clear-list', 'k', 'clear', false, () => clearList($), true)}
          </Box>
          {latestCount > 0 && <Text dimColor>── latest prompt ──</Text>}
          {sessionFiles.map((file, index) => [
            index === earlierAt && latestCount > 0 ? <Text key={`earlier-${index}`} dimColor>── earlier ──</Text> : null,
            fileRow(file, index),
          ])}
        </Box>
      )
    }

    // A tab's name: the file's, led by its folder's when another tab has the same name.
    const tabName = (tabPath: string) => {
      const name = basename(tabPath)
      const isShared = openTabs.some(other => other.path !== tabPath && basename(other.path) === name)

      return clean(isShared ? `${basename(dirname(tabPath))}/${name}` : name)
    }

    // One tab: its number and name, and a × the pointer brings out (always there on the one in view).
    const tabRow = () => (
      <Box flexDirection="row" columnGap={1} flexWrap="wrap">
        {openTabs.map((tab, index) => {
          const isActive = tab.path === path

          return (
            <Box key={`tabbox-${index}`} flexDirection="row" flexShrink={0}>
              <Button key={`tab-${index}`} plain hotkey={String(index + 1)} onPress={() => showTab($, paneSettings, tab.path)}>
                <Text
                  {...(isActive
                    ? { color: 'suggestion' as const, weight: 'bold' as const, underline: true }
                    : { dimColor: true, hover: { dimColor: false, underline: true } })}
                >
                  {tabName(tab.path)}
                </Text>
              </Button>
              <Box width={2} flexShrink={0} justifyContent="flex-end">
                <Box {...(isActive ? {} : { display: 'none' as const, hover: { display: 'flex' as const } })}>
                  <Button key={`tab-close-${index}`} plain onPress={() => closeTab($, paneSettings, tab.path)}>
                    <Text color="error" weight="bold">
                      ×
                    </Text>
                  </Button>
                </Box>
              </Box>
            </Box>
          )
        })}
      </Box>
    )

    // A view of the file, or a control of the pane: its key, then its name, lit when it is the one on.
    const choice = (key: string, hotkey: string, label: string, isOn: boolean, onPress: () => Promise<void>, isQuiet = false) => (
      <Box key={`over-${key}`} flexShrink={0}>
        <Button key={key} plain hotkey={hotkey} onPress={onPress}>
          <Text
            {...(isOn
            ? { color: 'success' as const, weight: 'bold' as const, underline: true }
            : isQuiet
              ? { dimColor: true, hover: { dimColor: false } }
              : { hover: { underline: true } })}
          >
            {label}
          </Text>
        </Button>
      </Box>
    )

    // The search in the file: its field between the two stops the arrows reach from it, then
    // which match is the current one of how many, and a close.
    const findStep = (stop: string, by: 1 | -1) => async () => {
      // A click on a stop from the field was answered as the ring's move was.
      if (steppedBy === stop) {
        steppedBy = undefined

        return
      }

      await stepFind($, paneSettings, by)
    }
    const findRow = () => {
      const count = current.hitCount ?? 0
      const kept = current.hits?.length ?? 0
      const typed = current.needle ?? ''
      const tally =
        typed === ''
          ? ''
          : count === 0
            ? 'no match'
            : `${(current.hitAt ?? 0) + 1} of ${kept}${count > kept ? ` (${count} lines match)` : ''}`

      // Three rows, for the arrows go to what is drawn above and below the field, not beside it.
      return (
        <Box key="find-row" flexDirection="column">
          <Box flexDirection="row" columnGap={2}>
            <Button key={FIND_UP} plain onPress={findStep(FIND_UP, -1)}>
              <Text dimColor hover={{ dimColor: false }}>
                ▲ previous match
              </Text>
            </Button>
            {tally !== '' && <Text color={count === 0 ? 'error' : 'warning'}>{tally}</Text>}
          </Box>
          <Input
            key={FIND}
            autoFocus
            label="Find in file"
            value={typed}
            placeholder={typed === '' ? 'text to find, then Enter or ↑↓' : typed}
            submitLabel="next"
            onInput={value => {
              // The module's own moves of the ring skip its hooks: typing here tells where it is.
              ringOn = FIND
              void findInFile($, paneSettings, value)
            }}
            onSubmit={value => {
              ringOn = FIND
              // The surface empties the field at Enter: empty with a search on, it is Enter again,
              // the next match; emptied by the person (which `onInput` told), it closes the search.
              void (value === '' && typed === ''
                ? closeFind($)
                : value === '' || value === typed
                  ? stepFind($, paneSettings, 1)
                  : findInFile($, paneSettings, value))
            }}
          />
          <Box flexDirection="row" columnGap={2}>
            <Button key={FIND_DOWN} plain onPress={findStep(FIND_DOWN, 1)}>
              <Text dimColor hover={{ dimColor: false }}>
                ▼ next match
              </Text>
            </Button>
            <Button key="find-close" plain onPress={() => closeFind($)}>
              <Text dimColor hover={{ dimColor: false, color: 'error' }}>
                × close search
              </Text>
            </Button>
          </Box>
        </Box>
      )
    }

    const shownDiffLines = (current.hunks ?? []).reduce((sum, hunk) => sum + hunk.lines.length, 0)
    const about =
      current.mode === 'file'
        ? current.totalLines === 0
          ? 'empty file'
          : `lines ${current.firstLine ?? 1}-${(current.firstLine ?? 1) + (current.lines?.length ?? 0) - 1} of ${current.totalLines ?? 0}`
        : current.mode === 'diff'
          ? current.diffKind === 'git'
            ? [
                `your changes against ${clean(current.diffBase ?? 'HEAD')}`,
                current.diffNote,
                `+${current.diffAdded ?? 0} −${current.diffRemoved ?? 0}`,
                (current.diffTotal ?? 0) > shownDiffLines
                  ? `lines ${(current.diffFirst ?? 0) + 1}-${(current.diffFirst ?? 0) + shownDiffLines} of ${current.diffTotal ?? 0} of the diff`
                  : undefined,
              ]
                .filter((part): part is string => part !== undefined)
                .join(' · ')
            : "Claude's change"
          : current.mode === 'results'
            ? `${current.results?.length ?? 0} files of ${current.scope === 'session' ? 'this session' : 'the project'} match "${clean(current.query ?? '')}"`
            : current.mode === 'bases'
              ? 'pick the branch to diff against'
              : current.mode === 'changes' && current.diffBase !== undefined
                ? `${current.changeCount ?? 0} ${current.changeCount === 1 ? 'file' : 'files'} changed against ${clean(current.diffBase)} · +${current.changeAdded ?? 0} −${current.changeRemoved ?? 0}`
                : ''

    const name =
      path !== undefined
        ? displayPath(path)
        : current.mode === 'changes' || current.basesFor === 'changes'
          ? 'Changes'
          : 'Code viewer'

    // The pane's keys that no drawn control answers now: held by Buttons that are never seen,
    // so a press says why it does nothing instead of falling through to the prompt.
    const fileFirst = current.firstLine ?? 1
    const fileLast = fileFirst + (current.lines?.length ?? 0) - 1
    // The git diff draws its own p and n, dimmed at its ends.
    const isGitDiff = current.mode === 'diff' && current.diffKind === 'git'
    const isListShown =
      current.mode === 'empty' && path === undefined && searchText.trim().length < 2 && sessionFiles.length > 0
    const noFile = 'No file is open: pick one, or type its name.'
    const idleKeys: Array<[hotkey: string, message: string]> = [
      ...(current.isCollapsed === true
        ? (['f', 'c', 'g', 'b', 'w', 'n', 'p', 's', 'l', 'd', 'k', 'e', ...'123456789'].map(key => [key, '']) as Array<[string, string]>)
        : [
            ...(path === undefined
              ? ((current.mode === 'changes' ? ['f', 'g', 'w'] : ['f', 'g', 'b', 'w']).map(key => [key, noFile]) as Array<[string, string]>)
              : []),
            // `e` searches in a file, where one is drawn.
            ...(current.mode === 'file' && path !== undefined
              ? []
              : [['e', path === undefined ? noFile : 'Search works on the file itself: press f, then e.'] as [string, string]]),
            // `k` clears the session's list, where that list is drawn.
            ...(isListShown ? [] : [['k', ''] as [string, string]]),
            ...(path === undefined || current.claudeHunks === undefined
              ? [['c', path === undefined ? noFile : 'Claude has not changed this file this session.'] as [string, string]]
              : []),
            ...(isGitDiff || (current.mode === 'file' && fileFirst > 1)
              ? []
              : [['p', current.mode === 'file' ? 'Already the first page.' : 'p and n turn the pages of a file.'] as [string, string]]),
            ...(isGitDiff || (current.mode === 'file' && fileLast < (current.totalLines ?? fileLast))
              ? []
              : [['n', current.mode === 'file' ? 'Already the last page.' : 'p and n turn the pages of a file.'] as [string, string]]),
            ...[...'123456789']
              .slice(openTabs.length)
              .map(
                key =>
                  [key, openTabs.length === 0 ? 'No tabs are open.' : `Only ${openTabs.length} ${openTabs.length === 1 ? 'tab is' : 'tabs are'} open.`] as [
                    string,
                    string,
                  ],
              ),
          ]),
    ]
    const idle = (
      <Box key="idle-keys" display="none">
        {idleKeys.map(([hotkey, message]) => (
          <Button
            key={`idle-${hotkey}`}
            plain
            hotkey={hotkey}
            label={hotkey}
            onPress={async () => {
              if (message !== '') {
                await say($, message)
              }
            }}
          />
        ))}
      </Box>
    )
    // A file under neither the working directory nor a folder Claude worked in.
    const isOutside = path !== undefined && shortOf(path, cwd, knownRoots) === path

    if (current.isCollapsed === true) {
      return (
        <Box flexDirection="row" gap={1}>
          <Button key="collapse" hotkey="m" label="expand" onPress={() => toggleCollapsed($, paneSettings)} />
          <Button key="close" hotkey="x" label="close" onPress={() => $.ui.close({ id: PANE })} />
          <Text wrap="truncate-start" dimColor>
            {name}
          </Text>
          {idle}
        </Box>
      )
    }

    // The rows drawn above a file's body (tabs, header, controls, field), reckoned for a tab's scroll.
    const columns = Math.max(20, event.props.bodyColumns)
    let tabLines = 0
    let lineUsed = columns

    for (const [index, tab] of openTabs.entries()) {
      const width = `${index + 1}: ${tabName(tab.path)}`.length + 3

      if (lineUsed + width > columns) {
        tabLines += 1
        lineUsed = 0
      }

      lineUsed += width
    }

    headerHeight(tabLines + (path === undefined ? 4 : 5))

    const keys = event.props.isFocused
      ? current.mode === 'file' && current.needle !== undefined
        ? 'enter or ↓ next match · ↑ previous · enter on an empty field closes the search · esc back to the prompt'
        : '↑↓ scroll · p/n page · esc back to the prompt'
      : `ctrl+x tab to use the keys${isFullscreen ? '' : ' · /tui fullscreen docks the pane, with the mouse'}`
    const folder = name.includes('/') ? name.slice(0, name.lastIndexOf('/') + 1) : ''

    return (
      <Box flexDirection="column">
        {openTabs.length > 0 && tabRow()}
        <Box flexDirection="row" columnGap={2}>
          <Box flexShrink={1}>
            <Text wrap="truncate-start">
              <Text dimColor>{folder}</Text>
              <Text weight="bold">{name.slice(folder.length)}</Text>
              {isOutside && <Text dimColor> (outside the project)</Text>}
              {about !== '' && <Text color="warning"> {about}</Text>}
            </Text>
          </Box>
          {current.mode === 'file' &&
            path !== undefined &&
            choice(
              'find-open',
              'e',
              'search in file',
              current.needle !== undefined,
              async () => {
                await openFind($)
                ringOn = FIND
              },
              true,
            )}
        </Box>
        <Box flexDirection="row" columnGap={2} flexWrap="wrap">
          {path !== undefined && choice('mode-file', 'f', 'file', current.mode === 'file', () => showFile($, paneSettings, path, current.focusLine))}
          {path !== undefined &&
            current.claudeHunks !== undefined &&
            choice('mode-claude', 'c', "Claude's diff", current.mode === 'diff' && current.diffKind === 'claude', () =>
              showDiff($, paneSettings, path, 'claude', current.claudeHunks ?? []),
            )}
          {path !== undefined &&
            choice('mode-git', 'g', 'git diff', current.mode === 'diff' && current.diffKind === 'git', () =>
              showGitDiff($, paneSettings, path),
            )}
          {path !== undefined &&
            choice('mode-base', 'b', baseBranch === '' ? 'vs…' : `vs ${clean(baseBranch).length > 30 ? `${clean(baseBranch).slice(0, 29)}…` : clean(baseBranch)}`, current.mode === 'bases', () =>
              askBase($, paneSettings, path),
            )}
          {path === undefined &&
            current.mode === 'changes' &&
            choice('mode-base', 'b', baseBranch === '' ? 'vs…' : `vs ${clean(baseBranch).length > 30 ? `${clean(baseBranch).slice(0, 30)}…` : clean(baseBranch)}`, false, () =>
              askBaseForChanges($, paneSettings, cwd),
            )}
          {choice('mode-changes', 'd', 'changes', current.mode === 'changes', async () => {
            await showChanges($, paneSettings)
          })}
        </Box>
        <Box flexDirection="row" columnGap={2} flexWrap="wrap">
          {choice(
            'find',
            's',
            'search',
            false,
            async () => {
              // An empty field: what was typed before is gone. The ring goes to it, so the letters
              // typed next are a name, not the pane's keys.
              await clearSearch($)
              await $.ui.focus({ requestId: PANE, key: 'search' }).catch(() => undefined)
            },
            true,
          )}
          {choice('list', 'l', 'files', current.mode === 'empty' && path === undefined, () => showList($, paneSettings), true)}
          {path !== undefined && choice('close-tab', 'w', 'close tab', false, () => closeTab($, paneSettings), true)}
          {choice('collapse', 'm', 'minimize', false, () => toggleCollapsed($, paneSettings), true)}
          <Box key="over-close" flexShrink={0}>
            <Button key="close" plain hotkey="x" onPress={() => $.ui.close({ id: PANE })}>
              <Text dimColor hover={{ dimColor: false, color: 'error' }}>
                close
              </Text>
            </Button>
          </Box>
        </Box>
        <Text dimColor wrap="truncate-end">
          {keys}
        </Text>
        <Input
          key="search"
          {...(path === undefined && current.mode === 'empty' ? { autoFocus: true as const } : {})}
          label="Find file"
          value={searchText}
          placeholder="a file of this session, or any name or path:line, then Enter"
          submitLabel="open"
          onInput={value => {
            void typing($, value)
          }}
          onSubmit={value => {
            void find($, paneSettings, value, true)
          }}
        />
        {searchText.trim().length >= 2 && foundBody()}
        {current.message !== undefined && <Text color="warning">{current.message}</Text>}
        {current.mode === 'file' && current.needle !== undefined && findRow()}
        {current.mode === 'file' && fileBody()}
        {current.mode === 'diff' && diffBody()}
        {current.mode === 'results' && resultsBody()}
        {current.mode === 'bases' && path !== undefined && basesBody(path)}
        {current.mode === 'bases' && path === undefined && current.basesFor === 'changes' && basesBody(`${cwd}/`)}
        {current.mode === 'changes' && changesBody()}
        {current.mode === 'empty' && path === undefined && searchText.trim().length < 2 && listBody()}
        {idle}
      </Box>
    )
  })
}
