/** One hunk of a unified diff: where it starts on each side, and its lines, each led by ` `, `+` or `-`. */
export type Hunk = { oldStart: number; newStart: number; lines: string[] }

/** What the pane shows. One value for the session; only the page in view is kept, never a whole file. */
export type View = {
  mode: 'empty' | 'file' | 'diff' | 'results' | 'bases'
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

  /** `diff`: whose change it is. */
  diffKind?: 'claude' | 'git'
  /** `diff` of kind `git`: what the file is compared with, a branch or `HEAD`. */
  diffBase?: string
  /** `bases`: the branches the person picks the base of the git diff from. */
  bases?: string[]
  /** `diff`: the hunks drawn. */
  hunks?: Hunk[]
  /** `diff`: true when the diff was longer than what is kept. */
  isCut?: boolean
  /** Claude's last edit of `path` opened from a tool row, kept so the pane can go back to it. */
  claudeHunks?: Hunk[]

  /** `results`: where the matches come from: the files Claude touched this session, or the whole project. */
  scope?: 'session' | 'project'
  /** `results`: what was searched for. */
  query?: string
  /** `results`: the matching files, absolute or relative to `cwd`. */
  results?: string[]
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
}

/** One file Claude read, changed or named this session. */
export type Touched = {
  /** Absolute. */
  path: string
  /** What Claude did with it: the strongest of the three it has done. */
  how: 'edited' | 'read' | 'named'
  /** `edited`: Claude's last change of it, cut to a length. */
  hunks?: Hunk[]
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
    }
  }
}
