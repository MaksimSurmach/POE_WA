import { z } from 'zod';

import {
  canonicalCraftMethodSchema,
  canonicalStartingModSchema,
} from './craftMethod.js';
import { canonicalItemSpecSchema } from './item.js';
import { canonicalTargetSpecSchema } from './target.js';

export const canonicalCraftSetupSchema = z.strictObject({
  base: canonicalItemSpecSchema,
  gameDataVersion: z.string().trim().min(1),
  method: canonicalCraftMethodSchema,
  startingMods: z.array(canonicalStartingModSchema).default([]),
  target: canonicalTargetSpecSchema,
});

export type CanonicalCraftSetup = z.output<typeof canonicalCraftSetupSchema>;

export type ResolutionDiagnostic = {
  code: string;
  entityId?: string;
  message: string;
  path: readonly (string | number)[];
  severity: 'error' | 'warning';
};

export type ResolutionResult<T> =
  | { diagnostics: readonly ResolutionDiagnostic[]; ok: false }
  | { diagnostics: readonly ResolutionDiagnostic[]; ok: true; value: T };
