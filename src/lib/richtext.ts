import { RNPlugin, RichTextInterface } from '@remnote/plugin-sdk';

/**
 * Converts a RemNote RichTextInterface into a plain-text string, truncated
 * for display in tables/lists. `plugin.richText.toString()` is the only
 * officially supported way to flatten rich text (it correctly handles bold,
 * references, LaTeX, etc. by falling back to their textual representation).
 */
export async function richTextToPlain(
  plugin: RNPlugin,
  richText: RichTextInterface | undefined,
  maxLength = 140
): Promise<string> {
  if (!richText) return '';
  try {
    const str = await plugin.richText.toString(richText);
    if (!str) return '';
    return str.length > maxLength ? str.slice(0, maxLength - 1) + '\u2026' : str;
  } catch {
    return '';
  }
}
