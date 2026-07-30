export class PromptQueue {
  constructor() { this._tail = Promise.resolve(); }
  enqueue(fn) {
    const run = this._tail.then(fn, fn);
    this._tail = run.then(() => {}, () => {});
    return run;
  }
}
