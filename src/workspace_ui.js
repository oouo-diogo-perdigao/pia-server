import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ActionIcon, createTheme, MantineProvider } from '@mantine/core';
import { AudioLines, Code2, Coffee, Eye, Grid2X2, HardDrive, LogOut, Mail, MessageCircle, Monitor, Plug, ShieldCheck } from 'lucide-react';

const require = createRequire(import.meta.url);
export const mantineCss = readFileSync(require.resolve('@mantine/core/styles.css'));
const palette = JSON.parse(readFileSync(new URL('../web/palette.json', import.meta.url), 'utf8'));
const theme = createTheme({ primaryColor: 'violet', defaultRadius: 'md', fontFamily: 'Inter, Segoe UI, sans-serif', colors: palette });
const rail = {
  recordings: ['Gravações', AudioLines], devices: ['Computadores', Monitor],
  mcp: ['MCP', Code2], admin: ['Administração', ShieldCheck], connectors: ['Conectores', Plug],
};
const connectors = {
  google: ['Google', Mail], microsoft: ['Microsoft', Grid2X2], storage: ['Object Storage', HardDrive],
  discord: ['Discord', MessageCircle], taverns: ['Taverns', Coffee],
};

function renderControl(group, key) {
  if (group === 'icon') {
    const icon = { LogOut, Eye }[key];
    if (!icon) throw new Error('Ícone desconhecido: ' + key);
    return renderToStaticMarkup(h(icon, { size: 20, 'aria-hidden': true }));
  }
  const isRail = group === 'rail';
  const [label, icon] = (isRail ? rail : connectors)[key];
  const props = isRail ? { component: 'a', href: '#' + key,
    ...(key === 'admin' ? { id: 'admin-link', hidden: true } : {}) } : { 'data-connector': key, type: 'button' };
  return renderToStaticMarkup(h(MantineProvider, {
    theme, forceColorScheme: 'dark', withCssVariables: false, withGlobalClasses: false,
    getRootElement: () => undefined,
  }, h(ActionIcon, { ...props, className: 'rail-icon', variant: 'subtle', size: 40,
    'aria-label': label, title: label }, h(icon, { size: 21, 'aria-hidden': true }))));
}

export function workspaceHtml(template) {
  const cssVariables = renderToStaticMarkup(h(MantineProvider, {
    theme, forceColorScheme: 'dark', withGlobalClasses: false,
  }));
  return template.replace('{{mantine-theme}}', cssVariables).replace(/\{\{(rail|connector|icon):([A-Za-z0-9]+)\}\}/g,
    (_, group, key) => renderControl(group, key));
}
