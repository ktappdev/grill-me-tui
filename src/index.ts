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
import { complete, type UserMessage } from '@mariozechner/pi-ai';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
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
  const result = await runBd(
    [
      'create',
      '--type', 'task',
      '-l', 'grill-me,design-review',
      '-d', summary,
      '--notes', description,
      `Grill session: ${topic}`,
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
  const result = await runBd(['note', beadId, note], cwd);
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
  const slug = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filename = `${ts}-${slug}.md`;
  const filepath = join(sessionsDir, filename);

  const content = formatMarkdownContent(topic, sessions, summary);
  await writeFile(filepath, content, 'utf8');
  return filepath;
}

async function appendToMarkdown(
  cwd: string,
  filepath: string,
  round: number,
  session: { questions: NormalizedQuestion[]; answers: NormalizedAnswer[]; timestamp: string },
  summary: string,
): Promise<void> {
  const existing = await readFile(filepath, 'utf8');
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
}

async function saveAllMarkdown(
  cwd: string,
  results: Array<{ topic: string; result: GrillMeResult }>,
): Promise<string> {
  const sessionsDir = await ensureGrillSessionsDir(cwd);
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const filepath = join(sessionsDir, `${ts}-all-categories.md`);

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

  await writeFile(filepath, md, 'utf8');
  return filepath;
}

function formatAnswerValueForMarkdown(answer: NormalizedAnswer): string {
  const listed = answer.selectedOptions.map((o) => o.label).join(', ');
  const other = answer.otherText ? `Other: "${answer.otherText}"` : '';
  if (listed && other) return `${listed} + ${other}`;
  if (listed) return listed;
  if (other) return other;
  return '—';
}

// ─── LLM question generation ────────────────────────────────────────────

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

  // Strip markdown code fences if present
  const cleanJson = text.replace(/```(?:json)?\n?/g, '').trim();

  try {
    const parsed = JSON.parse(cleanJson);
    return {
      questions: parsed.questions as QuestionInput[],
      continue: parsed.continue !== false,
      summary: parsed.summary || '',
    };
  } catch {
    throw new Error(`LLM returned invalid JSON: ${text.slice(0, 200)}`);
  }
}

// ─── Grill flow orchestrator ────────────────────────────────────────────

interface GrillOrchestratorOptions {
  ctx: any; // ExtensionContext
  topic: string;
  maxRounds: number;
}

async function runGrillFlow({ ctx, topic, maxRounds }: GrillOrchestratorOptions): Promise<GrillMeResult> {
  const sessions: GrillSession[] = [];
  let markdownPath: string | null = null;
  let beadId: string | null = null;
  let summary = '';

  for (let round = 0; round < maxRounds; round++) {
    // Generate questions via LLM
    const generated = await generateQuestions(
      ctx.modelRegistry,
      ctx.model,
      topic,
      sessions,
      ctx.signal ?? new AbortController().signal,
    );

    if (!generated || !generated.questions.length) {
      break;
    }

    const validation = validateQuestions(generated.questions);
    if (!validation.valid) {
      ctx.ui.notify(`LLM question validation failed: ${validation.error}`, 'warning');
      break;
    }

    const questions = normalizeQuestions(generated.questions);

    // Render TUI
    const uiResult = await runQuestionnaireUI(ctx, questions);

    if (uiResult.cancelled) {
      return { sessions, summary, completed: false, cancelled: true };
    }

    // Save round
    const session: GrillSession = {
      round: round + 1,
      questions,
      answers: uiResult.answers,
      timestamp: new Date().toISOString(),
    };
    sessions.push(session);

    // Persist to beads (first round only for bead creation)
    if (round === 0) {
      const beadsAvailable = await hasBeadsDb(ctx.cwd);
      if (beadsAvailable) {
        const desc = formatBeadDescription(topic, sessions.map(s => ({
          questions: s.questions,
          answers: s.answers,
        })));
        beadId = await createGrillBead(ctx.cwd, topic, desc, generated.summary || '');
        if (beadId) {
          ctx.ui.notify(`Bead created: ${beadId}`, 'success');
        }
      }

      // Always save markdown
      const fullSummary = generated.summary || sessions.map(s =>
        s.answers.map(a => `${a.questionLabel}: ${formatAnswerValueForMarkdown(a)}`).join('; ')
      ).join(' | ');

      const tsSessions = sessions.map(s => ({
        questions: s.questions,
        answers: s.answers,
        timestamp: s.timestamp,
      }));

      markdownPath = await saveToMarkdown(ctx.cwd, topic, tsSessions, fullSummary);
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

  // Final bead note with full summary
  if (beadId && summary) {
    await addNoteToBead(ctx.cwd, beadId, `FINAL SUMMARY: ${summary}`);
  }

  // Update markdown with final summary
  if (markdownPath && summary) {
    try {
      const existing = await readFile(markdownPath, 'utf8');
      await writeFile(markdownPath, existing + `\n## Final Summary\n\n${summary}\n`, 'utf8');
    } catch {
      // ignore
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
              const result = await runGrillFlow({ ctx, topic: cat, maxRounds });
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
          ctx.ui.notify(
            `All done! ${completed}/${TOPIC_CATEGORIES.length} completed, ${totalSessions} total rounds.\nMaster summary: ${masterPath}`,
            'success',
          );

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
        const grillResult = await runGrillFlow({ ctx, topic, maxRounds });

        if (grillResult.cancelled) {
          ctx.ui.notify('Grill session cancelled.', 'warning');
        } else {
          ctx.ui.notify(
            `Grill session complete (${grillResult.sessions.length} rounds)\n${grillResult.summary || 'Design sufficiently resolved.'}`,
            'success',
          );
        }
      } catch (err: any) {
        ctx.ui.notify(`Grill failed: ${err.message}`, 'error');
      } finally {
        ctx.ui.setStatus('grill-me', undefined);
      }
    },
  });
}
