// What the pane's buttons, the search field and the command do: each reads
// what it needs through `$`, writes the view and opens the pane.

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Change, Hunk, Tab, Touched, View } from '../types'
import {
  absolute,
  ancestors,
  basename,
  branchesNamed,
  clean,
  countHunks,
  dirname,
  fitHunks,
  insideWorktree,
  isAbsolute,
  isCode,
  mentionsOf,
  pageHunks,
  parseChanges,
  parsePatch,
  preferredBranch,
  rank,
  shortOf,
  relative,
  splitLines,
  splitLocation,
  WRAPPED_LINE,
} from './files'
import type { Settings } from './themes'
import { languageOf, stateAfter, tokenizeLine } from './tokenize'

export const PANE = 'code-viewer'
/** Lines of a file drawn at once; the pane's buttons turn the page. */
export const PAGE = 200
/** Lines of a diff kept. */
export const DIFF_LINES = 400
const RESULTS = 40
/** Tabs kept open at once: one digit each. */
export const TABS = 9
/** Files of the session remembered, and the lines of Claude's change kept for each. */
const TOUCHED = 60
const TOUCHED_DIFF_LINES = 120
/** How many of them keep that change: a stored value holds 20,000 values at most, every line one. */
const TOUCHED_WITH_DIFF = 12
/** Lines of Claude's change kept beside a tab and the view, for the same bound. */
const KEPT_DIFF_LINES = 400
/** Paths in one answer of Claude's looked up on disk. */
const MENTIONS = 60
/** Folders remembered for them, and the lookups one answer may cost. */
const ROOTS = 6
/** Matches drawn under the search field, and how long a listing of the roots is trusted. */
export const SUGGESTED = 12
const INDEX_MS = 20_000
const INDEX_FILES = 40_000
/** Branches offered as the base of a git diff, and the lines kept around each change. */
const BASES = 40
/** Bases whose distance from the current branch is counted, one git call each. */
const COUNTED_BASES = 20
const DIFF_CONTEXT = 3
/** Files drawn in the `changes` list; the rest are counted. */
export const CHANGES = 300
const USUAL_BASES = [
  'origin/dev',
  'origin/develop',
  'origin/main',
  'origin/master',
  'dev',
  'develop',
  'main',
  'master',
]
const LOOKUPS = 240
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'build', 'target', 'vendor', '__pycache__'])

/** The view before anything was opened. */
export const EMPTY: View = { mode: 'empty', cwd: '' }
// Bump a shape tag when its type changes: stored values of the old shape are dropped.
// register.tsx declares the same atoms, because the validator scans each file on its own.
const view = atom({ plugin: 'code-viewer', key: 'view' } as const, EMPTY, { shape: 'view-2' })

const tabs = atom({ plugin: 'code-viewer', key: 'tabs' } as const, [] as Tab[], { shape: 'tabs-2' })
const touched = atom({ plugin: 'code-viewer', key: 'touched' } as const, [] as Touched[], { shape: 'touched-2' })
const roots = atom({ plugin: 'code-viewer', key: 'roots' } as const, [] as string[], { shape: 'roots-1' })
const diffBase = atom({ plugin: 'code-viewer', key: 'base' } as const, '')
const suggestions = atom({ plugin: 'code-viewer', key: 'suggestions' } as const, [] as string[])
const searchText = atom({ plugin: 'code-viewer', key: 'query' } as const, '')
const promptTurn = atom({ plugin: 'code-viewer', key: 'turn' } as const, 0)

type Engine = EngineInterface

/** The first changed line of a diff, on the new side. */
export function firstChange(hunks: readonly Hunk[]): number | undefined {
  const hunk = hunks[0]

  if (hunk === undefined) {
    return undefined
  }

  let line = hunk.newStart

  for (const text of hunk.lines) {
    if (!text.startsWith(' ')) {
      break
    }

    line += 1
  }

  return line
}

