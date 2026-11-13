/** One hunk of a unified diff: where it starts on each side, and its lines, each led by ` `, `+` or `-`. */
export type Hunk = {
  oldStart: number
  newStart: number
  lines: string[]
  /** A page of a longer diff: the lines added and removed in the whole hunk, of which `lines` is a part. */
  added?: number
  removed?: number
  /** True when `lines` starts past the hunk's first line: the rest of it is on the page before. */
  isContinued?: boolean
  /** The tokenizer's state entering the hunk, from the file's lines before it. */
  lexState?: string
}

/** One file of the `changes` list: how it differs from the fork point with the base. */
export type Change = {
  /** Absolute. */
  path: string
  /** A added, M modified, D deleted, R renamed, ? untracked. */
  mark: 'A' | 'M' | 'D' | 'R' | '?'
  /** Lines added and removed; absent for a binary file. */
  added?: number
  removed?: number
  /** `R`: the path it had, relative to the repository. */
  from?: string
}

/** What the pane shows. One value for the session; only the page in view is kept, never a whole file. */
export type View = {
  mode: 'empty' | 'file' | 'diff' | 'results' | 'bases' | 'changes'
  /** The session's working directory, for showing paths relative to it. */
  cwd: string
  /** The file in view, absolute. */
  path?: string
  /** True while the pane is minimized to its one header line. */
  isCollapsed?: boolean
  /** A line said to the person in place of, or above, the body. */
  message?: string

  /** `file`: the page of lines in view, cleaned for drawing. */
  lines?: string[]
  /** `file`: the 1-based number of `lines[0]`. */
  firstLine?: number
  /** `file`: how many lines the file has. */
  totalLines?: number
  /** `file`: the line the person asked for, drawn marked. */
  focusLine?: number
  /** `file`: the tokenizer's state entering `lines[0]`. */
  lexState?: string

  /** `file`: what is searched for in it, while the search-in-file field is up; empty before a letter is typed. */
  needle?: string
  /** `file`: the lines that hold `needle`, 1-based, up to a number kept. */
  hits?: number[]
  /** `file`: how many lines hold it in all. */
  hitCount?: number
  /** `file`: which of `hits` is the current one, 0-based. */
  hitAt?: number

  /** `diff`: whose change it is. */
  diffKind?: 'claude' | 'git'
  /** `diff` of kind `git`: what the file is compared with, a branch or `HEAD`. */
  diffBase?: string
  /** `bases`: the branches the person picks the base of the git diff from. */
  bases?: string[]
  /** `bases`: how many commits the current branch is ahead of each base, and behind it, where counted. */
  baseCounts?: Record<string, [ahead: number, behind: number]>
  /** `bases`: what the pick opens: the `changes` list rather than the diff of `path`. */
  basesFor?: 'changes'
  /** `diff`: the hunks drawn. */
  hunks?: Hunk[]
  /** `diff`: true when the diff was longer than what is kept. */
  isCut?: boolean
  /** `diff` of kind `git`: what the file is besides changed: `new file`, `deleted`, `renamed from …`. */
  diffNote?: string
  /** `diff` of kind `git`: the lines the whole diff adds and removes, all pages counted. */
  diffAdded?: number
  diffRemoved?: number
  /** `diff` of kind `git`: the 0-based line of the whole diff the page starts at, and its lines in all. */
  diffFirst?: number
  diffTotal?: number
  /** Claude's last edit of `path` opened from a tool row, kept so the pane can go back to it. */
  claudeHunks?: Hunk[]

  /** `results`: where the matches come from: the files Claude touched this session, or the whole project. */
  scope?: 'session' | 'project'
  /** `changes`: the files that differ from the fork point, up to a number drawn. */
  changes?: Change[]
  /** `changes`: how many files differ in all, and the lines they add and remove. */
  changeCount?: number
  changeAdded?: number
  changeRemoved?: number

  /** `results`: what was searched for. */
  query?: string
  /** `results`: the matching files, absolute or relative to `cwd`. */
  results?: string[]
  /** `results`: the line asked for with them (`name:42`), which the file pressed opens at. */
  resultLine?: number
}

/** One file kept open in the pane: a tab the person switches to. */
export type Tab = {
  /** Absolute. */
  path: string
  /** The first line of the page it was last shown at. */
  first?: number
  /** The line marked in it. */
  line?: number
  /** Claude's last change of it, when a tool row or the session's list gave one. */
  claudeHunks?: Hunk[]
  /** How it was last shown, which a return to it shows again: the file, Claude's diff or the git diff. */
  mode?: 'file' | 'claude' | 'git'
  /** The rows it was scrolled down by when another was shown. */
  scroll?: number
}

/** One file Claude read, changed or named this session. */
export type Touched = {
  /** Absolute. */
  path: string
  /** What Claude did with it: the strongest of the three it has done. */
  how: 'edited' | 'read' | 'named'
  /** `edited`: Claude's last change of it, cut to a length. */
  hunks?: Hunk[]
  /** The number of the prompt it was last read or changed in (`turn`), for drawing the latest prompt's apart. */
  turn?: number
}

declare module 'claude-code' {
  interface PluginState {
    'code-viewer': {
      view: Shaped<View>
      /** The open tabs, in the order opened. */
      tabs: Shaped<Tab[]>
      /** The session's files, the latest first. */
      touched: Shaped<Touched[]>
      /** Folders the paths Claude names have hung from, absolute: tried again for the next ones. */
      roots: Shaped<string[]>
      /** What stands in the pane's search field, as typed: the session's files are narrowed to it. */
      query: string
      /** The files that match it, absolute, best first: drawn under the field as it is typed. */
      suggestions: string[]
      /** The branch the git diff compares with, as the person picked it; empty until they have. */
      base: string
      /** How many prompts the person has sent this session: the main loop's turns that began with text. */
      turn: number
    }
  }
}
