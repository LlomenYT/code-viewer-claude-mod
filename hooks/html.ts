// The diff as a page for the browser: every file changed against a base branch, or every file
// Claude changed this session, written into the plugin's HTML template and opened.

import { atom, read } from 'claude-code'
import type { EngineInterface, PluginOptions } from 'claude-code'

import type { Change, Hunk, Touched } from '../types'
import { existingFolder, forkOf, git, repoOf, resolveBase } from './actions'
import { absolute, basename, countHunks, isAbsolute, isTemporary, parseChanges, parsePatch, relative, splitLines } from './files'
import type { Settings } from './themes'
import { languageOf, tokenizeLine } from './tokenize'
import type { Kind } from './tokenize'

type Engine = EngineInterface

const diffBase = atom({ plugin: 'code-viewer', key: 'base' } as const, '')
const touched = atom({ plugin: 'code-viewer', key: 'touched' } as const, [] as Touched[], { shape: 'touched-2' })

/** Where the session's snapshots (each file as it was before Claude first changed it) are kept. */
const SNAPSHOTS = '/tmp/code-viewer-snapshots'
const DEFAULT_OUTPUT = '/tmp/code-viewer'
const TEMPLATE = 'assets/diff-viewer.html'
const DATA_MARK = '__CODE_VIEWER_DATA__'
const STYLE_MARK = '/*__CODE_VIEWER_THEME__*/'
/** Files put in one page, and the lines of a file kept whole so its unchanged ones can be shown. */
const MAX_FILES = 500
const FULL_LINES = 20_000
const LONG_LINE = 5_000
const DEFAULT_CONTEXT = 3
const BATCH = 6
/** The pages written, kept in the plugin's store across sessions: what `html clean` deletes. */
const PAGES_KEY = 'htmlPages'
/** From this many pages kept, each new one says how to delete them. */
const PAGES_WARNING = 50
const CLEAN_COMMAND = '/code-viewer html clean'

export type HtmlRequest = {
  /** `git`: the changes against a base branch (the default); `session`: Claude's this session. */
  source?: 'git' | 'session'
  /** `git`: the branch, tag or commit to compare with; else the one picked in the pane. */
  base?: string
  title?: string
  /** Only the files whose path, relative to the repository, contains one of these. */
  paths?: readonly string[]
  /** The file to write, absolute or relative to the working directory. */
  output?: string
  /** Opens the page in the browser once written. */
  open?: boolean
  /** Lines of context around each change. */
  context?: number
  language?: 'en' | 'es'
  /** `git`: a folder in the repository; the working directory by default. */
  folder?: string
}

/** The options of plugin.json that shape the page. */
export type HtmlConfig = { template?: string; outputDir: string; open: boolean; language: 'en' | 'es'; context: number }

export function htmlConfigOf(options: PluginOptions): HtmlConfig {
  const text = (key: string) => (typeof options[key] === 'string' ? (options[key] as string).trim() : '')
  const context = Number(options.htmlContext)

  return {
    ...(text('htmlTemplate') === '' ? {} : { template: text('htmlTemplate') }),
    outputDir: text('htmlOutputDir') || DEFAULT_OUTPUT,
    open: options.htmlOpen !== false,
    language: text('htmlLanguage') === 'es' ? 'es' : 'en',
    context: Number.isInteger(context) && context >= 0 && context <= 50 ? context : DEFAULT_CONTEXT,
  }
}

// ---------------------------------------------------------------------------------------------
// Snapshots: the session's diff is each file now against itself before Claude's first change.

type Index = Record<string, string | null>

let queue: Promise<unknown> = Promise.resolve()

async function snapshotDir($: Engine): Promise<string> {
  const id = (await $.session.id()).replace(/[^\w-]/g, '')

  return `${SNAPSHOTS}/${id || 'session'}`
}

async function readIndex($: Engine, dir: string): Promise<Index> {
  try {
    const parsed: unknown = JSON.parse(await $.fs.read(`${dir}/index.json`))

    return parsed !== null && typeof parsed === 'object' ? (parsed as Index) : {}
  } catch {
    return {}
  }
}

/**
 * Keeps the file as it is before Claude's first change of it this session: its text, or that it
 * was not there. Later changes keep the first snapshot. Run before an Edit or a Write.
 */