async function listFiles($: Engine, cwd: string): Promise<string[]> {
  const lines = (text: string) => text.split('\n').filter(line => line !== '')

  try {
    // The tracked files, the submodules' included; git takes no untracked ones with them, so those come apart.
    const tracked = await $.process.run(['git', '-c', 'core.quotePath=false', 'ls-files', '--cached', '--recurse-submodules'], {
      cwd,
    })

    if (tracked.exitCode === 0) {
      const untracked = await $.process
        .run(['git', '-c', 'core.quotePath=false', 'ls-files', '--others', '--exclude-standard'], { cwd })
        .catch(() => undefined)
      const files = [...lines(tracked.stdout), ...(untracked?.exitCode === 0 ? lines(untracked.stdout) : [])]

      if (files.length > 0) {
        return [...new Set(files)]
      }
    }
  } catch {
    // An older git, or none: the plain listing below.
  }

  try {
    const result = await $.process.run(
      ['git', '-c', 'core.quotePath=false', 'ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd },
    )

    if (result.exitCode === 0 && result.stdout.trim() !== '') {
      return lines(result.stdout)
    }
  } catch {
    // No git here: walk the folders instead.
  }

  const files: string[] = []
  const queue = ['']
  let visited = 0

  while (queue.length > 0 && files.length < 5000 && visited < 500) {
    const dir = queue.shift() ?? ''

    visited += 1

    const entries = await $.fs.list(dir === '' ? cwd : `${cwd}/${dir}`).catch(() => [])

    for (const entry of entries) {
      const path = dir === '' ? entry.name : `${dir}/${entry.name}`

      if (entry.kind === 'file') {
        files.push(path)
      } else if (entry.kind === 'dir' && !entry.name.startsWith('.') && !SKIPPED_DIRS.has(entry.name)) {
        queue.push(path)
      }
    }
  }

  return files
}

/** Rows asked for while the pane sits above the prompt: open, and minimized. */
const INLINE_ROWS = 24
const COLLAPSED_ROWS = 1

async function place(
  $: Engine,
  settings: Settings,
  title: string,
  isCollapsed: boolean,
  wantsKeyboard = settings.isFullscreen !== true,
): Promise<void> {
  await $.ui.open({
    id: PANE,
    title,
    columns: 84,
    rows: isCollapsed ? COLLAPSED_ROWS : INLINE_ROWS,
    // Above the prompt there is no mouse, so the pane takes the keyboard; Esc returns it.
    ...(wantsKeyboard && !isCollapsed ? { focus: true as const } : {}),
    ...(settings.theme.background === undefined ? {} : { backgroundColor: settings.theme.background }),
  })
}

// Where the pane's body is scrolled to, as the person's last move left it (register.tsx's
// `ui.scroll` hook), how many rows the drawing puts above a file's first line (its estimate, as
// the pane draws), and the offset a tab shown again goes back to. The module's own, gone at a reload.
let paneOffset = 0
let headerRows = 0
let restoreOffset: number | undefined

/** Remembers where the body was scrolled to. */
export function scrolled(offset: number): void {
  paneOffset = offset
}

/** Remembers how many rows the pane draws above a file's first line. */
export function headerHeight(rows: number): void {
  headerRows = rows
}

/** How a view shows its file, as a tab keeps it; nothing for a view that shows neither. */
function modeOf(next: View): Tab['mode'] {
  return next.mode === 'file' ? 'file' : next.mode === 'diff' ? (next.diffKind === 'git' ? 'git' : 'claude') : undefined
}

/** Shows `next` and opens the pane; the file in it becomes a tab unless `keepsTab` is false (a file that cannot be read). */
export async function show(
  $: Engine,
  settings: Settings,
  next: View,
  title: string,
  wantsKeyboard?: boolean,
  keepsTab = true,
): Promise<void> {
  const { path } = next
  const restore = restoreOffset

  restoreOffset = undefined

  if (next.claudeHunks !== undefined) {
    next = { ...next, claudeHunks: fitHunks(next.claudeHunks, KEPT_DIFF_LINES).hunks }
  }

  // The tab left keeps where it was scrolled to; the one shown, how it is shown.
  const shown = await read($, view)
  const leaving = shown.path !== undefined && shown.path !== path ? shown.path : undefined
  const leftAt = paneOffset
  const addsTab = path !== undefined && keepsTab
  let dropped: string | undefined

  if (addsTab || leaving !== undefined) {
    const mode = modeOf(next)

    await update($, tabs, open => {
      const kept = leaving === undefined ? open : open.map(openTab => (openTab.path === leaving ? { ...openTab, scroll: leftAt } : openTab))

      dropped = undefined

      if (!addsTab || path === undefined) {
        return kept
      }

      // The file in view is a tab: a new one goes last, the oldest leaving past nine.
      const tab: Tab = {
        path,
        ...(next.firstLine === undefined ? {} : { first: next.firstLine }),
        ...(next.focusLine === undefined ? {} : { line: next.focusLine }),
        ...(next.claudeHunks === undefined ? {} : { claudeHunks: next.claudeHunks }),
        ...(mode === undefined ? {} : { mode }),
      }

      if (kept.some(openTab => openTab.path === path)) {
        return kept.map(openTab => (openTab.path === path ? { ...openTab, ...tab } : openTab))
      }

      dropped = kept.length >= TABS ? kept[0]?.path : undefined

      return [...kept, tab].slice(-TABS)
    })
  }

  if (dropped !== undefined) {
    const said = `Tab ${basename(dropped)} closed: ${TABS} stay open.`

    next = { ...next, message: next.message === undefined ? said : `${next.message} ${said}` }
  }

  await update($, view, () => ({ ...next, isCollapsed: false }))
  await place($, settings, title, false, wantsKeyboard)
  // A new body starts at its top, wherever the last one was scrolled to; a tab shown again where it was left.
  paneOffset = 0
  await $.ui.scroll({ in: PANE, to: 'start' }).catch(() => undefined)

  // A file tab shown again goes back near where it was scrolled to: the module cannot move the
  // body to a row (its own moves skip its hooks), so it brings the line that stood at the top
  // there, as the rows above the first line are reckoned (a wrapped line counts as one).
  const first = next.firstLine ?? 1
  const shownLines = next.lines?.length ?? 0

  const above = headerRows + (next.message === undefined ? 0 : 1) + (first > 1 ? 1 : 0)

  if (restore !== undefined && next.mode === 'file' && shownLines > 0 && restore > above) {
    const top = Math.min(first + shownLines - 1, first + restore - above)

    paneOffset = restore
    await $.ui.scroll({ in: PANE, to: { key: `line-${top}` }, block: 'start' }).catch(() => undefined)
  }
}

/** Minimizes the pane to its header line, or brings it back. */
export async function toggleCollapsed($: Engine, settings: Settings): Promise<void> {
  const current = await read($, view)
  const isCollapsed = current.isCollapsed !== true

  await update($, view, value => ({ ...value, isCollapsed }))
  await place($, settings, current.path === undefined ? 'Code' : basename(current.path), isCollapsed)
}

/** What to carry from the view in place when `path` is still the file shown. */
async function carried($: Engine, path: string): Promise<Pick<View, 'claudeHunks'>> {
  const current = await read($, view)
  const hunks =
    (current.path === path ? current.claudeHunks : undefined) ??
    (await read($, tabs)).find(openTab => openTab.path === path)?.claudeHunks ??
    (await read($, touched)).find(entry => entry.path === path)?.hunks

  return hunks === undefined ? {} : { claudeHunks: hunks }
}

/** The session's files, with nothing in view: what the pane opens on. */
export async function showList($: Engine, settings: Settings): Promise<void> {
  return show($, settings, { mode: 'empty', cwd: await $.session.cwd() }, 'Code')
}

/** A line said in the pane, over what it shows: a key that has nothing to do here says why. */
export async function say($: Engine, message: string): Promise<void> {
  await update($, view, value => ({ ...value, message }))
}

/** Opens the pane where it was left, or closes it: the band's button and `/code-viewer`. */
export async function toggle($: Engine, settings: Settings): Promise<boolean> {
  const isOpen = (await $.ui.panes()).some(pane => pane.id === PANE)

  if (isOpen) {
    await $.ui.close({ id: PANE })

    return false
  }

  const current = await read($, view)

  await update($, view, value => ({ ...value, isCollapsed: false }))
  await place($, settings, current.path === undefined ? 'Code' : basename(current.path), false, true)

  if (current.mode === 'empty' || current.mode === 'results') {
    // With no file in view the search field takes the keys: type a name, Enter.
    await $.ui.focus({ requestId: PANE, key: 'search' }).catch(() => undefined)
  }

  return true
}

/** Goes back to a tab as it was left: the file, Claude's diff or the git diff, at its page and scroll. */
export async function showTab($: Engine, settings: Settings, path: string): Promise<void> {
  const tab = (await read($, tabs)).find(openTab => openTab.path === path)

  if (tab === undefined) {
    return showFile($, settings, path)
  }

  restoreOffset = tab.scroll

  if (tab.mode === 'git') {
    return showGitDiff($, settings, path)
  }

  if (tab.mode === 'claude' && tab.claudeHunks !== undefined) {
    return showDiff($, settings, path, 'claude', tab.claudeHunks)
  }

  const cwd = await $.session.cwd()
  const page = await pageOf($, settings, path, tab.first ?? 1)
  const base = { cwd, path, ...(tab.claudeHunks === undefined ? {} : { claudeHunks: tab.claudeHunks }) }

  return show(
    $,
    settings,
    typeof page === 'string'
      ? { ...base, mode: 'empty', message: page }
      : { ...base, ...page, ...(tab.line === undefined ? {} : { focusLine: tab.line }), mode: 'file' },
    basename(path),
  )
}

/** Closes a tab, the one in view unless another is named; then the one before it shows (else the one after), or the session's files. */
export async function closeTab($: Engine, settings: Settings, target?: string): Promise<void> {
  const { path } = await read($, view)
  const closed = target ?? path
  const open = await read($, tabs)
  const index = open.findIndex(openTab => openTab.path === closed)
  const left = open.filter(openTab => openTab.path !== closed)

  await update($, tabs, () => left)

  // A tab closed behind the one in view changes nothing else.
  if (closed !== path) {
    return
  }

  const neighbour = index < 0 ? left[left.length - 1] : (open[index - 1] ?? open[index + 1])

  return neighbour === undefined ? showList($, settings) : showTab($, settings, neighbour.path)
}

const STRENGTH = { named: 0, read: 1, edited: 2 } as const

/** Counts a prompt the person sent: the files touched from here on are the latest prompt's. */
export async function startTurn($: Engine): Promise<void> {
  await update($, promptTurn, count => count + 1)
}

/** Forgets the session's files: the list's "clear". */
export async function clearList($: Engine): Promise<void> {
  await update($, touched, () => [])
}

/** Empties the search field and what it found. */
export async function clearSearch($: Engine): Promise<void> {
  await update($, searchText, () => '')
  await update($, suggestions, () => [])
}

/**
 * Remembers a file Claude read, changed or named: the latest first. A file read or changed
 * again goes back to the top; one only named again stays where it is.
 */
export async function note($: Engine, file: string, how: Touched['how'], hunks?: readonly Hunk[]): Promise<void> {
  const path = absolute(await $.session.cwd(), file)

  // Only the project's code: no notes, logs, tool results or memory files.
  if (!isCode(path)) {
    return
  }

  if (how !== 'named') {
    await noteRoot($, dirname(path))
  }

  const turn = await read($, promptTurn)

  await update($, touched, files => {
    const previous = files.find(entry => entry.path === path)
    const kept = hunks !== undefined && hunks.length > 0 ? fitHunks(hunks, TOUCHED_DIFF_LINES).hunks : previous?.hunks

    if (how === 'named' && previous !== undefined) {
      return files
    }

    return [
      {
        path,
        how: previous !== undefined && STRENGTH[previous.how] > STRENGTH[how] ? previous.how : how,
        ...(kept === undefined ? {} : { hunks: kept }),
        turn,
      },
      ...files.filter(entry => entry.path !== path),
    ]
      .slice(0, TOUCHED)
      // Only the latest keep their change: the rest open as the file alone.
      .map((entry, index) =>
        index < TOUCHED_WITH_DIFF || entry.hunks === undefined
          ? entry
          : { path: entry.path, how: entry.how, ...(entry.turn === undefined ? {} : { turn: entry.turn }) },
      )
  })
}

// What git said of a folder, and the last listing: the module's own, gone at a reload.
const rootOf = new Map<string, string | null>()
let listing: { key: string; listedAt: number; files: Map<string, string> } | undefined

/**
 * Remembers where Claude works besides the working directory: the repository a folder
 * lies in, or the folder itself outside one. Its files are searched as the project's are.
 */
export async function noteRoot($: Engine, folder: string): Promise<void> {
  const dir = folder.replace(/\/+$/, '')

  if (!isAbsolute(dir) || /(^|\/)\.claude(\/|$)/.test(insideWorktree(dir)) || rootOf.has(dir)) {
    return
  }

  let root: string | null = null

  try {
    const result = await $.process.run(['git', 'rev-parse', '--show-toplevel'], { cwd: dir })

    if (result.exitCode === 0 && result.stdout.trim() !== '') {
      root = result.stdout.trim()
    }
  } catch {
    // No git, or no such folder.
  }

  if (root === null && dir.split('/').length > 4) {
    // Outside a repository a folder counts as it is, unless it is as wide as a home.
    const stat = await $.fs.stat(dir).catch(() => undefined)

    root = stat?.kind === 'dir' ? dir : null
  }

  rootOf.set(dir, root)

  const found = root

  if (found !== null && found !== (await $.session.cwd()).replace(/\/+$/, '')) {
    await update($, roots, knownRoots => [found, ...knownRoots.filter(knownRoot => knownRoot !== found)].slice(0, ROOTS))
    listing = undefined
  }
}

/** Every file of the working directory and the roots, absolute, by the name it is searched under. */
async function indexOf($: Engine): Promise<Map<string, string>> {
  const cwd = (await $.session.cwd()).replace(/\/+$/, '')
  const knownRoots = await read($, roots)
  const key = [cwd, ...knownRoots].join('\n')
  const listedAt = await $.clock.now().catch(() => 0)

  if (listing !== undefined && listing.key === key && listedAt - listing.listedAt < INDEX_MS) {
    return listing.files
  }

  const files = new Map<string, string>()

  for (const root of [cwd, ...knownRoots]) {
    for (const file of await listFiles($, root)) {
      const path = `${root}/${file}`
      const name = shortOf(path, cwd, knownRoots)

      if (files.size < INDEX_FILES && !files.has(name)) {
        files.set(name, path)
      }
    }
  }

  listing = { key, listedAt, files }

  return files
}

/** The files that come closest to what is typed, absolute: the session's first, then the roots'. */
async function matchesOf($: Engine, wanted: string, limit: number): Promise<string[]> {
  const cwd = await $.session.cwd()
  const knownRoots = await read($, roots)
  const session = new Map((await read($, touched)).map(entry => [shortOf(entry.path, cwd, knownRoots), entry.path]))
  const index = await indexOf($)
  const names = [...new Set([...session.keys(), ...index.keys()])]
  // The best match wins wherever it lies; of matches as good, the session's first.
  const found = rank(names, wanted, limit, new Set(session.keys()))
    .map(name => session.get(name) ?? index.get(name))
    .filter((path): path is string => path !== undefined)

  return [...new Set(found)].slice(0, limit)
}

/**
 * Remembers the code files an answer names. A relative path is matched as the tail of an
 * indexed file first, then looked up under the folders the answer and recent files point to.
 */
export async function noteMentions($: Engine, text: string): Promise<void> {
  const cwd = await $.session.cwd()
  const { files, folders } = mentionsOf(text, MENTIONS)

  for (const folder of folders) {
    await noteRoot($, folder)
  }

  const index = [...(await indexOf($)).values()]
  const recent = (await read($, touched)).slice(0, 3).flatMap(entry => ancestors(entry.path, 6))
  // The base that held the last path is tried first for the next.
  let bases = [...new Set([...folders, cwd, ...(await read($, roots)), ...recent])]
  let lookups = 0

  const isFile = async (path: string): Promise<boolean> => {
    lookups += 1

    return (await $.fs.stat(path).catch(() => undefined))?.kind === 'file'
  }

  // The last named ends first in the list, so walk them backwards.
  for (const file of files.filter(isCode).reverse()) {
    if (isAbsolute(file)) {
      if (await isFile(file)) {
        await note($, file, 'named')
      }

      continue
    }

    if (file.startsWith('~')) {
      continue
    }

    const tail = `/${file.replace(/^\.\//, '')}`
    const ending = index.filter(path => path.endsWith(tail))

    // A bare `utils.py` ends many paths: only a tail that picks out a few is taken.
    if (ending.length > 0 && ending.length <= 3) {
      for (const path of ending) {
        await note($, path, 'named')
      }

      continue
    }

    for (const base of bases) {
      if (lookups >= LOOKUPS) {
        return
      }

      if (await isFile(absolute(base, file))) {
        await note($, absolute(base, file), 'named')
        await noteRoot($, base)
        bases = [base, ...bases.filter(otherBase => otherBase !== base)]

        break
      }
    }
  }
}

/** Keeps what is typed in the search field and the files closest to it, drawn under the field. */
export async function typing($: Engine, typed: string): Promise<void> {
  await update($, searchText, () => typed)

  const wanted = splitLocation(typed.trim().replace(/^diff\s+/, '')).path
  const found = wanted.length < 2 ? [] : await matchesOf($, wanted, SUGGESTED)

  // A slower answer for an earlier key must not replace a later one's.
  if ((await read($, searchText)) === typed) {
    await update($, suggestions, () => found)
  }
}

/** One page of a file, starting at line `first`; a message when it cannot be read. */
export async function pageOf(
  $: Engine,
  settings: Settings,
  path: string,
  first: number,
): Promise<Pick<View, 'lines' | 'firstLine' | 'totalLines' | 'lexState'> | string> {
  let text: string

  try {
    text = await $.fs.read(path)
  } catch {
    return 'This file cannot be read: it is missing, or larger than 4 MiB.'
  }

  if (text.includes('\u0000')) {
    return 'This is a binary file.'
  }

  const all = splitLines(text)
  const start = Math.max(1, Math.min(first, all.length))
  const language = settings.isEngineOnly ? undefined : languageOf(path)

  return {
    // Wrapped, a line is drawn whole up to a far bound; cut, as wide as the old bound.
    lines: all.slice(start - 1, start - 1 + PAGE).map(line => clean(line, settings.isWrapping ? WRAPPED_LINE : undefined)),
    firstLine: start,
    totalLines: all.length,
    lexState: language === undefined ? '' : stateAfter(language, all.slice(0, start - 1)),
  }
}

export async function showFile($: Engine, settings: Settings, file: string, line?: number, claude?: Hunk[]): Promise<void> {
  const cwd = await $.session.cwd()
  const path = absolute(cwd, file)
  const claudeChange = claude === undefined ? await carried($, path) : { claudeHunks: claude }
  const page = await pageOf($, settings, path, line === undefined ? 1 : line - 3)
  const base = { cwd, path, ...claudeChange }

  if (typeof page === 'string') {
    // What cannot be read is said, and does not become a tab.
    return show($, settings, { ...base, mode: 'empty', message: page }, basename(path), undefined, false)
  }

  const focus = line === undefined ? {} : { focusLine: Math.min(line, page.totalLines ?? line) }

  return show($, settings, { ...base, ...page, ...focus, mode: 'file' }, basename(path))
}

export async function turnPage($: Engine, settings: Settings, first: number): Promise<void> {
  const current = await read($, view)

  if (current.path === undefined) {
    return
  }

  const page = await pageOf($, settings, current.path, first)

  return show(
    $,
    settings,
    typeof page === 'string' ? { ...current, mode: 'empty', message: page } : { ...current, ...page, mode: 'file' },
    basename(current.path),
  )
}

export async function showDiff($: Engine, settings: Settings, file: string, kind: 'claude' | 'git', hunks: Hunk[]): Promise<void> {
  const cwd = await $.session.cwd()
  const path = absolute(cwd, file)
  const kept = kind === 'claude' ? { claudeHunks: hunks } : await carried($, path)
  const fitted = fitHunks(hunks, DIFF_LINES)

  fitted.hunks = await seeded($, settings, path, fitted.hunks)

  return show(
    $,
    settings,
    { mode: 'diff', cwd, path, diffKind: kind, hunks: fitted.hunks, isCut: fitted.isCut, ...kept },
    basename(path),
  )
}

async function git(
  $: Engine,
  cwd: string,
  args: readonly string[],
  allowed: readonly number[] = [0],
): Promise<{ output: string; error?: string }> {
  try {
    const result = await $.process.run(['git', ...args], { cwd })

    return allowed.includes(result.exitCode ?? -1)
      ? { output: result.stdout }
      : { output: '', error: clean(result.stderr.split('\n')[0] ?? '').slice(0, 200) || 'git failed' }
  } catch {
    return { output: '', error: 'git could not be run here.' }
  }
}

/** Every branch of the file's repository, the latest committed to first. */
async function allBranches($: Engine, folder: string): Promise<string[]> {
  const listed = await git($, await existingFolder($, folder), [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname:short)',
    'refs/heads',
    'refs/remotes',
  ])

  return listed.output.split('\n').filter(name => name !== '' && !name.endsWith('/HEAD') && name !== 'origin')
}

