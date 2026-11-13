// Themes, and how the mod's options override one. A new theme needs an entry in THEMES
// and its name in the `theme` options of .claude-plugin/plugin.json.

import type { PluginOptions } from 'claude-code'

import type { Kind } from './tokenize'

/** How one kind of token is drawn. A color is a hex (`#61afef`), a color name, or a Claude Code theme key. */
export type Style = { color?: string; isBold?: boolean; isItalic?: boolean; isUnderlined?: boolean }

export type Theme = {
  /** A style per token kind; a kind left out is drawn as plain text. */
  tokens: Partial<Record<Kind, Style>>
  lineNumber: string
  /** The background of the line the person asked for. */
  focusLine: string
  /** What a search in the file found: the background and the text of each match. */
  match: string
  matchText: string
  /** The backgrounds of a diff's added and removed lines. */
  diffAdded: string
  diffRemoved: string
  /** Painted under the pane; undefined keeps the terminal's own. */
  background?: string
}

export const THEMES: Record<string, Theme> = {
  'one-dark': {
    tokens: {
      keyword: { color: '#c678dd' },
      string: { color: '#98c379' },
      number: { color: '#d19a66' },
      constant: { color: '#d19a66' },
      comment: { color: '#7f848e', isItalic: true },
      function: { color: '#61afef' },
      type: { color: '#e5c07b' },
      operator: { color: '#56b6c2' },
      property: { color: '#e06c75' },
      tag: { color: '#e06c75' },
      heading: { color: '#e06c75', isBold: true },
      link: { color: '#61afef', isUnderlined: true },
    },
    lineNumber: '#636d83',
    focusLine: '#3e4451',
    match: '#e5c07b',
    matchText: '#1e222a',
    // Claude Code theme keys: they follow the person's own theme.
    diffAdded: 'diffAdded',
    diffRemoved: 'diffRemoved',
  },
}

export const DEFAULT_THEME = 'one-dark'

export type Settings = {
  theme: Theme
  /** True when every file is left to Claude Code's own highlighter. */
  isEngineOnly: boolean
  isWrapping: boolean
  /**
   * Whether the surface the action came from docks panes beside the chat (the
   * terminal's fullscreen layout). Set per action by the hook that starts it.
   */
  isFullscreen?: boolean
}

/** A color the person typed: trimmed, short, free of control characters; else undefined. */
function color(options: PluginOptions, key: string): string | undefined {
  const value = options[key]

  if (typeof value !== 'string') {
    return undefined
  }

  const text = value.trim()

  return text === '' || text.length > 32 || /[^\w#(),.% -]/.test(text) ? undefined : text
}

/** The option fields that override one token kind's color, and the kinds each covers. */
const OVERRIDES: ReadonlyArray<readonly [field: string, kinds: readonly Kind[]]> = [
  ['keywordColor', ['keyword']],
  ['stringColor', ['string']],
  ['commentColor', ['comment']],
  ['numberColor', ['number', 'constant']],
  ['functionColor', ['function']],
  ['typeColor', ['type']],
  ['propertyColor', ['property', 'tag']],
]

export function resolveSettings(options: PluginOptions): Settings {
  const name = typeof options.theme === 'string' ? options.theme : DEFAULT_THEME
  const base = THEMES[name] ?? THEMES[DEFAULT_THEME]

  if (base === undefined) {
    throw new Error('code-viewer: the default theme is missing')
  }

  const tokens: Partial<Record<Kind, Style>> = { ...base.tokens }

  for (const [field, kinds] of OVERRIDES) {
    const picked = color(options, field)

    if (picked !== undefined) {
      for (const kind of kinds) {
        tokens[kind] = { ...tokens[kind], color: picked }
      }
    }
  }

  const background = color(options, 'backgroundColor') ?? base.background

  return {
    theme: {
      tokens,
      lineNumber: color(options, 'lineNumberColor') ?? base.lineNumber,
      focusLine: base.focusLine,
      match: base.match,
      matchText: base.matchText,
      diffAdded: color(options, 'diffAddedColor') ?? base.diffAdded,
      diffRemoved: color(options, 'diffRemovedColor') ?? base.diffRemoved,
      ...(background === undefined ? {} : { background }),
    },
    isEngineOnly: options.highlighter === 'engine',
    isWrapping: options.wrapLines !== false,
  }
}
