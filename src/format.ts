// Validation, normalization, and formatting utilities
// Adapted from pi-extensions/packages/questionnaire

import type {
  NormalizedAnswer,
  NormalizedQuestion,
  QuestionInput,
  QuestionSelectionState,
  QuestionnaireResult,
  SelectedOption,
} from './types.js';

export function validateQuestions(
  questions: QuestionInput[],
): { valid: true } | { valid: false; error: string } {
  if (questions.length === 0) {
    return { valid: false, error: 'Questionnaire must include at least 1 question.' };
  }

  if (questions.length > 5) {
    return { valid: false, error: 'Questionnaire supports at most 5 questions.' };
  }

  const idSet = new Set<string>();

  for (const [index, question] of questions.entries()) {
    const questionNumber = index + 1;
    const questionId = question.id.trim();

    if (!questionId) {
      return { valid: false, error: `Question ${questionNumber} has an empty id.` };
    }

    if (idSet.has(questionId)) {
      return { valid: false, error: `Duplicate question id: "${questionId}".` };
    }
    idSet.add(questionId);

    if (!question.options.length) {
      return {
        valid: false,
        error: `Question "${questionId}" must include at least one listed option.`,
      };
    }

    const valueSet = new Set<string>();
    for (const option of question.options) {
      const optionValue = option.value.trim();
      if (!optionValue) {
        return {
          valid: false,
          error: `Question "${questionId}" has an option with an empty value.`,
        };
      }
      if (valueSet.has(optionValue)) {
        return {
          valid: false,
          error: `Question "${questionId}" has duplicate option value "${optionValue}".`,
        };
      }
      valueSet.add(optionValue);
    }
  }

  return { valid: true };
}

export function normalizeQuestions(questions: QuestionInput[]): NormalizedQuestion[] {
  return questions.map((question, index) => ({
    id: question.id.trim(),
    label: question.label?.trim() || question.id.trim() || `Q${index + 1}`,
    prompt: question.prompt.trim(),
    selectionMode: question.selectionMode ?? 'single',
    options: question.options.map((option) => ({
      value: option.value.trim(),
      label: option.label,
      description: option.description,
    })),
    allowOther: question.allowOther !== false,
  }));
}

export function createInitialQuestionStateById(
  questions: NormalizedQuestion[],
): Record<string, QuestionSelectionState> {
  return Object.fromEntries(
    questions.map((question) => [
      question.id,
      {
        listedSelectedValues: [],
        otherText: '',
        wasOtherSelected: false,
      } satisfies QuestionSelectionState,
    ]),
  );
}

function hasValidOtherText(state: QuestionSelectionState): boolean {
  return state.wasOtherSelected && state.otherText.trim().length > 0;
}

export function isAnswerValid(
  question: NormalizedQuestion,
  state: QuestionSelectionState,
): boolean {
  const selectedListedCount = state.listedSelectedValues.length;
  const hasOtherText = hasValidOtherText(state);

  if (question.selectionMode === 'single') {
    const hasSingleListed = selectedListedCount === 1 && !state.wasOtherSelected;
    const hasSingleOther = selectedListedCount === 0 && hasOtherText;
    return hasSingleListed || hasSingleOther;
  }

  return selectedListedCount > 0 || hasOtherText;
}

export function areAllAnswersValid(
  questions: NormalizedQuestion[],
  stateById: Record<string, QuestionSelectionState>,
): boolean {
  return questions.every((question) => {
    const state = stateById[question.id];
    if (!state) return false;
    return isAnswerValid(question, state);
  });
}

export function normalizeAnswer(
  question: NormalizedQuestion,
  state: QuestionSelectionState,
): NormalizedAnswer {
  const selectedSet = new Set(state.listedSelectedValues);
  const selectedOptions: SelectedOption[] = question.options
    .filter((option) => selectedSet.has(option.value))
    .map((option) => ({ value: option.value, label: option.label }));

  const trimmedOther = state.otherText.trim();

  return {
    questionId: question.id,
    questionLabel: question.label,
    selectedOptions,
    otherText: state.wasOtherSelected && trimmedOther ? trimmedOther : null,
    wasOtherSelected: state.wasOtherSelected,
  };
}

export function normalizeAnswers(
  questions: NormalizedQuestion[],
  stateById: Record<string, QuestionSelectionState>,
): NormalizedAnswer[] {
  return questions.map((question) =>
    normalizeAnswer(question, stateById[question.id] ?? createEmptyQuestionState()),
  );
}

function createEmptyQuestionState(): QuestionSelectionState {
  return { listedSelectedValues: [], otherText: '', wasOtherSelected: false };
}

export function formatAnswerValue(answer: NormalizedAnswer): string {
  const listed = answer.selectedOptions.map((option) => option.label).join(', ');
  const other = answer.otherText ? `Other: "${answer.otherText}"` : '';

  if (listed && other) return `${listed} + ${other}`;
  if (listed) return listed;
  if (other) return other;
  return '—';
}

export function formatCompletedSummary(result: QuestionnaireResult): string {
  const parts = result.answers.map(
    (answer) => `${answer.questionLabel}: ${formatAnswerValue(answer)}`,
  );
  return `✓ ${parts.join(' • ')}`;
}

export function formatCancelledSummary(): string {
  return '⚠ Cancelled';
}

export function formatExpandedAnswerLines(result: QuestionnaireResult): string[] {
  return result.answers.map((answer) => `${answer.questionLabel}: ${formatAnswerValue(answer)}`);
}

export function formatToolContentSummary(result: QuestionnaireResult): string {
  if (result.cancelled) {
    return formatCancelledSummary();
  }
  return formatExpandedAnswerLines(result).join('\n');
}

// Grill-me specific: format for bead persistence
export function formatBeadDescription(
  topic: string,
  sessions: Array<{ questions: NormalizedQuestion[]; answers: NormalizedAnswer[] }>,
): string {
  let desc = `# Grill Session: ${topic}\n\n`;

  sessions.forEach((session, round) => {
    desc += `## Round ${round + 1}\n\n`;
    session.questions.forEach((q, i) => {
      const answer = session.answers[i];
      const answerText = answer ? formatAnswerValue(answer) : '(no answer)';
      desc += `### ${q.prompt}\n`;
      desc += `**Answer:** ${answerText}\n\n`;
    });
  });

  return desc;
}

export function formatMarkdownContent(
  topic: string,
  sessions: Array<{
    questions: NormalizedQuestion[];
    answers: NormalizedAnswer[];
    timestamp: string;
  }>,
  summary: string,
): string {
  let md = `# Grill Session: ${topic}\n\n`;
  md += `**Date:** ${new Date().toISOString()}\n`;
  md += `**Rounds:** ${sessions.length}\n\n`;
  md += `## Summary\n\n${summary}\n\n---\n\n`;

  sessions.forEach((session, round) => {
    md += `## Round ${round + 1}\n\n`;
    md += `*${session.timestamp}*\n\n`;
    session.questions.forEach((q, i) => {
      const answer = session.answers[i];
      const answerText = answer ? formatAnswerValue(answer) : '(no answer)';
      md += `**Q: ${q.prompt}**\n\n`;
      md += `A: ${answerText}\n\n`;
    });
    md += '\n---\n\n';
  });

  return md;
}
