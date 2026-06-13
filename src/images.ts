/**
 * Image resolution for @img:<path> references.
 *
 * Scans prompt text for `@img:<path>` references, reads each image
 * file, encodes as base64, and returns the cleaned text along with
 * image payloads ready for Anthropic vision API calls.
 *
 * DeepSeek does not support vision — @img: references on non-Anthropic
 * models are left as-is in the text (the model will see the literal
 * `@img:screenshot.png` string and may note it can't process images).
 */

import { promises as fsp } from "node:fs";
import * as path from "node:path";

export interface ImageBlock {
  media_type: string;
  data: string; // base64-encoded
}

export interface ImageResult {
  text: string;     // cleaned of @img: references
  images: ImageBlock[];
}

const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

/** 5 MB cap — Anthropic's image size limit. */
const MAX_IMAGE_BYTES = 5_242_880;

/**
 * Scan `text` for `@img:<path>` references, read each image file,
 * base64-encode, and return cleaned text + image payloads.
 *
 * Unknown extensions or unreadable files are left as-is (so the
 * model sees the literal `@img:missing.png` text).
 */
export async function resolveAtImages(
  text: string,
  cwd: string,
): Promise<ImageResult> {
  const re = /(?:^|\s)@img:(\S+)/g;
  const refs: { raw: string; targetPath: string }[] = [];
  for (const m of text.matchAll(re)) {
    refs.push({ raw: m[1], targetPath: m[1] });
  }
  if (refs.length === 0) return { text, images: [] };

  const images: ImageBlock[] = [];
  let clean = text;

  for (const ref of refs) {
    try {
      const abs = path.resolve(cwd, ref.targetPath);
      const ext = path.extname(ref.targetPath).toLowerCase();
      const mime = MIME_BY_EXT[ext];
      if (!mime) continue;

      const buf = await fsp.readFile(abs);
      if (buf.length > MAX_IMAGE_BYTES) continue;

      const data = buf.toString("base64");
      images.push({ media_type: mime, data });

      // Remove the @img:... reference from text
      const escaped = ref.raw.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      clean = clean.replace(new RegExp(`@img:${escaped}`, "g"), "");
    } catch {
      // File not found — leave reference as-is
    }
  }

  clean = clean.trim().replace(/\s+/g, " ");
  return { text: clean, images };
}

/**
 * Combine @file resolution results with @img resolution.
 * Call after resolveAtFiles to attach images to the resolved prompt.
 */
export function attachImages(
  enhancedText: string,
  originalText: string,
  images: ImageBlock[],
): { content: string; images?: ImageBlock[] } {
  if (images.length === 0) return { content: enhancedText };
  return { content: enhancedText, images };
}
