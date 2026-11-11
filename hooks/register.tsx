// Code Viewer: a pane beside the chat that shows files and diffs with syntax highlighting.
// This module wires the hooks and draws the UI; ./actions.ts holds what each press does.

import { atom, read } from 'claude-code'
import type { Register, TextProps } from 'claude-code'

import {
  DIFF_LINES,
  EMPTY,
  PAGE,
  PANE,
  askBase,
  chooseBase,
  closeTab,
  find,
  firstChange,
  note,
  noteMentions,
  noteRoot,
  showDiff,
  showFile,
  showGitDiff,
  showList,
  showTab,
  toggle,
  toggleCollapsed,
  turnPage,
  typing,
} from './actions'
import { basename, clean, hunksOf, mentionsOf, relative, shortOf, unified } from './files'
import { resolveSettings } from './themes'
import { languageOf, stateAfter, tokenizeLine } from './tokenize'
import type { Kind, Span } from './tokenize'
import type { Tab, Touched } from '../types'

// The same atoms ./actions.ts declares: keep keys and shape tags identical in both files.
const view = atom({ plugin: 'code-viewer', key: 'view' } as const, EMPTY, { shape: 'view-1' })
const tabs = atom({ plugin: 'code-viewer', key: 'tabs' } as const, [] as Tab[], { shape: 'tabs-1' })
const touched = atom({ plugin: 'code-viewer', key: 'touched' } as const, [] as Touched[], { shape: 'touched-2' })
const roots = atom({ plugin: 'code-viewer', key: 'roots' } as const, [] as string[], { shape: 'roots-1' })
const query = atom({ plugin: 'code-viewer', key: 'query' } as const, '')
const suggestions = atom({ plugin: 'code-viewer', key: 'suggestions' } as const, [] as string[])
const diffBase = atom({ plugin: 'code-viewer', key: 'base' } as const, '')

const FILE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit'])
const SEARCH_TOOLS = new Set(['Grep', 'Glob'])
// A drawn tree may hold 20,000 nodes: past this many colored spans, lines are drawn plain.
const MAX_COLORED_SPANS = 2500
const FILE_MARKS = { edited: '±', read: '▸', named: '·' } as const

