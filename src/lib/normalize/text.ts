/**
 * Deterministic text normalization and candidate-topic extraction.
 * Everything here is pure and side-effect free so it can be unit tested.
 */

const STOPWORDS = new Set(
  `a an and are as at be been being but by can could did do does doing for from had has have having he her here hers him his how i if in into is it its
  just me more most my no nor not now of off on once only or other our ours out over own same she should so some such than that the their theirs them
  then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your
  yours vs via about after again against all am any because before below between both down during each few further let lets get got gets going go
  new latest top best worst ever never really actually every why how what's whats i'm im you're youre it's dont don't can't cant won't wont isn't isnt
  one two three four five six seven eight nine ten first last next day days week weeks month months year years today tonight tomorrow yesterday
  2023 2024 2025 2026 2027 also still even much many make makes made making way ways thing things people time times part full video videos episode
  podcast live watch official shorts short reddit thread post comment comments help question questions advice anyone anybody someone think thoughts
  need needs want wants like look looking feel feels know knows say says said tell told use used using try trying work works good bad big small
  truth worth talking everyone everybody nobody mean means meaning tried honest inside behind rise rising fall future secret secrets mistake mistakes
  hype real changing change changes matter matters wrong right happening happened happens thing nothing something anything start started
  starting quit quitting stop stopped win winning wins lose losing lost here's heres there's theres what's breaking watching watch
  avoid avoiding must should`
    .split(/\s+/)
    .filter(Boolean),
);

/**
 * Generic business words that are too broad to be a topic on their own.
 * They may still appear inside a longer phrase ("small business taxes").
 */
const GENERIC_SINGLE = new Set(
  `business businesses money company companies startup startups founder founders market markets brand brands growth strategy marketing tech technology
  ai news update updates income job jobs career careers sales customer customers product products service services industry entrepreneur entrepreneurs
  entrepreneurship invest investing investment stock stocks finance financial economy economic ceo team world us usa america american report reports
  data deal deals plan plans idea ideas tips tip guide lesson lessons story stories life success rich wealth million billion trillion dollar dollars`
    .split(/\s+/)
    .filter(Boolean),
);

/** Words that describe coverage of a topic rather than the topic itself; stripped from canonical keys. */
const MODIFIERS = new Set(
  `news update updates explained explainer breakdown analysis review reviews reaction announcement announced announces launch launches launched
  launching release released rumor rumors leak leaks drama controversy deep dive why how guide tutorial tips report reports reported`
    .split(/\s+/)
    .filter(Boolean),
);

/** Common spelling variants folded before keying. */
const ALIAS_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\btik[\s-]?tok\b/g, "tiktok"],
  [/\bgen[\s-]?z(ers)?\b/g, "gen z"],
  [/\bchat[\s-]?gpt\b/g, "chatgpt"],
  [/\bopen[\s-]?ai\b/g, "openai"],
  [/\bsaa?s\b/g, "saas"],
  [/\be[\s-]?commerce\b/g, "ecommerce"],
  [/\bart(ificial)? intelligence\b/g, "ai"],
  [/\ba\.i\.?/g, "ai"],
  [/\b4[\s-]?day\b/g, "four day"],
  [/\bu\.s\.?\b/g, "us"],
];

