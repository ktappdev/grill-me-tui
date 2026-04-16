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

```
/grill                    # Interactive topic picker
/grill "API architecture" # Start grilling on specific topic
/grill "data model" 5     # Topic with 5 max rounds
```

## Install

### Global (all projects)

```bash
# Clone into pi extensions directory
git clone <repo-url> ~/.pi/agent/extensions/grill-me-tui

# Or symlink from your dev folder
ln -s ~/developer/grill-me-tui ~/.pi/agent/extensions/grill-me-tui

# Reload pi
/reload
```

### Project-local

```bash
mkdir -p .pi/extensions
ln -s ~/developer/grill-me-tui .pi/extensions/grill-me-tui
```

### Via settings.json

```json
{
  "extensions": ["~/developer/grill-me-tui"]
}
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
