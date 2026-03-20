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
/**
 * Detect actual image format from base64 data header bytes.
 *
 * The app's webhook hardcodes `data:image/png;base64,` for all screenshots
 * regardless of actual format, so we must detect from the data itself.
 *
 * Magic byte signatures (base64-encoded):
 * - JPEG: starts with /9j/ (FF D8 FF)
 * - PNG:  starts with iVBOR (89 50 4E 47)
 * - GIF:  starts with R0lG (47 49 46)
 * - WebP: starts with UklG (52 49 46 46) + WEBP at offset 8
 */
function detectMediaType(base64Data, declaredType) {
    if (base64Data.startsWith("/9j/"))
        return "image/jpeg";
    if (base64Data.startsWith("iVBOR"))
        return "image/png";
    if (base64Data.startsWith("R0lG"))
        return "image/gif";
    if (base64Data.startsWith("UklG"))
        return "image/webp";
    // Fall back to declared type if detection fails
    return `image/${declaredType}`;
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
const BASE64_IMAGE_REGEX = /!\[([^\]]*)\]\(data:image\/(png|jpeg|gif|webp);base64,([A-Za-z0-9+/=\s]+)\)/g;
/**
 * Strip all base64 images from text, replacing them with a placeholder.
 *
 * This prevents sending huge base64 strings as raw text to the model,
 * which wastes tokens and provides no visual information.
 */
export function stripBase64Images(text) {
    return text.replace(BASE64_IMAGE_REGEX, "[Screenshot attached - see image content block]");
}
/**
 * Extract all base64 images from text.
 *
 * Returns an array of objects with mediaType and cleaned base64 data
 * (whitespace stripped from the data).
 */
export function extractBase64Images(text) {
    const images = [];
    // Reset lastIndex since we reuse the global regex
    BASE64_IMAGE_REGEX.lastIndex = 0;
    let match;
    while ((match = BASE64_IMAGE_REGEX.exec(text)) !== null) {
        const declaredSubtype = match[2];
        // Strip any whitespace that may have been introduced by line wrapping
        const cleanData = match[3].replace(/\s/g, "");
        // Detect actual format from data bytes (app may declare wrong type)
        const mediaType = detectMediaType(cleanData, declaredSubtype);
        images.push({
            mediaType,
            data: cleanData,
        });
    }
    return images;
}
