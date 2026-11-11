// Paths, lines, patches and file search: the parts that touch nothing but text.

import type { Hunk } from '../types'

const MAX_LINE = 400

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
  const lines = text.split(/\r?\n/)

  if (lines.length > 1 && lines[lines.length - 1] === '') {
    lines.pop()
  }

  return lines
}

/** A line made safe to draw: tabs to spaces, control characters gone, held to a length. */
export function clean(line: string): string {
  const text = line.replace(/\t/g, '  ').replace(/[\u0000-\u001f\u007f-\u009f]/g, '')

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

/** The files matching `query`, best first: by name, then by path, then loosely. */
export function rank(files: readonly string[], query: string, limit: number): string[] {
  const wanted = query.toLowerCase().replace(/\s+/g, '')
  const words = query.toLowerCase().split(/[\s/]+/).filter(word => word !== '')
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
    } else if (isSubsequence(name, wanted)) {
      score = 4
    } else if (isSubsequence(lower, wanted)) {
      score = 5
    }

    if (score >= 0) {
      scored.push([score, file])
    }
  }

  // Best score first, then the shortest path, then alphabetically.
  scored.sort(([leftScore, leftFile], [rightScore, rightFile]) => {
    if (leftScore !== rightScore) {
      return leftScore - rightScore
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

/** True for a source file of the project: a code extension, and not under a `.claude` folder (tool results, memory, plans). */
export function isCode(path: string): boolean {
  const name = basename(path).toLowerCase()
  const dot = name.lastIndexOf('.')

  if (/(^|[\\/])\.claude[\\/]/.test(path)) {
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
