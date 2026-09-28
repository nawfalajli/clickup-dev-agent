import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// Remembers the outcome per task so a task is not processed twice.
export class State {
  constructor(file) {
    this.file = file;
    this.data = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  }

  get(id) {
    return this.data[id];
  }

  set(id, patch) {
    this.data[id] = { ...this.data[id], ...patch, at: new Date().toISOString() };
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    return this.data[id];
  }
}