export function snapshotBefore($: Engine, file: string): Promise<void> {
  const run = async () => {
    const path = absolute(await $.session.cwd(), file)

    if (isTemporary(path)) {
      return
    }

    const dir = await snapshotDir($)
    const index = await readIndex($, dir)

    if (path in index) {
      return
    }

    const stat = await $.fs.stat(path).catch(() => undefined)

    if (stat === undefined) {
      index[path] = null
    } else if (stat.kind === 'file') {
      const text = await $.fs.read(path).catch(() => undefined)

      // Too large or binary: the session's page leaves it out rather than show it wrong.
      if (text === undefined || text.includes('\u0000')) {
        return
      }

      const name = `${Object.keys(index).length}-${basename(path).replace(/[^\w.-]/g, '_')}`

      await $.fs.write(`${dir}/${name}`, text)
      index[path] = name
    } else {
      return
    }

    await $.fs.write(`${dir}/index.json`, JSON.stringify(index))
  }
  const next = queue.then(run, run)

  queue = next.catch(() => undefined)

  return next
}

// ---------------------------------------------------------------------------------------------
// The files of the page, before they are drawn.

type FileDiff = {
  /** Shown, relative to the repository or the working directory. */
  path: string
  mark: Change['mark']
  from?: string
  note?: string
  hunks: Hunk[]
  isBinary?: boolean
  /** The file as it is now, for its unchanged lines and their colors. */
  text?: string
  /** For the language. */
  absolute: string
}

const isBinaryPatch = (patch: string) => /^Binary files |^GIT binary patch/m.test(patch)

async function readText($: Engine, path: string): Promise<string | undefined> {
  const text = await $.fs.read(path).catch(() => undefined)

  return text === undefined || text.includes('\u0000') ? undefined : text
}

