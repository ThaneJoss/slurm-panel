import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// Keep this synthetic schema compatible with gpuq; never copy a live queue.
const SCHEMA = `
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE workers (
    gpu INTEGER PRIMARY KEY, slurm_job_id TEXT NOT NULL,
    heartbeat REAL NOT NULL, pid INTEGER NOT NULL
  );
  CREATE TABLE jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, argv TEXT NOT NULL, cwd TEXT NOT NULL,
    environment TEXT NOT NULL, retry_command TEXT,
    state TEXT NOT NULL DEFAULT 'queued',
    created REAL NOT NULL, updated REAL NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    active_attempt INTEGER, failed_gpus TEXT NOT NULL DEFAULT '[]',
    blocked_processes TEXT, wait_epoch INTEGER,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    message TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES jobs(id), number INTEGER NOT NULL,
    gpu INTEGER NOT NULL, state TEXT NOT NULL,
    slurm_job_id TEXT NOT NULL, session TEXT NOT NULL,
    log_path TEXT NOT NULL, created REAL NOT NULL,
    started REAL, finished REAL, runner_pid INTEGER, train_pid INTEGER,
    exit_code INTEGER, message TEXT NOT NULL DEFAULT '',
    UNIQUE(job_id, number)
  );
  CREATE INDEX attempts_state ON attempts(state);
  CREATE INDEX jobs_state ON jobs(state, id);
`;

export async function createFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'slurm-panel-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, 'project');
  await mkdir(cwd);
  const databasePath = join(directory, 'queue.sqlite3');
  const writer = new DatabaseSync(databasePath);
  writer.exec(SCHEMA);
  const now = Date.now() / 1000;
  const created = now - 3600;
  writer.prepare('INSERT INTO meta VALUES (?, ?)').run('paused', '0');
  writer.prepare('INSERT INTO meta VALUES (?, ?)').run('manager_heartbeat', String(now - 1));
  writer.prepare('INSERT INTO meta VALUES (?, ?)').run('private_setting', 'not-public');
  writer.prepare('INSERT INTO workers VALUES (?, ?, ?, ?)').run(0, 'synthetic-worker', now - 1, 12345);

  function job(overrides = {}) {
    const record = {
      id: 1,
      name: 'Synthetic experiment',
      argv: ['node', 'train.mjs'],
      cwd,
      environment: { API_TOKEN: 'fixture-secret-token', PASSWORD: 'fixture-secret-password' },
      state: 'running',
      created,
      updated: now,
      attempt_count: 0,
      message: '',
      ...overrides,
    };
    writer.prepare(`
      INSERT INTO jobs (id, name, argv, cwd, environment, state, created, updated, attempt_count, message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id, record.name, JSON.stringify(record.argv), record.cwd,
      JSON.stringify(record.environment), record.state, record.created,
      record.updated, record.attempt_count, record.message,
    );
    return record;
  }

  function attempt(overrides = {}) {
    const record = {
      job_id: 1,
      number: 1,
      gpu: 0,
      state: 'running',
      slurm_job_id: 'synthetic-worker',
      session: 'private-session',
      log_path: join(directory, 'attempt-1.log'),
      created: now - 200,
      started: now - 190,
      finished: null,
      runner_pid: 22222,
      train_pid: 33333,
      exit_code: null,
      message: '',
      ...overrides,
    };
    writer.prepare(`
      INSERT INTO attempts (
        job_id, number, gpu, state, slurm_job_id, session, log_path,
        created, started, finished, runner_pid, train_pid, exit_code, message
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...Object.values(record));
    return record;
  }

  let writerClosed = false;
  function finish() {
    writer.close();
    writerClosed = true;
  }
  t.after(() => {
    if (!writerClosed) writer.close();
  });
  return { directory, databasePath, cwd, now, created, job, attempt, finish };
}

export async function writeAt(path, text, seconds) {
  await writeFile(path, text);
  await utimes(path, seconds, seconds);
}