/** The branches offered as a base: the usual first, then the latest committed to, never the one checked out. */
async function branchesOf($: Engine, folder: string): Promise<string[]> {
  const all = await allBranches($, folder)
  const current = (await git($, folder, ['rev-parse', '--abbrev-ref', 'HEAD'])).output.trim()
  const offered = all.filter(name => name !== current)

  return [...USUAL_BASES.filter(name => offered.includes(name)), ...offered.filter(name => !USUAL_BASES.includes(name))].slice(
    0,
    BASES,
  )
}

/** How far the current branch is ahead of each base, and behind it: the first few only. */
async function countsOf($: Engine, folder: string, bases: readonly string[]): Promise<Record<string, [number, number]>> {
  const counts: Record<string, [number, number]> = {}
  const counted = await Promise.all(
    bases
      .slice(0, COUNTED_BASES)
      .map(async base => [base, await git($, folder, ['rev-list', '--left-right', '--count', `HEAD...${base}`])] as const),
  )

  for (const [base, result] of counted) {
    const [ahead, behind] = result.output.trim().split(/\s+/).map(Number)

    if (result.error === undefined && Number.isInteger(ahead) && Number.isInteger(behind)) {
      counts[base] = [ahead ?? 0, behind ?? 0]
    }
  }

  return counts
}