const matches = (path: string, filters: readonly string[] | undefined) =>
  filters === undefined || filters.length === 0 || filters.some(filter => filter !== '' && path.includes(filter.replace(/^\.\//, '')))

/** Runs `work` on each item, a few at once, in order. */
async function inBatches<T, R>(items: readonly T[], work: (item: T) => Promise<R>): Promise<R[]> {
  const done: R[] = []

  for (let at = 0; at < items.length; at += BATCH) {
    done.push(...(await Promise.all(items.slice(at, at + BATCH).map(work))))
  }

  return done
}

type Collected = { files: FileDiff[]; total: number; meta: Record<string, string> } | { error: string }

async function gitFiles($: Engine, request: HtmlRequest, context: number): Promise<Collected> {
  const cwd = await $.session.cwd()
  const folder = await existingFolder($, absolute(cwd, request.folder ?? cwd))
  const repo = await repoOf($, folder)

  if ('error' in repo) {
    return { error: repo.error.replace('this file has', 'there is') }
  }

  const { root } = repo
  let base = (await read($, diffBase)).trim()

  if (request.base !== undefined && request.base.trim() !== '') {
    const resolved = await resolveBase($, root, request.base)

    if ('candidates' in resolved) {
      return { error: `"${request.base}" fits several branches: ${resolved.candidates.slice(0, 8).join(', ')}. Name one.` }
    }

    if ('isUnknown' in resolved) {
      return { error: `No branch or commit named "${request.base}".` }
    }

    base = resolved.base
  }

  if (base === '') {
    return { error: 'No base branch: name one (for example origin/dev, or HEAD for the uncommitted changes), or pick one in the pane with b.' }
  }

  const since = await forkOf($, root, base)

  if (since === undefined) {
    return { error: `git has no "${base}" here to compare with.` }
  }

  const names = await git($, root, ['diff', '-M', '--name-status', '-z', since])

  if (names.error !== undefined) {
    return { error: `git diff failed: ${names.error}` }
  }

  const numbers = await git($, root, ['diff', '-M', '--numstat', '-z', since])
  const others = await git($, root, ['ls-files', '--others', '--exclude-standard', '-z'])
  const listed: Array<Pick<Change, 'path' | 'mark' | 'from'>> = [
    ...parseChanges(names.output, numbers.output),
    ...others.output
      .split('\u0000')
      .filter(name => name !== '')
      .map(name => ({ path: name, mark: '?' as const })),
  ]
  const all = listed
    .filter(change => matches(change.path, request.paths) || (change.from !== undefined && matches(change.from, request.paths)))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))
  const unified = `-U${context}`
  const files = await inBatches(all.slice(0, MAX_FILES), async change => {
    const isUntracked = change.mark === '?'
    const specs = change.from === undefined ? [`:(literal)${change.path}`] : [`:(literal)${change.from}`, `:(literal)${change.path}`]
    const diff = isUntracked
      ? await git($, root, ['diff', '--no-index', '--no-color', '--no-ext-diff', unified, '--', '/dev/null', change.path], [0, 1])
      : await git($, root, ['diff', since, '-M', '--no-color', '--no-ext-diff', unified, '--', ...specs])
    const path = `${root}/${change.path}`
    const text = change.mark === 'D' ? undefined : await readText($, path)
    const note =
      change.mark === 'A' ? 'new file' : change.mark === '?' ? 'new file, untracked' : change.mark === 'D' ? 'deleted' : undefined

    return {
      path: change.path,
      absolute: path,
      mark: change.mark,
      ...(change.from === undefined ? {} : { from: change.from }),
      ...(note === undefined ? {} : { note }),
      hunks: parsePatch(diff.output),
      ...(isBinaryPatch(diff.output) ? { isBinary: true } : {}),
      ...(text === undefined ? {} : { text }),
    } satisfies FileDiff
  })
  const branch = (await git($, root, ['rev-parse', '--abbrev-ref', 'HEAD'])).output.trim()
  const short = (await git($, root, ['rev-parse', '--short', since])).output.trim()

  return {
    files,
    total: all.length,
    meta: { source: 'git', base, branch, fork: short, root, repository: basename(root) },
  }
}

async function sessionFiles($: Engine, request: HtmlRequest, context: number): Promise<Collected> {
  const cwd = await $.session.cwd()
  const dir = await snapshotDir($)
  const index = await readIndex($, dir)
  const unified = `-U${context}`
  const files: FileDiff[] = []
  const shown = (path: string) => relative(cwd, path)

  for (const [path, snapshot] of Object.entries(index)) {
    if (!matches(shown(path), request.paths)) {
      continue
    }

    const isThere = (await $.fs.stat(path).catch(() => undefined))?.kind === 'file'
    const text = isThere ? await readText($, path) : undefined

    if (isThere && text === undefined) {
      files.push({ path: shown(path), absolute: path, mark: 'M', hunks: [], isBinary: true })
      continue
    }

    const before = snapshot === null ? '/dev/null' : `${dir}/${snapshot}`
    const diff = await git(
      $,
      dir,
      ['diff', '--no-index', '--no-color', '--no-ext-diff', unified, '--', before, isThere ? path : '/dev/null'],
      [0, 1],
    )
    const hunks = parsePatch(diff.output)

    // Changed and changed back: nothing to show.
    if (hunks.length === 0) {
      continue
    }

    const mark = snapshot === null ? 'A' : isThere ? 'M' : 'D'

    files.push({
      path: shown(path),
      absolute: path,
      mark,
      ...(mark === 'A' ? { note: 'new file' } : mark === 'D' ? { note: 'deleted' } : {}),
      hunks,
      ...(text === undefined ? {} : { text }),
    })
  }

  // Files a shell command changed have no snapshot: against the last commit, where git has them.
  for (const entry of await read($, touched)) {
    if (entry.how !== 'edited' || entry.path in index || !matches(shown(entry.path), request.paths)) {
      continue
    }

    const repo = await repoOf($, await existingFolder($, entry.path.slice(0, entry.path.lastIndexOf('/')) || '/'))

    if ('error' in repo) {
      continue
    }

    const rel = relative(repo.root, entry.path)
    const diff = await git($, repo.root, ['diff', 'HEAD', '--no-color', '--no-ext-diff', unified, '--', `:(literal)${rel}`])
    const hunks = parsePatch(diff.output)

    if (hunks.length > 0) {
      const text = await readText($, entry.path)

      files.push({
        path: shown(entry.path),
        absolute: entry.path,
        mark: 'M',
        note: 'changed by a shell command: against the last commit',
        hunks,
        ...(text === undefined ? {} : { text }),
      })
    }
  }

  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0))

  return { files: files.slice(0, MAX_FILES), total: files.length, meta: { source: 'session', root: cwd, repository: basename(cwd) } }
}

