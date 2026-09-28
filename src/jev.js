// Jev (TypeSafe AI System One model) as the final judge of a task: https://docs.typesafe.ai/api
// Claude triage proposes a decision and reformulates the task (text generation); Jev, which returns
// calibrated typed answers instead of text, takes the final decision and checks the reformulation.
import { taskDescription } from './task.js';

const ACTION_CRITERIA = {
  develop: 'A concrete code change that one of `repositories` can implement and verify with automated tests',
  needs_details: 'Could be a code change but is too vague or ambiguous: a human must clarify it first',
  skip: 'Not a code change for these repositories (meeting, design, ops, question, another project)',
};
const CLARITY_LEVELS = ['Too vague to implement', 'Implementable with assumptions', 'Clear and testable'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate({ apiKey, apiUrl, model }, body, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, ...body }),
    });
    if ((res.status === 429 || res.status === 529) && attempt < retries) {
      await sleep(1000 * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`Jev -> ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  }
}

/** Ask Jev for the final decision on a task, given Claude's triage proposal and reformulated spec. */
export async function jevJudge(jev, { task, repos, proposal }) {
  const state = {
    task: {
      title: task.name,
      description: taskDescription(task) || '(none)',
      tags: (task.tags ?? []).map((t) => t.name),
      checklists: (task.checklists ?? []).map((c) => ({ name: c.name, items: (c.items ?? []).map((i) => i.name) })),
    },
    repositories: repos.map((r) => r.name),
    triage_proposal: { action: proposal.action, repo: proposal.repo.name, reason: proposal.reason },
    ...(proposal.spec ? { reformulated_spec: proposal.spec } : {}),
  };
  const questions = {
    action: {
      type: 'choice',
      instructions: 'Final decision: what should the automation do with `task`? Judge the task itself; `triage_proposal` is a second opinion.',
      criteria: ACTION_CRITERIA,
    },
    clarity: { type: 'score', instructions: 'How clearly does `task` define the expected change?', criteria: CLARITY_LEVELS },
  };
  if (repos.length > 1) {
    questions.repo = {
      type: 'choice',
      instructions: 'Which of `repositories` should implement `task`?',
      criteria: Object.fromEntries(repos.map((r) => [r.name, null])),
    };
  }
  if (proposal.spec) {
    questions.spec_faithful = {
      type: 'noul',
      instructions: 'Does `reformulated_spec` describe the same work as `task`, without adding requirements the task does not ask for?',
    };
  }
  const { answers, model } = await evaluate(jev, { state, questions });
  return {
    model,
    action: answers.action.choice,
    confidence: answers.action.confidence,
    clarity: answers.clarity?.score ?? null,
    repo: answers.repo ? { name: answers.repo.choice, confidence: answers.repo.confidence } : null,
    specFaithful: answers.spec_faithful?.noul ?? null,
  };
}

/**
 * Merge Jev's verdict into the triage decision. Jev has the final word when it is confident;
 * below the threshold the task goes back to a human (needs_details).
 */
export function applyVerdict(decision, verdict, repos, minConfidence) {
  const summary = `Jev ${verdict.action} (confidence ${verdict.confidence.toFixed(2)}`
    + `${verdict.clarity === null ? '' : `, clarity ${verdict.clarity.toFixed(1)}/2`})`;
  if (verdict.confidence < minConfidence) {
    return {
      ...decision, action: 'needs_details', spec: null, jev: summary,
      reason: `Jev is not confident enough to act (${verdict.confidence.toFixed(2)} < ${minConfidence}). ${decision.reason}`.trim(),
    };
  }
  const jevRepo = verdict.repo && verdict.repo.confidence >= minConfidence && repos.find((r) => r.name === verdict.repo.name);
  const faithful = verdict.specFaithful === null || verdict.specFaithful >= 0.5;
  return {
    ...decision,
    action: verdict.action,
    repo: jevRepo || decision.repo,
    spec: faithful ? decision.spec : null,
    jev: faithful ? summary : `${summary}; reformulated spec rejected (${verdict.specFaithful.toFixed(2)}), using the original task`,
  };
}