/**
 * Asks which branch the git diff compares with: the pane lists them (or the `offered` ones,
 * when a typed name fits several) over a field for any other, and that field takes the keys.
 */
export async function askBase(
  $: Engine,
  settings: Settings,
  file: string,
  message?: string,
  offered?: readonly string[],
): Promise<void> {
  const cwd = await $.session.cwd()
  const path = absolute(cwd, file)
  // A deleted file's folder may be gone too: git runs in the nearest one left.
  const folder = await existingFolder($, dirname(path))
  const bases = offered === undefined ? await branchesOf($, folder) : [...offered]

  await show(
    $,
    settings,
    {
      mode: 'bases',
      cwd,
      path,
      bases,
      baseCounts: await countsOf($, folder, bases),
      ...(message === undefined ? {} : { message }),
      ...(await carried($, path)),
    },
    basename(path),
    // What is typed next is a branch's name: the pane asks for the keyboard, docked too.
    true,
  )
  await $.ui.focus({ requestId: PANE, key: 'base' }).catch(() => undefined)
}

/**
 * What a typed base names: itself when git resolves it to a commit (a branch, a tag, a SHA,
 * `HEAD~1`); else the one branch it fits, the whole name first, then a part of it.
 */
export async function resolveBase(
  $: Engine,
  folder: string,
  typed: string,
): Promise<{ base: string } | { candidates: string[] } | { isUnknown: true }> {
  const wanted = typed.trim()

  // A leading dash would read as an option of git's.
  if (!wanted.startsWith('-')) {
    const resolved = await git($, folder, ['rev-parse', '--verify', '--quiet', `${wanted}^{commit}`])

    if (resolved.error === undefined && resolved.output.trim() !== '') {
      return { base: wanted }
    }
  }

  const found = branchesNamed(await allBranches($, folder), wanted)
  const meant = preferredBranch(found, wanted)

  return meant !== undefined ? { base: meant } : found.length > 0 ? { candidates: found.slice(0, BASES) } : { isUnknown: true }
}

