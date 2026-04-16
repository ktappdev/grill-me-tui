/**
 * grill-me-tui — Interactive design-grilling extension for pi
 *
 * /grill [topic] — launches TUI questionnaire powered by LLM-generated questions.
 * Answers persist to bd beads (if available) and markdown files.
 * Supports multi-round grilling until design is resolved.
 *
 * Install: drop into ~/.pi/agent/extensions/grill-me-tui/ or link via settings.json
 */

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent';
import { BorderedLoader } from '@mariozechner/pi-coding-agent';
import { complete, type UserMessage } from '@mariozechner/pi-ai';
import { mkdir, writeFile, readFile, access, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  formatBeadDescription,
  formatExpandedAnswerLines,
  formatMarkdownContent,
  normalizeQuestions,
  validateQuestions,
} from './format.js';
import type { QuestionInput } from './schema.js';
import type {
  NormalizedAnswer,
  NormalizedQuestion,
  GrillMeResult,
  GrillSession,
} from './types.js';
import { runQuestionnaireUI } from './ui.js';

type GrillContext = any;

// Mutex for markdown file writes
const writeLocks = new Map<string, Promise<void>>();

// Sanitize topic for safe shell usage
function sanitizeTopic(topic: string): string {
  return topic.replace(/[^a-zA-Z0-9 _-]/g, '').trim().slice(0, 100);
}

// Parse LLM JSON with retry
async function parseLLMJson(text: string, maxRetries: number = 2): Promise<any> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const clean = text.replace(/```[\s\S]*?\n|```/g, '');
      const start = clean.indexOf('{');
      const end = clean.lastIndexOf('}');
      if (start === -1 || end === -1 || end <= start) throw new Error('No JSON object found');
      return JSON.parse(clean.slice(start, end + 1));
    } catch (err) {
      if (attempt === maxRetries) {
        throw new Error(`JSON parse failed after ${maxRetries} retries. Response: ${text.slice(0, 200)}`);
      }
      await new Promise(r => setTimeout(r, 100 * Math.pow(2, attempt)));
    }
  }
}

// ─── System prompt for question generation ──────────────────────────────

const GRILL_SYSTEM_PROMPT = `You are a ruthless design interviewer. Your job is to stress-test a design plan by asking sharp, specific questions that expose ambiguities, hidden assumptions, and unresolved dependencies.

Rules:
- Ask 1 to 5 questions per round.
- Each question must have a clear purpose: resolve ambiguity, force a tradeoff, or expose a hidden assumption.
- Provide a recommended answer (your best guess) as the "recommended" value.
- Questions should be answerable with a single choice or short text.
- For each question, provide 2-4 options plus an "Other" free-text option.
- Do NOT ask questions that have already been answered.
- Focus on: architecture decisions, data flow, error handling, performance, security, scalability, developer experience, testing strategy.

Response format: Return ONLY valid JSON with this exact shape. No markdown, no explanation, no code fences.

{
  "questions": [
    {
      "id": "unique-lowercase-id",
      "label": "Short label",
      "prompt": "The full question text",
      "options": [
        {"value": "option-value", "label": "Option Label", "description": "Optional description"}
      ],
      "allowOther": true,
      "recommended": "The value of the option you recommend, or free text recommendation"
    }
  ],
  "continue": true,
  "summary": "Brief summary of what's been resolved so far"
}

Set "continue" to false when enough has been resolved to proceed with implementation.
`;

// ─── Beads integration ──────────────────────────────────────────────────

async function runBd(args: string[], cwd: string): Promise<{ stdout: string; exitCode: number }> {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve) => {
    const proc = spawn('bd', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.on('close', (code) => resolve({ stdout: stdout.trim(), exitCode: code ?? 1 }));
    proc.on('error', () => resolve({ stdout: '', exitCode: -1 }));
  });
}

async function hasBeadsDb(cwd: string): Promise<boolean> {
  const result = await runBd(['list', '--flat', '-q'], cwd);
  return result.exitCode === 0;
}

async function createGrillBead(
  cwd: string,
  topic: string,
  description: string,
  summary: string,
): Promise<string | null> {
  const safeTopic = sanitizeTopic(topic);
  if (!safeTopic) {
    return null;
  }

  const safeSummary = summary.slice(0, 1000);
  const safeDesc = description.slice(0, 5000);
  const result = await runBd(
    [
      'create',
      '--type', 'task',
      '-l', 'grill-me,design-review',
      '-d', safeSummary,
      '--notes', safeDesc,
      `Grill session: ${safeTopic}`,
    ],
    cwd,
  );

  if (result.exitCode === 0) {
    const idMatch = result.stdout.match(/([a-z]+-\d+)/i);
    return idMatch ? idMatch[1] : null;
  }
  return null;
}

async function addNoteToBead(cwd: string, beadId: string, note: string): Promise<boolean> {
  const safeNote = note.slice(0, 5000);
  const result = await runBd(['note', beadId, safeNote], cwd);
  return result.exitCode === 0;
}

// ─── Markdown persistence ───────────────────────────────────────────────

async function ensureGrillSessionsDir(cwd: string): Promise<string> {
  const sessionsDir = join(cwd, '.grill-sessions');
  try {
    await access(sessionsDir);
  } catch {
    await mkdir(sessionsDir, { recursive: true });
  }
  return sessionsDir;
}