// ---------------------------------------------------------------------------------------------
// Drawing: each line as HTML, colored by the mod's own tokenizer.

const escapeHtml = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

function sanitize(line: string): string {
  const text = line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')

  return text.length > LONG_LINE ? `${text.slice(0, LONG_LINE)}…` : text
}

const PLAIN: ReadonlySet<Kind> = new Set(['plain', 'punctuation'])
/** The class each token kind is drawn with, kept short: a page holds every line of every file changed. */
const CLASSES: Partial<Record<Kind, string>> = {
  keyword: 'k',
  string: 's',
  number: 'n',
  comment: 'c',
  function: 'f',
  type: 't',
  constant: 'o',
  operator: 'p',
  property: 'r',
  tag: 'g',
  heading: 'h',
  link: 'l',
}

/** A line made HTML, and the tokenizer's state after it. */
function lineHtml(language: ReturnType<typeof languageOf>, line: string, state: string): [html: string, state: string] {
  const text = sanitize(line)

  if (language === undefined) {
    return [escapeHtml(text), state]
  }

  const lexed = tokenizeLine(language, text, state)
  const html = lexed.spans
    .map(([kind, part]) => (PLAIN.has(kind) || CLASSES[kind] === undefined ? escapeHtml(part) : `<i class=${CLASSES[kind]}>${escapeHtml(part)}</i>`))
    .join('')

  return [html, lexed.state]
}

/** One drawn row of a hunk: its sign, its old and new numbers (0 where none) and, unless it is a line of the file now, its HTML. */
type Row = [sign: '+' | '-' | ' ', oldLine: number, newLine: number, html?: string]

type FileData = {
  p: string
  m: Change['mark']
  f?: string
  n?: string
  a: number
  r: number
  b?: true
  /** The file now, each line as HTML: what an unchanged line and an expanded gap draw. */
  l?: string[]
  h: Array<{ o: number; s: number; r: Row[] }>
}

function fileData(file: FileDiff, settings: Settings): FileData {
  const language = settings.isEngineOnly ? undefined : languageOf(file.absolute)
  const counts = countHunks(file.hunks)
  const lines = file.text === undefined ? undefined : splitLines(file.text)
  const keepsLines = lines !== undefined && lines.length <= FULL_LINES
  // Each line of the file now, and the tokenizer's state entering it.
  const now: string[] = []
  const entering: string[] = []

  if (keepsLines) {
    let state = ''

    for (const line of lines) {
      entering.push(state)
      const [html, after] = lineHtml(language, line, state)

      now.push(html)
      state = after
    }
  }

  const hunks = file.hunks.map(hunk => {
    let oldLine = hunk.oldStart
    let newLine = hunk.newStart
    // Removed lines are colored from the state their side left: the line before them.
    let state = keepsLines ? (entering[hunk.newStart - 1] ?? '') : ''
    const rows: Row[] = []

    for (const raw of hunk.lines) {
      const sign = raw.slice(0, 1) as Row[0]
      const text = raw.slice(1)

      if (sign === '-') {
        const [html, after] = lineHtml(language, text, state)

        rows.push(['-', oldLine, 0, html])
        state = after
        oldLine += 1
        continue
      }

      if (keepsLines && now[newLine - 1] !== undefined) {
        rows.push([sign, sign === '+' ? 0 : oldLine, newLine])
        state = entering[newLine] ?? state
      } else {
        const [html, after] = lineHtml(language, text, state)

        rows.push([sign, sign === '+' ? 0 : oldLine, newLine, html])
        state = after
      }

      oldLine += sign === ' ' ? 1 : 0
      newLine += 1
    }

    return { o: hunk.oldStart, s: hunk.newStart, r: rows }
  })

  return {
    p: file.path,
    m: file.mark,
    ...(file.from === undefined ? {} : { f: file.from }),
    ...(file.note === undefined ? {} : { n: file.note }),
    a: counts.added,
    r: counts.removed,
    ...(file.isBinary === true ? { b: true as const } : {}),
    ...(keepsLines ? { l: now } : {}),
    h: hunks,
  }
}

/** A CSS color from a theme's: a theme key of Claude Code's (`diffAdded`) is none. */
function cssColor(value: string | undefined): string | undefined {
  return value !== undefined && /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i.test(value.trim()) ? value.trim() : undefined
}