/** Takes the base picked or typed (part of a branch's name is enough) and shows the diff against it. */
export async function chooseBase($: Engine, settings: Settings, file: string, typed: string): Promise<void> {
  const wanted = typed.trim()
  // Picked for the `changes` list, the list opens after it.
  const isForChanges = (await read($, view)).basesFor === 'changes'

  if (wanted === '') {
    return isForChanges ? askBaseForChanges($, settings, dirname(file)) : askBase($, settings, file)
  }

  const cwd = await $.session.cwd()
  const folder = await existingFolder($, dirname(absolute(cwd, file)))
  const resolved = await resolveBase($, folder, wanted)
  // Asked again, the picker stays the one it was: the diff's, or the `changes` list's.
  const askAgain = (message: string, offered?: readonly string[]) =>
    isForChanges ? askBaseForChanges($, settings, folder, message, offered) : askBase($, settings, file, message, offered)

  if ('candidates' in resolved) {
    const count = resolved.candidates.length

    return askAgain(
      `"${clean(wanted)}" is ambiguous: ${count}${count === BASES ? '+' : ''} branches match it. Pick one, or type more of its name.`,
      resolved.candidates,
    )
  }

  if ('isUnknown' in resolved) {
    return askAgain(`No branch or commit named "${clean(wanted)}".`)
  }

  await update($, diffBase, () => resolved.base)

  if (isForChanges) {
    await showChanges($, settings)

    return
  }

  return showGitDiff($, settings, file)
}

