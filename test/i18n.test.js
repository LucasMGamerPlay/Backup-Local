const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeLanguage, translate } = require('../src/i18n');

test('normaliza idiomas suportados', () => {
  assert.equal(normalizeLanguage('en'), 'en');
  assert.equal(normalizeLanguage('pt-BR'), 'pt-BR');
  assert.equal(normalizeLanguage('fr'), 'pt-BR');
});

test('traduz mensagens e substitui valores', () => {
  assert.equal(translate('en', 'preparing'), 'Preparing backup...');
  assert.equal(translate('en', 'filesCreated', { count: 2 }), '2 file(s) created.');
  assert.equal(translate('pt-BR', 'filesCreated', { count: 2 }), '2 arquivo(s) criado(s).');
});
