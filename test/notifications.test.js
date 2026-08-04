// Tests unitaires de echapperHtml (src/utils/notifications.js) — la seule protection contre
// l'injection HTML dans les emails générés à partir de champs saisis par les utilisateurs (nom,
// adresse, description d'annonce...). Une régression ici est une vraie faille XSS.
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { echapperHtml } = require('../src/utils/notifications');

describe('echapperHtml', () => {
  test('échappe les caractères HTML dangereux', () => {
    assert.equal(echapperHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  test('échappe les guillemets (empêche de casser un attribut HTML)', () => {
    assert.equal(echapperHtml('" onmouseover="alert(1)'), '&quot; onmouseover=&quot;alert(1)');
  });

  test('échappe l\'esperluette', () => {
    assert.equal(echapperHtml('Jean & Fils'), 'Jean &amp; Fils');
  });

  test('laisse un texte normal inchangé', () => {
    assert.equal(echapperHtml('Immeuble Zenith, Cotonou'), 'Immeuble Zenith, Cotonou');
  });

  test('gère null et undefined sans planter (renvoie une chaîne vide)', () => {
    assert.equal(echapperHtml(null), '');
    assert.equal(echapperHtml(undefined), '');
  });

  test('convertit les nombres en chaîne avant d\'échapper', () => {
    assert.equal(echapperHtml(50000), '50000');
  });
});
