import type { FlashcardsPlan } from '../schemas/task-schemas.js';

export const FLASHCARD_CREATE_CAPABILITIES = [
  'namespace:rem.createTreeWithMarkdown',
  'namespace:rem.findOne',
  'namespace:rem.findMany',
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

export function requiredTaskCapabilities(plan: FlashcardsPlan): readonly string[] {
  const required = new Set<string>();
  if (plan.newCards?.length)
    FLASHCARD_CREATE_CAPABILITIES.forEach((capability) => required.add(capability));
  if (plan.answerPatches?.length)
    FLASHCARD_PATCH_CAPABILITIES.forEach((capability) => required.add(capability));
  if (plan.reusedCardRemIds?.length)
    FLASHCARD_REUSE_CAPABILITIES.forEach((capability) => required.add(capability));
  return [...required].sort();
}
