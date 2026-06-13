/**
 * LLM-based proposition extraction and relationship classification.
 *
 * Ported from Python validate_extraction.py and graph.py's classify_relationships().
 * Uses the DeepSeek API directly (same prompts as Python version).
 */

// ── Proposition extraction ────────────────────────────────────────────

const EXTRACTION_PROMPT = `Extract atomic propositions from this text.

Each proposition must be:
- A single minimal claim, self-contained
- Stated as a proposition (true/false capable)
- Free of source references ("Claude said", "we discussed")
- As small as possible without losing meaning

Return one proposition per line, nothing else.
No numbering, no bullets, no commentary.`;

/**
 * Extract atomic propositions from arbitrary text.
 * Splits long text into chunks at paragraph boundaries.
 */
export async function extractPropositions(
  text: string,
  model: string,
  apiCall: (model: string, messages: any[], maxTokens?: number) => Promise<string>,
  maxChunkChars: number = 3000,
): Promise<string[]> {
  // Split long text into chunks at paragraph boundaries
  const chunks: string[] = [];
  if (text.length > maxChunkChars) {
    const paragraphs = text.split("\n\n");
    let current = "";
    for (const para of paragraphs) {
      if (current.length + para.length < maxChunkChars) {
        current = current ? current + "\n\n" + para : para;
      } else {
        if (current) chunks.push(current.trim());
        current = para;
      }
    }
    if (current) chunks.push(current.trim());
  } else {
    chunks.push(text);
  }

  const allProps: string[] = [];
  const seen = new Set<string>();

  for (const chunk of chunks) {
    const prompt = `${EXTRACTION_PROMPT}\n\nText:\n${chunk}`;
    const raw = await apiCall(model, [{ role: "user", content: prompt }], 4000);

    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        allProps.push(trimmed);
      }
    }
  }

  return allProps;
}

// ── Relationship classification ───────────────────────────────────────

export interface Candidate {
  id: number;
  text: string;
  similarity: number;
  weight: number;
}

const RELATIONSHIP_PROMPT_PREFIX = `Classify relationships between these propositions.

For each candidate, choose ONE type:
supports | contradicts | instantiates | analogizes | questions | relates | none

Return: NUMBER: type (one per line)
Example:
1: supports
2: none`;

/**
 * Classify relationships between a source proposition and each candidate.
 * Batch all candidates into a single API call for efficiency.
 */
export async function classifyRelationships(
  sourceText: string,
  candidates: Candidate[],
  model: string,
  apiCall: (model: string, messages: any[], maxTokens?: number) => Promise<string>,
): Promise<Record<number, string>> {
  if (candidates.length === 0) return {};

  const candidateList = candidates
    .map((c, i) => `${i + 1}. ${c.text}`)
    .join("\n");

  const prompt =
    `${RELATIONSHIP_PROMPT_PREFIX}\n\n` +
    `Source: "${sourceText}"\n\n` +
    `Candidates:\n${candidateList}`;

  const raw = await apiCall(model, [{ role: "user", content: prompt }], 4000);

  // Parse response: "1: supports", "2: none", etc.
  const result: Record<number, string> = {};
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    try {
      const idx = parseInt(trimmed.substring(0, colonIdx).trim(), 10) - 1; // 1-based → 0-based
      const relType = trimmed.substring(colonIdx + 1).trim().toLowerCase();

      if (idx >= 0 && idx < candidates.length) {
        if (relType === "relates" || relType === "none") {
          if (relType === "relates") {
            result[candidates[idx].id] = "relates";
          }
          // "none" → don't add
        } else {
          // One of: supports, contradicts, instantiates, analogizes, questions
          result[candidates[idx].id] = relType;
        }
      }
    } catch {
      // Parse error, skip this line
    }
  }

  return result;
}
