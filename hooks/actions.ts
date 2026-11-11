// What the pane's buttons, the search field and the command do: each reads
// what it needs through `$`, writes the view and opens the pane.

import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Hunk, Tab, Touched, View } from '../types'
import {
  absolute,
  ancestors,
  basename,
  clean,
  dirname,
  fitHunks,
  isAbsolute,
  isCode,
  mentionsOf,
  parsePatch,
  rank,
  shortOf,
  relative,
  splitLines,
  splitLocation,
} from './files'
import type { Settings } from './themes'
import { languageOf, stateAfter } from './tokenize'

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
const DIFF_CONTEXT = 2
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
const view = atom({ plugin: 'code-viewer', key: 'view' } as const, EMPTY, { shape: 'view-1' })

const tabs = atom({ plugin: 'code-viewer', key: 'tabs' } as const, [] as Tab[], { shape: 'tabs-1' })
const touched = atom({ plugin: 'code-viewer', key: 'touched' } as const, [] as Touched[], { shape: 'touched-2' })
const roots = atom({ plugin: 'code-viewer', key: 'roots' } as const, [] as string[], { shape: 'roots-1' })
const diffBase = atom({ plugin: 'code-viewer', key: 'base' } as const, '')
const suggestions = atom({ plugin: 'code-viewer', key: 'suggestions' } as const, [] as string[])
const searchText = atom({ plugin: 'code-viewer', key: 'query' } as const, '')

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
  try {
    const result = await $.process.run(
      ['git', '-c', 'core.quotePath=false', 'ls-files', '--cached', '--others', '--exclude-standard'],
      { cwd },
    )

    if (result.exitCode === 0 && result.stdout.trim() !== '') {
      return result.stdout.split('\n').filter(line => line !== '')
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

export async function show($: Engine, settings: Settings, next: View, title: string): Promise<void> {
  const { path } = next

  if (next.claudeHunks !== undefined) {
    next = { ...next, claudeHunks: fitHunks(next.claudeHunks, KEPT_DIFF_LINES).hunks }
  }

  if (path !== undefined) {
    // The file in view is a tab: a new one goes last, the oldest leaving past nine.
    const tab: Tab = {
      path,
      ...(next.firstLine === undefined ? {} : { first: next.firstLine }),
      ...(next.focusLine === undefined ? {} : { line: next.focusLine }),
      ...(next.claudeHunks === undefined ? {} : { claudeHunks: next.claudeHunks }),
    }

    await update($, tabs, open =>
      open.some(openTab => openTab.path === path)
        ? open.map(openTab => (openTab.path === path ? { ...openTab, ...tab } : openTab))
        : [...open, tab].slice(-TABS),
    )
  }

  await update($, view, () => ({ ...next, isCollapsed: false }))
  await place($, settings, title, false)
  // A new body starts at its top, wherever the last one was scrolled to.
  await $.ui.scroll({ in: PANE, to: 'start' }).catch(() => undefined)
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

/** Goes back to a tab, at the page it was left on. */
export async function showTab($: Engine, settings: Settings, path: string): Promise<void> {
  const tab = (await read($, tabs)).find(openTab => openTab.path === path)

  if (tab === undefined) {
    return showFile($, settings, path)
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

/** Closes a tab, the one in view unless another is named; then the one before it shows, or the session's files. */
export async function closeTab($: Engine, settings: Settings, target?: string): Promise<void> {
  const { path } = await read($, view)
  const closed = target ?? path
  const left = (await read($, tabs)).filter(openTab => openTab.path !== closed)

  await update($, tabs, () => left)

  // A tab closed behind the one in view changes nothing else.
  if (closed !== path) {
    return
  }

  const previous = left[left.length - 1]

  return previous === undefined ? showList($, settings) : showTab($, settings, previous.path)
}

const STRENGTH = { named: 0, read: 1, edited: 2 } as const

/** Remembers a file Claude read, changed or named: the latest first. */
export async function note($: Engine, file: string, how: Touched['how'], hunks?: readonly Hunk[]): Promise<void> {
  const path = absolute(await $.session.cwd(), file)

  // Only the project's code: no notes, logs, tool results or memory files.
  if (!isCode(path)) {
    return
  }

  if (how !== 'named') {
    await noteRoot($, dirname(path))
  }

  await update($, touched, files => {
    const previous = files.find(entry => entry.path === path)
    const kept = hunks !== undefined && hunks.length > 0 ? fitHunks(hunks, TOUCHED_DIFF_LINES).hunks : previous?.hunks

    return [
      {
        path,
        how: previous !== undefined && STRENGTH[previous.how] > STRENGTH[how] ? previous.how : how,
        ...(kept === undefined ? {} : { hunks: kept }),
      },
      ...files.filter(entry => entry.path !== path),
    ]
      .slice(0, TOUCHED)
      // Only the latest keep their change: the rest open as the file alone.
      .map((entry, index) => (index < TOUCHED_WITH_DIFF || entry.hunks === undefined ? entry : { path: entry.path, how: entry.how }))
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

  if (!isAbsolute(dir) || /(^|\/)\.claude(\/|$)/.test(dir) || rootOf.has(dir)) {
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
  const found = [
    ...rank([...session.keys()], wanted, limit).map(name => session.get(name)),
    ...rank([...index.keys()], wanted, limit).map(name => index.get(name)),
  ].filter((path): path is string => path !== undefined)

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
    lines: all.slice(start - 1, start - 1 + PAGE).map(clean),
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
    return show($, settings, { ...base, mode: 'empty', message: page }, basename(path))
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

  return show(
    $,
    settings,
    { mode: 'diff', cwd, path, diffKind: kind, hunks: fitted.hunks, isCut: fitted.isCut, ...kept },
    basename(path),
  )
}

async function git($: Engine, cwd: string, args: readonly string[]): Promise<{ output: string; error?: string }> {
  try {
    const result = await $.process.run(['git', ...args], { cwd })

    return result.exitCode === 0
      ? { output: result.stdout }
      : { output: '', error: clean(result.stderr.split('\n')[0] ?? '').slice(0, 200) || 'git failed' }
  } catch {
    return { output: '', error: 'git could not be run here.' }
  }
}

/** The branches of the file's repository, the usual bases first, then the latest committed to. */
async function branchesOf($: Engine, folder: string): Promise<string[]> {
  const listed = await git($, folder, [
    'for-each-ref',
    '--sort=-committerdate',
    '--format=%(refname:short)',
    'refs/heads',
    'refs/remotes',
  ])
  const all = listed.output.split('\n').filter(name => name !== '' && !name.endsWith('/HEAD') && name !== 'origin')

  return [...USUAL_BASES.filter(name => all.includes(name)), ...all.filter(name => !USUAL_BASES.includes(name))].slice(
    0,
    BASES,
  )
}

/** Asks which branch the git diff compares with: the pane lists them over a field for any other. */
export async function askBase($: Engine, settings: Settings, file: string, message?: string): Promise<void> {
  const cwd = await $.session.cwd()
  const path = absolute(cwd, file)

  await show(
    $,
    settings,
    {
      mode: 'bases',
      cwd,
      path,
      bases: await branchesOf($, dirname(path)),
      ...(message === undefined ? {} : { message }),
      ...(await carried($, path)),
    },
    basename(path),
  )
  await $.ui.focus({ requestId: PANE, key: 'base' }).catch(() => undefined)
}

/** Takes the base picked or typed (part of a branch's name is enough) and shows the diff against it. */
export async function chooseBase($: Engine, settings: Settings, file: string, typed: string): Promise<void> {
  const wanted = typed.trim()

  if (wanted === '') {
    return askBase($, settings, file)
  }

  const cwd = await $.session.cwd()
  const branches = wanted === 'HEAD' ? [] : await branchesOf($, dirname(absolute(cwd, file)))
  const base = branches.includes(wanted) ? wanted : (rank(branches, wanted, 1)[0] ?? wanted)

  await update($, diffBase, () => base)

  return showGitDiff($, settings, file)
}

/**
 * The person's own changes of a file against the base they picked: what differs from the
 * commit their branch left it at, the uncommitted included, so nothing the base gained since.
 */
export async function showGitDiff($: Engine, settings: Settings, file: string): Promise<void> {
  const cwd = await $.session.cwd()
  const path = absolute(cwd, file)
  const folder = dirname(path)
  const base = await read($, diffBase)

  if (base === '') {
    return askBase($, settings, path)
  }

  // Diffing from the fork point leaves out what the base branch gained since.
  let sinceCommit = 'HEAD'

  if (base !== 'HEAD') {
    const fork = await git($, folder, ['merge-base', base, 'HEAD'])

    if (fork.error !== undefined || fork.output.trim() === '') {
      return askBase($, settings, path, `git has no "${clean(base)}" here to compare with: pick another.`)
    }

    sinceCommit = fork.output.trim()
  }

  const diff = await git($, folder, ['diff', sinceCommit, '--no-color', '--no-ext-diff', `-U${DIFF_CONTEXT}`, '--', path])
  const hunks = parsePatch(diff.output)

  if (hunks.length > 0) {
    const fitted = fitHunks(hunks, DIFF_LINES)

    return show(
      $,
      settings,
      {
        mode: 'diff',
        cwd,
        path,
        diffKind: 'git',
        diffBase: base,
        hunks: fitted.hunks,
        isCut: fitted.isCut,
        ...(await carried($, path)),
      },
      basename(path),
    )
  }

  const message =
    diff.error === undefined
      ? `No changes of yours against ${clean(base)} (a file git does not track shows none).`
      : `git diff failed: ${diff.error}`

  return show($, settings, { mode: 'empty', cwd, path, message, ...(await carried($, path)) }, basename(path))
}

/** Opens what the person typed: a file, its diff, or the files that match. Answers one line saying which. */
export async function find($: Engine, settings: Settings, typed: string, opensBest = false): Promise<string> {
  const cwd = await $.session.cwd()

  await update($, searchText, () => '')
  await update($, suggestions, () => [])

  const wantsDiff = /^diff(?:\s|$)/.test(typed.trim())
  const query = typed.trim().replace(/^diff(?:\s+|$)/, '')
  const current = await read($, view)

  if (query === '') {
    if (wantsDiff && current.path !== undefined) {
      await showGitDiff($, settings, current.path)

      return `Code viewer: git diff of ${relative(cwd, current.path)}.`
    }

    await showList($, settings)

    return 'Code viewer: the files of this session.'
  }

  const open = async (file: string, line?: number): Promise<string> => {
    if (wantsDiff) {
      await showGitDiff($, settings, file)

      return `Code viewer: git diff of ${relative(cwd, absolute(cwd, file))}.`
    }

    await showFile($, settings, file, line)

    return `Code viewer: ${relative(cwd, absolute(cwd, file))}.`
  }

  const { path, line } = splitLocation(query)
  const stat = await $.fs.stat(absolute(cwd, path)).catch(() => undefined)

  if (stat?.kind === 'file') {
    return open(path, line)
  }

  // The closest files, the session's first: the same list the field draws as it is typed.
  const results = await matchesOf($, path, RESULTS)
  const first = results[0]
  const isMine = first !== undefined && (await read($, touched)).some(entry => entry.path === first)
  const scope = isMine ? 'session' : 'project'
  // Enter in the field opens the first; a command lists what it found when the project has several.
  const only = opensBest || isMine || results.length === 1 ? first : undefined

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
      ...(results.length === 0 ? { message: `No file matches "${clean(path)}".` } : {}),
    },
    'Find file',
  )

  return results.length === 0
    ? `Code viewer: no file matches "${path}".`
    : `Code viewer: ${results.length} files ${scope === 'session' ? 'of this session' : 'of the project'} match "${path}".`
}
