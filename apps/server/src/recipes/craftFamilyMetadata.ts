import type { CraftFamily } from '@poe-worksmith/domain';

// Read metadata separately: adding taxonomy must not invalidate saved recipe hashes/history.
export const recipeStageFamilies: Readonly<Record<string, CraftFamily[]>> = {
  'minion-bone-helmet-greed': ['bench'],
  'minion-convoking-wand-fear-trigger': ['bench'],
  'rf-fire-trap-any-support': ['bench'],
  'rf-fire-trap-level-20': ['bench'],
  'minion-fossilised-shield-greed': ['bench'],
};