async function saveToMarkdown(
  cwd: string,
  topic: string,
  sessions: Array<{ questions: NormalizedQuestion[]; answers: NormalizedAnswer[]; timestamp: string }>,
  summary: string,
): Promise<string> {
  const sessionsDir = await ensureGrillSessionsDir(cwd);
  const baseSlug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
  const suffix = Math.random().toString(36).slice(2, 6);
  const slug = baseSlug || 'grill-session';
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${ts}-${slug}-${suffix}.md`;
  const filepath = join(sessionsDir, filename);

  if (writeLocks.has(filepath)) await writeLocks.get(filepath);
  let resolveLock: () => void;
  const lock = new Promise<void>(resolve => { resolveLock = resolve; });
  writeLocks.set(filepath, lock);
  try {
    const content = formatMarkdownContent(topic, sessions, summary);
    await writeFile(filepath, content, 'utf8');
    return filepath;
  } finally {
    writeLocks.delete(filepath);
    resolveLock();
  }
}

async function appendToMarkdown(
  cwd: string,
  filepath: string,
  round: number,
  session: { questions: NormalizedQuestion[]; answers: NormalizedAnswer[]; timestamp: string },
  summary: string,
) {
  // Wait for existing write lock on this file
  if (writeLocks.has(filepath)) {
    await writeLocks.get(filepath);
  }

  let resolveLock: () => void;
  const lock = new Promise<void>(resolve => { resolveLock = resolve; });
  writeLocks.set(filepath, lock);

  try {
    let existing = '';
    try {
      existing = await readFile(filepath, 'utf8');
    } catch {
      // File does not exist yet
    }

    let append = `\n## Round ${round + 1}\n\n`;
    append += `*${session.timestamp}*\n\n`;
    session.questions.forEach((q, i) => {
      const answer = session.answers[i];
      const answerText = answer ? formatAnswerValueForMarkdown(answer) : '(no answer)';
      append += `**Q: ${q.prompt}**\n\n`;
      append += `A: ${answerText}\n\n`;
    });
    append += `\n---\n\n**Summary:** ${summary}\n\n`;

    await writeFile(filepath, existing + append, 'utf8');
  } catch (err) {
    console.warn('Failed to append to markdown:', err);
  } finally {
    writeLocks.delete(filepath);
    resolveLock();
  }
}

async function saveAllMarkdown(
  cwd: string,
  results: Array<{ topic: string; result: GrillMeResult }>,
): Promise<string> {
  const sessionsDir = await ensureGrillSessionsDir(cwd);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const suffix = Math.random().toString(36).slice(2, 6);
  const filepath = join(sessionsDir, `${ts}-all-categories-${suffix}.md`);

  // Acquire lock
  if (writeLocks.has(filepath)) await writeLocks.get(filepath);
  let resolveLock: () => void;
  const lock = new Promise<void>(resolve => { resolveLock = resolve; });
  writeLocks.set(filepath, lock);

  let md = `# Full Grill Session — All Categories\n\n`;
  md += `**Date:** ${new Date().toISOString()}\n`;
  md += `**Categories:** ${results.length}\n\n---\n\n`;

  for (const { topic, result } of results) {
    md += `# ${topic}\n\n`;
    md += `**Status:** ${result.completed ? 'Complete' : 'Incomplete'}\n`;
    md += `**Rounds:** ${result.sessions.length}\n\n`;
    if (result.summary) {
      md += `**Summary:** ${result.summary}\n\n`;
    }
    md += `---\n\n`;

    result.sessions.forEach((session) => {
      md += `## Round ${session.round}\n\n`;
      md += `*${session.timestamp}*\n\n`;
      session.questions.forEach((q, i) => {
        const a = session.answers[i];
        const answerText = a ? formatAnswerValueForMarkdown(a) : '(no answer)';
        md += `**Q: ${q.prompt}**\n\nA: ${answerText}\n\n`;
      });
    });
    md += `\n---\n\n`;
  }

  try {
    await writeFile(filepath, md, 'utf8');
    return filepath;
  } finally {
    writeLocks.delete(filepath);
    resolveLock();
  }
}

function formatAnswerValueForMarkdown(answer: NormalizedAnswer): string {
  const listed = answer.selectedOptions.map((o) => o.label).join(', ');
  const other = answer.otherText ? `Other: "${answer.otherText}"` : '';
  if (listed && other) return `${listed} + ${other}`;
  if (listed) return listed;
  if (other) return other;
  return '—';
}

// Check if an answer is ambiguous/vague (should not be marked as resolved)
function isAnswerAmbiguous(answer: NormalizedAnswer): boolean {
  const text = answer.selectedOptions.map(o => o.label.toLowerCase()).join(' ') + ' ' + (answer.otherText || '').toLowerCase();
  const vaguePatterns = ['none', 'ignore', 'undecided', 'deferred', 'unsure', 'not sure', 'maybe', 'idk', 'dont know', "don't know", 'n/a', 'na', 'unknown', 'tbd', 'skip', 'pending'];
  return vaguePatterns.some(p => text.includes(p));
}

// ─── LLM PRD generation ─────────────────────────────────────────────────

const PRD_PROMPT = `You are a technical writer. Given a project description and grill session Q&A answers, generate a structured PRD checklist in markdown.

Rules:
- Group related decisions into logical phases (Phase 1, Phase 2, etc.)
- Each phase has 3-6 checkable items
- Mark items as [x] if the answer is RESOLVED (clear, actionable decision)
- Mark items as [ ] if the answer is UNRESOLVED (vague, ambiguous, conflicting, or unclear)
- Answers marked "AMBIGUOUS" must be [ ]. Examples: "none", "ignore", typos, contradictions.
- Include relative links to detailed session files using the EXACT filenames provided in the "File references" section
- Format links as: [filename](./filename.md)
- Add an "Open Questions" section for anything that wasn't decided or is ambiguous
- Keep it concise — this is a working checklist, not an essay
- Use the project description as the overview

Output ONLY the markdown. No code fences, no preamble.
`;

