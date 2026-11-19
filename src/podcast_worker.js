import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const MAX_OUTPUT = 256 * 1024;
const TIMEOUT_MS = 2 * 60 * 60 * 1000;

export function createPodcastWorker({ command, args, cwd, env }) {
  function invoke(action, input, progress) {
    return new Promise((resolve, reject) => {
      if (!command) return reject(new Error('Worker indisponível'));
      const child = spawn(command, args, { cwd, env, shell: false, windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'] });
      const output = createInterface({ input: child.stdout, crlfDelay: Infinity });
      let total = 0;
      let result;
      let stages = Promise.resolve();
      const timeout = setTimeout(() => fail(), TIMEOUT_MS);
      timeout.unref();

      function fail() {
        clearTimeout(timeout);
        child.kill();
        reject(new Error('Falha no worker de podcast'));
      }

      child.stdout.on('data', (chunk) => {
        total += chunk.byteLength;
        if (total > MAX_OUTPUT) fail();
      });
      output.on('line', (line) => {
        let event;
        try { event = JSON.parse(line); } catch { return fail(); }
        if (event?.event === 'stage' && typeof event.stage === 'string') {
          stages = stages.then(() => progress?.(event.stage.slice(0, 200)));
          stages.catch(fail);
        } else if (event?.event === 'result' && result === undefined && event.result &&
          typeof event.result === 'object') {
          result = event.result;
        } else if (event?.event !== 'checkpoint') {
          fail();
        }
      });
      child.once('error', fail);
      child.stdin.once('error', fail);
      child.once('close', (code) => {
        clearTimeout(timeout);
        if (code !== 0 || result === undefined) return fail();
        stages.then(() => resolve(result), fail);
      });
      child.stdin.end(JSON.stringify({ action, ...input }) + '\n');
    });
  }
  return {
    prepare: (input, progress) => invoke('prepare', input, progress),
    publish: (input) => invoke('publish', input),
  };
}
