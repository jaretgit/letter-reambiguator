/**
 * POST /api/paraphrase
 * Body: { letter: string, tone: string, personalization?: string }
 * Returns: { text: string } | { error: string }
 *
 * Rewrites a campaign/boilerplate letter so it keeps its core ask and
 * factual claims but not its exact wording or structure — so a legislative
 * office reading a hundred submissions on the same topic can't just
 * pattern-match them all to one template and skim past them.
 *
 * This function is the ONLY thing that holds the Anthropic API key. Set
 * ANTHROPIC_API_KEY as a Vercel environment variable (Project Settings →
 * Environment Variables) — never put it in the frontend.
 *
 * Two lightweight abuse guards, since this is a public URL hitting a paid
 * API:
 *   1. A capped max_tokens per request.
 *   2. A per-IP rate limit, held in memory.
 * The rate limit resets whenever the serverless instance cold-starts, so
 * it's a soft guard, not a hard one — fine for "stop a runaway script,"
 * not sufficient on its own if this ever gets popular. If usage grows,
 * swap RATE_LIMIT's in-memory Map for Vercel KV or Upstash Redis so the
 * count is shared across instances.
 */

const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const RATE_LIMIT_MAX_REQUESTS = 8;           // per IP, per window
const MAX_LETTER_CHARS = 6000;
const MAX_PERSONALIZATION_CHARS = 500;
const MODEL = "claude-haiku-4-5-20251001";
const MAX_TOKENS = 900;

// In-memory store: ip -> array of request timestamps (ms).
// Lives only as long as this serverless instance does.
const requestLog = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const timestamps = (requestLog.get(ip) || []).filter(
    (t) => now - t < RATE_LIMIT_WINDOW_MS
  );
  timestamps.push(now);
  requestLog.set(ip, timestamps);
  return timestamps.length > RATE_LIMIT_MAX_REQUESTS;
}

const TONE_GUIDANCE = {
  formal: "Formal and professional. Measured, respectful, precise language — the register of a constituent writing to a government office, not a friend.",
  passionate: "Passionate and urgent. Convey genuine concern and stakes without becoming hostile, insulting, or making threats.",
  personal: "Personal and story-based. Grounded in lived experience and specific, concrete detail rather than abstract policy language.",
  concise: "Concise and direct. Short sentences, no throat-clearing, gets to the ask quickly. Still complete and polite.",
  skeptical: "Skeptical and questioning. Raises pointed questions about the policy or decision rather than making flat statements — while remaining civil.",
};

module.exports = async (req, res) => {
  // CORS: only meaningful if this function is deployed on a different
  // origin than the frontend. Same-origin deployments (the normal case
  // on Vercel) don't need this at all — the browser won't send a
  // cross-origin request in the first place.
  const allowedOrigin = process.env.ALLOWED_ORIGIN;
  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  if (req.method !== "POST") {
    res.status(405).json({ error: "Use POST." });
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: "Server isn't configured with an API key yet." });
    return;
  }

  const ip =
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "unknown";

  if (isRateLimited(ip)) {
    res.status(429).json({ error: "Too many requests from this connection — try again in a bit." });
    return;
  }

  const { letter, tone, personalization } = req.body || {};

  if (!letter || typeof letter !== "string" || !letter.trim()) {
    res.status(400).json({ error: "Paste the letter you want rewritten." });
    return;
  }
  if (letter.length > MAX_LETTER_CHARS) {
    res.status(400).json({ error: `That letter is too long (max ${MAX_LETTER_CHARS} characters).` });
    return;
  }
  if (personalization && personalization.length > MAX_PERSONALIZATION_CHARS) {
    res.status(400).json({ error: `Personalization note is too long (max ${MAX_PERSONALIZATION_CHARS} characters).` });
    return;
  }
  const toneKey = typeof tone === "string" ? tone.toLowerCase() : "";
  const toneInstruction = TONE_GUIDANCE[toneKey];
  if (!toneInstruction) {
    res.status(400).json({ error: "Pick a valid tone." });
    return;
  }

  const systemPrompt = `You help a constituent turn a campaign or advocacy group's template letter into their own personal message to a government representative, for a legitimate individual letter-writing campaign.

Rules:
- Preserve the core ask (what the sender wants the recipient to do) and every factual claim in the original. Do not add, drop, or alter facts, numbers, dates, or claims.
- Do not preserve the original's sentence structure, paragraph order, phrasing, or word choice. Rewrite it from scratch in different words and structure so it reads as an independent, individually-written letter rather than a copy of a template.
- Write in the requested tone: ${toneInstruction}
- If the sender gave a personalization note, naturally weave it in as something that sounds like it comes from them personally — don't bolt it on as an unrelated final sentence.
- Write only the letter body itself. No greeting boilerplate like "Dear [Name]" unless the original had one worth keeping in spirit, no subject line, no meta-commentary, no markdown formatting, no explanation of what you changed.
- Keep it roughly the same length as the original (within about 30%).
- Never fabricate specific personal details (a name, address, job, or story) that weren't in the original letter or the personalization note.`;

  const userPrompt = `Original template letter:
"""
${letter.trim()}
"""

Personalization note from the sender (may be empty): ${personalization ? personalization.trim() : "(none provided)"}

Rewrite this as described.`;

  try {
    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        temperature: 1,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!apiRes.ok) {
      const errBody = await apiRes.text();
      console.error("Anthropic API error:", apiRes.status, errBody);
      res.status(502).json({ error: "The paraphraser is temporarily unavailable — try again shortly." });
      return;
    }

    const data = await apiRes.json();
    const text = (data.content || [])
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    if (!text) {
      res.status(502).json({ error: "Got an empty response — try again." });
      return;
    }

    res.status(200).json({ text });
  } catch (err) {
    console.error("Paraphrase function error:", err);
    res.status(500).json({ error: "Something went wrong generating the letter — try again shortly." });
  }
};
