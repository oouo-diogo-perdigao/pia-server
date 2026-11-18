import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('npm run legal:preview -- --out gera as páginas, inclusive rascunhos, sem PG* nem GOOGLE_*', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pia-legal-preview-'));
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    assert.equal(pkg.scripts['legal:preview'], 'node scripts/legal-preview.js');
    execFileSync(process.execPath, ['scripts/legal-preview.js', '--out', dir], {
      cwd: new URL('..', import.meta.url), env: { PATH: process.env.PATH }, encoding: 'utf8',
    });
    const files = readdirSync(dir).sort();
    for (const name of ['index.html', 'privacidade.html', 'termos.html', 'preview_privacidade_v1.0.html', 'preview_termos_v1.0.html']) {
      assert.ok(files.includes(name), name);
    }
    assert.match(readFileSync(join(dir, 'preview_privacidade_v1.0.html'), 'utf8'), /<h1>Política de Privacidade<\/h1>/);
    assert.match(readFileSync(join(dir, 'index.html'), 'utf8'), /rascunho/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
