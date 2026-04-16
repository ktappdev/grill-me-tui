# grill-me-tui

Interactive design-grilling extension for [pi](https://github.com/mariozechner/pi-coding-agent).

Generates sharp design questions via LLM, renders them in a TUI questionnaire, persists answers to [bd/beads](https://github.com/steveyegge/beads) and markdown files. Supports multi-round grilling until the design is resolved.

## Features

- **LLM-generated questions** — each round adapts based on previous answers
- **Rich TUI** — tab navigation, single/multi-select, free-text "Other" option, review mode
- **Beads persistence** — creates a task bead with all Q&A as notes (requires `bd` initialized)
- **Markdown persistence** — saves session transcripts to `.grill-sessions/` in project root
- **Multi-round** — LLM decides when enough has been resolved (configurable max rounds)

## Usage

### `/grill` — Review existing systems
```
/grill                    # Interactive topic picker
/grill "API architecture" # Start grilling on specific topic
/grill "data model" 5     # Topic with 5 max rounds
```

### `/grill-new` — Start a new project
```
/grill-new
```
1. Describes the project ("A SaaS todo app with teams")
2. Detects existing project or scaffolds basic folders (`src/`, `tests/`, `docs/`, `scripts/`)
3. Pick categories (or All)
4. LLM generates questions specific to *your* project
5. All answers + project context saved to beads + markdown + `.grill-sessions/project-context.md`

## Install

### Quick install (global)

```bash
pi install ~/developer/grill-me-tui
```

### Quick install (project-local)

```bash
pi install -l ~/developer/grill-me-tui
```

### From GitHub (once pushed)

```bash
pi install git:github.com/ktappdev/grill-me-tui@v1.0.0
```

### Try without installing

```bash
pi -e ~/developer/grill-me-tui
```

### Manual symlink

```bash
# Global (all projects)
ln -s ~/developer/grill-me-tui ~/.pi/agent/extensions/grill-me-tui

# Project-local
ln -s ~/developer/grill-me-tui .pi/extensions/grill-me-tui
```

Then `/reload` in pi.

### Uninstall

```bash
pi remove ~/developer/grill-me-tui    # global
pi remove -l ~/developer/grill-me-tui  # project
```

## Prerequisites

- **pi** — the coding agent
- **bd** (optional) — for beads persistence. Run `bd init` in your project first.
- Without `bd`, answers still persist to `.grill-sessions/*.md`.

## TUI Controls

| Key | Action |
|-----|--------|
| `←` `→` | Navigate question tabs |
| `↑` `↓` | Move option cursor |
| `Space` | Select/modify option |
| `r` | Jump to review mode |
| `Enter` | Submit (in review) |
| `Esc` | Cancel |

## Structure

```
grill-me-tui/
├── package.json
├── src/
│   ├── index.ts     # Extension entry, /grill command, orchestrator
│   ├── schema.ts    # TypeBox schemas (from pi-extensions questionnaire)
│   ├── types.ts     # TypeScript types
│   ├── format.ts    # Validation, normalization, formatting
│   └── ui.ts        # TUI questionnaire component
└── README.md
```

## License

MIT
# grill-me-tui
