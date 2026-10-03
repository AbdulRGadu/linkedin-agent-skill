import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
function check(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = directory + '/' + entry.name;
    if (entry.isDirectory()) check(path);
    else if (path.endsWith('.js')) {
      const result = spawnSync(process.execPath, ['--check', path], { stdio: 'inherit' });
      if (result.status !== 0) process.exit(result.status || 1);
    }
  }
}
for (const directory of ['apps', 'server', 'worker', 'scripts', 'tests']) check(directory);
console.log('JavaScript syntax checks passed.');
