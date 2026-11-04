// Vergleiche mit der PHP-Referenz: PHP kannte nur die ersten 30 Designs. Die Designs für Winter und Weihnachten
// (Gruppe „seasonal“, seit 3.3) gibt es nur in Node – sie werden in den Vergleichen ausgelassen und in eigenen Tests
// geprüft (test/themes-seasonal.test.ts).
import { themes, type Theme } from '../../src/content/themes.js';

export const phpThemes = (): Record<string, Theme> =>
  Object.fromEntries(Object.entries(themes()).filter(([, t]) => t.group !== 'seasonal'));

export const phpThemeKeys = (): string[] => Object.keys(phpThemes());

export const seasonalThemeKeys = (): string[] => Object.entries(themes()).filter(([, t]) => t.group === 'seasonal').map(([k]) => k);
