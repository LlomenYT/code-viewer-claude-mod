// Paths, lines, patches and file search: the parts that touch nothing but text.

import type { Change, Hunk } from '../types'

const MAX_LINE = 400
/** A line drawn wrapped is kept whole up to this length: past it, a mark says how much was left out. */
export const WRAPPED_LINE = 4000

export function isAbsolute(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)
}

export function absolute(cwd: string, path: string): string {
  return isAbsolute(path) ? path : `${cwd.replace(/\/+$/, '')}/${path.replace(/^\.\//, '')}`
}

/** `path` as the person reads it: relative to `cwd` when it lies under it. */
export function relative(cwd: string, path: string): string {
  const root = `${cwd.replace(/\/+$/, '')}/`

  return cwd !== '' && path.startsWith(root) ? path.slice(root.length) : path
}

export function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

export function dirname(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))

  return cut <= 0 ? '/' : path.slice(0, cut)
}

/** A file's lines, without the empty one a final newline leaves. */
export function splitLines(text: string): string[] {
  // An empty file has no lines, not one empty one.
  if (text === '') {
    return []
  }

  const lines = text.split(/\r?\n/)

  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop()
  }

  return lines
}

/** A line made safe to draw: tabs to spaces, control characters gone, held to a length (`limit`: with a mark of what was cut). */
export function clean(line: string, limit?: number): string {
  const text = line.replace(/\t/g, '  ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '')

  if (limit !== undefined) {
    return text.length > limit ? `${text.slice(0, limit)} … +${text.length - limit} chars` : text
  }

  return text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}…` : text
}

/** `src/a.ts:42` as a path and a line; a trailing `:col` is dropped. */
export function splitLocation(text: string): { path: string; line?: number } {
  const found = /^(.+?):(\d+)(?::\d+)?$/.exec(text)
  const line = found === null ? Number.NaN : Number(found[2])

  return found === null || !(line > 0) ? { path: text } : { path: found[1] ?? text, line }
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/

/** The hunks of a unified diff of one file, as `git diff` prints it. */
export function parsePatch(patch: string): Hunk[] {
  const hunks: Hunk[] = []
  let current: Hunk | undefined

  for (const line of patch.split(/\r?\n/)) {
    const head = HUNK.exec(line)

    if (head !== null) {
      current = { oldStart: Number(head[1]), newStart: Number(head[2]), lines: [] }
      hunks.push(current)
    } else if (line.startsWith('diff ')) {
      current = undefined
    } else if (current !== undefined && /^[ +-]/.test(line)) {
      current.lines.push(line)
    }
  }

  return hunks
}

/** The hunks a tool's result carries as `structuredPatch`, or none. */
export function hunksOf(output: unknown): Hunk[] {
  const patch = (output as { structuredPatch?: unknown } | null | undefined)?.structuredPatch

  if (!Array.isArray(patch)) {
    return []
  }

  const hunks: Hunk[] = []

  for (const hunk of patch as ReadonlyArray<Partial<Hunk> | null>) {
    if (
      hunk !== null &&
      typeof hunk.oldStart === 'number' &&
      typeof hunk.newStart === 'number' &&
      Array.isArray(hunk.lines)
    ) {
      hunks.push({
        oldStart: hunk.oldStart,
        newStart: hunk.newStart,
        lines: hunk.lines.filter(line => typeof line === 'string' && /^[ +-]/.test(line)),
      })
    }
  }

  return hunks
}

/** Hunks cut to `limit` lines in all, cleaned for drawing, and whether any were left out. */
export function fitHunks(hunks: readonly Hunk[], limit: number): { hunks: Hunk[]; isCut: boolean } {
  const kept: Hunk[] = []
  let room = limit

  for (const hunk of hunks) {
    if (room <= 0) {
      return { hunks: kept, isCut: true }
    }

    const lines = hunk.lines.slice(0, room).map(line => line.slice(0, 1) + clean(line.slice(1)))

    kept.push({ oldStart: hunk.oldStart, newStart: hunk.newStart, lines })
    room -= lines.length

    if (lines.length < hunk.lines.length) {
      return { hunks: kept, isCut: true }
    }
  }

  return { hunks: kept, isCut: false }
}

/** The lines a diff adds and removes. */
export function countHunks(hunks: readonly Hunk[]): { added: number; removed: number; total: number } {
  let added = 0
  let removed = 0
  let total = 0

  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      added += line.startsWith('+') ? 1 : 0
      removed += line.startsWith('-') ? 1 : 0
    }

    total += hunk.lines.length
  }

  return { added, removed, total }
}

/**
 * One page of a diff: its lines `first` to `first + limit - 1` (0-based, counted across the
 * hunks), cleaned for drawing. A hunk cut by the page keeps where its part starts and the
 * counts of the whole hunk.
 */
export function pageHunks(hunks: readonly Hunk[], first: number, limit: number): { hunks: Hunk[]; isCut: boolean } {
  const kept: Hunk[] = []
  const end = first + limit
  let offset = 0

  for (const hunk of hunks) {
    const from = Math.max(first, offset)
    const to = Math.min(end, offset + hunk.lines.length)

    if (from < to) {
      const skipped = hunk.lines.slice(0, from - offset)
      const added = hunk.lines.filter(line => line.startsWith('+')).length
      const removed = hunk.lines.filter(line => line.startsWith('-')).length

      kept.push({
        oldStart: hunk.oldStart + skipped.filter(line => !line.startsWith('+')).length,
        newStart: hunk.newStart + skipped.filter(line => !line.startsWith('-')).length,
        lines: hunk.lines.slice(from - offset, to - offset).map(line => line.slice(0, 1) + clean(line.slice(1))),
        added,
        removed,
        ...(skipped.length > 0 ? { isContinued: true } : {}),
      })
    }

    offset += hunk.lines.length
  }

  return { hunks: kept, isCut: offset > end }
}

const MARKS: Record<string, Change['mark']> = { A: 'A', C: 'A', D: 'D', R: 'R', M: 'M', T: 'M', U: 'M' }

/**
 * The files of `git diff --name-status -z` and `git diff --numstat -z` (both with `-M`), paths
 * relative to the repository: each with its mark, its counts and, renamed, its old path.
 */
export function parseChanges(
  nameStatus: string,
  numstat: string,
): Array<{ path: string; mark: Change['mark']; from?: string; added?: number; removed?: number }> {
  const counts = new Map<string, { added?: number; removed?: number }>()
  const numbers = numstat.split('\u0000')

  for (let index = 0; index < numbers.length; index += 1) {
    const found = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(numbers[index] ?? '')

    if (found === null) {
      continue
    }

    let path = found[3] ?? ''

    // A rename leaves the path empty and gives the old and the new one next.
    if (path === '') {
      path = numbers[index + 2] ?? ''
      index += 2
    }

    counts.set(path, found[1] === '-' ? {} : { added: Number(found[1]), removed: Number(found[2]) })
  }

  const changes: Array<{ path: string; mark: Change['mark']; from?: string; added?: number; removed?: number }> = []
  const fields = nameStatus.split('\u0000')

  for (let index = 0; index < fields.length; index += 1) {
    const status = fields[index] ?? ''

    if (status === '') {
      continue
    }

    const mark = MARKS[status.slice(0, 1)] ?? 'M'
    const hasTwo = /^[RC]/.test(status)
    const from = hasTwo ? fields[index + 1] : undefined
    const path = fields[index + (hasTwo ? 2 : 1)] ?? ''

    index += hasTwo ? 2 : 1
    changes.push({ path, mark, ...(mark === 'R' && from !== undefined ? { from } : {}), ...counts.get(path) })
  }

  return changes
}

/** The hunks as unified-diff text, for a highlighter that reads one. */
export function unified(hunks: readonly Hunk[]): string {
  return hunks
    .map(hunk => {
      const removed = hunk.lines.filter(line => !line.startsWith('+')).length
      const added = hunk.lines.filter(line => !line.startsWith('-')).length

      return [
        `@@ -${hunk.oldStart},${removed} +${hunk.newStart},${added} @@`,
        ...hunk.lines,
      ].join('\n')
    })
    .join('\n')
}

function isSubsequence(text: string, query: string): boolean {
  let matched = 0

  for (const char of text) {
    if (char === query[matched]) {
      matched += 1
    }
  }

  return matched === query.length
}

/**
 * The files matching `query`, best first: by name, then by path, then loosely; among equals the
 * `preferred` (the session's) first, then the shortest. With a folder typed, the loose rule asks
 * the folders as typed and is loose on the name alone.
 */
export function rank(files: readonly string[], query: string, limit: number, preferred?: ReadonlySet<string>): string[] {
  const wanted = query.toLowerCase().replace(/\s+/g, '')
  const words = query.toLowerCase().split(/[\s/]+/).filter(word => word !== '')
  const cut = wanted.lastIndexOf('/')
  const wantedFolder = cut < 0 ? '' : wanted.slice(0, cut + 1).replace(/^\/+/, '')
  const wantedName = wanted.slice(cut + 1)
  const scored: Array<[score: number, file: string]> = []

  for (const file of files) {
    const lower = file.toLowerCase()
    const name = basename(lower)
    let score = -1

    if (name === wanted || lower === wanted || lower.endsWith(`/${wanted}`)) {
      // The whole name, or the tail of the path as Claude wrote it.
      score = 0
    } else if (name.startsWith(wanted)) {
      score = 1
    } else if (name.includes(wanted)) {
      score = 2
    } else if (lower.includes(wanted)) {
      score = 3
    } else if (words.length > 1 && words.every(word => lower.includes(word))) {
      // Every word typed, in any order.
      score = 3.5
    } else if (cut < 0 && isSubsequence(name, wanted)) {
      score = 4
    } else if (cut < 0 && isSubsequence(lower, wanted)) {
      score = 5
    } else if (cut >= 0 && wantedName !== '' && dirname(lower).concat('/').includes(wantedFolder) && isSubsequence(name, wantedName)) {
      // `src/btn`: the folders as typed, the name loosely.
      score = 5
    }

    if (score >= 0) {
      scored.push([score, file])
    }
  }

  // Best score first, then the session's, then the shortest path, then alphabetically.
  scored.sort(([leftScore, leftFile], [rightScore, rightFile]) => {
    if (leftScore !== rightScore) {
      return leftScore - rightScore
    }

    const leftPreferred = preferred?.has(leftFile) === true
    const rightPreferred = preferred?.has(rightFile) === true

    if (leftPreferred !== rightPreferred) {
      return leftPreferred ? -1 : 1
    }

    if (leftFile.length !== rightFile.length) {
      return leftFile.length - rightFile.length
    }

    return leftFile < rightFile ? -1 : leftFile > rightFile ? 1 : 0
  })

  return scored.slice(0, limit).map(([, file]) => file)
}

const MENTION = /(?<![\w@.~/-])(?:~?\/)?(?:[\w@.~-]+\/)*[\w@.-]+\.[A-Za-z][A-Za-z0-9]{0,7}(?::\d+)?/g
const FOLDER = /(?<![\w@.~/-])\/(?:[\w@.-]+\/)+[\w@.-]*/g

/**
 * What in a text reads as a file's path (`src/a.ts`, `/repo/README.md:12`), each once, up to `limit`,
 * and the absolute folders it names (`/Users/me/repo/`), which a relative path beside them may hang from.
 */
export function mentionsOf(text: string, limit: number): { files: string[]; folders: string[] } {
  const files = new Set<string>()
  const folders = new Set<string>()

  for (const match of text.match(MENTION) ?? []) {
    const { path } = splitLocation(match)

    // A version (`2.1.3`) is no file; a URL's tail is left to the stat.
    if (!/^[\d.]+$/.test(path) && path.length <= 300) {
      files.add(path)
    }

    if (files.size >= limit) {
      break
    }
  }

  for (const match of text.match(FOLDER) ?? []) {
    const folder = match.replace(/\/+$/, '')

    if (folder.length <= 300 && folders.size < 8) {
      folders.add(folder)
      // A file's own folder counts too: `/repo/app/a.py` names `/repo/app`.
      if (files.has(folder)) {
        folders.delete(folder)
        folders.add(dirname(folder))
      }
    }
  }

  return { files: [...files], folders: [...folders] }
}

/** The folders above a path, the nearest first, up to `limit`. */
export function ancestors(path: string, limit: number): string[] {
  const folders: string[] = []
  let folder = dirname(path)

  while (folder !== '/' && folders.length < limit) {
    folders.push(folder)
    folder = dirname(folder)
  }

  return folders
}

const CODE = new Set(
  (
    'ts tsx mts cts js jsx mjs cjs py pyi yml yaml go rs java kt kts swift c h cc cpp hpp cs rb php ' +
    'sh bash zsh sql html htm css scss sass less vue svelte astro graphql gql proto tf toml lua dart scala ex exs'
  ).split(' '),
)

/** What lies inside a Claude Code worktree (`<repo>/.claude/worktrees/<name>/…`), as a path of its own. */
export function insideWorktree(path: string): string {
  return path.replace(/^.*[\\/]\.claude[\\/]worktrees[\\/][^\\/]+(?=[\\/]|$)/, '')
}

/**
 * True for a source file of the project: a code extension, and not under a `.claude` folder (tool
 * results, memory, plans). A worktree Claude Code made under `.claude/worktrees/` is a project too.
 */
export function isCode(path: string): boolean {
  const name = basename(path).toLowerCase()
  const dot = name.lastIndexOf('.')

  if (/(^|[\\/])\.claude[\\/]/.test(insideWorktree(path))) {
    return false
  }

  return name === 'dockerfile' || name === 'makefile' || (dot > 0 && CODE.has(name.slice(dot + 1)))
}

/** A path as the pane shows and searches it: under `cwd` as it is, under another root led by that root's name. */
export function shortOf(path: string, cwd: string, roots: readonly string[]): string {
  const under = relative(cwd, path)

  if (under !== path) {
    return under
  }

  for (const root of roots) {
    const inside = relative(root, path)

    if (inside !== path) {
      return `${basename(root)}/${inside}`
    }
  }

  return path
}

/**
 * The branches a typed base names, best tier only: the whole name (any case), then a name
 * or a part after a `/` that starts with it, then a name that holds it. Never loosely.
 */
export function branchesNamed(branches: readonly string[], typed: string): string[] {
  const wanted = typed.trim().toLowerCase()

  if (wanted === '') {
    return []
  }

  const tails = (name: string) => name.split('/').map((_, index, parts) => parts.slice(index).join('/'))
  const tiers = [
    (name: string) => name === wanted,
    (name: string) => tails(name).some(tail => tail.startsWith(wanted)),
    (name: string) => name.includes(wanted),
  ]

  for (const tier of tiers) {
    const found = branches.filter(name => tier(name.toLowerCase()))

    if (found.length > 0) {
      return found
    }
  }

  return []
}

/** The one branch of several that a typed base means: `origin/<typed>`, else the one whose last part it is. */
export function preferredBranch(found: readonly string[], typed: string): string | undefined {
  const wanted = typed.trim().toLowerCase()

  if (found.length === 1) {
    return found[0]
  }

  for (const isMeant of [
    (name: string) => name === `origin/${wanted}`,
    (name: string) => name.slice(name.lastIndexOf('/') + 1) === wanted,
  ]) {
    const meant = found.filter(name => isMeant(name.toLowerCase()))

    if (meant.length === 1) {
      return meant[0]
    }
  }

  return undefined
}