async function generatePRD(
  modelRegistry: any,
  model: any,
  projectDesc: string,
  projectType: string,
  allResults: Array<{ topic: string; result: GrillMeResult }>,
  fileMap: Record<string, string>,
  signal: AbortSignal,
): Promise<string> {
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    return generateSimplePRD(projectDesc, projectType, allResults, fileMap);
  }

  let context = `Project: ${projectDesc}\nType: ${projectType}\n\n`;
  context += `File references (use these exact filenames for links):\n`;
  for (const [topic, filename] of Object.entries(fileMap)) {
    context += `  ${topic} → ${filename}\n`;
  }
  context += '\n';

  allResults.forEach((r) => {
    context += `### ${r.topic}\n`;
    if (r.result.summary) context += `Summary: ${r.result.summary}\n`;
    r.result.sessions.forEach((s) => {
      s.questions.forEach((q, i) => {
        const a = s.answers[i];
        const answer = a ? formatAnswerValueForMarkdown(a) : '(unresolved)';
        const status = a && !isAnswerAmbiguous(a) ? 'RESOLVED' : 'AMBIGUOUS';
        context += `- [${status}] Q: ${q.prompt}\n  A: ${answer}\n`;
      });
    });
    context += '\n';
  });

  const userMessage: UserMessage = {
    role: 'user',
    content: [{ type: 'text', text: context }],
    timestamp: Date.now(),
  };

  try {
    const response = await complete(
      model,
      { systemPrompt: PRD_PROMPT, messages: [userMessage] },
      { apiKey: auth.apiKey, headers: auth.headers, signal },
    );

    if (response.stopReason === 'aborted') {
      return generateSimplePRD(projectDesc, projectType, allResults, fileMap);
    }

    const text = response.content
      .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
      .map((c) => c.text)
      .join('\n');

    return text.replace(/```(?:markdown)?\n?/g, '').trim();
  } catch {
    return generateSimplePRD(projectDesc, projectType, allResults, fileMap);
  }
}

function generateSimplePRD(
  projectDesc: string,
  projectType: string,
  allResults: Array<{ topic: string; result: GrillMeResult }>,
  fileMap: Record<string, string>,
): string {
  let md = `# Project: ${projectDesc}\n\n`;
  md += `**Type:** ${projectType}\n`;
  md += `**Date:** ${new Date().toISOString().slice(0, 10)}\n`;
  md += `**Categories grilled:** ${allResults.map(r => r.topic).join(', ')}\n\n`;
  md += `---\n\n`;

  allResults.forEach((r) => {
    const link = fileMap[r.topic] ? ` ([${fileMap[r.topic]}](./${fileMap[r.topic]}))` : '';
    md += `## ${r.topic}${link}\n\n`;
    r.result.sessions.forEach((s) => {
      s.questions.forEach((q, i) => {
        const a = s.answers[i];
        const answer = a ? formatAnswerValueForMarkdown(a) : '(unresolved)';
        const status = a && !isAnswerAmbiguous(a);
        md += `- [${status ? 'x' : ' '}] ${q.prompt}\n  - Answer: ${answer}\n`;
      });
    });
    md += `\n`;
  });

  return md;
}

async function generateQuestionsWithLoader(
  uiCtx: any,
  modelRegistry: any,
  model: any,
  topic: string,
  previousSessions: GrillSession[],
  signal?: AbortSignal,
): Promise<{ questions: QuestionInput[]; continue: boolean; summary: string } | null> {
  return uiCtx.ui.custom((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, `Generating questions${topic ? ` — ${topic}` : ''}...`);
    loader.onAbort = () => done(null);
    const effectiveSignal = signal ?? loader.signal;
    generateQuestions(modelRegistry, model, topic, previousSessions, effectiveSignal)
      .then((result) => done(result))
      .catch((err) => {
        loader.message = `Error: ${err.message}`;
        setTimeout(() => done(null), 500);
      });
    return loader;
  });
}

async function generateQuestions(
  modelRegistry: any,
  model: any,
  topic: string,
  previousSessions: GrillSession[],
  signal: AbortSignal,
): Promise<{ questions: QuestionInput[]; continue: boolean; summary: string } | null> {
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);
  }

  let conversationHistory = `Design topic: ${topic}\n\n`;

  if (previousSessions.length > 0) {
    conversationHistory += 'Previous rounds:\n\n';
    previousSessions.forEach((session, round) => {
      conversationHistory += `### Round ${round + 1}\n`;
      session.questions.forEach((q, i) => {
        const a = session.answers[i];
        const answerText = a ? formatAnswerValueForMarkdown(a) : '(skipped)';
        conversationHistory += `- ${q.prompt} → ${answerText}\n`;
      });
      conversationHistory += '\n';
    });
    const lastSession = previousSessions[previousSessions.length - 1];
    conversationHistory += `\nCurrent summary: ${lastSession ? 'rounds completed: ' + lastSession.round : 'none yet'}\n\n`;
  }

  conversationHistory += `Generate the next round of design questions.`;

  const userMessage: UserMessage = {
    role: 'user',
    content: [{ type: 'text', text: conversationHistory }],
    timestamp: Date.now(),
  };

  const response = await complete(
    model,
    { systemPrompt: GRILL_SYSTEM_PROMPT, messages: [userMessage] },
    { apiKey: auth.apiKey, headers: auth.headers, signal },
  );

  if (response.stopReason === 'aborted') {
    return null;
  }

  const text = response.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

  try {
    const parsed = await parseLLMJson(text);
    return {
      questions: parsed.questions as QuestionInput[],
      continue: parsed.continue !== false,
      summary: parsed.summary || '',
    };
  } catch (err: any) {
    throw new Error(`LLM returned invalid response. Check API key and retry. Details: ${err.message.slice(0, 100)}`);
  }
}