export const register: Register = (on, options) => {
  const settings = resolveSettings(options)
  const { theme } = settings

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
      argumentHint: '[diff] [file[:line] | search words]',
      immediate: true,
    })

    return next(event)
  })

  on('command.run', { command: 'code-viewer' }, async ($, event) => {
    const paneSettings = { ...settings, isFullscreen: event.presentation.isFullscreen }

    if (event.args.trim() === '') {
      return { text: (await toggle($, paneSettings)) ? 'Code viewer opened.' : 'Code viewer closed.' }
    }

    return { text: await find($, paneSettings, event.args) }
  })

  // The session's files: what Claude read or changed, as each call ends.
  on('tool.call', async ($, event, next) => {
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

    return result
  }).catch(($, event, next) => next(event))

  // And the files its answer names.
  on('turn.complete', async ($, event, next) => {
    const completed = await next(event)

    await noteMentions($, `${event.answer}\n${completed.text === event.answer ? '' : completed.text}`).catch(() => undefined)

    return completed
  })

  // The row above the prompt: the button that opens and closes the pane.
  on('ui.render', { component: 'AbovePrompt' }, async ($, event, next) => {
    if (event.props.hasSurvey) {
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
          {language === undefined || path === undefined ? (
            <Code source={lines.join('\n')} path={path ?? ''} startLine={first} wrap={wrap} />
          ) : (
            lines.map((line, index) => {
              const lexed = tokenizeLine(language, line, state)
              const number = first + index

              state = lexed.state

              return (
                <Box
                  flexDirection="row"
                  {...(number === current.focusLine ? { backgroundColor: theme.focusLine } : {})}
                >
                  <Box flexShrink={0}>
                    <Text color={theme.lineNumber}>{`${String(number).padStart(width)} `}</Text>
                  </Box>
                  <Text wrap={wrap}>{paint(lexed.spans)}</Text>
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

    const diffBody = () => {
      const hunks = current.hunks ?? []

      if (language === undefined) {
        return <Code format="diff" source={unified(hunks)} path={path ?? ''} wrap={wrap} />
      }

      const width = String(
        Math.max(1, ...hunks.map(hunk => Math.max(hunk.oldStart, hunk.newStart) + hunk.lines.length)),
      ).length

      return (
        <Box flexDirection="column">
          {hunks.map((hunk, hunkIndex) => {
            const added = hunk.lines.filter(line => line.startsWith('+')).length
            const removed = hunk.lines.filter(line => line.startsWith('-')).length
            const summary = [
              added > 0 ? ['Added', added] : undefined,
              removed > 0 ? [added > 0 ? 'removed' : 'Removed', removed] : undefined,
            ].filter((part): part is [string, number] => part !== undefined)
            // Each side of the change is tokenized with a state of its own.
            let oldNumber = hunk.oldStart
            let newNumber = hunk.newStart
            let oldState = ''
            let newState = ''

            return (
              <Box flexDirection="column" {...(hunkIndex > 0 ? { marginTop: 1 } : {})}>
                <Text>
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
                  // One column of numbers: a removed line keeps its old one, every other its new one.
                  const number = String(isRemoved ? oldNumber : newNumber)
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
                        <Text color={tint ?? theme.lineNumber}>{`${number.padStart(width)} ${tint === undefined ? ' ' : mark} `}</Text>
                      </Box>
                      <Text wrap={wrap}>{paint(lexed.spans)}</Text>
                    </Box>
                  )
                })}
              </Box>
            )
          })}
          {current.isCut === true && <Text dimColor>The diff goes on: only its first {DIFF_LINES} lines are shown.</Text>}
        </Box>
      )
    }

    const resultsBody = () => (
      <Box flexDirection="column">
        {(current.results ?? []).map((file, index) => (
          <Button key={`result-${index}`} plain onPress={() => showFile($, paneSettings, file)}>
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
          </Button>
        ))}
      </Box>
    )

    const listBody = () =>
      sessionFiles.length === 0 ? (
        <Text dimColor>
          No files yet this session. Press "view code" under a Read, Edit or Write row, type a file name above,
          or run /code-viewer &lt;file&gt;.
        </Text>
      ) : (
        <Box flexDirection="column">
          <Text dimColor>This session's files, the latest first (± changed, ▸ read, · named):</Text>
          {sessionFiles.map(fileRow)}
        </Box>
      )

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
                  {clean(basename(tab.path))}
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

    const about =
      current.mode === 'file'
        ? `lines ${current.firstLine ?? 1}-${(current.firstLine ?? 1) + (current.lines?.length ?? 0) - 1} of ${current.totalLines ?? 0}`
        : current.mode === 'diff'
          ? current.diffKind === 'git'
            ? `your changes against ${clean(current.diffBase ?? 'HEAD')}`
            : "Claude's change"
          : current.mode === 'results'
            ? `${current.results?.length ?? 0} files of ${current.scope === 'session' ? 'this session' : 'the project'} match "${clean(current.query ?? '')}"`
            : current.mode === 'bases'
              ? 'pick the branch to diff against'
              : ''

    const name = path === undefined ? 'Code viewer' : displayPath(path)

    if (current.isCollapsed === true) {
      return (
        <Box flexDirection="row" gap={1}>
          <Button key="collapse" hotkey="m" label="expand" onPress={() => toggleCollapsed($, paneSettings)} />
          <Button key="close" hotkey="x" label="close" onPress={() => $.ui.close({ id: PANE })} />
          <Text wrap="truncate-start" dimColor>
            {name}
          </Text>
        </Box>
      )
    }

    const keys = event.props.isFocused
      ? '↑↓ scroll · p/n page · esc back to the prompt'
      : `ctrl+x tab to use the keys${isFullscreen ? '' : ' · /tui fullscreen docks the pane, with the mouse'}`
    const folder = name.includes('/') ? name.slice(0, name.lastIndexOf('/') + 1) : ''

    return (
      <Box flexDirection="column">
        {openTabs.length > 0 && tabRow()}
        <Text wrap="truncate-start">
          <Text dimColor>{folder}</Text>
          <Text weight="bold">{name.slice(folder.length)}</Text>
          {about !== '' && <Text color="warning"> {about}</Text>}
        </Text>
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
            choice('mode-base', 'b', baseBranch === '' ? 'vs…' : `vs ${clean(baseBranch).slice(0, 30)}`, current.mode === 'bases', () =>
              askBase($, paneSettings, path),
            )}
        </Box>
        <Box flexDirection="row" columnGap={2} flexWrap="wrap">
          {choice(
            'find',
            's',
            'search',
            false,
            async () => {
              // The ring goes to the field, so the letters typed next are a name, not the pane's keys.
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
        {current.mode === 'file' && fileBody()}
        {current.mode === 'diff' && diffBody()}
        {current.mode === 'results' && resultsBody()}
        {current.mode === 'bases' && path !== undefined && basesBody(path)}
        {current.mode === 'empty' && path === undefined && searchText.trim().length < 2 && listBody()}
      </Box>
    )
  })
}