/** The nearest folder above `folder` that is on disk, itself included: a deleted file's may be gone. */
async function existingFolder($: Engine, folder: string): Promise<string> {
  let dir = folder

  for (let step = 0; step < 40 && dir !== '/'; step += 1) {
    if ((await $.fs.stat(dir).catch(() => undefined))?.kind === 'dir') {
      return dir
    }

    dir = dirname(dir)
  }

  return folder
}

/** The top of the repository a folder lies in, spelled as the folder is; or why there is none. */
async function repoOf($: Engine, folder: string): Promise<{ root: string } | { error: string }> {
  const up = await git($, folder, ['rev-parse', '--show-cdup'])

  if (up.error !== undefined) {
    return {
      error: /not a git repository/i.test(up.error)
        ? 'Not in a git repository: this file has no git diff.'
        : `git cannot be asked here: ${up.error}`,
    }
  }

  let root = folder

  for (const part of up.output.trim().split('/')) {
    root = part === '..' ? dirname(root) : root
  }

  return { root }
}

/** The commit the branch left `base` at, run in `root`: `HEAD` for the base `HEAD`. */
async function forkOf($: Engine, root: string, base: string): Promise<string | undefined> {
  if (base === 'HEAD') {
    return 'HEAD'
  }

  const fork = await git($, root, ['merge-base', base, 'HEAD'])

  return fork.error !== undefined || fork.output.trim() === '' ? undefined : fork.output.trim()
}

/** Each hunk with the tokenizer's state entering it, from the lines of the file on disk before it. */
async function seeded($: Engine, settings: Settings, path: string, hunks: Hunk[]): Promise<Hunk[]> {
  const language = settings.isEngineOnly ? undefined : languageOf(path)

  if (language === undefined || hunks.length === 0) {
    return hunks
  }

  const text = await $.fs.read(path).catch(() => undefined)

  if (text === undefined || text.includes('\u0000')) {
    return hunks
  }

  const lines = splitLines(text)
  let state = ''
  let at = 0

  return hunks.map(hunk => {
    const until = Math.min(lines.length, hunk.newStart - 1)

    for (; at < until; at += 1) {
      state = tokenizeLine(language, lines[at] ?? '', state).state
    }

    return { ...hunk, lexState: state }
  })
}

/**
 * The person's own changes of a file against the base they picked: what differs from the
 * commit their branch left it at, the uncommitted included, so nothing the base gained since.
 * A file deleted, new (untracked too) or renamed since shows as such; `first` is the 0-based
 * line of the whole diff the page starts at.
 */
export async function showGitDiff($: Engine, settings: Settings, file: string, first = 0): Promise<void> {
  const cwd = await $.session.cwd()
  const path = absolute(cwd, file)
  const isOnDisk = (await $.fs.stat(path).catch(() => undefined))?.kind === 'file'
  const kept = await carried($, path)
  const say = (message: string) => show($, settings, { mode: 'empty', cwd, path, message, ...kept }, basename(path))
  const repo = await repoOf($, isOnDisk ? dirname(path) : await existingFolder($, dirname(path)))

  if ('error' in repo) {
    return say(repo.error)
  }

  const { root } = repo
  const base = await read($, diffBase)

  if (base === '') {
    return askBase($, settings, path)
  }

  // Diffing from the fork point leaves out what the base branch gained since.
  const sinceCommit = await forkOf($, root, base)

  if (sinceCommit === undefined) {
    return askBase($, settings, path, `git has no "${clean(base)}" here to compare with: pick another.`)
  }

  const rel = relative(root, path)
  const wasThere = (await git($, root, ['cat-file', '-e', `${sinceCommit}:${rel}`])).error === undefined

  if (!wasThere && !isOnDisk) {
    return say(`There is no ${clean(rel)} here, nor where your branch left ${clean(base)}.`)
  }

  let specs = [`:(literal)${rel}`]
  let aside: string | undefined

  // On one side only: new, deleted, or one end of a rename.
  if (wasThere !== isOnDisk) {
    const renames = await git($, root, ['diff', '-M', '--name-status', '-z', '--diff-filter=R', sinceCommit])
    const pair = parseChanges(renames.output, '').find(change =>
      change.mark === 'R' && (isOnDisk ? change.path === rel : change.from === rel),
    )

    if (pair?.from !== undefined) {
      specs = [`:(literal)${pair.from}`, `:(literal)${pair.path}`]
      aside = isOnDisk ? `renamed from ${clean(pair.from)}` : `renamed to ${clean(pair.path)}`
    } else {
      aside = isOnDisk ? 'new file' : 'deleted'
    }
  }

  let diff = await git($, root, ['diff', sinceCommit, '-M', '--no-color', '--no-ext-diff', `-U${DIFF_CONTEXT}`, '--', ...specs])
  let hunks = parsePatch(diff.output)

  // A file git does not track yet, as Claude just wrote it: the whole of it is new.
  if (hunks.length === 0 && diff.error === undefined && aside === 'new file' && !/^Binary files /m.test(diff.output)) {
    if ((await git($, root, ['check-ignore', '-q', '--', rel])).error === undefined) {
      return say('git ignores this file: it has no git diff.')
    }

    aside = 'new file, untracked'
    diff = await git(
      $,
      root,
      ['diff', '--no-index', '--no-color', '--no-ext-diff', `-U${DIFF_CONTEXT}`, '--', '/dev/null', rel],
      [0, 1],
    )
    hunks = parsePatch(diff.output)
  }

  if (hunks.length === 0) {
    const what = aside === undefined ? '' : ` (${aside})`

    return say(
      diff.error !== undefined
        ? `git diff failed: ${diff.error}`
        : /^Binary files |^GIT binary patch/m.test(diff.output)
          ? `Binary file${what}: it differs from ${clean(base)}, but git shows no lines of it.`
          : aside?.startsWith('renamed') === true
            ? `The file was ${aside} against ${clean(base)}, with no line changed.`
            : aside === 'new file, untracked'
              ? 'New file, untracked: it is empty.'
              : await noChangesWhy($, root, path, base, sinceCommit),
    )
  }

  // The counts are the whole diff's; the page is what fits a drawn tree.
  const counts = countHunks(hunks)
  const start = Math.max(0, Math.min(first, counts.total - 1))
  const page = pageHunks(hunks, start, DIFF_LINES)

  return show(
    $,
    settings,
    {
      mode: 'diff',
      cwd,
      path,
      diffKind: 'git',
      diffBase: base,
      hunks: await seeded($, settings, path, page.hunks),
      isCut: page.isCut,
      diffAdded: counts.added,
      diffRemoved: counts.removed,
      diffFirst: start,
      diffTotal: counts.total,
      ...(aside === undefined ? {} : { diffNote: aside }),
      ...kept,
    },
    basename(path),
  )
}