// ─── Grill flow orchestrator ────────────────────────────────────────────

interface GrillOrchestratorOptions {
  ctx: GrillContext;
  topic: string;
  maxRounds: number;
  signal?: AbortSignal;
}

async function runGrillFlow({ ctx, topic, maxRounds, signal }: GrillOrchestratorOptions): Promise<GrillMeResult> {
  const sessions: GrillSession[] = [];
  let markdownPath: string | null = null;
  let beadId: string | null = null;
  let summary = '';

  for (let round = 0; round < maxRounds; round++) {
    const generated = await generateQuestionsWithLoader(
      ctx,
      ctx.modelRegistry,
      ctx.model,
      topic,
      sessions,
      signal,
    );

    if (!generated || !generated.questions.length) {
      break;
    }

    const validation = validateQuestions(generated.questions);
    if (validation.valid === false) {
      ctx.ui.notify(`Question validation failed: ${validation.error}`, 'warning');
      break;
    }

    const questions = normalizeQuestions(generated.questions);
    const uiResult = await runQuestionnaireUI(ctx, questions);

    if (uiResult.cancelled) {
      return { sessions, summary, completed: false, cancelled: true };
    }

    const session: GrillSession = {
      round: round + 1,
      questions,
      answers: uiResult.answers,
      timestamp: new Date().toISOString(),
    };
    sessions.push(session);

    if (round === 0) {
      const beadsAvailable = await hasBeadsDb(ctx.cwd);
      if (beadsAvailable) {
        const safeTopic = sanitizeTopic(topic);
        const desc = formatBeadDescription(safeTopic, sessions.map(s => ({
          questions: s.questions,
          answers: s.answers,
        })));
        beadId = await createGrillBead(ctx.cwd, safeTopic, desc, generated.summary || '');
        if (beadId) {
          ctx.ui.notify(`Bead created: ${beadId}`, 'success');
        }
      }

      const fullSummary = generated.summary || sessions.map(s =>
        s.answers.map(a => `${a.questionLabel}: ${formatAnswerValueForMarkdown(a)}`).join('; ')
      ).join(' | ');

      const tsSessions = sessions.map(s => ({
        questions: s.questions,
        answers: s.answers,
        timestamp: s.timestamp,
      }));

      markdownPath = await saveToMarkdown(ctx.cwd, sanitizeTopic(topic), tsSessions, fullSummary);
      ctx.ui.notify(`Saved: ${markdownPath}`, 'success');
    } else {
      // Append to existing markdown
      if (markdownPath) {
        await appendToMarkdown(ctx.cwd, markdownPath, round, {
          questions: session.questions,
          answers: session.answers,
          timestamp: session.timestamp,
        }, generated.summary || '');
      }

      // Append to bead
      if (beadId) {
        const roundNote = `Round ${round + 1}: ${session.answers.map(a =>
          `${a.questionLabel}: ${formatAnswerValueForMarkdown(a)}`
        ).join(' | ')}`;
        await addNoteToBead(ctx.cwd, beadId, roundNote);
      }
    }

    summary = generated.summary;

    // Show round results
    const answerSummary = formatExpandedAnswerLines({
      questions,
      answers: uiResult.answers,
      cancelled: false,
    }).join('\n');
    ctx.ui.notify(`Round ${round + 1} complete:\n${answerSummary}`, 'info');

    // Stop if LLM says done
    if (!generated.continue) {
      break;
    }
  }

  if (beadId && summary) {
    await addNoteToBead(ctx.cwd, beadId, `FINAL SUMMARY: ${summary.slice(0, 1000)}`);
  }
  if (markdownPath && summary) {
    try {
      await appendToMarkdown(ctx.cwd, markdownPath, -1, {
        questions: [],
        answers: [],
        timestamp: new Date().toISOString(),
      }, `FINAL SUMMARY: ${summary.slice(0, 1000)}`);
    } catch (err: any) {
      ctx.ui.notify(`Failed to save final summary: ${err.message.slice(0, 100)}`, 'warning');
    }
  }

  return { sessions, summary, completed: true, cancelled: false };
}

// ─── Project context question generation ────────────────────────────────

const GRILL_NEW_SYSTEM_PROMPT = `You are a ruthless design interviewer. Your job is to stress-test a new project plan by asking sharp, specific questions that expose ambiguities, hidden assumptions, and unresolved dependencies.

Project context:
{projectContext}

Rules:
- Ask 1 to 5 questions per round.
- Each question must be specific to THIS project, not generic.
- Reference the actual project description, tech stack, target users, and any existing structure.
- Each question must have a clear purpose: resolve ambiguity, force a tradeoff, or expose a hidden assumption.
- Questions should be answerable with a single choice or short text.
- For each question, provide 2-4 options plus an "Other" free-text option.
- Do NOT ask questions that have already been answered.
- Focus on: architecture decisions, data flow, error handling, performance, security, scalability, developer experience, testing strategy.

Response format: Return ONLY valid JSON with this exact shape. No markdown, no explanation, no code fences.

{
  "questions": [
    {
      "id": "unique-lowercase-id",
      "label": "Short label",
      "prompt": "The full question text",
      "options": [
        {"value": "option-value", "label": "Option Label", "description": "Optional description"}
      ],
      "allowOther": true,
      "recommended": "The value of the option you recommend, or free text recommendation"
    }
  ],
  "continue": true,
  "summary": "Brief summary of what's been resolved so far"
}

Set "continue" to false when enough has been resolved to proceed with implementation.
`;

