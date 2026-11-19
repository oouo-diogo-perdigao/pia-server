import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../web/ui.js', import.meta.url), 'utf8');

test('web/index.html segue layout, ordem, acessibilidade, estado inicial desabilitado e preserva Discord', () => {
  const tavernsMatch = html.match(/data-connector-panel="taverns"[\s\S]*?<\/div>\s*<\/section>/);
  assert.ok(tavernsMatch, 'Painel taverns não encontrado');
  const tavernsHtml = tavernsMatch[0];

  for (const id of [
    'taverns-token',
    'taverns-reveal',
    'taverns-save',
    'taverns-destination',
    'taverns-destination-help',
    'taverns-destination-error',
    'taverns-destination-dirty',
    'taverns-save-destination',
    'taverns-test',
    'taverns-remove',
  ]) {
    assert.ok(tavernsHtml.includes(`id="${id}"`), `Faltando #${id}`);
  }

  // Ordem de tabulação: token -> reveal -> Salvar bot -> destino -> Salvar destino -> Enviar teste -> Remover bot
  const order = [
    'id="taverns-token"',
    'id="taverns-reveal"',
    'id="taverns-save"',
    'id="taverns-destination"',
    'id="taverns-save-destination"',
    'id="taverns-test"',
    'id="taverns-remove"',
  ].map((marker) => tavernsHtml.indexOf(marker));
  for (let i = 1; i < order.length; i++) {
    assert.ok(order[i] > order[i - 1], `Ordem inválida no índice ${i}`);
  }

  // Estado inicial carregando: campo e botões de destino/teste desabilitados antes do GET
  assert.match(tavernsHtml, /<input id="taverns-destination"[^>]*\bdisabled\b/);
  assert.match(tavernsHtml, /<button id="taverns-save-destination"[^>]*\bdisabled\b/);
  assert.match(tavernsHtml, /<button id="taverns-test"[^>]*\bdisabled\b/);
  assert.match(tavernsHtml, /Carregando configuração do Taverns…/);
  assert.match(tavernsHtml, /font-family:\s*monospace/);
  assert.match(tavernsHtml, /aria-describedby="taverns-destination-help taverns-destination-error"/);

  // Preservação do painel Discord
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

test('web/ui.js implementa estados carregando/erro/vazio/sucesso, validação inline, dirty, R-6 e distinção gravação vs recarga', () => {
  // Falha de leitura bloqueia campo e os dois botões (salvar e teste)
  assert.match(ui, /tavernsInput\.disabled\s*=\s*true;\s*tavernsSaveBtn\.disabled\s*=\s*true;\s*tavernsTestBtn\.disabled\s*=\s*true;/);
  assert.match(ui, /Não foi possível carregar os conectores\. Recarregue a página para tentar de novo\./);

  // Estados de ajuda (vazio, salvo sem token, salvo com token)
  assert.match(ui, /Nenhum destino padrão salvo\. Informe o ID da taverna e o ID do canal no formato ID da taverna\/ID do canal\./);
  assert.match(ui, /Destino salvo\. Configure o token do bot para publicar e testar\./);
  assert.match(ui, /Use o formato ID da taverna\/ID do canal\. Não é preciso informar o token de novo\./);

  // Aviso de edição (dirty)
  assert.match(ui, /Alteração não salva\. Destino salvo: \$\{saved\}/);
  assert.match(ui, /Alteração não salva\. Nenhum destino salvo\./);

  // Validação inline (aria-invalid + foco + mensagem)
  assert.match(ui, /TAVERNS_DESTINATION_RE\.test\(destination\)/);
  assert.match(ui, /setTavernsDestinationError\('Informe o destino como ID da taverna\/ID do canal\.'\)/);
  assert.match(ui, /element\('taverns-destination'\)\.focus\(\)/);
  assert.match(ui, /inputEl\.setAttribute\('aria-invalid',\s*'true'\)/);

  // Gravação sem token e distinção entre falha na gravação e falha na recarga
  assert.match(ui, /await api\('connectors\/save',\s*\{\s*provider:\s*'taverns',\s*destination\s*\}\)/);
  assert.match(ui, /Não foi possível salvar o destino\. O destino anterior foi mantido\./);
  assert.match(ui, /Destino do Taverns salvo\./);
  assert.match(ui, /Destino do Taverns salvo, mas não foi possível recarregar os conectores\./);

  // Confirmação e sucesso R-6
  assert.match(ui, /Remover o bot do Taverns\? O token será removido\. O destino padrão continuará salvo e reaparecerá quando você reconectar o bot\./);
  assert.match(ui, /Bot do Taverns removido\. O destino padrão continua salvo\./);

  // Discord preservado
  assert.match(ui, /on\('discord-save-channel',\s*\(\)\s*=>\s*saveConnector\('discord',\s*\{\s*channel:\s*input\('discord-channel'\)\s*\}\)\)/);
});
