import type { EffortMap } from '../catalog';

/**
 * Claude's `thought_level` values for Spence's Effort levels. The adapter names them as Spence does; a level the
 * running Claude does not list is shown disabled.
 */
export const claudeEffort: EffortMap = { low: 'low', medium: 'medium', high: 'high', max: 'max' };
