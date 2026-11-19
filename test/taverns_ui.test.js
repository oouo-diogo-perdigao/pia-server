import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../web/ui.js', import.meta.url), 'utf8');

test('web/index.html contém estrutura Taverns 0005-C2 e preserva Discord', () => {
  for (const id of [
    'taverns-token',
    'taverns-reveal',
    'taverns-save',
    'taverns-remove',
    'taverns-destination',
    'taverns-default-empty',
    'taverns-save-destination',
    'taverns-test',
    'taverns-feedback',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `Faltando #${id} em web/index.html`);
  }

  for (const id of [
    'discord',
    'discord-reveal',
    'save-discord',
    'discord-channel',
    'discord-save-channel',
    'discord-link',
    'discord-test',
    'discord-remove',
  ]) {
    assert.ok(html.includes(`id="${id}"`), `Regressão Discord: faltando #${id}`);
  }
});

test('web/ui.js implementa leitura, estado vazio, salvar sem token, erro recuperável e confirmação R-6', () => {
  assert.match(ui, /connectorState\.taverns\?\.destination\s*\|\|\s*''/);
  assert.match(ui, /element\('taverns-default-empty'\)\.hidden\s*=\s*Boolean\(tavernsDestination\)/);
  assert.match(ui, /on\('taverns-save-destination',\s*async\s*\(\)\s*=>/);
  assert.match(ui, /saveConnector\('taverns',\s*\{\s*destination:\s*input\('taverns-destination'\)\.trim\(\)\s*\}\)/);
  assert.match(ui, /tavernsInput\.disabled\s*=\s*true/);
  assert.match(ui, /tavernsSaveBtn\.disabled\s*=\s*true/);
  assert.match(ui, /feedback\.textContent\s*=\s*error\.message/);
  assert.match(ui, /on\('taverns-remove',\s*\(\)\s*=>\s*[\s\S]*Remover apenas o token do Taverns\? O destino padrão e os demais dados serão preservados\./);
  assert.match(ui, /\['taverns',\s*'taverns-destination'\]/);
  assert.match(ui, /on\('discord-save-channel',\s*\(\)\s*=>\s*saveConnector\('discord',\s*\{\s*channel:\s*input\('discord-channel'\)\s*\}\)\)/);
});