export function stripDiacritics(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

/** Lowercase, unify punctuation and whitespace, fold common aliases. */
export function normalizeText(s: string): string {
  let t = stripDiacritics(s).toLowerCase();
  t = t.replace(/[‘’“”]/g, "'").replace(/&amp;/g, "&");
  for (const [re, rep] of ALIAS_REPLACEMENTS) t = t.replace(re, rep);
  t = t.replace(/[^a-z0-9$%'\s-]/g, " ").replace(/'s\b/g, "").replace(/'/g, "");
  t = t.replace(/-/g, " ");
  return t.replace(/\s+/g, " ").trim();
}

/** Very small English singularizer, enough to fold "side hustles" -> "side hustle". */
/** Words whose plural and singular are the same (or that only look plural). */
const INVARIANT = new Set(["series", "species", "news", "means", "headquarters", "sales", "analytics", "economics", "politics", "ethics", "logistics", "graphics", "physics"]);

export function singularize(word: string): string {
  if (word.length <= 3 || INVARIANT.has(word)) return word;
  if (/(ss|us|is|ics|sis)$/.test(word)) return word;
  if (word.endsWith("sses")) return word.slice(0, -2);
  if (word.endsWith("ies") && word.length > 4) return word.slice(0, -3) + "y";
  if (/(ches|shes|xes|zes)$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s")) return word.slice(0, -1);
  return word;
}

/** The grouping key for a phrase: normalized, singularized, modifiers removed. */
export function canonicalKey(phrase: string): string {
  const tokens = normalizeText(phrase)
    .split(" ")
    .filter((t) => t && !MODIFIERS.has(t))
    .map(singularize);
  return tokens.join(" ");
}

export function slugify(s: string): string {
  return canonicalKey(s).replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 80) || "topic";
}

export function tokenSet(s: string): Set<string> {
  return new Set(canonicalKey(s).split(" ").filter(Boolean));
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/** Amounts and bare numbers ("$100", "1b", "000", "30%") are never topics on their own. */
const NUMERIC_TOKEN = /^\$?\d[\d.,]*(k|m|b|bn|x|%)?$/;

/** Whether a canonical key may become a topic (shared by extraction and the cleanup pass). */
export function isValidTopicKey(key: string): boolean {
  if (!key) return false;
  const toks = key.split(" ").filter(Boolean);
  if (toks.length === 0) return false;
  // A phrase may contain an amount ("Series A $5m round") but not start or end with one ("led by $1b").
  if (toks[0].startsWith("$") || toks[toks.length - 1].startsWith("$")) return false;
  if (toks.length === 1 && (GENERIC_SINGLE.has(toks[0]) || STOPWORDS.has(toks[0]) || toks[0].length < 3)) return false;
  if (toks.every((t) => STOPWORDS.has(t) || GENERIC_SINGLE.has(t) || NUMERIC_TOKEN.test(t))) return false;
  return true;
}

export interface Candidate {
  /** Display form (original casing from the first occurrence). */
  phrase: string;
  key: string;
  /** Proper-noun sequences get a boost; plain n-grams need more support. */
  kind: "entity" | "ngram";
}

function isContentToken(t: string): boolean {
  return t.length > 1 && !STOPWORDS.has(t) && !/^\d+$/.test(t);
}

/**
 * Extracts candidate topic phrases from a title/description.
 * - Capitalized sequences ("Apple Vision Pro", "TikTok Shop") are entity candidates.
 * - Content-word n-grams (1-3 tokens) are generic candidates.
 * Single generic words ("business", "money") are dropped.
 */
export function extractCandidates(text: string, maxNgram = 3): Candidate[] {
  const out = new Map<string, Candidate>();
  const add = (phrase: string, kind: Candidate["kind"]) => {
    const key = canonicalKey(phrase);
    if (!isValidTopicKey(key)) return;
    const existing = out.get(key);
    if (!existing || (existing.kind === "ngram" && kind === "entity")) out.set(key, { phrase: phrase.trim(), key, kind });
  };

  // Entity pass on the raw text, split at sentence-ish punctuation.
  const raw = stripDiacritics(text).replace(/[‘’]/g, "'");
  for (const segment of raw.split(/[.!?:;|()[\]{}"“”,–—]+|\s-\s/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    // Title Case / ALL CAPS headlines capitalize every word, so capitalization says nothing
    // about entities there. Skip the entity pass and rely on n-grams + curated aliases.
    const capitalized = words.filter((w) => /^[A-Z0-9$]/.test(w)).length;
    if (words.length >= 4 && capitalized / words.length > 0.6) continue;
    let run: string[] = [];
    let runStart = 0;
    const flush = () => {
      // Drop leading/trailing stopwords inside the run ("The Rise Of TikTok Shop" -> "TikTok Shop" candidates via n-grams).
      while (run.length && STOPWORDS.has(normalizeText(run[0]))) run.shift();
      while (run.length && STOPWORDS.has(normalizeText(run[run.length - 1]))) run.pop();
      if (run.length >= 1 && run.length <= 4) {
        const joined = run.join(" ");
        // A capitalized word at the start of a segment is just sentence case; mid-sentence it is a
        // proper noun ("... like Nvidia"). Internal capitals or digits ("OpenAI", "GPT5") always count.
        if (run.length > 1 || runStart > 0 || /[A-Z].*[A-Z]|\d/.test(run[0])) add(joined, "entity");
      }
      run = [];
    };
    words.forEach((w, i) => {
      const clean = w.replace(/^[^A-Za-z0-9$]+|[^A-Za-z0-9%]+$/g, "");
      if (clean && /^[A-Z0-9$]/.test(clean)) {
        if (run.length === 0) runStart = i;
        run.push(clean);
      } else {
        flush();
      }
    });
    flush();
  }

  // N-gram pass on normalized text.
  const norm = normalizeText(text).split(" ").filter(Boolean);
  for (let n = 1; n <= maxNgram; n++) {
    for (let i = 0; i + n <= norm.length; i++) {
      const gram = norm.slice(i, i + n);
      if (!isContentToken(gram[0]) || !isContentToken(gram[gram.length - 1])) continue;
      if (gram.some((t) => /^\d+$/.test(t) && n === 1)) continue;
      add(gram.join(" "), "ngram");
    }
  }
  return [...out.values()];
}

// ---------- URL + story fingerprinting (dedupe) ----------

const TRACKING_PARAMS = /^(utm_|fbclid|gclid|mc_|ref$|ref_src|igshid|si$|feature$|share|cmpid|ocid|taid|smid|cid$|guccounter)/i;

/** Canonical form of a URL for duplicate detection: https, no www, no tracking params, no fragment, no trailing slash. */
export function canonicalizeUrl(input: string): string {
  try {
    const u = new URL(input);
    u.protocol = "https:";
    u.hostname = u.hostname.replace(/^(www|m|amp|mobile)\./, "");
    u.hash = "";
    const keep = new URLSearchParams();
    const sorted = [...u.searchParams.entries()].filter(([k]) => !TRACKING_PARAMS.test(k)).sort(([a], [b]) => a.localeCompare(b));
    for (const [k, v] of sorted) keep.append(k, v);
    // YouTube: only the video id matters.
    if (u.hostname === "youtu.be") return `https://youtube.com/watch?v=${u.pathname.slice(1)}`;
    if (u.hostname.endsWith("youtube.com") && u.searchParams.get("v")) return `https://youtube.com/watch?v=${u.searchParams.get("v")}`;
    let p = u.pathname.replace(/\/amp\/?$/, "/").replace(/\/+$/, "");
    if (!p) p = "";
    const q = keep.toString();
    return `https://${u.hostname}${p}${q ? `?${q}` : ""}`;
  } catch {
    return input.trim();
  }
}

/**
 * Title fingerprint used to recognise syndicated / copied stories.
 * Wire copies usually share the headline but differ in outlet suffixes and punctuation.
 */
export function titleFingerprint(title: string): string {
  const t = normalizeText(title.replace(/\s[-|–—]\s[^-|–—]{2,40}$/, "")); // drop " - Outlet Name"
  const toks = t.split(" ").filter((x) => isContentToken(x)).map(singularize);
  return [...new Set(toks)].sort().join(" ");
}

/** Similarity of two fingerprints (token Jaccard). */
export function fingerprintSimilarity(a: string, b: string): number {
  return jaccard(new Set(a.split(" ").filter(Boolean)), new Set(b.split(" ").filter(Boolean)));
}

/** Context check for ambiguous aliases (see config/topics.json requireContext). */
export function hasContext(text: string, contextWords: string[] | undefined): boolean {
  if (!contextWords || contextWords.length === 0) return true;
  const norm = ` ${normalizeText(text)} `;
  return contextWords.some((w) => norm.includes(` ${normalizeText(w)} `));
}

/**
 * Recovers how a normalized phrase is usually written in the source titles
 * ("creator led brand" -> "creator-led brands"), for display names.
 */
export function surfaceForm(phrase: string, texts: string[]): string {
  const toks = normalizeText(phrase).split(" ").filter(Boolean);
  if (toks.length === 0) return phrase;
  const pattern = new RegExp(`\\b${toks.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[\\s\\-]+")}(e?s)?\\b`, "i");
  const counts = new Map<string, number>();
  for (const t of texts) {
    const m = stripDiacritics(t).match(pattern);
    if (m) counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
  }
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0];
  if (!best) return phrase;
  // Keep brand casing ("TikTok"), otherwise sentence case.
  return /[A-Z]/.test(best.slice(1)) ? best : best.charAt(0).toUpperCase() + best.slice(1).toLowerCase();
}

export const _internals = { STOPWORDS, GENERIC_SINGLE, MODIFIERS };