async function generateQuestionsWithContextWithLoader(
  uiCtx: any,
  modelRegistry: any,
  model: any,
  projectContext: string,
  category: string,
  previousSessions: GrillSession[],
  signal?: AbortSignal,
): Promise<{ questions: QuestionInput[]; continue: boolean; summary: string } | null> {
  return uiCtx.ui.custom((tui, theme, _kb, done) => {
    const loader = new BorderedLoader(tui, theme, `Generating ${category} questions...`);
    loader.onAbort = () => done(null);
    const effectiveSignal = signal ?? loader.signal;
    generateQuestionsWithContext(modelRegistry, model, projectContext, category, previousSessions, effectiveSignal)
      .then((result) => done(result))
      .catch((err) => {
        loader.message = `Error: ${err.message}`;
        setTimeout(() => done(null), 500);
      });
    return loader;
  });
}

async function generateQuestionsWithContext(
  modelRegistry: any,
  model: any,
  projectContext: string,
  category: string,
  previousSessions: GrillSession[],
  signal: AbortSignal,
): Promise<{ questions: QuestionInput[]; continue: boolean; summary: string } | null> {
  const auth = await modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok || !auth.apiKey) {
    throw new Error(auth.ok ? `No API key for ${model.provider}` : auth.error);
  }

  const prompt = GRILL_NEW_SYSTEM_PROMPT.replace('{projectContext}', projectContext);

  let conversationHistory = `Category: ${category}\n\n`;

  if (previousSessions.length > 0) {
    conversationHistory += 'Previous rounds:\n\n';
    previousSessions.forEach((session, round) => {
      conversationHistory += `### Round ${round + 1}\n`;
      session.questions.forEach((q, i) => {
        const a = session.answers[i];
        const answerText = a ? formatAnswerValueForMarkdown(a) : '(skipped)';
        conversationHistory += `- ${q.prompt} → ${answerText}\n`;
      });
      conversationHistory += '\n';
    });
    const lastSession = previousSessions[previousSessions.length - 1];
    conversationHistory += `\nCurrent summary: ${lastSession ? lastSession.round + ' rounds completed' : 'none yet'}\n\n`;
  }

  conversationHistory += `Generate the next round of design questions for the ${category} category.`;

  const userMessage: UserMessage = {
    role: 'user',
    content: [{ type: 'text', text: conversationHistory }],
    timestamp: Date.now(),
  };

  const response = await complete(
    model,
    { systemPrompt: prompt, messages: [userMessage] },
    { apiKey: auth.apiKey, headers: auth.headers, signal },
  );

  if (response.stopReason === 'aborted') {
    return null;
  }

  const text = response.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

  try {
    const parsed = await parseLLMJson(text);
    return {
      questions: parsed.questions as QuestionInput[],
      continue: parsed.continue !== false,
      summary: parsed.summary || '',
    };
  } catch (err: any) {
    throw new Error(`LLM returned invalid response. Check API key and retry. Details: ${err.message.slice(0, 100)}`);
  }
}

// ─── Project detection & scaffolding ────────────────────────────────────

interface ProjectInfo {
  exists: boolean;
  type: string;
  files: string[];
  structure: string;
}

async function detectProject(cwd: string): Promise<ProjectInfo> {
  let files: string[] = [];
  try {
    files = await readdir(cwd);
  } catch {
    return { exists: false, type: 'empty', files: [], structure: '' };
  }

  const indicators: Record<string, string[]> = {
    'Node.js/TypeScript': ['package.json', 'tsconfig.json'],
    'Python': ['requirements.txt', 'pyproject.toml', 'setup.py'],
    'Go': ['go.mod'],
    'Rust': ['Cargo.toml'],
    'Ruby': ['Gemfile'],
    'Java': ['pom.xml', 'build.gradle'],
    '.NET': [],
    'Mono/Next.js': ['next.config.js', 'next.config.ts'],
    'React/Vite': ['vite.config.ts', 'vite.config.js'],
  };

  let type = 'unknown';
  
  // Special check for .csproj files
  if (files.some(f => f.endsWith('.csproj'))) {
    type = '.NET';
  } else {
    for (const [name, markers] of Object.entries(indicators)) {
      if (markers.some(m => files.includes(m))) {
        type = name;
        break;
      }
    }
  }

  const structure = files.slice(0, 20).join(', ');

  return {
    exists: files.length > 0,
    type,
    files,
    structure,
  };
}

const DEFAULT_FOLDERS = ['src', 'tests', 'docs', 'scripts'];

async function scaffoldProject(cwd: string): Promise<{ created: string[]; failed: string[] }> {
  const created: string[] = [];
  const failed: string[] = [];
  for (const folder of DEFAULT_FOLDERS) {
    const path = join(cwd, folder);
    try {
      await access(path);
    } catch {
      try {
        await mkdir(path, { recursive: true });
        created.push(folder);
      } catch {
        failed.push(folder);
      }
    }
  }
  return { created, failed };
}

