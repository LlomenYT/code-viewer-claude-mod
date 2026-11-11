<div align="center">

# 👁 Code Viewer for Claude Code

**Read the code Claude is touching without leaving the conversation.**

A side pane for [Claude Code](https://claude.com/claude-code) with tabs, fuzzy file search, syntax highlighting and clean diffs.

[![Version](https://img.shields.io/badge/version-0.0.1-D97757?style=for-the-badge)](.claude-plugin/plugin.json)
[![Claude Code mod](https://img.shields.io/badge/Claude%20Code-mod-D97757?style=for-the-badge&logo=claude&logoColor=white)](https://claude.com/claude-code)
[![Built with Claude](https://img.shields.io/badge/built%20with-Claude-191919?style=for-the-badge&logo=anthropic&logoColor=white)](https://www.anthropic.com/claude)
[![License: MIT](https://img.shields.io/badge/license-MIT-2ea44f?style=for-the-badge)](LICENSE)

</div>

---

> **v0.0.1** is the first release of the mod. The Claude Code mod API is early access and can change between releases; this version was written against Claude Code 2.1.319.

## ✨ What it does

| | Feature | How it works |
| --- | --- | --- |
| 👁 | **One button to open it** | A `👁 code viewer` row sits above the prompt. Click it to open or close the pane; `/code-viewer` does the same. |
| 🗂 | **Session files** | The pane lists the code files Claude changed (`±`), read (`▸`) or named in an answer (`·`), latest first. |
| 🔎 | **Fuzzy search** | Type part of a name or path and results appear under the field as you type. `Enter` opens the first; `↓` picks another. |
| 📑 | **Tabs** | Every file you open stays as a tab (up to nine). Hover a tab to get a red `×`, or press `w`. |
| 🎨 | **Syntax highlighting** | JavaScript, TypeScript, JSX/TSX, Python, JSON, YAML and Markdown use a themeable highlighter. Other languages use Claude Code's own. |
| 🧩 | **Claude's diff** | See exactly what Claude changed in a file, block by block, with `Added N lines, removed M lines` headers. |
| 🌿 | **Git diff against a branch** | Pick a base such as `origin/dev` and see only your own changes: the file is compared with the commit your branch forked from. |
| 🧭 | **Works across repositories** | If Claude works in another repository or a sandbox folder, its files are indexed and searchable too. |

## 📦 Install

Try it from a local clone:

```bash
git clone https://github.com/LlomenYT/code-viewer-claude-mod.git
claude --plugin-dir ./code-viewer-claude-mod
```

Or install it from its marketplace, at the prompt of a Claude Code session:

```
/plugin install code-viewer --marketplace LlomenYT/code-viewer-claude-mod
```

Answer `y` to add the marketplace, then pick a scope.

## 🚀 Usage

1. Click `👁 code viewer` above the prompt, or run `/code-viewer`.
2. Pick a file from the session list, or type part of its name in `Find file`.
3. Switch between the file, Claude's diff and the git diff from the pane.

You can also open things straight from the conversation:

- Every `Read`, `Edit` and `Write` row gets a `▸ view code` button, and `± view diff` when the call changed the file.
- `/code-viewer src/app.ts:42` opens a file at a line.
- `/code-viewer diff src/app.ts` opens its git diff.

### Where the pane goes

| Layout | Placement | Input |
| --- | --- | --- |
| `/tui fullscreen`, terminal at least 110 columns wide | Docked to the right of the conversation | Mouse and keyboard |
| Default layout | Above the prompt | Keyboard |

### Keys inside the pane

| Key | Action |
| --- | --- |
| `s` | Put the cursor in `Find file` |
| `↑` `↓` | Scroll, or walk the search results |
| `1`–`9` | Switch tab |
| `w` | Close the current tab |
| `l` | Back to the session files |
| `f` / `c` / `g` | File / Claude's diff / git diff |
| `b` | Choose the branch to diff against |
| `p` / `n` | Previous / next page |
| `m` | Minimize to one line |
| `x` | Close the pane |
| `Esc` | Back to the prompt |

When the pane does not have the keyboard, `ctrl+x tab` gives it to the pane.

### Limits

- Files are shown 200 lines at a time; a diff shows its first 400 lines.
- Files over 4 MiB and binary files are not shown.
- The session list only keeps code files: no `.txt`, `.md`, `.json`, and nothing under `.claude/`.
- The git diff uses your local copy of the base branch; it does not run `git fetch`.

## ⚙️ Options

Set them in `/config`, under the plugin's name. A color is a hex value (`#c678dd`) or a color name; leave it empty to keep the theme's.

| Option | Default | What it does |
| --- | --- | --- |
| `theme` | `one-dark` | The color theme. |
| `highlighter` | `theme` | `engine` leaves every file to Claude Code's highlighter. |
| `wrapLines` | `true` | Wrap long lines instead of cutting them. |
| `keywordColor`, `stringColor`, `commentColor`, `numberColor`, `functionColor`, `typeColor`, `propertyColor` | theme | One token color each. |
| `lineNumberColor` | theme | The gutter. |
| `backgroundColor` | terminal's | Painted under the pane. |
| `diffAddedColor`, `diffRemovedColor` | your Claude Code theme's | Backgrounds of added and removed lines. |

## 🛠 Development

| File | What is in it |
| --- | --- |
| `hooks/register.tsx` | The hooks and everything drawn: tool-row buttons, the row above the prompt, the pane. |
| `hooks/actions.ts` | What each press does: open files, run git, search, track the session's files. |
| `hooks/files.ts` | Paths, patches, mentions and file ranking. Pure text helpers. |
| `hooks/tokenize.ts` | The line tokenizers, one function per language. |
| `hooks/themes.ts` | The themes and the options that override them. |
| `types/index.d.ts` | The shape of the mod's stored state. |
| `tests/code-viewer.test.tsx` | The test suite. |

Check a change with:

```bash
claude plugin validate .
claude plugin test .
```

- **A new theme:** add an entry to `THEMES` in `hooks/themes.ts` and its name to the `theme` options in `.claude-plugin/plugin.json`.
- **A new language:** add its extensions to `EXTENSIONS` and a `(line, state) => { spans, state }` function in `hooks/tokenize.ts`.

## 📄 License

[MIT](LICENSE)

---

<div align="center">

Made for <a href="https://claude.com/claude-code">Claude Code</a> · Code Viewer v0.0.1

</div>