/** Turns the page of the git diff in view: `first` is the 0-based line of the whole diff to start at. */
export async function turnDiffPage($: Engine, settings: Settings, first: number): Promise<void> {
  const current = await read($, view)

  if (current.mode !== 'diff' || current.diffKind !== 'git' || current.path === undefined) {
    return
  }

  return showGitDiff($, settings, current.path, Math.max(0, first))
}

/** True when git knew `path` where the branch left the base (or, with no base yet, in any branch's history). */
async function wasTracked($: Engine, path: string): Promise<boolean> {
  const repo = await repoOf($, await existingFolder($, dirname(path)))

  if ('error' in repo) {
    return false
  }

  const rel = relative(repo.root, path)
  const base = await read($, diffBase)
  const sinceCommit = base === '' ? undefined : await forkOf($, repo.root, base)

  if (sinceCommit !== undefined) {
    return (await git($, repo.root, ['cat-file', '-e', `${sinceCommit}:${rel}`])).error === undefined
  }

  // With no base chosen yet, any branch that ever held it will do: the base is asked for next.
  return (await git($, repo.root, ['log', '-1', '--all', '--format=%h', '--', `:(literal)${rel}`])).output.trim() !== ''
}

/** Asks which branch the `changes` list compares with: the same picker, the list opening after it. */
export async function askBaseForChanges(
  $: Engine,
  settings: Settings,
  folder: string,
  message?: string,
  offered?: readonly string[],
): Promise<void> {
  const inFolder = await existingFolder($, folder)
  const bases = offered === undefined ? await branchesOf($, inFolder) : [...offered]

  await show(
    $,
    settings,
    {
      mode: 'bases',
      cwd: await $.session.cwd(),
      basesFor: 'changes',
      bases,
      baseCounts: await countsOf($, inFolder, bases),
      ...(message === undefined ? {} : { message }),
    },
    'Changes',
    // What is typed next is a branch's name: the pane asks for the keyboard, docked too.
    true,
  )
  await $.ui.focus({ requestId: PANE, key: 'base' }).catch(() => undefined)
}

/**
 * Every file that differs between the fork point with the base and the working tree, the
 * untracked included, each with its mark and counts. Answers one line saying what it found.
 */
export async function showChanges($: Engine, settings: Settings): Promise<string> {
  const cwd = await $.session.cwd()
  const current = await read($, view)
  const folder = current.path === undefined ? cwd : await existingFolder($, dirname(current.path))
  const say = async (message: string) => {
    await show($, settings, { mode: 'changes', cwd, message }, 'Changes')

    return `Code viewer: ${message}`
  }
  const repo = await repoOf($, folder)

  if ('error' in repo) {
    return say(repo.error.replace('this file has', 'there is'))
  }

  const { root } = repo
  const base = await read($, diffBase)

  if (base === '') {
    await askBaseForChanges($, settings, root)

    return 'Code viewer: pick the branch to compare with.'
  }

  const sinceCommit = await forkOf($, root, base)

  if (sinceCommit === undefined) {
    await askBaseForChanges($, settings, root, `git has no "${clean(base)}" here to compare with: pick another.`)

    return `Code viewer: git has no "${base}" here.`
  }

  const names = await git($, root, ['diff', '-M', '--name-status', '-z', sinceCommit])

  if (names.error !== undefined) {
    return say(`git diff failed: ${names.error}`)
  }

  const numbers = await git($, root, ['diff', '-M', '--numstat', '-z', sinceCommit])
  const others = await git($, root, ['ls-files', '--others', '--exclude-standard', '-z'])
  const all: Change[] = [
    ...parseChanges(names.output, numbers.output),
    ...others.output
      .split('\u0000')
      .filter(name => name !== '')
      .map(name => ({ path: name, mark: '?' as const })),
  ].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const changes: Change[] = []

  for (const change of all.slice(0, CHANGES)) {
    let counted: Pick<Change, 'added' | 'removed'> = {}

    // git counts no lines of an untracked file: the file's own are its added ones.
    if (change.mark === '?') {
      const text = await $.fs.read(`${root}/${change.path}`).catch(() => undefined)

      counted = text === undefined || text.includes('\u0000') ? {} : { added: splitLines(text).length, removed: 0 }
    }

    changes.push({ ...change, ...counted, path: `${root}/${change.path}` })
  }

  const sum = (key: 'added' | 'removed') =>
    [...all.filter(change => change.mark !== '?'), ...changes.filter(change => change.mark === '?')].reduce(
      (total, change) => total + (change[key] ?? 0),
      0,
    )

  await show(
    $,
    settings,
    {
      mode: 'changes',
      cwd,
      diffBase: base,
      changes,
      changeCount: all.length,
      changeAdded: sum('added'),
      changeRemoved: sum('removed'),
      ...(all.length === 0 ? { message: `No changes of yours against ${clean(base)}.` } : {}),
    },
    'Changes',
  )

  return `Code viewer: ${all.length} ${all.length === 1 ? 'file' : 'files'} changed against ${base}.`
}

