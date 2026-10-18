import type { ReactRNPlugin, RichTextInterface } from '@remnote/plugin-sdk';
import { sdkSafeRichText } from './sdk-rich-text.js';

/** Names must use the SDK's supported rich-text renderer, never lossy string filtering. */
export async function plainText(
  plugin: ReactRNPlugin,
  text: RichTextInterface | undefined
): Promise<string> {
  const rendered = await plugin.richText.toString(sdkSafeRichText(text));
  if (typeof rendered !== 'string')
    throw new Error('SDK rich-text rendering did not return a string');
  return rendered;
}
