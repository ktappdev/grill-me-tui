# Grill-Me-Tui Extension — Review Checklist

**Repo:** https://github.com/ktappdev/grill-me-tui
**Structure:** `package.json` → `src/index.ts` (entry), `src/schema.ts`, `src/types.ts`, `src/format.ts`, `src/ui.ts`

---

## 1. Architecture & Module Boundaries

- [ ] `index.ts` does entry point + orchestration. Does it import from `schema.ts`, `types.ts`, `format.ts`, `ui.ts`?
- [ ] No circular dependencies between modules.
- [ ] `ui.ts` imports `ExtensionContext` from `@mariozechner/pi-coding-agent` — correct type?
- [ ] `schema.ts` uses `@sinclair/typebox` and `@mariozechner/pi-ai` (`StringEnum`) — are these in `package.json` deps?
- [ ] Are `format.ts` functions pure (no side effects, no I/O)?

## 2. `/grill` Command (Existing System Review)

- [ ] Topic selector shows categories + "All" option.
- [ ] "All" mode: runs all categories sequentially, doesn't crash if one fails.
- [ ] Status bar shows progress: `🔥 Category [N/M]`.
- [ ] Per-category markdown saved to `.grill-sessions/`.
- [ ] Master summary saved as `all-categories.md`.
- [ ] Max rounds respected (1-10, default 3).

## 3. `/grill-new` Command (New Project)

- [ ] Asks "What are we building?" → free text.
- [ ] `detectProject()` scans `cwd` for package.json, tsconfig, pyproject, etc. — does it handle nested dirs?
- [ ] `scaffoldProject()` creates `src/`, `tests/`, `docs/`, `scripts/` — idempotent? (should be — checks `access` first)
- [ ] PRD generated from LLM → `project-context.md` with checkboxes, phases, links to session files.
- [ ] LLM fallback (`generateSimplePRD`) works if model call fails.
- [ ] `generateQuestionsWithContext` injects project context into system prompt.
- [ ] Bead notes include reference to PRD path.

## 4. LLM Integration (`generateQuestions` / `generateQuestionsWithContext`)

- [ ] `modelRegistry.getApiKeyAndHeaders(model)` — does it handle missing keys gracefully?
- [ ] `complete()` from `@mariozechner/pi-ai` — correct import, correct args shape?
- [ ] JSON parsing: strips markdown code fences, catches parse errors with descriptive message.
- [ ] `signal` from `AbortController` passed to `complete()` — cancel works?
- [ ] System prompts prevent non-JSON responses.
- [ ] Previous rounds included in conversation context for follow-up questions.

## 5. Spinner / Loading UI

- [ ] `BorderedLoader` from `@mariozechner/pi-coding-agent` imported correctly.
- [ ] `generateQuestionsWithLoader` wraps LLM call → shows spinner.
- [ ] `generateQuestionsWithContextWithLoader` does the same for `/grill-new`.
- [ ] `loader.onAbort` → done(null) → flow handles null gracefully.
- [ ] Error case: loader shows error message then closes.

## 6. TUI Questionnaire (`runQuestionnaireUI` / `ui.ts`)

- [ ] Tabs navigate between questions (← →).
- [ ] Space selects/deselects options.
- [ ] "Other" free-text input works — inline editor appears.
- [ ] Review mode (press `r`) shows all answers before submit.
- [ ] Enter submits, Esc cancels.
- [ ] Validation: `areAllAnswersValid()` checks all questions answered.
- [ ] `ctx.ui.custom()` overlay — does it clean up on close?

## 7. Persistence

### Beads
- [ ] `hasBeadsDb()` checks via `bd list -q` — correct exit code?
- [ ] `createGrillBead()` uses correct flags: `--type task`, `-l grill-me,design-review`, `-d`, `--notes`.
- [ ] `addNoteToBead()` appends round summaries.
- [ ] All bead calls are guarded by `if (beadsAvailable)`.
- [ ] Master bead created in "All" and `/grill-new` flows.

### Markdown
- [ ] `.grill-sessions/` dir created via `ensureGrillSessionsDir()`.
- [ ] Filenames: `YYYY-MM-DDTHH-MM-SS-topic.md` — sortable, no collisions.
- [ ] `appendToMarkdown()` reads existing file, appends new round, writes back.
- [ ] `saveAllMarkdown()` creates combined report for "All" mode.
- [ ] PRD: `project-context.md` — LLM-generated checkboxes + phases + links.
- [ ] Fallback PRD: `generateSimplePRD()` — plain checklist if LLM unavailable.

## 8. Error Handling

- [ ] Missing API key → thrown, caught, notified to user.
- [ ] LLM returns invalid JSON → caught, error message shown.
- [ ] LLM question validation fails (duplicate IDs, empty prompts) → warned, flow breaks.
- [ ] `bd` commands fail (not installed, no db) → silent skip, no crash.
- [ ] File write failures (permissions, disk full) → caught, ignored.
- [ ] User cancels at any point → flow exits cleanly, partial results preserved.

## 9. Edge Cases

- [ ] Empty project dir → scaffold prompt shown.
- [ ] Single category selected → no "All" loop overhead.
- [ ] Category name with special chars → slugified for filenames.
- [ ] Very long project description → handled? (check if any truncation needed)
- [ ] Model stops mid-response (`stopReason !== 'stop'`) → handled by `complete()`?
- [ ] `ctx.signal` undefined → falls back to `new AbortController().signal`.

## 10. Code Quality

- [ ] No unused imports (check `truncateToWidth`, `readdir`, `mkdir` etc.).
- [ ] No `any` types that should be specific (check `ctx: any` — intentional for ExtensionContext?).
- [ ] Consistent error handling pattern: `try/catch` → `ctx.ui.notify()`.
- [ ] No hardcoded paths — all relative to `cwd`.
- [ ] `package.json` has correct `pi.extensions` entry point.

## 11. Install & Setup

- [ ] `pi install git:github.com/ktappdev/grill-me-tui@v1.0.0` works.
- [ ] `pi install ./path/to/grill-me-tui` works (local).
- [ ] README has install commands, usage examples, prerequisites.
- [ ] `npm install` resolves all deps.

---

## Quick Review Commands

```bash
# Clone & install deps
git clone https://github.com/ktappdev/grill-me-tui
cd grill-me-tui && npm install

# Symlink into pi for testing
ln -sfn ~/developer/grill-me-tui ~/.pi/agent/extensions/grill-me-tui
# Then in pi: /reload

# Test beads (if available)
cd /some/project && bd init
```
