import type { FlashcardsPlan, WikiPlan } from '../schemas/task-schemas.js';

export const FLASHCARD_CREATE_CAPABILITIES = [
  'namespace:rem.createTreeWithMarkdown',
  'namespace:rem.findOne',
  'namespace:richText.rem',
  'rem:addPowerup',
  'rem:addTag',
  'rem:getAliases',
  'rem:getCards',
  'rem:getChildrenRem',
  'rem:getParentRem',
  'rem:getTagRems',
  'rem:hasPowerup',
  'rem:isDocument',
  'rem:isFolder',
  'rem:setIsCardItem',
  'rem:setIsCollapsed',
  'rem:setText',
] as const;

export const FLASHCARD_PATCH_CAPABILITIES = [
  'namespace:rem.findOne',
  'namespace:richText.rem',
  'rem:getCards',
  'rem:setIsCardItem',
  'rem:setText',
] as const;

export const FLASHCARD_REUSE_CAPABILITIES = ['namespace:rem.findOne', 'rem:getCards'] as const;

export const WIKI_CREATE_CAPABILITIES = [
  'namespace:rem.createRem',
  'namespace:rem.findOne',
  'namespace:richText.rem',
  'rem:getAliases',
  'rem:getCards',
  'rem:getChildrenRem',
  'rem:getOrCreateAliasWithText',
  'rem:getParentRem',
  'rem:getTagRems',
  'rem:hasPowerup',
  'rem:isDocument',
  'rem:isFolder',
  'rem:setIsCollapsed',
  'rem:setParent',
  'rem:setText',
] as const;

export const WIKI_PATCH_CAPABILITIES = [
  'namespace:rem.findOne',
  'namespace:richText.rem',
  'rem:setText',
] as const;

export function requiredTaskCapabilities(
  kind: 'flashcards' | 'wiki',
  plan: FlashcardsPlan | WikiPlan
): readonly string[] {
  const required = new Set<string>();
  if (kind === 'flashcards') {
    const flashcards = plan as FlashcardsPlan;
    if (flashcards.newCards?.length)
      FLASHCARD_CREATE_CAPABILITIES.forEach((capability) => required.add(capability));
    if (flashcards.answerPatches?.length)
      FLASHCARD_PATCH_CAPABILITIES.forEach((capability) => required.add(capability));
    if (flashcards.reusedCardRemIds?.length)
      FLASHCARD_REUSE_CAPABILITIES.forEach((capability) => required.add(capability));
  } else {
    const wiki = plan as WikiPlan;
    if (wiki.pages.length)
      WIKI_CREATE_CAPABILITIES.forEach((capability) => required.add(capability));
    if (wiki.answerPatches?.length)
      WIKI_PATCH_CAPABILITIES.forEach((capability) => required.add(capability));
  }
  return [...required].sort();
}
