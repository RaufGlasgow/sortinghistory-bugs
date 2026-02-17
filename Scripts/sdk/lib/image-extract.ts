/**
 * Utility functions for extracting and stripping base64 images from text.
 *
 * Bug reports submitted via the SDK include screenshots as inline base64
 * data URIs in Markdown image syntax:
 *   ![Screenshot](data:image/png;base64,<data>)
 *
 * These need to be:
 * 1. Stripped from text prompts (so the model doesn't see raw base64 noise)
 * 2. Extracted as separate image content blocks (so multimodal models can see them)
 */

/** Supported image media types */
type ImageMediaType = `image/${"png" | "jpeg" | "gif" | "webp"}`;

/** Extracted image data ready for Claude API content blocks */
export interface ExtractedImage {
  mediaType: ImageMediaType;
  data: string;
}

/**
 * Regex pattern matching Markdown images with base64 data URIs.
 *
 * Matches: ![alt text](data:image/png;base64,ABCDef012+/=)
 * Groups:
 *   1: alt text
 *   2: image subtype (png, jpeg, gif, webp)
 *   3: base64 data (may contain whitespace from line wrapping)
 */
const BASE64_IMAGE_REGEX =
  /!\[([^\]]*)\]\(data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=\s]+)\)/g;

/**
 * Strip all base64 images from text, replacing them with a placeholder.
 *
 * This prevents sending huge base64 strings as raw text to the model,
 * which wastes tokens and provides no visual information.
 */
export function stripBase64Images(text: string): string {
  return text.replace(
    BASE64_IMAGE_REGEX,
    "[Screenshot attached - see image content block]",
  );
}

/**
 * Extract all base64 images from text.
 *
 * Returns an array of objects with mediaType and cleaned base64 data
 * (whitespace stripped from the data).
 */
export function extractBase64Images(text: string): ExtractedImage[] {
  const images: ExtractedImage[] = [];

  // Reset lastIndex since we reuse the global regex
  BASE64_IMAGE_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = BASE64_IMAGE_REGEX.exec(text)) !== null) {
    const imageSubtype = match[2] as "png" | "jpeg" | "gif" | "webp";
    // Strip any whitespace that may have been introduced by line wrapping
    const cleanData = match[3].replace(/\s/g, "");

    images.push({
      mediaType: `image/${imageSubtype}`,
      data: cleanData,
    });
  }

  return images;
}
