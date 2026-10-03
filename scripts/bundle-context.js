import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
const resources = [];
for (const directory of ['skills', 'brand/abdul', 'brand/centrisec']) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relative = directory === 'skills' ? entry.name + '/SKILL.md' : entry.name;
    if (directory === 'skills' ? !entry.isDirectory() : !entry.name.endsWith('.md')) continue;
    const name = directory + '/' + relative;
    resources.push({ name, uri: 'linkedin-agent://context/' + name, text: readFileSync(name, 'utf8') });
  }
}
mkdirSync('worker', { recursive: true });
writeFileSync('worker/context.generated.js', 'export default ' + JSON.stringify(resources) + ';\n');
console.log('Bundled ' + resources.length + ' fixed context documents.');