// ─── Grill-new flow orchestrator ────────────────────────────────────────

async function runGrillNewFlow({
  ctx,
  projectContext,
  projectType,
  projectStructure,
  category,
  maxRounds,
  signal,
}: {
  ctx: any;
  projectContext: string;
  projectType: string;
  projectStructure: string;
  category: string;
  maxRounds: number;
  signal?: AbortSignal;
}): Promise<GrillMeResult> {
  const sessions: GrillSession[] = [];
  let markdownPath: string | null = null;
  let beadId: string | null = null;
  let summary = '';

  const fullContext = `Project: ${projectContext}\nType: ${projectType}\nStructure: ${projectStructure || 'Empty directory'}`;

  for (let round = 0; round < maxRounds; round++) {
    const generated = await generateQuestionsWithContextWithLoader(
      ctx,
      ctx.modelRegistry,
      ctx.model,
      fullContext,
      category,
      sessions,
      signal,
    );

    if (!generated || !generated.questions.length) {
      break;
    }

    const validation = validateQuestions(generated.questions);
    if (validation.valid === false) {
      ctx.ui.notify(`Question validation failed: ${validation.error}`, 'warning');
      break;
    }

    const questions = normalizeQuestions(generated.questions);
    const uiResult = await runQuestionnaireUI(ctx, questions);

    if (uiResult.cancelled) {
      return { sessions, summary, completed: false, cancelled: true };
    }

    const session: GrillSession = {
      round: round + 1,
      questions,
      answers: uiResult.answers,
      timestamp: new Date().toISOString(),
    };
    sessions.push(session);

    if (round === 0) {
      const beadsAvailable = await hasBeadsDb(ctx.cwd);
      if (beadsAvailable) {
        const safeCategory = sanitizeTopic(category);
        const desc = formatBeadDescription(safeCategory, sessions.map(s => ({
          questions: s.questions,
          answers: s.answers,
        })));
        beadId = await createGrillBead(ctx.cwd, `New: ${safeCategory}`, desc, generated.summary || '');
        if (beadId) {
          ctx.ui.notify(`Bead created: ${beadId}`, 'success');
        }
      }

      const fullSummary = generated.summary || sessions.map(s =>
        s.answers.map(a => `${a.questionLabel}: ${formatAnswerValueForMarkdown(a)}`).join('; ')
      ).join(' | ');

      const tsSessions = sessions.map(s => ({
        questions: s.questions,
        answers: s.answers,
        timestamp: s.timestamp,
      }));

      markdownPath = await saveToMarkdown(ctx.cwd, sanitizeTopic(`new-${category}`), tsSessions, fullSummary);
      ctx.ui.notify(`Saved: ${markdownPath}`, 'success');
    } else {
      if (markdownPath) {
        await appendToMarkdown(ctx.cwd, markdownPath, round, {
          questions: session.questions,
          answers: session.answers,
          timestamp: session.timestamp,
        }, generated.summary || '');
      }
      if (beadId) {
        const roundNote = `Round ${round + 1}: ${session.answers.map(a =>
          `${a.questionLabel}: ${formatAnswerValueForMarkdown(a)}`
        ).join(' | ')}`;
        await addNoteToBead(ctx.cwd, beadId, roundNote);
      }
    }

    summary = generated.summary;

    const answerSummary = formatExpandedAnswerLines({
      questions,
      answers: uiResult.answers,
      cancelled: false,
    }).join('\n');
    ctx.ui.notify(`Round ${round + 1} complete:\n${answerSummary}`, 'info');

    if (!generated.continue) {
      break;
    }
  }

  if (beadId && summary) {
    await addNoteToBead(ctx.cwd, beadId, `FINAL SUMMARY: ${summary.slice(0, 1000)}`);
  }
  if (markdownPath && summary) {
    try {
      await appendToMarkdown(ctx.cwd, markdownPath, -1, {
        questions: [],
        answers: [],
        timestamp: new Date().toISOString(),
      }, `FINAL SUMMARY: ${summary.slice(0, 1000)}`);
    } catch (err: any) {
      ctx.ui.notify(`Failed to save final summary: ${err.message.slice(0, 100)}`, 'warning');
    }
  }
  return { sessions, summary, completed: true, cancelled: false };
}

// ─── Topic selection using built-in UI ──────────────────────────────────

const TOPIC_SUGGESTIONS = [
  'Architecture review',
  'API design',
  'Data model',
  'Security review',
  'Performance',
  'Testing strategy',
  'State management',
  'Auth flow',
  'Deployment strategy',
  'Microservices boundaries',
  'All',
];

const TOPIC_CATEGORIES = TOPIC_SUGGESTIONS.filter(t => t !== 'All');

// ─── Extension entry ────────────────────────────────────────────────────

