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
 * Strip all base64 images from text, replacing them with a placeholder.
 *
 * This prevents sending huge base64 strings as raw text to the model,
 * which wastes tokens and provides no visual information.
 */
export declare function stripBase64Images(text: string): string;
/**
 * Extract all base64 images from text.
 *
 * Returns an array of objects with mediaType and cleaned base64 data
 * (whitespace stripped from the data).
 */
export declare function extractBase64Images(text: string): ExtractedImage[];
export {};
