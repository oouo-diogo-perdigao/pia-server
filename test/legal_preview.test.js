import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('npm run legal:preview -- --out gera as páginas publicadas (v1.0 final), sem PG* nem GOOGLE_*', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pia-legal-preview-'));
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(pkg.scripts['legal:preview'], 'node scripts/legal-preview.js');
    execFileSync(process.execPath, ['scripts/legal-preview.js', '--out', dir], {
      cwd: new URL('..', import.meta.url), env: { PATH: process.env.PATH }, encoding: 'utf8',
    });
    const files = readdirSync(dir).sort();
    for (const name of ['index.html', 'privacidade.html', 'termos.html', 'privacidade_v1.0.html', 'termos_v1.0.html', 'preview_privacidade_v1.0.html', 'preview_termos_v1.0.html']) {
      assert.ok(files.includes(name), name);
    }
    assert.match(readFileSync(join(dir, 'preview_privacidade_v1.0.html'), 'utf8'), /<h1>Política de Privacidade<\/h1>/);
    const index = readFileSync(join(dir, 'index.html'), 'utf8');
    assert.match(index, /\/preview\/privacidade\/v1\.0<\/a> \(publicada\)/);
    assert.match(index, /\/preview\/termos\/v1\.0<\/a> \(publicada\)/);
    assert.doesNotMatch(index, /rascunho|com pendências/, 'release legal v1.0: nada em rascunho');
    for (const name of files.filter((f) => f !== 'index.html')) {
      assert.doesNotMatch(readFileSync(join(dir, name), 'utf8'), /\[|RASCUNHO|noindex|legal-pendente/, `${name} sem selo, faixa nem noindex`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
