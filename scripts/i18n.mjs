// Spanish translations for the renderer (src/locale/messages.es.xlf).
//
//   node scripts/i18n.mjs merge   extract the English messages and merge them into messages.es.xlf:
//                                 existing translations stay, new messages are copied in English and
//                                 flagged state="new", messages gone from the source are dropped
//   node scripts/i18n.mjs check   fail if a message has no Spanish translation yet (the `i18n` verify step)
//
// Both run `ng extract-i18n` into a temporary folder, so the English source file is never committed.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkTranslations, mergeTranslations } from './i18n/xliff.mjs';

const SPANISH = 'src/locale/messages.es.xlf';
const command = process.argv[2];

if (command !== 'merge' && command !== 'check') {
  console.error('Usage: node scripts/i18n.mjs merge|check');
  process.exit(2);
}

/** Runs `ng extract-i18n` and returns the XLIFF it wrote. */
const extract = () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'spence-i18n-'));
  try {
    const run = spawnSync(`npx ng extract-i18n --output-path "${dir}"`, {
      shell: true,
      encoding: 'utf8',
    });
    if (run.status !== 0) {
      console.error(`${run.stdout ?? ''}${run.stderr ?? ''}`.trimEnd());
      console.error('i18n: ng extract-i18n failed');
      process.exit(1);
    }
    return readFileSync(path.join(dir, 'messages.xlf'), 'utf8');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

const extracted = extract();
const spanish = existsSync(SPANISH) ? readFileSync(SPANISH, 'utf8') : undefined;

if (command === 'merge') {
  const { xml, added, removed } = mergeTranslations(extracted, spanish);
  writeFileSync(SPANISH, xml);
  console.log(`i18n: ${SPANISH} updated (${added.length} new, ${removed.length} removed)`);
  if (added.length > 0) {
    console.log(`Translate the units marked state="new": ${added.join(', ')}`);
  }
  process.exit(0);
}

const { missing, untranslated, obsolete } = checkTranslations(extracted, spanish ?? '');
const problems = [
  [missing, 'have no Spanish translation'],
  [untranslated, 'are still marked state="new" (translate them and remove the state)'],
  [obsolete, 'are no longer in the source'],
].filter(([ids]) => ids.length > 0);

for (const [ids, what] of problems)
  console.error(`i18n: ${ids.length} message(s) ${what}: ${ids.join(', ')}`);
if (problems.length > 0) {
  console.error(`Run \`npm run i18n:merge\`, then translate the new units in ${SPANISH}.`);
  process.exit(1);
}
console.log('i18n: every message has a Spanish translation');
