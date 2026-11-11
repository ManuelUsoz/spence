// Keeps `src/locale/messages.es.xlf` in step with what `ng extract-i18n` finds in the source.
//
// Angular writes only the English source file and ships no merge (docs/research/angular-i18n.md §6).
// These pure functions do that merge and the check behind the `i18n` verify step; `i18n.mjs` runs them.
// XLIFF 1.2 as written by Angular is regular enough to handle with patterns: no XML dependency.

/** @typedef {{ id: string, open: string, source: string, target: string | undefined, notes: string[] }} Unit */

const UNIT = /^([ \t]*)<trans-unit\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/trans-unit>/gm;
const SOURCE = /<source>[\s\S]*?<\/source>/;
const TARGET = /<target\b[^>]*>[\s\S]*?<\/target>|<target\b[^>]*\/>/;
const NOTE = /<note\b[^>]*>[\s\S]*?<\/note>/g;

/**
 * @param {string} xml
 * @returns {Unit[]}
 */
const parseUnits = (xml) =>
  [...xml.matchAll(UNIT)].map(([whole, , id = '', body = '']) => ({
    id,
    open: (whole.match(/<trans-unit\b[^>]*>/) ?? [''])[0],
    source: (body.match(SOURCE) ?? ['<source></source>'])[0],
    target: body.match(TARGET)?.[0],
    notes: body.match(NOTE) ?? [],
  }));

/** @param {string} source */
const newTarget = (source) =>
  source.replace(/^<source>/, '<target state="new">').replace(/<\/source>$/, '</target>');

/** @param {Unit} unit @param {string} target */
const renderUnit = (unit, target) =>
  [
    `      ${unit.open}`,
    `        ${unit.source}`,
    `        ${target}`,
    ...unit.notes.map((note) => `        ${note}`),
    '      </trans-unit>',
  ].join('\n');

/**
 * Merges the freshly extracted English messages into the Spanish file.
 * Every extracted message is kept in extraction order: its existing translation if there is one,
 * else a copy of the English text flagged `state="new"`. Messages no longer in the source are dropped.
 * Source locations are left out, so the file changes only when messages do.
 *
 * @param {string} extractedXml what `ng extract-i18n` wrote
 * @param {string | undefined} existingXml the current `messages.es.xlf`, if any
 * @returns {{ xml: string, added: string[], removed: string[] }}
 */
export const mergeTranslations = (extractedXml, existingXml) => {
  const existing = new Map(parseUnits(existingXml ?? '').map((unit) => [unit.id, unit]));
  const units = parseUnits(extractedXml);
  const added = units.filter((unit) => !existing.get(unit.id)?.target).map((unit) => unit.id);
  const body = units
    .map((unit) => renderUnit(unit, existing.get(unit.id)?.target ?? newTarget(unit.source)))
    .join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8" ?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
  <file source-language="en" target-language="es" datatype="plaintext" original="ng2.template">
    <body>
${body}
    </body>
  </file>
</xliff>
`;
  const current = new Set(units.map((unit) => unit.id));
  const removed = [...existing.keys()].filter((id) => !current.has(id));
  return { xml, added, removed };
};

/**
 * What stands between the Spanish file and a clean build: messages with no Spanish target (`missing`,
 * the build fails on these), targets the merge flagged `state="new"` and nobody translated yet
 * (`untranslated`), and Spanish units the source no longer has (`obsolete`).
 *
 * @param {string} extractedXml what `ng extract-i18n` wrote
 * @param {string} existingXml the current `messages.es.xlf`
 * @returns {{ missing: string[], untranslated: string[], obsolete: string[] }}
 */
export const checkTranslations = (extractedXml, existingXml) => {
  const existing = new Map(parseUnits(existingXml).map((unit) => [unit.id, unit]));
  const units = parseUnits(extractedXml);
  const current = new Set(units.map((unit) => unit.id));
  const targetOf = (/** @type {Unit} */ unit) => existing.get(unit.id)?.target;
  return {
    missing: units.filter((unit) => !targetOf(unit)).map((unit) => unit.id),
    untranslated: units
      .filter((unit) => /^<target\b[^>]*\bstate="new"/.test(targetOf(unit) ?? ''))
      .map((unit) => unit.id),
    obsolete: [...existing.keys()].filter((id) => !current.has(id)),
  };
};
