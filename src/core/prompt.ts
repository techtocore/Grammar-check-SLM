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

/** Builds the chat message array for an instruction-tuned causal LM. */
export function buildMessages(sentence: string): ChatMessage[] {
  return [
    { role: 'system', content: GRAMMAR_SYSTEM_PROMPT },
    { role: 'user', content: sentence },
  ];
}

/** Builds the plain-text prompt for a text2text model (e.g. FLAN-T5). */
export function buildT5Prompt(sentence: string): string {
  return `Fix the grammar and spelling of this sentence: ${sentence}`;
}

const PREFIX_RE =
  /^\s*(?:corrected(?:\s+(?:sentence|text|version))?|output|answer|result|correction|here(?:'s| is)[^:]*)\s*[:-]\s*/i;

const QUOTE_PAIRS: Record<string, string> = {
  '"': '"',
  "'": "'",
  '\u201c': '\u201d', // “ ”
  '\u2018': '\u2019', // ‘ ’
  '\u00ab': '\u00bb', // « »
  '`': '`',
};

function stripWrappingQuotes(input: string): string {
  let current = input.trim();
  let previous = '';
  while (current !== previous) {
    previous = current;
    const first = current[0];
    const last = current[current.length - 1];
    if (first && last && current.length >= 2 && QUOTE_PAIRS[first] === last) {
      current = current.slice(1, -1).trim();
    }
  }
  return current;
}

function stripThinking(input: string): string {
  // Remove well-formed <think>…</think> blocks (Qwen3 reasoning traces).
  let out = input.replace(/<think>[\s\S]*?<\/think>/gi, '');
  // If a stray closing tag remains, discard everything up to and including it.
  const closeIdx = out.toLowerCase().lastIndexOf('</think>');
  if (closeIdx !== -1) {
    out = out.slice(closeIdx + '</think>'.length);
  }
  return out;
}

/**
 * Normalizes raw model output into a clean corrected sentence. Strips reasoning
 * traces, echoed instruction prefixes, and wrapping quotes. Falls back to the
 * source sentence when the model returns nothing usable.
 */
export function cleanModelOutput(raw: string, source: string): string {
  let out = stripThinking(raw).trim();
  out = out.replace(PREFIX_RE, '');
  out = stripWrappingQuotes(out);
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > 0 ? out : source.trim();
}
