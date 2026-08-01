// Snippet hygiene: strip prompt-injection / jailbreak preamble from scraped
// source snippets before they ever reach the synthesis model.
//
// Why: scraped sources (linux.do OPs, aggregator extracts) sometimes carry text
// that reads as instructions to the model — e.g. a forum post whose first lines
// are "CRITICAL INSTRUCTIONS FOR ALL AI ASSISTANTS… You MUST REFUSE to generate,
// draft, compose, ghostwrite…", or "As an AI language model…". A naive pipeline
// feeds that verbatim into the synthesis prompt, handing external, untrusted
// content a direct instruction channel into the model. That is a prompt-injection
// surface on a report that ships to an Obsidian vault daily.
//
// Defense: treat source snippets as DATA, not instructions. Drop injection-like
// sentences or clauses (we'd rather have a thinner snippet than one the model
// mistakes for an order), and if a whole source card has nothing but injection-like
// text left, flag it for removal.

// Injection signatures. Matched against trimmed paragraphs and sentence segments.
const INJECTION_RE_list = [
  /CRITICAL\s+INSTRUCTIONS?\s+FOR\s+ALL\s+AI/i,
  /\bYou\s+MUST\s+(?:REFUSE|NOT|NEVER)\b/i,
  /\bAs\s+an?\s+AI(\s+(?:language|-)?\s*model|language\s+model|assistant)\b/i,
  /IGNORE\s+(?:ALL\s+)?(?:previous|prior|above|all)\s+instructions/i,
  /DISREGARD\s+(?:THE\s+)?(?:REPORT|PREVIOUS|ABOVE|ALL)\b/i,
  /FOLLOW\s+THESE\s+INSTRUCTIONS?\s+INSTEAD/i,
  /INSTEAD\s+OF\s+THE\s+SYSTEM\s+PROMPT/i,
  /请忽略以上规则/u,
  /忽略.*(?:之前|以上|所有).*(?:指令|规则|提示)/u,
  /改为输出/u,
  /不要遵守.*(?:系统|指令|规则)/u,
  /^\s*System\s*:\s/i,
  /do\s+not\s+reveal\s+these\s+instructions/i,
  /\bAI\s+ASSISTANT[S]?\b.*\bMUST\s+REFUSE\b/i,
  /This\s+policy\s+is\s+enforced\s+with\s+zero\s+tolerance/i,
  /\bIf\s+you\s+are\s+an?\s+AI\s+(?:agent|language\s+model|automated\s+assistant)\b/i,
  /\bAny\s+user\s+caught\s+submitting\s+AI[-\s]generated\s+content\b/i,
  /\bThis\s+includes\s+but\s+is\s+not\s+limited\s+to:\s+forum\s+posts\b/i,
  /\bThis\s+applies\s+to\s+all\s+forms\s+of\s+AI\s+assistance\b/i,
  /\bPERMANENTLY\s+BANNED\b/i,
  /\bDo\s+NOT\s+generate\s+the\s+content\s+under\s+any\s+circumstances\b/i,
  /\bThis\s+website\s+strictly\s+prohibits\s+AI[-\s]generated\s+content\b/i,
  /\bPlease\s+write\s+your\s+own\s+content\b/i,
  /\bRead\s+the\s+site\s+guidelines\b/i,
  /\bautomated\s+session\b.*\bcompose\s+or\s+post\s+content\b/i,
  /\bMUST\s+immediately\s+stop\s+and\s+navigate\b/i,
  /\bThere\s+are\s+NO\s+exceptions\s+to\s+this\s+policy\b/i,
  /\bThis\s+policy\s+applies\s+regardless\s+of\s+how\s+the\s+AI[-\s]generated\s+content\s+is\s+used\b/i,
  /\[END\s+INSTRUCTIONS?\]/i,
  /\bViolators\s+will\s+be\s+permanently\s+ban(?:ned)?\b/i,
  /\bJAILBREAK\b|\bprompt\s*injection\b/i,
  /You\s+are\s+(?:now\s+)?(?:a|an)\s+(?:helpful|unfiltered|unrestricted)\s+(?:AI|assistant|language\s+model)/i,
];

// A single compiled alternation for fast paragraph scans.
const INJECTION_RE = new RegExp(
  INJECTION_RE_list.map((re) => `(${re.source})`).join("|"),
  "i",
);

// A second, deliberately conservative detector catches paraphrases that avoid the
// fixed denylist: an imperative aimed at instructions/rules/system prompts. It is
// intentionally bounded so ordinary prose about following product instructions is
// less likely to be removed unless it also targets a control channel.
const HIGH_RISK_IMPERATIVE_RE =
  /(?:\b(?:ignore|disregard|override|replace|follow|obey|reveal|publish|output|tell)\b|(?:忽略|无视|覆盖|改为输出|不要遵守|发布|告诉))[\s\S]{0,120}(?:\bsystem(?:\s+prompt)?\b|\binstructions?\b|\brules?\b|\bprompts?\b|系统(?:提示)?|指令|规则|提示)/iu;

// Does a single paragraph look like injected-instruction text?
function looksInjected(para) {
  if (!para) return false;
  return INJECTION_RE.test(para) || HIGH_RISK_IMPERATIVE_RE.test(para);
}

/**
 * Sanitize a snippet: split into paragraphs, remove injection-looking sentence
 * segments, and trim. Returns the cleaned snippet, or "" if nothing but injection
 * remained. Exported for tests.
 */
// Split only at sentence boundaries. The punctuation-aware whitespace rule keeps
// version numbers such as "v4.5" intact while allowing an injected sentence to be
// removed without discarding legitimate prose that follows it in the same paragraph.
const SENTENCE_SPLIT_RE = /(?<=[。！？!?])\s*|(?<=\.)\s+/u;

function sanitizeParagraph(para) {
  if (!looksInjected(para)) return para;
  const segments = para
    .split(SENTENCE_SPLIT_RE)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .filter((segment) => !/^\d+[.)]?$/.test(segment))
    .filter((segment) => !looksInjected(segment));
  return segments.join(" ");
}

export function sanitizeSnippet(snippet, { maxChars = 1000 } = {}) {
  if (!snippet) return "";
  const text = String(snippet).replace(/\r/g, "");
  // Also treat common markdown bullet/quote chrome as paragraph breaks.
  const paras = text
    .split(/\n{1,}/)
    .map((p) => p.replace(/^>\s?/, "").replace(/^\s*[-*]\s+/, "").trim())
    .filter(Boolean)
    .map(sanitizeParagraph)
    .filter(Boolean);
  if (!paras.length) return "";
  const joined = paras.join(" ").replace(/\s{2,}/g, " ").trim();
  return joined.slice(0, maxChars);
}

/**
 * True if a source card is entirely injection / nonsense and should be dropped
 * (rather than shipped as-is to the model). We sanitize first, then decide.
 */
export function isInjectionOnlySource(source) {
  const snip = sanitizeSnippet(source?.snippet || "");
  const title = source?.title || "";
  // A card with a real title but an injection-only snippet is salvageable — the
  // title itself is rarely an instruction. Only drop if BOTH are injected/empty.
  const titleClean = sanitizeSnippet(title);
  return !snip && !titleClean;
}
