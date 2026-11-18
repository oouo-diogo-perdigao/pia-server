import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { legalFiles, legalNotFound } from '../src/legal.js';

const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
const css = read('web/legal.css');

function classes(html) {
  const found = new Set();
  for (const [, list] of html.matchAll(/class="([^"]+)"/g)) for (const name of list.split(/\s+/)) found.add(name);
  return found;
}

test('F2-03: /legal.css está registrado em publicFiles como text/css', () => {
  const index = read('src/index.js');
  assert.match(index, /\['\/legal\.css', \['text\/css; charset=utf-8', readFileSync\(new URL\('\.\.\/web\/legal\.css', import\.meta\.url\)\)\]\]/);
});

test('F2-03: legal.css não usa recursos externos nem depende de JS', () => {
  assert.doesNotMatch(css, /url\(/i);
  assert.doesNotMatch(css, /@import/i);
  assert.doesNotMatch(css, /@font-face/i);
  assert.doesNotMatch(css, /https?:\/\//i);
  assert.doesNotMatch(css, /expression\(|(^|[\s;{])behavior\s*:/i);
});

test('F2-03: legal.css cobre todas as classes geradas pelas páginas legais (final, rascunho e 404)', () => {
  const html = legalFiles('https://pia.example').map(([, [, body]]) => String(body)).join('') +
    legalNotFound('/privacidade/v9.9').body;
  const rascunhoForcado = '<p class="legal-rascunho"></p><span class="legal-pendente">[x]</span>';
  const usadas = classes(html + rascunhoForcado);
  for (const name of usadas) assert.match(css, new RegExp('\\.' + name + '\\b'), 'legal.css sem regra para .' + name);
  for (const name of ['legal', 'legal-cabecalho', 'legal-datas', 'legal-resumo', 'legal-sumario', 'legal-corpo', 'legal-historico', 'legal-rodape']) {
    assert.ok(usadas.has(name), 'contrato da F2-01 mudou: falta .' + name);
  }
});

test('F2-03: leitura confortável e responsiva de 320 a 1920 px', () => {
  assert.match(css, /68ch/, 'largura de leitura limitada');
  assert.match(css, /@media \(min-width: 64rem\)/, 'sumário lateral em telas largas');
  assert.match(css, /position: sticky/);
  assert.match(css, /overflow-wrap: (break-word|anywhere)/, 'palavras longas não causam rolagem horizontal');
  assert.match(css, /\.legal-historico[^{]*\{[^}]*overflow-x: auto/, 'tabela rola dentro do bloco em 320 px');
  assert.match(css, /:focus-visible \{[^}]*outline: 2px solid #b6a2ff/, 'foco visível #b6a2ff');
  for (const fixo of css.matchAll(/(?:^|[\s;{])(?:min-)?width:\s*(\d+)px/g)) assert.ok(Number(fixo[1]) <= 320, 'largura fixa maior que 320 px');
});

test('F2-03: cores de texto têm contraste AA sobre os fundos da página', () => {
  const lum = (hex) => {
    const [r, g, b] = hex.match(/[0-9a-f]{2}/gi).map((c) => {
      const v = parseInt(c, 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  };
  const pares = [
    ['#edeaf6', '#11121b'], ['#c6bed8', '#11121b'], ['#d4c4ff', '#11121b'], ['#f3edff', '#11121b'],
    ['#edeaf6', '#1b1b2b'], ['#d4c4ff', '#1b1b2b'], ['#d4c4ff', '#191928'], ['#bcadf2', '#191928'],
    ['#c6bed8', '#191928'], ['#f3edff', '#352957'], ['#ffe08a', '#3d2c05'], ['#3d2c05', '#f0b429'],
    ['#ffd666', '#2b2210'],
  ];
  for (const [fg, bg] of pares) {
    assert.ok(css.includes(fg) && css.includes(bg), `par ${fg}/${bg} não está mais em legal.css`);
    assert.ok(ratio(fg, bg) >= 4.5, `${fg} sobre ${bg}: ${ratio(fg, bg).toFixed(2)}:1`);
  }
});

test('F2-03: foco #b6a2ff em tudo e nenhum outline: none sem substituto', () => {
  assert.doesNotMatch(css, /#8f9eff/, 'foco antigo do style.css');
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^}]*outline:\s*(?:none|0)[^}]*)\}/g)) {
    assert.match(selector, /\[tabindex="-1"\]:focus|main\.legal:focus/, 'outline removido em ' + selector.trim());
    assert.doesNotMatch(selector, /focus-visible/);
    void body;
  }
  assert.match(css, /\.legal \.legal-sumario a:focus-visible \{ outline-offset: -2px; \}/);
});

test('F2-03: neutraliza as armadilhas do style.css global (spec UX 1.10)', () => {
  assert.match(css, /\.legal section \{ padding: 0; margin: 0; background: none; border: 0; border-radius: 0; \}/);
  assert.match(css, /\.legal nav \{ display: block; gap: 0; justify-items: normal; \}/);
  assert.match(css, /\.legal \.skip-link \{[^}]*color: #11121b/);
  assert.match(css, /\.legal h2 \{/);
  // as caixas que são <section> precisam vencer o reset (0,1,1) com 0,2,0
  assert.match(css, /\.legal \.legal-resumo, \.legal \.legal-summary \{/);
  assert.match(css, /\.legal \.legal-historico \{/);
});

test('F2-03: links do corpo e do rodapé da página sempre sublinhados', () => {
  assert.match(css, /^a \{[^}]*text-decoration: underline/m);
  for (const [, selector] of css.matchAll(/([^{}]+)\{[^}]*text-decoration:\s*none/g)) {
    assert.match(selector, /skip-link|nav a|legal-sumario a/, 'sublinhado removido em ' + selector.trim());
  }
});