export default function grillMeTuiExtension(pi: ExtensionAPI) {
  pi.registerCommand('grill', {
    description: 'Start an interactive grill-me design interview session',
    getArgumentCompletions: (prefix: string) => {
      const suggestions = [
        { value: 'architecture', label: 'Architecture review' },
        { value: 'api-design', label: 'API design' },
        { value: 'data-model', label: 'Data model' },
        { value: 'security', label: 'Security review' },
        { value: 'performance', label: 'Performance' },
        { value: 'testing', label: 'Testing strategy' },
      ];
      const filtered = prefix
        ? suggestions.filter(s => s.value.startsWith(prefix.toLowerCase()) || s.label.toLowerCase().includes(prefix.toLowerCase()))
        : suggestions;
      return filtered.length > 0 ? filtered : null;
    },
    handler: async (args: string | undefined, ctx: any) => {
      if (!ctx.hasUI) {
        ctx.ui.notify('/grill requires interactive mode.', 'error');
        return;
      }

      if (!ctx.model) {
        ctx.ui.notify('No model selected.', 'error');
        return;
      }

      // Parse args: /grill "topic" [rounds]
      let topic = args?.trim() || '';
      let maxRounds = 3;

      if (!topic) {
        // Show topic selector using built-in UI
        const choice = await ctx.ui.select('🔥 What do you want to grill?', TOPIC_SUGGESTIONS);
        if (!choice) {
          ctx.ui.notify('Cancelled.', 'info');
          return;
        }

        const roundsInput = await ctx.ui.input('Max rounds per topic? (default: 3)');
        if (roundsInput && /^\d+$/.test(roundsInput.trim())) {
          maxRounds = Math.max(1, Math.min(10, parseInt(roundsInput.trim(), 10)));
        }

        if (choice === 'All') {
          // Run all topics sequentially
          ctx.ui.notify(`Grilling all ${TOPIC_CATEGORIES.length} categories, ${maxRounds} rounds each...`, 'info');
          const allResults: Array<{ topic: string; result: GrillMeResult }> = [];
          for (const cat of TOPIC_CATEGORIES) {
            ctx.ui.setStatus('grill-me', ctx.ui.theme.fg('accent', `🔥 ${cat} [${allResults.length + 1}/${TOPIC_CATEGORIES.length}]`));
            try {
              const result = await runGrillFlow({ ctx, topic: cat, maxRounds, signal: ctx.signal });
              allResults.push({ topic: cat, result });
            } catch (err: any) {
              ctx.ui.notify(`${cat}: ${err.message}`, 'error');
              allResults.push({ topic: cat, result: { sessions: [], summary: `Failed: ${err.message}`, completed: false, cancelled: false } });
            }
          }
          ctx.ui.setStatus('grill-me', undefined);

          // Save master summary
          const masterPath = await saveAllMarkdown(ctx.cwd, allResults);
          const completed = allResults.filter(r => r.result.completed).length;
          const totalSessions = allResults.reduce((sum, r) => sum + r.result.sessions.length, 0);
          // Build file summary for user
          const fileSummary = [
            '✅ Grill session complete!',
            '',
            `📊 ${completed}/${TOPIC_CATEGORIES.length} categories, ${totalSessions} rounds`,
            '',
            '📁 Your files:',
            `  PRD checklist: .grill-sessions/project-context.md`,
            `  Full report:   .grill-sessions/${masterPath.split('/').pop()}`,
            '',
            '💡 Tip: Share project-context.md with any LLM to continue building.',
          ].join('\n');

          ctx.ui.notify(fileSummary, 'success');

          // Save master bead
          const beadsAvailable = await hasBeadsDb(ctx.cwd);
          if (beadsAvailable) {
            const masterDesc = allResults.map(r =>
              `## ${r.topic}\n\n${r.result.summary || 'No summary'}`
            ).join('\n\n');
            const masterBeadId = await createGrillBead(
              ctx.cwd,
              'All categories grill session',
              masterDesc,
              `${completed}/${TOPIC_CATEGORIES.length} categories completed, ${totalSessions} rounds total`,
            );
            if (masterBeadId) {
              ctx.ui.notify(`Master bead: ${masterBeadId}`, 'success');
            }
          }
          return;
        }

        topic = choice;
      } else {
        // Check if args ends with a number
        const parts = topic.split(/\s+/);
        const last = parts[parts.length - 1];
        if (last && /^\d+$/.test(last)) {
          maxRounds = parseInt(last, 10);
          topic = parts.slice(0, -1).join(' ');
        }
      }

      ctx.ui.setStatus('grill-me', ctx.ui.theme.fg('accent', `🔥 Grilling: ${topic}`));

      try {
        const grillResult = await runGrillFlow({ ctx, topic, maxRounds, signal: ctx.signal });

        if (grillResult.cancelled) {
          ctx.ui.notify('Grill session cancelled.', 'warning');
        } else {
          const fileSummary = [
            '✅ Grill session complete!',
            '',
            `📊 ${grillResult.sessions.length} rounds`,
            '',
            '📁 Your files:',
            `  Sessions: .grill-sessions/ (files for: ${topic})`,
            '',
            '💡 Use /grill to continue reviewing, or /grill-new for a new project.',
          ].join('\n');

          ctx.ui.notify(fileSummary, 'success');
        }
      } catch (err: any) {
        ctx.ui.notify(`Grill failed: ${err.message}`, 'error');
      } finally {
        ctx.ui.setStatus('grill-me', undefined);
      }
    },
  });

  // ─── /grill-new ─────────────────────────────────────────────────────

  pi.registerCommand('grill-new', {
    description: 'Start a new project grill session. Captures project context, sets up structure, then grills all relevant categories.',
    handler: async (_args: string | undefined, ctx: any) => {
      if (!ctx.hasUI) {
        ctx.ui.notify('/grill-new requires interactive mode.', 'error');
        return;
      }

      if (!ctx.model) {
        ctx.ui.notify('No model selected.', 'error');
        return;
      }

      // Step 1: What are we building?
      const projectDesc = await ctx.ui.input('🔥 What are we building?\nDescribe the project in 1-2 sentences...');
      if (!projectDesc || !projectDesc.trim()) {
        ctx.ui.notify('Cancelled.', 'info');
        return;
      }

      // Step 2: Detect existing project
      const projectInfo = await detectProject(ctx.cwd);
      ctx.ui.notify(
        projectInfo.exists
          ? `Found ${projectInfo.type} project: ${projectInfo.files.filter(f => !f.startsWith('.')).join(', ') || 'files'}`
          : 'Empty directory — will scaffold basic structure',
        'info',
      );

      // Step 3: Scaffold if empty
      if (!projectInfo.exists) {
        const confirm = await ctx.ui.confirm('Scaffold project?', `Create: ${DEFAULT_FOLDERS.join(', ')}`);
        if (confirm) {
          const result = await scaffoldProject(ctx.cwd);
          if (result.created.length > 0) {
            ctx.ui.notify(`Created: ${result.created.join(', ')}`, 'success');
          }
          if (result.failed.length > 0) {
            ctx.ui.notify(`Failed to create: ${result.failed.join(', ')}`, 'warning');
          }
        }
      }

      // Step 4: Pick categories
      const choice = await ctx.ui.select('🔥 Which categories to grill?', TOPIC_SUGGESTIONS);
      if (!choice) {
        ctx.ui.notify('Cancelled.', 'info');
        return;
      }

      const roundsInput = await ctx.ui.input('Max rounds per category? (default: 3)');
      const maxRounds = roundsInput && /^\d+$/.test(roundsInput.trim())
        ? Math.max(1, Math.min(10, parseInt(roundsInput.trim(), 10)))
        : 3;

      // Step 5: Run grilling
      const selectedCategories = choice === 'All' ? TOPIC_CATEGORIES : [choice];
      const allResults: Array<{ topic: string; result: GrillMeResult }> = [];

      ctx.ui.notify(`Grilling ${selectedCategories.length} categories, ${maxRounds} rounds each...`, 'info');

      for (const cat of selectedCategories) {
        ctx.ui.setStatus('grill-me', ctx.ui.theme.fg('accent', `🔥 ${cat} [${allResults.length + 1}/${selectedCategories.length}]`));
        try {
          const result = await runGrillNewFlow({
            ctx,
            projectContext: projectDesc.trim(),
            projectType: projectInfo.type,
            projectStructure: projectInfo.structure,
            category: cat,
            maxRounds,
            signal: ctx.signal,
          });
          allResults.push({ topic: cat, result });
        } catch (err: any) {
          ctx.ui.notify(`${cat}: ${err.message}`, 'error');
          allResults.push({ topic: cat, result: { sessions: [], summary: `Failed: ${err.message}`, completed: false, cancelled: false } });
        }
      }
      ctx.ui.setStatus('grill-me', undefined);

      // Save individual session markdown files first
      const sessionsDir = await ensureGrillSessionsDir(ctx.cwd);
      const slug = projectDesc.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const fileMap: Record<string, string> = {};

      for (const r of allResults) {
        const catSlug = r.topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
        const filename = `${ts}-${slug}-${catSlug}.md`;
        const filepath = join(sessionsDir, filename);
        const content = formatMarkdownContent(`${r.topic} (${projectDesc.trim()})`, r.result.sessions.map(s => ({
          questions: s.questions,
          answers: s.answers,
          timestamp: s.timestamp,
        })), r.result.summary || '');
        await writeFile(filepath, content, 'utf8');
        fileMap[r.topic] = filename;
      }

      // Save combined master report
      const masterPath = await saveAllMarkdown(ctx.cwd, allResults);

      // Generate PRD checklist with actual file links
      ctx.ui.setStatus('grill-me', ctx.ui.theme.fg('accent', '📝 Generating PRD...'));
      const prdContent = await generatePRD(
        ctx.modelRegistry,
        ctx.model,
        projectDesc.trim(),
        projectInfo.type,
        allResults,
        fileMap,
        new AbortController().signal,
      );

      const prdPath = join(sessionsDir, 'project-context.md');
      await writeFile(prdPath, prdContent, 'utf8');
      ctx.ui.setStatus('grill-me', undefined);
      const completed = allResults.filter(r => r.result.completed).length;
      const totalSessions = allResults.reduce((sum, r) => sum + r.result.sessions.length, 0);

      // Build file summary for user
      const fileSummary = [
        '✅ Project grill complete!',
        '',
        `📊 ${completed}/${selectedCategories.length} categories, ${totalSessions} rounds`,
        '',
        '📁 Your files:',
        `  PRD checklist: .grill-sessions/project-context.md`,
        `  Full sessions: .grill-sessions/`,
        '',
        '💡 Tip: Give project-context.md to any LLM — it has all decisions + checkboxes.',
      ].join('\n');

      ctx.ui.notify(fileSummary, 'success');

      // Save master bead
      const beadsAvailable = await hasBeadsDb(ctx.cwd);
      if (beadsAvailable) {
        const masterDesc = allResults.map(r =>
          `## ${r.topic}\n\n${r.result.summary || 'No summary'}`
        ).join('\n\n');
        const masterBeadId = await createGrillBead(
          ctx.cwd,
          `New project: ${projectDesc.trim().slice(0, 50)}`,
          `PRD: .grill-sessions/project-context.md\n\n${masterDesc}`,
          `${completed}/${selectedCategories.length} completed, ${totalSessions} rounds`,
        );
        if (masterBeadId) {
          ctx.ui.notify(`Master bead: ${masterBeadId}`, 'success');
        }
      }
    },
  });
}