function themeCss(settings: Settings): string {
  const { theme } = settings
  const rules: string[] = []

  for (const [kind, style] of Object.entries(theme.tokens)) {
    const color = cssColor(style?.color)
    const parts = [
      ...(color === undefined ? [] : [`color:${color}`]),
      ...(style?.isBold === true ? ['font-weight:600'] : []),
      ...(style?.isItalic === true ? ['font-style:italic'] : []),
      ...(style?.isUnderlined === true ? ['text-decoration:underline'] : []),
    ]

    if (parts.length > 0 && CLASSES[kind as Kind] !== undefined) {
      rules.push(`i.${CLASSES[kind as Kind]}{${parts.join(';')}}`)
    }
  }

  const vars = [
    ['--line-number', cssColor(theme.lineNumber)],
    ['--added-bg', cssColor(theme.diffAdded)],
    ['--removed-bg', cssColor(theme.diffRemoved)],
    ['--bg', cssColor(theme.background)],
    ['--match', cssColor(theme.match)],
    ['--match-text', cssColor(theme.matchText)],
  ].filter((entry): entry is [string, string] => entry[1] !== undefined)

  return `${vars.length > 0 ? `:root{${vars.map(([name, value]) => `${name}:${value}`).join(';')}}` : ''}${rules.join('')}`
}

// ---------------------------------------------------------------------------------------------

const slug = (text: string) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'diff'

async function openInBrowser($: Engine, file: string): Promise<boolean> {
  const system = await $.process.run(['uname', '-s'], { timeoutMs: 5_000 }).catch(() => undefined)
  const opener = system?.stdout.trim() === 'Darwin' ? 'open' : system?.stdout.trim() === 'Linux' ? 'xdg-open' : undefined

  if (opener === undefined) {
    return false
  }

  const opened = await $.process.run([opener, file], { timeoutMs: 15_000 }).catch(() => undefined)

  return opened?.exitCode === 0
}

/**
 * Writes the page and opens it: answers one line for the person or the model, and the path.
 */
