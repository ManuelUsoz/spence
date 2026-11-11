import { describe, expect, it } from 'vitest';
import { checkTranslations, mergeTranslations } from './xliff.mjs';

/** What `ng extract-i18n` writes (XLIFF 1.2), trimmed to the parts that matter. */
const extracted = (units) => `<?xml version="1.0" encoding="UTF-8" ?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
  <file source-language="en" datatype="plaintext" original="ng2.template">
    <body>
${units}
    </body>
  </file>
</xliff>
`;

const LOAD = `      <trans-unit id="111" datatype="html">
        <source>Load app info</source>
        <context-group purpose="location">
          <context context-type="sourcefile">src/app/features/app-info/app-info.ts</context>
          <context context-type="linenumber">25,26</context>
        </context-group>
      </trans-unit>`;

const NAME = `      <trans-unit id="222" datatype="html">
        <source>Name</source>
        <context-group purpose="location">
          <context context-type="sourcefile">src/app/features/app-info/app-info.ts</context>
          <context context-type="linenumber">36,37</context>
        </context-group>
        <note priority="1" from="description">app name</note>
      </trans-unit>`;

describe('mergeTranslations', () => {
  it('starts a Spanish file with every message flagged as new', () => {
    const result = mergeTranslations(extracted(`${LOAD}\n${NAME}`), undefined);

    expect(result.added).toEqual(['111', '222']);
    expect(result.xml).toBe(`<?xml version="1.0" encoding="UTF-8" ?>
<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">
  <file source-language="en" target-language="es" datatype="plaintext" original="ng2.template">
    <body>
      <trans-unit id="111" datatype="html">
        <source>Load app info</source>
        <target state="new">Load app info</target>
      </trans-unit>
      <trans-unit id="222" datatype="html">
        <source>Name</source>
        <target state="new">Name</target>
        <note priority="1" from="description">app name</note>
      </trans-unit>
    </body>
  </file>
</xliff>
`);
  });

  it('keeps existing translations, adds new messages and drops the ones gone from the source', () => {
    const spanish = mergeTranslations(extracted(LOAD), undefined)
      .xml.replace(
        '<target state="new">Load app info</target>',
        '<target state="translated">Cargar información</target>',
      )
      .replace(
        '</body>',
        `  <trans-unit id="999" datatype="html">
        <source>Gone</source>
        <target>Ya no está</target>
      </trans-unit>
    </body>`,
      );

    const result = mergeTranslations(extracted(`${NAME}\n${LOAD}`), spanish);

    expect(result.added).toEqual(['222']);
    expect(result.removed).toEqual(['999']);
    expect(result.xml).toContain(`      <trans-unit id="222" datatype="html">
        <source>Name</source>
        <target state="new">Name</target>
        <note priority="1" from="description">app name</note>
      </trans-unit>
      <trans-unit id="111" datatype="html">
        <source>Load app info</source>
        <target state="translated">Cargar información</target>
      </trans-unit>
    </body>`);
  });
});

describe('checkTranslations', () => {
  const translated = mergeTranslations(extracted(`${LOAD}\n${NAME}`), undefined)
    .xml.replace(
      '<target state="new">Load app info</target>',
      '<target>Cargar información</target>',
    )
    .replace('<target state="new">Name</target>', '<target>Nombre</target>');

  it('passes when every message has a Spanish translation', () => {
    expect(checkTranslations(extracted(`${LOAD}\n${NAME}`), translated)).toEqual({
      missing: [],
      untranslated: [],
      obsolete: [],
    });
  });

  it('reports a message with no Spanish unit as missing', () => {
    const withoutName = translated.replace(/ {6}<trans-unit id="222"[\s\S]*?<\/trans-unit>\n/, '');
    expect(checkTranslations(extracted(`${LOAD}\n${NAME}`), withoutName).missing).toEqual(['222']);
  });

  it('reports a unit without a target as missing', () => {
    const noTarget = translated.replace('        <target>Nombre</target>\n', '');
    expect(checkTranslations(extracted(`${LOAD}\n${NAME}`), noTarget).missing).toEqual(['222']);
  });

  it('reports units still flagged new by the merge as untranslated', () => {
    const merged = mergeTranslations(extracted(`${LOAD}\n${NAME}`), undefined).xml;
    expect(checkTranslations(extracted(`${LOAD}\n${NAME}`), merged).untranslated).toEqual([
      '111',
      '222',
    ]);
  });

  it('reports Spanish units the source no longer has as obsolete', () => {
    expect(checkTranslations(extracted(LOAD), translated).obsolete).toEqual(['222']);
  });
});
