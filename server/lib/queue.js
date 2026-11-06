'use strict';
// Build/deploy concurrency limiter. Only N heavy jobs (git pull + docker build)
// run at once; the rest wait in line. This is what stops 5 clients from
// crashing the VPS by all deploying at the same second.
function createQueue(concurrency = 2) {
  let active = 0;
  const waiting = [];
  function pump() {
    while (active < concurrency && waiting.length) {
      const { fn, resolve, reject } = waiting.shift();
      active++;
      Promise.resolve().then(fn).then(resolve, reject).finally(() => { active--; pump(); });
    }
  }
  function run(fn) {
    return new Promise((resolve, reject) => { waiting.push({ fn, resolve, reject }); pump(); });
  }
  run.stats = () => ({ active, queued: waiting.length, concurrency });
  return run;
}
module.exports = { createQueue };