/** Why the diff against `base` is empty: the branch already in it, or a file git does not track. */
async function noChangesWhy($: Engine, folder: string, path: string, base: string, sinceCommit: string): Promise<string> {
  const name = clean(base)
  const isTracked = (await git($, folder, ['ls-files', '--error-unmatch', '--', path])).error === undefined
  const untracked = isTracked ? '' : ' (a file git does not track shows none).'

  if (base === 'HEAD') {
    return `No uncommitted changes in this file${untracked || '.'}`
  }

  const head = (await git($, folder, ['rev-parse', 'HEAD'])).output.trim()

  if (head !== '' && head === sinceCommit) {
    const behind = Number((await git($, folder, ['rev-list', '--count', `HEAD..${base}`])).output.trim())
    const where =
      Number.isInteger(behind) && behind > 0
        ? `your branch is already merged into ${name} (${behind} ${behind === 1 ? 'commit' : 'commits'} behind it)`
        : `${name} is at your own commit`

    return `No changes of yours against ${name}: ${where}, so there is nothing of yours to show${untracked || '.'}`
  }

  return `No changes of yours to this file against ${name}${untracked || '.'}`
}

/** Opens what the person typed: a file, its diff, or the files that match. Answers one line saying which. */
export async function find($: Engine, settings: Settings, typed: string, opensBest = false): Promise<string> {
  const cwd = await $.session.cwd()

  await update($, searchText, () => '')
  await update($, suggestions, () => [])

  const wantsDiff = /^diff(?:\s|$)/.test(typed.trim())
  const diffOf = async (file: string): Promise<string> => {
    await showGitDiff($, settings, file)

    const name = relative(cwd, absolute(cwd, file))

    return (await read($, diffBase)) === ''
      ? `Code viewer: pick the branch to diff ${name} against.`
      : `Code viewer: git diff of ${name}.`
  }
  const query = typed.trim().replace(/^diff(?:\s+|$)/, '')
  const current = await read($, view)

  if (query === '') {
    if (wantsDiff && current.path !== undefined) {
      return diffOf(current.path)
    }

    // Nothing named: the search field takes the keys, docked too, so the name typed next is the file's.
    await show($, settings, { mode: 'empty', cwd }, 'Code', true)
    await $.ui.focus({ requestId: PANE, key: 'search' }).catch(() => undefined)

    return 'Code viewer: the files of this session.'
  }

  const open = async (file: string, line?: number): Promise<string> => {
    if (wantsDiff) {
      return diffOf(file)
    }

    await showFile($, settings, file, line)

    return `Code viewer: ${relative(cwd, absolute(cwd, file))}.`
  }

  const { path, line } = splitLocation(query)
  const stat = await $.fs.stat(absolute(cwd, path)).catch(() => undefined)

  if (stat?.kind === 'file') {
    return open(path, line)
  }

  // A file deleted on the branch is on disk no more, but its diff is still there to see.
  if (wantsDiff && stat === undefined && (await wasTracked($, absolute(cwd, path)))) {
    return open(path)
  }

  // The closest files, the session's first: the same list the field draws as it is typed.
  const results = await matchesOf($, path, RESULTS)
  const first = results[0]
  const isMine = first !== undefined && (await read($, touched)).some(entry => entry.path === first)
  const scope = isMine ? 'session' : 'project'
  // A name, or a path's tail, that one file alone has exactly is that file.
  const knownRoots = await read($, roots)
  const exactly = path.toLowerCase().replace(/^\.\//, '')
  const exact = results.filter(file => {
    const name = shortOf(file, cwd, knownRoots).toLowerCase()

    return name === exactly || name.endsWith(`/${exactly}`) || file.toLowerCase().endsWith(`/${exactly}`)
  })
  // Enter in the field opens the first; a command lists what it found when the project has several.
  const only = opensBest || isMine || results.length === 1 ? first : exact.length === 1 ? exact[0] : undefined

  if (only !== undefined) {
    return open(only, line)
  }

  await show(
    $,
    settings,
    {
      mode: 'results',
      cwd,
      scope,
      query: path,
      results,
      ...(line === undefined ? {} : { resultLine: line }),
      ...(results.length === 0 ? { message: `No file matches "${clean(path)}".` } : {}),
    },
    'Find file',
  )
  // The ring starts on the first: Enter opens it, the arrows walk the others.
  if (results.length > 0) {
    await $.ui.focus({ requestId: PANE, key: 'result-0' }).catch(() => undefined)
  }

  return results.length === 0
    ? `Code viewer: no file matches "${path}".`
    : `Code viewer: ${results.length} files ${scope === 'session' ? 'of this session' : 'of the project'} match "${path}".`
}
