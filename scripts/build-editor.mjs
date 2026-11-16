import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const result = await build({
  entryPoints: ['src/editor.mjs'], outfile: 'public/editor.js',
  bundle: true, minify: true, format: 'esm', target: ['es2022'],
  legalComments: 'none', metafile: true,
});
const packages = new Set(Object.keys(result.metafile.inputs).map((path) =>
  /^node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(path)?.[1]).filter(Boolean));
const notices = [];
for (const name of [...packages].sort()) {
  const directory = join('node_modules', name);
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  let license;
  for (const filename of ['LICENSE', 'LICENSE.md', 'LICENSE.txt']) {
    try { license = await readFile(join(directory, filename), 'utf8'); break; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (!license) throw new Error('Licença não encontrada: ' + name);
  notices.push(name + '@' + pkg.version + '\n' + license.trim());
}
await writeFile('public/editor-LICENSE.txt', notices.join('\n\n--------------------\n\n') + '\n');
console.log('Editor compilado localmente; licenças de ' + packages.size + ' pacotes preservadas.');