export async function writeHtmlDiff(
  $: Engine,
  settings: Settings,
  config: HtmlConfig,
  request: HtmlRequest,
): Promise<{ text: string; path?: string; isError?: true }> {
  const cwd = await $.session.cwd()
  const context = request.context !== undefined && request.context >= 0 && request.context <= 50 ? Math.floor(request.context) : config.context
  const source = request.source ?? 'git'
  const collected = source === 'session' ? await sessionFiles($, request, context) : await gitFiles($, request, context)

  if ('error' in collected) {
    return { text: `Code viewer: ${collected.error}`, isError: true }
  }

  const { files, total, meta } = collected
  const language = request.language ?? config.language

  if (files.length === 0) {
    return {
      text:
        source === 'session'
          ? 'Code viewer: Claude has changed no file this session (or every change was undone).'
          : `Code viewer: no changes against ${meta.base ?? 'the base'}.`,
    }
  }

  const templatePath = config.template === undefined ? `${$.plugin.root}/${TEMPLATE}` : absolute(cwd, config.template)
  const template = await $.fs.read(templatePath).catch(() => undefined)

  if (template === undefined || !template.includes(DATA_MARK)) {
    return { text: `Code viewer: the HTML template ${templatePath} cannot be read, or has no ${DATA_MARK} in it.`, isError: true }
  }

  const data = files.map(file => fileData(file, settings))
  const title =
    request.title?.trim() ||
    (source === 'session'
      ? language === 'es'
        ? 'Cambios de Claude en la sesión'
        : "Claude's changes this session"
      : language === 'es'
        ? `Cambios respecto a ${meta.base}`
        : `Changes against ${meta.base}`)
  const payload = {
    title,
    language,
    generatedAt: await $.clock.now().catch(() => 0),
    ...meta,
    total,
    added: data.reduce((sum, file) => sum + file.a, 0),
    removed: data.reduce((sum, file) => sum + file.r, 0),
    files: data,
  }
  // Inside a <script>, `</script>` and `<!--` must not appear: both are written escaped, as JSON reads them.
  const json = JSON.stringify(payload).replace(/<\//g, '<\\/').replace(/<!--/g, '\\u003c!--')
  // Sliced, not replace(): the data may hold `$&` and the like, which replace() would read.
  // The theme first: the data may hold the style's marker too (a diff of this very file).
  const styled = template.split(STYLE_MARK).join(themeCss(settings))
  const at = styled.indexOf(DATA_MARK)
  const html = `${styled.slice(0, at)}${json}${styled.slice(at + DATA_MARK.length)}`
  const name =
    source === 'session' ? `session-${slug(meta.repository ?? '')}` : `changes-${slug(meta.branch ?? '')}-vs-${slug(meta.base ?? '')}`
  const output =
    request.output !== undefined && request.output.trim() !== ''
      ? absolute(cwd, request.output.trim().endsWith('.html') ? request.output.trim() : `${request.output.trim()}.html`)
      : `${isAbsolute(config.outputDir) ? config.outputDir : absolute(cwd, config.outputDir)}/${name}.html`

  try {
    await $.fs.write(output, html)
  } catch {
    return { text: `Code viewer: could not write ${output}.`, isError: true }
  }

  const pages = await notePage($, output)
  const isOpened = (request.open ?? config.open) ? await openInBrowser($, output) : false
  const count = `${files.length}${total > files.length ? ` of ${total}` : ''} ${total === 1 ? 'file' : 'files'}`
  const warning =
    pages >= PAGES_WARNING ? ` ${pages} HTML pages are kept on disk: ${CLEAN_COMMAND} deletes them.` : ''

  if (warning !== '') {
    $.ui.toast(`Code viewer: ${pages} HTML pages kept. Run ${CLEAN_COMMAND} to delete them.`)
  }

  return {
    text: `Code viewer: wrote ${output} (${count}, +${payload.added} −${payload.removed})${isOpened ? ', opened in the browser' : ''}.${warning}`,
    path: output,
  }
}

async function isFile($: Engine, path: string): Promise<boolean> {
  return (await $.fs.stat(path).catch(() => undefined))?.kind === 'file'
}

/** The pages written and still on disk, as the store keeps them. */
async function keptPages($: Engine): Promise<string[]> {
  const stored = await $.store.get(PAGES_KEY).catch(() => undefined)
  const listed = Array.isArray(stored) ? stored.filter((path): path is string => typeof path === 'string' && path.endsWith('.html')) : []
  const kept: string[] = []

  for (const path of listed) {
    if (await isFile($, path)) {
      kept.push(path)
    }
  }

  return kept
}

/** Adds a page written to the store's list; answers how many it holds. */
async function notePage($: Engine, output: string): Promise<number> {
  const pages = [...(await keptPages($)).filter(path => path !== output), output]

  await $.store.set(PAGES_KEY, pages).catch(() => undefined)

  return pages.length
}

/**
 * `/code-viewer html clean`: deletes the HTML pages the plugin wrote (only those, as its store
 * lists them) and the snapshots of other sessions. This session's snapshots stay.
 */
export async function cleanHtmlPages($: Engine): Promise<string> {
  const pages = await keptPages($)
  let deleted = 0

  for (let at = 0; at < pages.length; at += 50) {
    const chunk = pages.slice(at, at + 50)
    const removed = await $.process.run(['rm', '-f', '--', ...chunk], { timeoutMs: 20_000 }).catch(() => undefined)

    if (removed?.exitCode === 0) {
      deleted += chunk.length
    }
  }

  const left = await keptPages($)

  await $.store.set(PAGES_KEY, left).catch(() => undefined)

  // Other sessions' snapshots: each a folder of SNAPSHOTS, named by its session id.
  const own = basename(await snapshotDir($))
  const others = (await $.fs.list(SNAPSHOTS).catch(() => []))
    .filter(entry => entry.kind === 'dir' && entry.name !== own && /^[\w-]+$/.test(entry.name))
    .map(entry => `${SNAPSHOTS}/${entry.name}`)

  if (others.length > 0) {
    await $.process.run(['rm', '-rf', '--', ...others], { timeoutMs: 20_000 }).catch(() => undefined)
  }

  const snapshots = others.length > 0 ? `, and the snapshots of ${others.length} earlier ${others.length === 1 ? 'session' : 'sessions'}` : ''

  return pages.length === 0 && others.length === 0
    ? 'Code viewer: no HTML pages to delete.'
    : `Code viewer: deleted ${deleted} HTML ${deleted === 1 ? 'page' : 'pages'}${snapshots}.${left.length > 0 ? ` ${left.length} could not be deleted.` : ''}`
}
