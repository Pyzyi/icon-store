import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MESSAGES, pickLanguage, translate } from '../public/i18n.js';
import { ERROR_MESSAGES } from '../src/lib/errors.js';

describe('i18n', () => {
  it('translates every API error code in German and English', () => {
    for (const code of Object.keys(ERROR_MESSAGES)) {
      assert.ok(MESSAGES.de[code], `de missing ${code}`);
      assert.ok(MESSAGES.en[code], `en missing ${code}`);
    }
  });

  it('has the same keys in both languages', () => {
    assert.deepEqual(Object.keys(MESSAGES.de).sort(), Object.keys(MESSAGES.en).sort());
  });

  it('interpolates parameters', () => {
    assert.equal(translate('de', 'name_too_long', { max: 100 }), 'Name ist zu lang (max. 100 Zeichen).');
    assert.equal(translate('en', 'search.count', { n: 3 }), '3 matches');
    assert.equal(translate('en', 'search.count'), '{n} matches');
    assert.equal(translate('de', 'unknown.key'), 'unknown.key');
  });

  it('picks the browser language', () => {
    assert.equal(pickLanguage(['de-AT', 'en']), 'de');
    assert.equal(pickLanguage(['fr', 'en-US']), 'en');
    assert.equal(pickLanguage(['fr']), 'en');
  });
});
