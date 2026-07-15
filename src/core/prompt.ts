export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/**
 * Instruction given to instruction-tuned chat SLMs (Qwen3, Llama, Gemma,
 * SmolLM, …). Kept deliberately strict so the model returns *only* the
 * corrected sentence with no commentary.
 */
export const GRAMMAR_SYSTEM_PROMPT = [
  'You are a precise grammar, spelling, and punctuation correction engine.',
  'You are given exactly one sentence. Return the corrected sentence and nothing else.',
  'Rules:',
  '- Preserve the original meaning, tone, wording, and formatting as much as possible.',
  '- Only fix objective grammar, spelling, punctuation, and capitalization errors.',
  '- Do not rephrase, translate, summarize, answer, or add or remove information.',
  '- Do not add quotation marks, labels, explanations, or extra whitespace.',
  '- If the sentence is already correct, return it exactly as-is.',
].join('\n');

/**
 * Builds the chat message array for an instruction-tuned causal LM. Includes a
 * few short examples to steer small models toward returning only the corrected
 * sentence (and leaving already-correct text untouched).
 */
export function buildMessages(sentence: string): ChatMessage[] {
  return [
    { role: 'system', content: GRAMMAR_SYSTEM_PROMPT },
    { role: 'user', content: 'she dont has any freinds' },
    { role: 'assistant', content: "She doesn't have any friends." },
    { role: 'user', content: 'the meetings is schedule for tommorow' },
    { role: 'assistant', content: 'The meetings are scheduled for tomorrow.' },
    { role: 'user', content: 'This sentence is already correct.' },
    { role: 'assistant', content: 'This sentence is already correct.' },
    { role: 'user', content: sentence },
  ];
}

/** Builds the plain-text prompt for a text2text model (e.g. FLAN-T5). */
export function buildT5Prompt(sentence: string): string {
  return `Fix the grammar and spelling of this sentence: ${sentence}`;
}

/**
 * System + few-shot context for the Chrome Prompt API's `initialPrompts`
 * (everything {@link buildMessages} produces except the final user sentence).
 */
export function buildInitialPrompts(): ChatMessage[] {
  return buildMessages('').slice(0, -1);
}

const PREFIX_RE =
  /^\s*(?:corrected(?:\s+(?:sentence|text|version))?|output|answer|result|correction|here(?:'s| is)\s+(?:(?:the|your|a)\s+)?(?:corrected\s+(?:sentence|text|version)|answer|result|correction))\s*[:-]\s*/i;

const EXPLANATION_RE = /^\s*(?:explanation|reasoning|changes?|notes?|why)\s*:/i;
const UNLABELLED_EXPLANATION_RE =
  /^\s*(?:(?:i|we)(?:'ve| have)?\s+(?:fixed|corrected|changed|adjusted|updated|removed|added)|this\s+(?:fixes|corrects|changes)|the\s+(?:verb|grammar|spelling|punctuation)\s+(?:was|is|has))/i;

const QUOTE_PAIRS: Record<string, string> = {
  '"': '"',
  "'": "'",
  '\u201c': '\u201d', // “ ”
  '\u2018': '\u2019', // ‘ ’
  '\u00ab': '\u00bb', // « »
  '`': '`',
};

function wrappingQuote(input: string): string | undefined {
  const current = input.trim();
  const first = current[0];
  const last = current[current.length - 1];
  return first && last && current.length >= 2 && QUOTE_PAIRS[first] === last ? first : undefined;
}

function stripWrappingQuotes(input: string, source: string): string {
  let current = input.trim();
  let previous = '';
  while (current !== previous) {
    previous = current;
    const quote = wrappingQuote(current);
    if (quote && wrappingQuote(source) !== quote) {
      current = current.slice(1, -1).trim();
    }
  }
  return current;
}

function stripLeadingThinking(input: string, source: string): string {
  if (/<\/?think\b/i.test(source)) return input;

  // Qwen reasoning traces precede the answer. Never remove matching text from
  // inside a user's sentence.
  let out = input.replace(/^\s*(?:<think>[\s\S]*?<\/think>\s*)+/i, '');
  const closeIdx = out.toLowerCase().indexOf('</think>');
  if (closeIdx !== -1) {
    out = out.slice(closeIdx + '</think>'.length);
  }
  return out;
}

/** Joins wrapped output lines while dropping explicitly labelled commentary. */
function correctedTextLines(text: string, source: string): string {
  const lines = text.split(/\r?\n/);
  const parts: string[] = [];
  for (const line of lines) {
    if (parts.length > 0 && (EXPLANATION_RE.test(line) || UNLABELLED_EXPLANATION_RE.test(line))) {
      break;
    }

    let stripped = line.trim();
    if (parts.length === 0) {
      const rawPrefix = stripped.match(PREFIX_RE)?.[0]?.trim().toLocaleLowerCase();
      const sourcePrefix = source.trim().match(PREFIX_RE)?.[0]?.trim().toLocaleLowerCase();
      if (rawPrefix !== sourcePrefix) stripped = stripped.replace(PREFIX_RE, '').trim();
    }
    if (stripped) parts.push(stripped);
  }
  return parts.join(' ');
}

/**
 * Normalizes raw model output into a clean corrected sentence. Strips reasoning
 * traces, echoed instruction prefixes, verbose trailing explanations, and
 * wrapping quotes. Falls back to the source sentence when nothing usable remains.
 */
export function cleanModelOutput(raw: string, source: string): string {
  if (raw.trim() === source.trim()) return source.trim();

  let out = correctedTextLines(stripLeadingThinking(raw, source), source);
  out = stripWrappingQuotes(out, source);
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > 0 ? out : source.trim();
}
