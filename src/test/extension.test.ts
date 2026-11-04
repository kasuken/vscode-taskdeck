import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  createPackageScriptExecution,
  createStableTaskId,
  resolvePackageManager,
  TaskTreeProvider
} from '../extension';

class TestMemento implements vscode.Memento {
  private readonly values = new Map<string, unknown>();

  keys(): readonly string[] {
    return Array.from(this.values.keys());
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return this.values.has(key) ? this.values.get(key) as T : defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

suite('TaskDeck task identity', () => {
  test('distinguishes same-named scripts in different packages', () => {
    const createTask = (packagePath: string) => new vscode.Task(
      { type: 'npm', script: 'build', path: packagePath },
      vscode.TaskScope.Workspace,
      'build',
      'npm script',
      new vscode.ShellExecution('npm run build')
    );

    const first = createStableTaskId(createTask('C:\\workspace\\packages\\first'));
    const second = createStableTaskId(createTask('C:\\workspace\\packages\\second'));

    assert.notStrictEqual(first, second);
  });

  test('creates the same identity regardless of definition property order', () => {
    const first = new vscode.Task(
      { type: 'npm', script: 'build', path: 'C:\\workspace\\packages\\app' },
      vscode.TaskScope.Workspace,
      'build',
      'npm script',
      new vscode.ShellExecution('npm run build')
    );
    const second = new vscode.Task(
      { path: 'C:\\workspace\\packages\\app', script: 'build', type: 'npm' },
      vscode.TaskScope.Workspace,
      'build',
      'npm script',
      new vscode.ShellExecution('npm run build')
    );

    assert.strictEqual(createStableTaskId(first), createStableTaskId(second));
  });

  test('uses a packageManager declaration before lockfile detection', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskdeck-package-manager-'));
    try {
      fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');
      assert.strictEqual(resolvePackageManager('pnpm@9.0.0', root, root), 'pnpm');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('inherits the nearest workspace lockfile package manager', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskdeck-package-manager-'));
    const packageDir = path.join(root, 'packages', 'web');
    fs.mkdirSync(packageDir, { recursive: true });
    try {
      fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0');
      assert.strictEqual(resolvePackageManager(undefined, packageDir, root), 'pnpm');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('prefers a package-local lockfile over a workspace lockfile', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskdeck-package-manager-'));
    const packageDir = path.join(root, 'packages', 'web');
    fs.mkdirSync(packageDir, { recursive: true });
    try {
      fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0');
      fs.writeFileSync(path.join(packageDir, 'package-lock.json'), '{}');
      assert.strictEqual(resolvePackageManager(undefined, packageDir, root), 'npm');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('inherits a workspace packageManager declaration', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taskdeck-package-manager-'));
    const packageDir = path.join(root, 'packages', 'web');
    fs.mkdirSync(packageDir, { recursive: true });
    try {
      fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ packageManager: 'yarn@4.0.0' }));
      assert.strictEqual(resolvePackageManager(undefined, packageDir, root), 'yarn');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('passes script names as shell arguments', () => {
    const execution = createPackageScriptExecution('pnpm', 'build; echo unsafe', 'C:\\workspace');

    assert.strictEqual(execution.command, 'pnpm');
    assert.deepStrictEqual(execution.args, ['run', 'build; echo unsafe']);
    assert.strictEqual(execution.options?.cwd, 'C:\\workspace');
  });
});

suite('TaskDeck execution history', () => {
  test('records one completed history entry per concurrent execution', async () => {
    const memento = new TestMemento();
    const provider = new TaskTreeProvider(memento);
    const task = new vscode.Task(
      { type: 'shell' },
      vscode.TaskScope.Workspace,
      'build',
      'test',
      new vscode.ShellExecution('echo build')
    );
    const createExecution = (): vscode.TaskExecution => ({ task, terminate: () => undefined });
    const first = createExecution();
    const second = createExecution();

    await provider.startTask(first, 1_000);
    await provider.startTask(second, 2_000);
    assert.strictEqual(provider.getHistory().length, 2);
    assert.strictEqual(provider.getRunningTasks().length, 2);
    assert.strictEqual(provider.getRecentTaskEntries([provider.createTaskModel(task)]).length, 0);

    provider.recordTaskExitCode(first, 0);
    provider.recordTaskExitCode(second, undefined);
    await provider.finishTask(first, 3_500);
    await provider.finishTask(second, 6_000);

    assert.strictEqual(provider.getHistory().length, 2);
    assert.strictEqual(provider.getRunningTasks().length, 0);
    assert.deepStrictEqual(
      provider.getHistory().map(entry => [entry.status, entry.exitCode, entry.durationMs]),
      [['succeeded', 0, 2_500], ['terminated', undefined, 4_000]]
    );
    assert.strictEqual(provider.getRecentTaskEntries([provider.createTaskModel(task)])[0].historyEntry.status, 'terminated');
  });
});
