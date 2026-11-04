import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// Data models
interface TaskItemModel {
  id: string;
  label: string;
  source: string;
  folderName?: string;
  workspacePath?: string;
  packageManager?: PackageManager;
  definitionUri?: vscode.Uri;
  vscodeTask: vscode.Task;
}

type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

interface NpmScript {
  name: string;
  script: string;
  packageManager: PackageManager;
  packageJsonPath: string;
  folderName: string;
  workspacePath: string;
}

interface AntTarget {
  name: string;
  description?: string;
  buildXmlPath: string;
  folderName: string;
  workspacePath: string;
}

interface HistoryEntry {
  taskId: string;
  label: string;
  runAt: number;
  exitCode?: number;
  durationMs?: number;
  status?: 'running' | 'succeeded' | 'failed' | 'terminated' | 'interrupted' | 'completed';
}

interface RunningTask {
  id: number;
  execution: vscode.TaskExecution;
  task: TaskItemModel;
  startedAt: number;
  historyEntry: HistoryEntry;
}

type TaskGroupKind = 'npmScripts' | 'npmWorkspace' | 'npmPackage' | 'antTargets' | 'source' | 'running';

interface TaskQuickPickItem extends vscode.QuickPickItem {
  taskId?: string;
}

function sortTaskDefinition(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(item => sortTaskDefinition(item));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, item]) => [key, sortTaskDefinition(item)])
    );
  }
  return value;
}

export function createStableTaskId(task: vscode.Task): string {
  const workspaceFolder = task.scope && typeof task.scope !== 'number' ? task.scope : undefined;
  const scope = workspaceFolder?.uri.toString() ??
    (task.scope === vscode.TaskScope.Workspace ? 'workspace' : 'global');
  const definition = sortTaskDefinition(task.definition);
  return `taskdeck:v2:${JSON.stringify([scope, task.source, task.name, definition])}`;
}

export function resolvePackageManager(
  declaredPackageManager: unknown,
  packageDir: string,
  workspaceRoot: string
): PackageManager {
  const declared = parsePackageManager(declaredPackageManager);
  if (declared) {
    return declared;
  }

  const root = path.resolve(workspaceRoot);
  let directory = path.resolve(packageDir);
  while (directory === root || directory.startsWith(`${root}${path.sep}`)) {
    if (directory !== path.resolve(packageDir)) {
      const ancestorManifest = path.join(directory, 'package.json');
      if (fs.existsSync(ancestorManifest)) {
        try {
          const packageJson = JSON.parse(fs.readFileSync(ancestorManifest, 'utf8'));
          const ancestorPackageManager = parsePackageManager(packageJson.packageManager);
          if (ancestorPackageManager) {
            return ancestorPackageManager;
          }
        } catch (error) {
          console.error(`Failed to read package manager from ${ancestorManifest}:`, error);
        }
      }
    }
    if (fs.existsSync(path.join(directory, 'pnpm-lock.yaml'))) {
      return 'pnpm';
    }
    if (fs.existsSync(path.join(directory, 'yarn.lock'))) {
      return 'yarn';
    }
    if (fs.existsSync(path.join(directory, 'bun.lock')) || fs.existsSync(path.join(directory, 'bun.lockb'))) {
      return 'bun';
    }
    if (fs.existsSync(path.join(directory, 'package-lock.json')) || fs.existsSync(path.join(directory, 'npm-shrinkwrap.json'))) {
      return 'npm';
    }
    if (directory === root) {
      break;
    }
    directory = path.dirname(directory);
  }
  return 'npm';
}

function parsePackageManager(value: unknown): PackageManager | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const match = /^(npm|pnpm|yarn|bun)(?:@|$)/.exec(value)?.[1];
  return match === 'npm' || match === 'pnpm' || match === 'yarn' || match === 'bun'
    ? match
    : undefined;
}

export function createPackageScriptExecution(
  packageManager: PackageManager,
  scriptName: string,
  cwd: string
): vscode.ShellExecution {
  return new vscode.ShellExecution(packageManager, ['run', scriptName], { cwd });
}

// Tree item types
type TreeItemType = 'group' | 'task';

class TaskTreeItem extends vscode.TreeItem {
  public taskModel?: TaskItemModel;
  public taskId?: string;
  public groupKind?: TaskGroupKind;
  public groupTasks?: TaskItemModel[];
  public execution?: vscode.TaskExecution;
  public runningTask?: RunningTask;
  public historyEntry?: HistoryEntry;
  
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly itemType: TreeItemType,
    taskModel?: TaskItemModel,
    options: {
      groupKind?: TaskGroupKind;
      groupTasks?: TaskItemModel[];
      runningTask?: RunningTask;
      historyEntry?: HistoryEntry;
    } = {}
  ) {
    super(label, collapsibleState);
    this.taskModel = taskModel;
    this.groupKind = options.groupKind;
    this.groupTasks = options.groupTasks;
    this.runningTask = options.runningTask;
    this.execution = options.runningTask?.execution;
    this.historyEntry = options.historyEntry;

    if (itemType === 'task' && taskModel) {
      this.contextValue = options.runningTask ? 'runningTask' : 'task';
      this.id = options.runningTask ? `running-${options.runningTask.id}` : taskModel.id;
      this.taskId = taskModel.id; // Store for command lookup
      this.tooltip = `${taskModel.label} (${taskModel.source})${taskModel.folderName ? ` - ${taskModel.folderName}` : ''}`;
      this.description = taskModel.source + (taskModel.folderName ? ` - ${taskModel.folderName}` : '');
    } else if (itemType === 'group') {
      this.contextValue = 'group';
      this.id = `group-${options.groupKind ?? ''}-${label}-${options.groupTasks?.[0]?.workspacePath ?? ''}-${options.groupTasks?.[0]?.folderName ?? ''}`;
    }
  }
}

export class TaskTreeProvider implements vscode.TreeDataProvider<TaskTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<TaskTreeItem | undefined | null | void> = new vscode.EventEmitter<TaskTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<TaskTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  private tasks: TaskItemModel[] = [];
  private npmScriptTasks: TaskItemModel[] = [];
  private antTargetTasks: TaskItemModel[] = [];
  private favorites: string[] = [];
  private history: HistoryEntry[] = [];
  private filterText: string = '';
  private taskbarPinned: Set<string> = new Set();
  private runningTasks = new Map<vscode.TaskExecution, RunningTask>();
  private taskExitCodes = new Map<vscode.TaskExecution, number | undefined>();
  private nextRunningTaskId = 0;
  private historySavePromise: Promise<void> = Promise.resolve();
  private tasksLoaded = false;
  private loadingTasks: Promise<void> | undefined;
  private reloadRequested = false;

  constructor(private globalState: vscode.Memento) {
    this.loadFavorites();
    this.loadHistory();
    this.loadTaskbarPinned();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  async ensureTasksLoaded(): Promise<void> {
    if (!this.tasksLoaded) {
      await this.loadTasks();
    }
  }

  loadTasks(): Promise<void> {
    if (this.loadingTasks) {
      return this.loadingTasks;
    }

    this.loadingTasks = this.loadTasksInternal().finally(() => {
      this.loadingTasks = undefined;
    });
    return this.loadingTasks;
  }

  reloadTasks(): Promise<void> {
    if (!this.loadingTasks) {
      return this.loadTasks();
    }

    this.reloadRequested = true;
    return this.loadingTasks.then(() => {
      if (!this.reloadRequested) {
        return;
      }
      this.reloadRequested = false;
      return this.reloadTasks();
    });
  }

  private async loadTasksInternal(): Promise<void> {
    try {
      const allTasks = await vscode.tasks.fetchTasks();
      // Filter out built-in npm tasks since we load them separately with enhanced info
      this.tasks = allTasks
        .filter(task => task.source !== 'npm')
        .map(task => this.createTaskModel(task));
      
      // Load npm scripts separately with enhanced workspace/folder info
      await Promise.all([this.loadNpmScripts(), this.loadAntTargets()]);
      await this.migrateLegacyTaskIds();
      this.tasksLoaded = true;
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to load tasks: ${error}`);
    } finally {
      this.refresh();
    }
  }

  async loadNpmScripts(): Promise<void> {
    try {
      this.npmScriptTasks = [];
      const npmScripts = await this.findNpmScripts();
      
      for (const npmScript of npmScripts) {
        const task = this.createNpmTask(npmScript);
        const taskModel = this.createTaskModel(task);
        taskModel.workspacePath = npmScript.workspacePath;
        taskModel.folderName = npmScript.folderName;
        taskModel.packageManager = npmScript.packageManager;
        taskModel.definitionUri = vscode.Uri.file(npmScript.packageJsonPath);
        this.npmScriptTasks.push(taskModel);
      }
    } catch (error) {
      console.error('Failed to load npm scripts:', error);
    }
  }

  async findNpmScripts(): Promise<NpmScript[]> {
    const npmScripts: NpmScript[] = [];
    
    if (!vscode.workspace.workspaceFolders) {
      return npmScripts;
    }

    for (const folder of vscode.workspace.workspaceFolders) {
      // Search for all package.json files in the workspace folder
      const pattern = new vscode.RelativePattern(folder, '**/package.json');
      const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**');
      
      for (const file of files) {
        try {
          const content = await fs.promises.readFile(file.fsPath, 'utf8');
          const packageJson = JSON.parse(content);
          
          if (typeof packageJson.scripts === 'object' && packageJson.scripts !== null) {
            const packageDir = path.dirname(file.fsPath);
            const relativePath = path.relative(folder.uri.fsPath, packageDir);
            const folderName = relativePath || '.';
            const packageManager = resolvePackageManager(packageJson.packageManager, packageDir, folder.uri.fsPath);
            
            for (const [scriptName, scriptCommand] of Object.entries(packageJson.scripts)) {
              if (typeof scriptCommand !== 'string') {
                continue;
              }
              npmScripts.push({
                name: scriptName,
                script: scriptCommand,
                packageManager,
                packageJsonPath: file.fsPath,
                folderName: folderName,
                workspacePath: folder.uri.fsPath
              });
            }
          }
        } catch (error) {
          console.error(`Failed to parse package.json at ${file.fsPath}:`, error);
        }
      }
    }

    return npmScripts;
  }

  createNpmTask(npmScript: NpmScript): vscode.Task {
    const workspaceFolder = vscode.workspace.workspaceFolders?.find(
      folder => folder.uri.fsPath === npmScript.workspacePath
    );
    
    const packageDir = path.dirname(npmScript.packageJsonPath);
    const definition: vscode.TaskDefinition = {
      type: 'npm',
      script: npmScript.name,
      path: packageDir,
      packageManager: npmScript.packageManager
    };

    const task = new vscode.Task(
      definition,
      workspaceFolder || vscode.TaskScope.Workspace,
      npmScript.name,
      'npm script',
      createPackageScriptExecution(npmScript.packageManager, npmScript.name, packageDir)
    );

    return task;
  }

  async loadAntTargets(): Promise<void> {
    try {
      this.antTargetTasks = [];
      const antTargets = await this.findAntTargets();

      for (const antTarget of antTargets) {
        const task = this.createAntTask(antTarget);
        const taskModel = this.createTaskModel(task);
        taskModel.workspacePath = antTarget.workspacePath;
        taskModel.folderName = antTarget.folderName;
        taskModel.definitionUri = vscode.Uri.file(antTarget.buildXmlPath);
        this.antTargetTasks.push(taskModel);
      }
    } catch (error) {
      console.error('Failed to load Ant targets:', error);
    }
  }

  async findAntTargets(): Promise<AntTarget[]> {
    const antTargets: AntTarget[] = [];

    if (!vscode.workspace.workspaceFolders) {
      return antTargets;
    }

    for (const folder of vscode.workspace.workspaceFolders) {
      const pattern = new vscode.RelativePattern(folder, '**/build.xml');
      const files = await vscode.workspace.findFiles(pattern, '**/node_modules/**');

      for (const file of files) {
        try {
          const content = await fs.promises.readFile(file.fsPath, 'utf8');
          const buildDir = path.dirname(file.fsPath);
          const relativePath = path.relative(folder.uri.fsPath, buildDir);
          const folderName = relativePath || folder.name;

          const targetRegex = /<target\s+([^>]*)>/g;
          let match;
          while ((match = targetRegex.exec(content)) !== null) {
            const attrs = match[1];
            const nameMatch = attrs.match(/name="([^"]*)"/);
            if (nameMatch) {
              const targetName = nameMatch[1];
              // Skip private targets (conventionally starting with -)
              if (targetName.startsWith('-')) {
                continue;
              }
              const descMatch = attrs.match(/description="([^"]*)"/);
              antTargets.push({
                name: targetName,
                description: descMatch ? descMatch[1] : undefined,
                buildXmlPath: file.fsPath,
                folderName: folderName,
                workspacePath: folder.uri.fsPath
              });
            }
          }
        } catch (error) {
          console.error(`Failed to parse build.xml at ${file.fsPath}:`, error);
        }
      }
    }

    return antTargets;
  }

  createAntTask(antTarget: AntTarget): vscode.Task {
    const workspaceFolder = vscode.workspace.workspaceFolders?.find(
      folder => folder.uri.fsPath === antTarget.workspacePath
    );

    const buildDir = path.dirname(antTarget.buildXmlPath);
    const definition: vscode.TaskDefinition = {
      type: 'ant',
      target: antTarget.name,
      path: buildDir
    };

    const task = new vscode.Task(
      definition,
      workspaceFolder || vscode.TaskScope.Workspace,
      antTarget.name,
      'ant',
      new vscode.ShellExecution('ant', [antTarget.name], { cwd: buildDir })
    );

    return task;
  }

  createTaskModel(task: vscode.Task): TaskItemModel {
    const folderName = task.scope && typeof task.scope !== 'number' ? task.scope.name : undefined;
    const id = this.createId(task);
    const workspaceFolder = task.scope && typeof task.scope !== 'number' ? task.scope : undefined;
    const tasksJson = workspaceFolder
      ? vscode.Uri.joinPath(workspaceFolder.uri, '.vscode', 'tasks.json')
      : undefined;
    return {
      id,
      label: task.name,
      source: task.source,
      folderName,
      workspacePath: undefined,
      definitionUri: tasksJson && fs.existsSync(tasksJson.fsPath) ? tasksJson : undefined,
      vscodeTask: task
    };
  }

  createId(task: vscode.Task): string {
    return createStableTaskId(task);
  }

  private createLegacyId(task: vscode.Task): string {
    const folderName = task.scope && typeof task.scope !== 'number' ? task.scope.name : 'global';
    return `${folderName}:${task.source}:${task.name}`;
  }

  private async migrateLegacyTaskIds(): Promise<void> {
    const tasksByLegacyId = new Map<string, TaskItemModel[]>();
    for (const task of this.getTasks()) {
      const legacyId = this.createLegacyId(task.vscodeTask);
      const matchingTasks = tasksByLegacyId.get(legacyId) ?? [];
      matchingTasks.push(task);
      tasksByLegacyId.set(legacyId, matchingTasks);
    }

    let favoritesChanged = false;
    const migratedFavorites = new Set<string>();
    for (const favoriteId of this.favorites) {
      const matches = tasksByLegacyId.get(favoriteId);
      if (matches) {
        favoritesChanged = true;
        matches.forEach(task => migratedFavorites.add(task.id));
      } else {
        migratedFavorites.add(favoriteId);
      }
    }
    this.favorites = Array.from(migratedFavorites);

    let pinsChanged = false;
    const migratedPins = new Set<string>();
    for (const pinnedId of this.taskbarPinned) {
      const matches = tasksByLegacyId.get(pinnedId);
      if (matches) {
        pinsChanged = true;
        matches.forEach(task => migratedPins.add(task.id));
      } else {
        migratedPins.add(pinnedId);
      }
    }
    this.taskbarPinned = migratedPins;

    let historyChanged = false;
    this.history = this.history.map(entry => {
      const matches = tasksByLegacyId.get(entry.taskId);
      if (!matches) {
        return entry;
      }
      historyChanged = true;
      return { ...entry, taskId: matches[matches.length - 1].id };
    });

    if (favoritesChanged) {
      await this.saveFavorites();
    }
    if (pinsChanged) {
      await this.saveTaskbarPinned();
    }
    if (historyChanged) {
      await this.saveHistory();
    }
  }

  getTreeItem(element: TaskTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TaskTreeItem): Promise<TaskTreeItem[]> {
    if (!element) {
      // Root level - show top-level groups
      // Only load tasks if not already loaded
      if (!this.tasksLoaded) {
        await this.loadTasks();
      }

      const filteredTasks = this.getFilteredTasks();
      const filteredNpmScripts = this.getFilteredNpmScripts();
      const filteredAntTargets = this.getFilteredAntTargets();
      const allFilteredTasks = [...filteredTasks, ...filteredNpmScripts, ...filteredAntTargets];
      const result: TaskTreeItem[] = [];
      const runningTasks = this.getVisibleRunningTasks();
      if (runningTasks.length > 0) {
        const runningGroup = new TaskTreeItem('Running', vscode.TreeItemCollapsibleState.Expanded, 'group', undefined, {
          groupKind: 'running'
        });
        runningGroup.iconPath = new vscode.ThemeIcon('debug-start');
        result.push(runningGroup);
      }

      // Create a map of task IDs for quick lookup
      const taskMap = new Map<string, TaskItemModel>();
      allFilteredTasks.forEach(task => taskMap.set(task.id, task));

      // Split into favorites (in stored order) and others
      const favoriteSet = new Set(this.favorites);
      const favoriteTasks: TaskItemModel[] = this.favorites
        .map(id => taskMap.get(id))
        .filter((t): t is TaskItemModel => t !== undefined);
      const nonFavoriteTasks: TaskItemModel[] = allFilteredTasks.filter(task => !favoriteSet.has(task.id));

      // Favorites group
      if (favoriteTasks.length > 0) {
        const favGroup = new TaskTreeItem('Favorites', vscode.TreeItemCollapsibleState.Expanded, 'group');
        favGroup.iconPath = new vscode.ThemeIcon('star-full');
        result.push(favGroup);
      }

      // Pinned group
      const pinnedTasks = allFilteredTasks.filter(t => this.taskbarPinned.has(t.id) && !this.favorites.includes(t.id));
      if (pinnedTasks.length > 0) {
        const pinnedGroup = new TaskTreeItem('Pinned', vscode.TreeItemCollapsibleState.Expanded, 'group');
        pinnedGroup.iconPath = new vscode.ThemeIcon('pinned');
        result.push(pinnedGroup);
      }

      // Recent group
      const recentTasks = this.getRecentTasks(allFilteredTasks);

      if (recentTasks.length > 0) {
        const recentGroup = new TaskTreeItem('Recent', vscode.TreeItemCollapsibleState.Expanded, 'group');
        recentGroup.iconPath = new vscode.ThemeIcon('history');
        result.push(recentGroup);
      }

      // npm scripts group (only show if there are npm scripts)
      const recentIds = new Set(recentTasks.map(task => task.id));
      const pinnedIds = new Set(pinnedTasks.map(t => t.id));
      
      if (filteredNpmScripts.length > 0) {
        const npmScriptsToShow = filteredNpmScripts.filter(t => !this.favorites.includes(t.id) && !pinnedIds.has(t.id) && !recentIds.has(t.id));
        
        if (npmScriptsToShow.length > 0) {
          const npmScriptsGroup = new TaskTreeItem('npm scripts', vscode.TreeItemCollapsibleState.Collapsed, 'group', undefined, {
            groupKind: 'npmScripts',
            groupTasks: npmScriptsToShow
          });
          npmScriptsGroup.iconPath = new vscode.ThemeIcon('package');
          result.push(npmScriptsGroup);
        }
      }

      // Ant targets group (only show if there are Ant targets)
      if (filteredAntTargets.length > 0) {
        const antTargetsToShow = filteredAntTargets.filter(t => !this.favorites.includes(t.id) && !pinnedIds.has(t.id) && !recentIds.has(t.id));

        if (antTargetsToShow.length > 0) {
          const antTargetsGroup = new TaskTreeItem('Ant targets', vscode.TreeItemCollapsibleState.Collapsed, 'group', undefined, {
            groupKind: 'antTargets',
            groupTasks: antTargetsToShow
          });
          antTargetsGroup.iconPath = new vscode.ThemeIcon('symbol-event');
          result.push(antTargetsGroup);
        }
      }

      // Group other tasks by source
      const otherTasks = nonFavoriteTasks.filter(t => !pinnedIds.has(t.id) && !recentIds.has(t.id) && t.source !== 'npm script' && t.source !== 'ant');

      if (otherTasks.length > 0) {
        // Group tasks by source type
        const tasksBySource = new Map<string, TaskItemModel[]>();
        otherTasks.forEach(task => {
          const source = task.source || 'other';
          if (!tasksBySource.has(source)) {
            tasksBySource.set(source, []);
          }
          tasksBySource.get(source)!.push(task);
        });

        // Sort sources alphabetically
        const sortedSources = Array.from(tasksBySource.keys()).sort();

        // Create a group for each source
        sortedSources.forEach(source => {
          const sourceGroup = new TaskTreeItem(
            this.getSourceDisplayName(source),
            vscode.TreeItemCollapsibleState.Collapsed,
            'group',
            undefined,
            {
              groupKind: 'source',
              groupTasks: tasksBySource.get(source)
            }
          );
          sourceGroup.iconPath = this.getSourceIcon(source);
          result.push(sourceGroup);
        });
      }

      return result;
    } else if (element.itemType === 'group') {
      // Child level - show tasks within the group
      const filteredTasks = this.getFilteredTasks();
      const filteredNpmScripts = this.getFilteredNpmScripts();
      const filteredAntTargets = this.getFilteredAntTargets();
      const allFilteredTasks = [...filteredTasks, ...filteredNpmScripts, ...filteredAntTargets];
      const taskMap = new Map<string, TaskItemModel>();
      allFilteredTasks.forEach(task => taskMap.set(task.id, task));

      if (element.groupKind === 'running') {
        return this.getVisibleRunningTasks().map(runningTask => {
          const item = new TaskTreeItem(
            runningTask.task.label,
            vscode.TreeItemCollapsibleState.None,
            'task',
            runningTask.task,
            { runningTask }
          );
          item.description = `Started ${new Date(runningTask.startedAt).toLocaleTimeString()}`;
          item.tooltip = `${runningTask.task.label}\nRunning since ${new Date(runningTask.startedAt).toLocaleString()}`;
          item.iconPath = new vscode.ThemeIcon('loading~spin');
          return item;
        });
      } else if (element.groupKind === 'npmScripts') {
        return this.createNpmWorkspaceGroups(element.groupTasks ?? []);
      } else if (element.groupKind === 'npmWorkspace') {
        return this.createNpmPackageGroups(element.groupTasks ?? []);
      } else if (element.groupKind === 'npmPackage') {
        return (element.groupTasks ?? []).map(task => this.createNpmTaskItem(task));
      } else if (element.groupKind === 'source') {
        return (element.groupTasks ?? []).map(task => {
          const item = new TaskTreeItem(task.label, vscode.TreeItemCollapsibleState.None, 'task', task);
          item.iconPath = new vscode.ThemeIcon('play-circle');
          return item;
        });
      } else if (element.groupKind === 'antTargets') {
        return (element.groupTasks ?? []).map(task => {
          const item = new TaskTreeItem(task.label, vscode.TreeItemCollapsibleState.None, 'task', task);
          item.iconPath = new vscode.ThemeIcon('symbol-event');
          item.tooltip = this.getTaskTooltip(task);
          return item;
        });
      } else if (element.label === 'Favorites') {
        const favoriteTasks = this.getFavoriteTasks(allFilteredTasks);
        return favoriteTasks.map(task => {
          const item = new TaskTreeItem(task.label, vscode.TreeItemCollapsibleState.None, 'task', task);
          item.contextValue = 'favoriteTask';
          item.iconPath = new vscode.ThemeIcon('star-full');
          return item;
        });
      } else if (element.label === 'Pinned') {
        const pinnedTasks = allFilteredTasks.filter(t => this.taskbarPinned.has(t.id) && !this.favorites.includes(t.id));
        return pinnedTasks.map(task => {
          const item = new TaskTreeItem(task.label, vscode.TreeItemCollapsibleState.None, 'task', task);
          item.iconPath = new vscode.ThemeIcon('pinned');
          return item;
        });
      } else if (element.label === 'Recent') {
        const recentEntries = this.getRecentTaskEntries(allFilteredTasks);

        return recentEntries.map(({ task, historyEntry }) => {
          const item = new TaskTreeItem(task.label, vscode.TreeItemCollapsibleState.None, 'task', task, { historyEntry });
          item.iconPath = new vscode.ThemeIcon('history');
          item.description = `${task.source}${task.folderName ? ` - ${task.folderName}` : ''} - ${this.formatHistoryEntry(historyEntry)}`;
          item.tooltip = `${this.getTaskTooltip(task)}\n${this.formatHistoryEntry(historyEntry)}`;
          return item;
        });
      } else if (element.label === 'npm scripts') {
        // Show npm script tasks
        const recentIds = new Set(this.getRecentTasks(allFilteredTasks).map(task => task.id));

        const npmScriptTasks = filteredNpmScripts.filter(
          t => !this.favorites.includes(t.id) && !this.taskbarPinned.has(t.id) && !recentIds.has(t.id)
        );

        return this.createNpmWorkspaceGroups(npmScriptTasks);
      } else if (element.label === 'Ant targets') {
        // Show Ant target tasks
        const recentIds = new Set(this.getRecentTasks(allFilteredTasks).map(task => task.id));

        const antTasks = filteredAntTargets.filter(
          t => !this.favorites.includes(t.id) && !this.taskbarPinned.has(t.id) && !recentIds.has(t.id)
        );

        return antTasks.map(task => {
          const item = new TaskTreeItem(task.label, vscode.TreeItemCollapsibleState.None, 'task', task);
          item.iconPath = new vscode.ThemeIcon('symbol-event');

          // Enhanced tooltip with workspace and folder info
          const tooltipParts = [
            `${task.label}`,
            `Source: ${task.source}`,
          ];
          if (task.folderName) {
            tooltipParts.push(`Folder: ${task.folderName}`);
          }
          if (task.workspacePath) {
            tooltipParts.push(`Workspace: ${task.workspacePath}`);
          }
          item.tooltip = tooltipParts.join('\n');

          // Enhanced description
          const descriptionParts = [task.source];
          if (task.folderName) {
            descriptionParts.push(task.folderName);
          }
          item.description = descriptionParts.join(' - ');

          return item;
        });
      } else {
        const recentIds = new Set(this.getRecentTasks(allFilteredTasks).map(task => task.id));

        const sourceTasks = filteredTasks.filter(t =>
          t.source === this.getSourceFromDisplayName(element.label) &&
          !this.favorites.includes(t.id) &&
          !this.taskbarPinned.has(t.id) &&
          !recentIds.has(t.id)
        );

        return sourceTasks.map(task => {
          const item = new TaskTreeItem(task.label, vscode.TreeItemCollapsibleState.None, 'task', task);
          item.iconPath = new vscode.ThemeIcon('play-circle');
          return item;
        });
      }

    }

    return [];
  }

  private createNpmWorkspaceGroups(tasks: TaskItemModel[]): TaskTreeItem[] {
    const groups = new Map<string, TaskItemModel[]>();
    for (const task of tasks) {
      const workspacePath = task.workspacePath ?? '';
      const group = groups.get(workspacePath) ?? [];
      group.push(task);
      groups.set(workspacePath, group);
    }

    return Array.from(groups, ([workspacePath, workspaceTasks]) => {
      const folder = vscode.workspace.workspaceFolders?.find(candidate => candidate.uri.fsPath === workspacePath);
      const label = folder?.name ?? (workspacePath ? path.basename(workspacePath) : 'Workspace');
      const group = new TaskTreeItem(label, vscode.TreeItemCollapsibleState.Collapsed, 'group', undefined, {
        groupKind: 'npmWorkspace',
        groupTasks: workspaceTasks
      });
      group.iconPath = new vscode.ThemeIcon('root-folder');
      return group;
    }).sort((left, right) => left.label.localeCompare(right.label));
  }

  private createNpmPackageGroups(tasks: TaskItemModel[]): TaskTreeItem[] {
    const groups = new Map<string, TaskItemModel[]>();
    for (const task of tasks) {
      const packagePath = task.folderName ?? '.';
      const group = groups.get(packagePath) ?? [];
      group.push(task);
      groups.set(packagePath, group);
    }

    return Array.from(groups, ([packagePath, packageTasks]) => {
      const label = packagePath === '.' ? 'Root package' : packagePath;
      const group = new TaskTreeItem(label, vscode.TreeItemCollapsibleState.Collapsed, 'group', undefined, {
        groupKind: 'npmPackage',
        groupTasks: packageTasks
      });
      group.iconPath = new vscode.ThemeIcon('folder');
      return group;
    }).sort((left, right) => left.label.localeCompare(right.label));
  }

  private createNpmTaskItem(task: TaskItemModel): TaskTreeItem {
    const item = new TaskTreeItem(task.label, vscode.TreeItemCollapsibleState.None, 'task', task);
    item.iconPath = new vscode.ThemeIcon('package');
    item.description = `${task.packageManager ?? 'npm'}${task.folderName ? ` - ${task.folderName}` : ''}`;
    item.tooltip = `${this.getTaskTooltip(task)}\nPackage manager: ${task.packageManager ?? 'npm'}`;
    return item;
  }

  private getTaskTooltip(task: TaskItemModel): string {
    const parts = [task.label, `Source: ${task.source}`];
    if (task.folderName) {
      parts.push(`Folder: ${task.folderName}`);
    }
    if (task.workspacePath) {
      parts.push(`Workspace: ${task.workspacePath}`);
    }
    return parts.join('\n');
  }

  private getVisibleRunningTasks(): RunningTask[] {
    const visibleTasks = new Set(this.filterTasks(this.getRunningTasks().map(task => task.task)).map(task => task.id));
    return this.getRunningTasks().filter(task => visibleTasks.has(task.task.id));
  }

  private getSourceDisplayName(source: string): string {
    const displayNames: { [key: string]: string } = {
      'npm': 'npm',
      'gulp': 'Gulp',
      'grunt': 'Grunt',
      'jake': 'Jake',
      'Workspace': 'Workspace',
      'shell': 'Shell',
      'process': 'Process',
      'extension': 'Extension',
      'ant': 'Ant',
      'other': 'Other'
    };
    return displayNames[source] || source.charAt(0).toUpperCase() + source.slice(1);
  }

  private getSourceFromDisplayName(displayName: string): string {
    const sourceMap: { [key: string]: string } = {
      'npm': 'npm',
      'Gulp': 'gulp',
      'Grunt': 'grunt',
      'Jake': 'jake',
      'Workspace': 'Workspace',
      'Shell': 'shell',
      'Process': 'process',
      'Extension': 'extension',
      'Ant': 'ant',
      'Other': 'other'
    };
    return sourceMap[displayName] || displayName.toLowerCase();
  }

  private getSourceIcon(source: string): vscode.ThemeIcon {
    const iconMap: { [key: string]: string } = {
      'npm': 'package',
      'gulp': 'beaker',
      'grunt': 'tools',
      'jake': 'tools',
      'Workspace': 'workspace-trusted',
      'shell': 'terminal',
      'process': 'gear',
      'extension': 'extensions',
      'ant': 'symbol-event',
      'other': 'question'
    };
    return new vscode.ThemeIcon(iconMap[source] || 'gear');
  }

  private getExcludedSources(): Set<string> {
    const config = vscode.workspace.getConfiguration('taskdeck');
    const excluded = config.get<string[]>('excludeSources', []);
    return new Set(excluded.map(s => s.toLowerCase()));
  }

  private filterTasks(tasks: TaskItemModel[]): TaskItemModel[] {
    const excludedSources = this.getExcludedSources();
    const lowerFilter = this.filterText.toLowerCase();
    return tasks.filter(task => {
      if (excludedSources.has(task.source.toLowerCase())) {
        return false;
      }
      if (!lowerFilter) {
        return true;
      }
      return [task.label, task.source, task.folderName, task.workspacePath]
        .some(value => value?.toLowerCase().includes(lowerFilter));
    });
  }

  private getFilteredTasks(): TaskItemModel[] {
    return this.filterTasks(this.tasks);
  }

  private getFilteredNpmScripts(): TaskItemModel[] {
    return this.filterTasks(this.npmScriptTasks);
  }

  private getFilteredAntTargets(): TaskItemModel[] {
    return this.filterTasks(this.antTargetTasks);
  }

  getVisibleTasks(): TaskItemModel[] {
    return [...this.getFilteredTasks(), ...this.getFilteredNpmScripts(), ...this.getFilteredAntTargets()];
  }

  getFavoriteTasks(tasks: TaskItemModel[]): TaskItemModel[] {
    const tasksById = new Map(tasks.map(task => [task.id, task]));
    return this.favorites
      .map(id => tasksById.get(id))
      .filter((task): task is TaskItemModel => task !== undefined);
  }

  getRecentTasks(tasks: TaskItemModel[]): TaskItemModel[] {
    return this.getRecentTaskEntries(tasks).map(entry => entry.task);
  }

  getRecentTaskEntries(tasks: TaskItemModel[]): Array<{ task: TaskItemModel; historyEntry: HistoryEntry }> {
    const tasksById = new Map(tasks.map(task => [task.id, task]));
    const runningTaskIds = new Set(this.getRunningTasks().map(task => task.task.id));
    const seen = new Set<string>();
    const recent: Array<{ task: TaskItemModel; historyEntry: HistoryEntry }> = [];
    for (const historyEntry of this.history.slice().reverse()) {
      if (seen.has(historyEntry.taskId)) {
        continue;
      }
      seen.add(historyEntry.taskId);
      if (runningTaskIds.has(historyEntry.taskId)) {
        continue;
      }
      const task = tasksById.get(historyEntry.taskId);
      if (task && !this.favorites.includes(task.id) && !this.taskbarPinned.has(task.id)) {
        recent.push({ task, historyEntry });
      }
      if (recent.length === 10) {
        break;
      }
    }
    return recent;
  }

  private formatHistoryEntry(entry: HistoryEntry): string {
    const status = entry.status ??
      (entry.exitCode === 0 ? 'succeeded' : entry.exitCode !== undefined ? 'failed' : 'completed');
    const statusLabel = status === 'succeeded' ? 'Succeeded'
      : status === 'failed' ? `Failed (exit ${entry.exitCode})`
      : status === 'terminated' ? 'Stopped'
      : status === 'running' ? 'Running'
      : status === 'interrupted' ? 'Interrupted'
      : 'Completed';
    const duration = entry.durationMs === undefined ? '' : ` · ${this.formatDuration(entry.durationMs)}`;
    return `${statusLabel} · ${new Date(entry.runAt).toLocaleString()}${duration}`;
  }

  private formatDuration(durationMs: number): string {
    const totalSeconds = Math.floor(durationMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
  }

  async setFilter(filterText: string): Promise<void> {
    this.filterText = filterText;
    this.refresh();
  }

  getFilterText(): string {
    return this.filterText;
  }

  async toggleFavorite(taskModel: TaskItemModel): Promise<void> {
    console.log('[TaskDeck] Toggling favorite for task:', taskModel.id);
    const index = this.favorites.indexOf(taskModel.id);
    if (index !== -1) {
      console.log('[TaskDeck] Removing from favorites');
      this.favorites.splice(index, 1);
    } else {
      console.log('[TaskDeck] Adding to favorites');
      this.favorites.push(taskModel.id);
    }
    await this.saveFavorites();
    console.log('[TaskDeck] Favorites saved, refreshing tree');
    this.refresh();
  }

  isFavorite(taskId: string): boolean {
    return this.favorites.includes(taskId);
  }

  async moveFavoriteUp(taskId: string): Promise<void> {
    const index = this.favorites.indexOf(taskId);
    if (index > 0) {
      [this.favorites[index - 1], this.favorites[index]] = [this.favorites[index], this.favorites[index - 1]];
      await this.saveFavorites();
      this.refresh();
    }
  }

  async moveFavoriteDown(taskId: string): Promise<void> {
    const index = this.favorites.indexOf(taskId);
    if (index !== -1 && index < this.favorites.length - 1) {
      [this.favorites[index], this.favorites[index + 1]] = [this.favorites[index + 1], this.favorites[index]];
      await this.saveFavorites();
      this.refresh();
    }
  }

  async reorderFavorite(taskId: string, targetTaskId: string): Promise<void> {
    const fromIndex = this.favorites.indexOf(taskId);
    if (fromIndex === -1) { return; }
    this.favorites.splice(fromIndex, 1);
    const toIndex = this.favorites.indexOf(targetTaskId);
    if (toIndex === -1) {
      this.favorites.push(taskId);
    } else {
      this.favorites.splice(toIndex, 0, taskId);
    }
    await this.saveFavorites();
    this.refresh();
  }

  private loadFavorites(): void {
    this.favorites = this.globalState.get<string[]>('taskdeck.favorites', []);
  }

  private async saveFavorites(): Promise<void> {
    await this.globalState.update('taskdeck.favorites', this.favorites);
  }

  private loadHistory(): void {
    const savedHistory = this.globalState.get<HistoryEntry[]>('taskdeck.history', []);
    let interruptedTasks = false;
    this.history = savedHistory.map(entry => {
      if (entry.status !== 'running') {
        return entry;
      }
      interruptedTasks = true;
      return { ...entry, status: 'interrupted' };
    });
    if (interruptedTasks) {
      void this.saveHistory().catch(error => console.error('Failed to save task history:', error));
    }
  }

  private async saveHistory(): Promise<void> {
    const snapshot = this.history.map(entry => ({ ...entry }));
    this.historySavePromise = this.historySavePromise
      .catch(error => {
        console.error('Failed to save task history:', error);
      })
      .then(() => this.globalState.update('taskdeck.history', snapshot));
    await this.historySavePromise;
  }

  getTasks(): TaskItemModel[] {
    return [...this.tasks, ...this.npmScriptTasks, ...this.antTargetTasks];
  }

  getTaskById(taskId: string): TaskItemModel | undefined {
    return this.tasks.find(t => t.id === taskId) || this.npmScriptTasks.find(t => t.id === taskId) || this.antTargetTasks.find(t => t.id === taskId);
  }

  getHistory(): HistoryEntry[] {
    return this.history;
  }

  async startTask(execution: vscode.TaskExecution, startedAt = Date.now()): Promise<RunningTask> {
    const task = this.getTaskById(this.createId(execution.task)) ?? this.createTaskModel(execution.task);
    const historyEntry: HistoryEntry = {
      taskId: task.id,
      label: task.label,
      runAt: startedAt,
      status: 'running'
    };
    const runningTask: RunningTask = {
      id: ++this.nextRunningTaskId,
      execution,
      task,
      startedAt,
      historyEntry
    };
    this.runningTasks.set(execution, runningTask);
    this.history.push(historyEntry);
    while (this.history.length > 20) {
      const completedIndex = this.history.findIndex(entry => entry.status !== 'running');
      if (completedIndex === -1) {
        break;
      }
      this.history.splice(completedIndex, 1);
    }
    try {
      await this.saveHistory();
    } finally {
      this.refresh();
    }
    return runningTask;
  }

  recordTaskExitCode(execution: vscode.TaskExecution, exitCode: number | undefined): void {
    if (this.runningTasks.has(execution)) {
      this.taskExitCodes.set(execution, exitCode);
    }
  }

  async finishTask(execution: vscode.TaskExecution, finishedAt = Date.now()): Promise<HistoryEntry | undefined> {
    const runningTask = this.runningTasks.get(execution);
    if (!runningTask) {
      return undefined;
    }

    this.runningTasks.delete(execution);
    const hasExitCode = this.taskExitCodes.has(execution);
    const exitCode = this.taskExitCodes.get(execution);
    this.taskExitCodes.delete(execution);
    if (hasExitCode && exitCode !== undefined) {
      runningTask.historyEntry.exitCode = exitCode;
    }
    runningTask.historyEntry.status = !hasExitCode
      ? 'completed'
      : exitCode === undefined ? 'terminated'
      : exitCode === 0 ? 'succeeded' : 'failed';
    runningTask.historyEntry.durationMs = Math.max(0, finishedAt - runningTask.startedAt);
    try {
      await this.saveHistory();
    } finally {
      this.refresh();
    }
    return runningTask.historyEntry;
  }

  getRunningTasks(): RunningTask[] {
    return Array.from(this.runningTasks.values());
  }

  getRunningTaskById(id: number): RunningTask | undefined {
    return this.getRunningTasks().find(task => task.id === id);
  }

  async toggleTaskbarPin(taskModel: TaskItemModel): Promise<void> {
    console.log('[TaskDeck] Toggling taskbar pin for task:', taskModel.id);
    if (this.taskbarPinned.has(taskModel.id)) {
      console.log('[TaskDeck] Removing from taskbar');
      this.taskbarPinned.delete(taskModel.id);
    } else {
      console.log('[TaskDeck] Adding to taskbar');
      this.taskbarPinned.add(taskModel.id);
    }
    await this.saveTaskbarPinned();
    console.log('[TaskDeck] Taskbar pins saved');
    this.refresh();
  }

  isTaskbarPinned(taskId: string): boolean {
    return this.taskbarPinned.has(taskId);
  }

  getTaskbarPinnedTasks(): TaskItemModel[] {
    const allTasks = [...this.tasks, ...this.npmScriptTasks, ...this.antTargetTasks];
    const excludedSources = this.getExcludedSources();
    return allTasks.filter(t => this.taskbarPinned.has(t.id) && !excludedSources.has(t.source.toLowerCase()));
  }

  private loadTaskbarPinned(): void {
    const saved = this.globalState.get<string[]>('taskdeck.taskbarPinned', []);
    this.taskbarPinned = new Set(saved);
  }

  private async saveTaskbarPinned(): Promise<void> {
    await this.globalState.update('taskdeck.taskbarPinned', Array.from(this.taskbarPinned));
  }
}

const FAVORITE_MIME_TYPE = 'application/vnd.code.tree.taskdeck.favorite';

class FavoriteDragAndDropController implements vscode.TreeDragAndDropController<TaskTreeItem> {
  readonly dropMimeTypes = [FAVORITE_MIME_TYPE];
  readonly dragMimeTypes = [FAVORITE_MIME_TYPE];

  constructor(private treeProvider: TaskTreeProvider) {}

  handleDrag(source: readonly TaskTreeItem[], dataTransfer: vscode.DataTransfer): void {
    const favoriteItem = source.find(s => s.contextValue === 'favoriteTask' && s.taskModel);
    if (favoriteItem?.taskModel) {
      dataTransfer.set(FAVORITE_MIME_TYPE, new vscode.DataTransferItem(favoriteItem.taskModel.id));
    }
  }

  async handleDrop(target: TaskTreeItem | undefined, dataTransfer: vscode.DataTransfer): Promise<void> {
    const draggedId = dataTransfer.get(FAVORITE_MIME_TYPE)?.value;
    if (!draggedId || !target?.taskModel || target.contextValue !== 'favoriteTask') {
      return;
    }
    if (draggedId === target.taskModel.id) {
      return;
    }
    await this.treeProvider.reorderFavorite(draggedId, target.taskModel.id);
  }
}

export function activate(context: vscode.ExtensionContext) {
  console.log('TaskDeck extension is now active!');

  // Create the tree data provider
  const treeProvider = new TaskTreeProvider(context.globalState);

  // Create the tree view with drag-and-drop for favorite reordering
  const dragAndDropController = new FavoriteDragAndDropController(treeProvider);
  const treeView = vscode.window.createTreeView('taskdeck.tasksView', {
    treeDataProvider: treeProvider,
    dragAndDropController
  });

  // Status bar item
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);

  // Taskbar status bar items for pinned tasks
  const taskbarStatusBarItems: Map<string, vscode.StatusBarItem> = new Map();
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let completionTimeout: ReturnType<typeof setTimeout> | undefined;
  let lastCompletedEntry: HistoryEntry | undefined;

  // Function to update taskbar status bar items
  function updateTaskbarItems() {
    // Clear existing items
    taskbarStatusBarItems.forEach(item => item.dispose());
    taskbarStatusBarItems.clear();

    // Create new items for pinned tasks
    const pinnedTasks = treeProvider.getTaskbarPinnedTasks();
    pinnedTasks.forEach((task, index) => {
      const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99 - index);
      item.text = `$(play-circle) ${task.label}`;
      item.tooltip = `Run: ${task.label}\nSource: ${task.source}${task.folderName ? `\nFolder: ${task.folderName}` : ''}\nRight-click to unpin`;
      item.command = {
        command: 'taskdeck.runTaskFromTaskbar',
        title: 'Run Task',
        arguments: [task.id]
      };
      item.show();
      taskbarStatusBarItems.set(task.id, item);
    });
  }

  function updateTaskStatus(completedEntry?: HistoryEntry) {
    const runningTasks = treeProvider.getRunningTasks();
    if (completionTimeout) {
      clearTimeout(completionTimeout);
      completionTimeout = undefined;
    }

    if (runningTasks.length > 0) {
      lastCompletedEntry = undefined;
      const current = runningTasks[runningTasks.length - 1];
      statusBarItem.text = runningTasks.length === 1
        ? `$(terminal) ${current.task.label}`
        : `$(terminal) ${runningTasks.length} tasks running`;
      statusBarItem.tooltip = `Running:\n${runningTasks.map(task => task.task.label).join('\n')}`;
      statusBarItem.command = {
        command: 'taskdeck.focusTaskTerminal',
        title: 'Focus Task Terminal',
        arguments: [current.id]
      };
      statusBarItem.show();
      return;
    }

    if (completedEntry) {
      lastCompletedEntry = completedEntry;
      statusBarItem.text = completedEntry.status === 'succeeded'
        ? `$(check) ${completedEntry.label}`
        : completedEntry.status === 'failed'
          ? `$(error) ${completedEntry.label}`
          : completedEntry.status === 'terminated'
            ? `$(debug-stop) ${completedEntry.label}`
            : `$(terminal) ${completedEntry.label}`;
      statusBarItem.tooltip = `${completedEntry.status ?? 'completed'}${completedEntry.exitCode === undefined ? '' : ` (exit code ${completedEntry.exitCode})`}`;
      statusBarItem.command = 'workbench.action.terminal.focus';
      statusBarItem.show();
      completionTimeout = setTimeout(() => {
        if (lastCompletedEntry === completedEntry && treeProvider.getRunningTasks().length === 0) {
          statusBarItem.hide();
          lastCompletedEntry = undefined;
        }
      }, 5000);
      return;
    }

    statusBarItem.hide();
  }

  async function focusTaskTerminal(runningTask: RunningTask): Promise<void> {
    const terminalNames = new Set([runningTask.task.label, `Task - ${runningTask.task.label}`]);
    const matchingTerminals = vscode.window.terminals.filter(terminal => terminalNames.has(terminal.name));
    if (matchingTerminals.length === 1) {
      matchingTerminals[0].show();
      return;
    }
    if (matchingTerminals.length > 1) {
      const selected = await vscode.window.showQuickPick(
        matchingTerminals.map((terminal, index) => ({
          label: terminal.name,
          description: `Terminal ${index + 1}`,
          terminal
        })),
        { placeHolder: `Select a terminal for ${runningTask.task.label}` }
      );
      selected?.terminal.show();
      return;
    }
    await vscode.commands.executeCommand('workbench.action.terminal.focus');
  }

  async function updateFilterContext(): Promise<void> {
    const filterText = treeProvider.getFilterText();
    treeView.description = filterText ? `Filter: ${filterText}` : undefined;
    await vscode.commands.executeCommand('setContext', 'taskdeck.hasFilter', Boolean(filterText));
  }

  void updateFilterContext().catch(error => console.error('Failed to update filter context:', error));

  function scheduleTaskRefresh(uri?: vscode.Uri) {
    if (uri?.fsPath.split(path.sep).some(segment => segment.toLowerCase() === 'node_modules')) {
      return;
    }
    if (refreshTimer) {
      clearTimeout(refreshTimer);
    }
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      void treeProvider.reloadTasks().then(updateTaskbarItems);
    }, 200);
  }

  for (const pattern of ['**/package.json', '**/build.xml', '**/.vscode/tasks.json']) {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    context.subscriptions.push(
      watcher,
      watcher.onDidCreate(uri => scheduleTaskRefresh(uri)),
      watcher.onDidChange(uri => scheduleTaskRefresh(uri)),
      watcher.onDidDelete(uri => scheduleTaskRefresh(uri))
    );
  }

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(() => scheduleTaskRefresh()),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('taskdeck.excludeSources')) {
        treeProvider.refresh();
        updateTaskbarItems();
      }
    }),
    {
      dispose: () => {
        if (refreshTimer) {
          clearTimeout(refreshTimer);
        }
      }
    }
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('taskdeck.refreshTasks', async () => {
      await treeProvider.reloadTasks();
      treeProvider.refresh();
      updateTaskbarItems();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('taskdeck.moveFavoriteUp', async (item: TaskTreeItem) => {
      if (item?.taskModel) {
        await treeProvider.moveFavoriteUp(item.taskModel.id);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('taskdeck.moveFavoriteDown', async (item: TaskTreeItem) => {
      if (item?.taskModel) {
        await treeProvider.moveFavoriteDown(item.taskModel.id);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('taskdeck.runTask', async (item?: TaskTreeItem) => {
      try {
        console.log('[TaskDeck] runTask command invoked with item:', item);
        
        let taskModel: TaskItemModel | undefined;
        
        // Use taskModel directly from the TreeItem to avoid ID lookup issues
        if (item && item.taskModel) {
          console.log('[TaskDeck] Using taskModel from TreeItem:', item.taskModel.label);
          taskModel = item.taskModel;
        }
        
        if (!taskModel) {
          console.log('[TaskDeck] No task found, showing quick pick');
          // No task provided, show quick pick
          await vscode.commands.executeCommand('taskdeck.runTaskQuickPick');
          return;
        }

        console.log('[TaskDeck] Executing task:', taskModel.label);
        await vscode.tasks.executeTask(taskModel.vscodeTask);
      } catch (error) {
        console.error('[TaskDeck] Failed to run task:', error);
        vscode.window.showErrorMessage(`Failed to run task: ${error}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('taskdeck.toggleFavorite', async (item: TaskTreeItem) => {
      console.log('[TaskDeck] toggleFavorite command invoked with item:', item);
      
      let taskModel: TaskItemModel | undefined;
      
      // Use taskModel directly from the TreeItem to avoid ID lookup issues
      if (item && item.taskModel) {
        console.log('[TaskDeck] Using taskModel from TreeItem:', item.taskModel.label);
        taskModel = item.taskModel;
      }
      
      if (taskModel) {
        console.log('[TaskDeck] Task model found:', taskModel.id);
        await treeProvider.toggleFavorite(taskModel);
      } else {
        console.log('[TaskDeck] No task model found');
        vscode.window.showErrorMessage('No task selected');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('taskdeck.setFilter', async () => {
      const filterText = await vscode.window.showInputBox({
        prompt: 'Enter filter text (searches task name, source, package, and workspace)',
        placeHolder: 'Filter tasks...',
        value: treeProvider.getFilterText()
      });

      if (filterText !== undefined) {
        await treeProvider.setFilter(filterText);
        await updateFilterContext();
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('taskdeck.clearFilter', async () => {
      await treeProvider.setFilter('');
      await updateFilterContext();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('taskdeck.openTaskDefinition', async (item?: TaskTreeItem) => {
      const definitionUri = item?.taskModel?.definitionUri;
      if (!definitionUri) {
        vscode.window.showErrorMessage('No task definition file is available for this task.');
        return;
      }

      try {
        await vscode.window.showTextDocument(definitionUri);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to open task definition: ${error}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('taskdeck.stopTask', (item?: TaskTreeItem) => {
      if (!item?.execution) {
        vscode.window.showErrorMessage('No running task selected.');
        return;
      }
      item.execution.terminate();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('taskdeck.restartTask', async (item?: TaskTreeItem) => {
      const runningTask = item?.runningTask;
      if (!runningTask || !treeProvider.getRunningTaskById(runningTask.id)) {
        vscode.window.showErrorMessage('No running task selected.');
        return;
      }

      const taskEnded = new Promise<void>(resolve => {
        const subscription = vscode.tasks.onDidEndTask(event => {
          if (event.execution === runningTask.execution) {
            subscription.dispose();
            resolve();
          }
        });
      });

      runningTask.execution.terminate();
      await taskEnded;
      try {
        await vscode.tasks.executeTask(runningTask.task.vscodeTask);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to restart task: ${error}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('taskdeck.focusTaskTerminal', async (itemOrId?: TaskTreeItem | number) => {
      const runningTask = typeof itemOrId === 'number'
        ? treeProvider.getRunningTaskById(itemOrId)
        : itemOrId?.runningTask;
      if (runningTask) {
        await focusTaskTerminal(runningTask);
      } else {
        await vscode.commands.executeCommand('workbench.action.terminal.focus');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('taskdeck.sendToTaskbar', async (item: TaskTreeItem) => {
      console.log('[TaskDeck] sendToTaskbar command invoked with item:', item);
      
      let taskModel: TaskItemModel | undefined;
      
      // Use taskModel directly from the TreeItem to avoid ID lookup issues
      if (item && item.taskModel) {
        console.log('[TaskDeck] Using taskModel from TreeItem:', item.taskModel.label);
        taskModel = item.taskModel;
      }
      
      if (taskModel) {
        console.log('[TaskDeck] Task model found:', taskModel.id);
        await treeProvider.toggleTaskbarPin(taskModel);
        updateTaskbarItems();
      } else {
        console.log('[TaskDeck] No task model found');
        vscode.window.showErrorMessage('No task selected');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('taskdeck.runTaskFromTaskbar', async (taskId: string) => {
      console.log('[TaskDeck] runTaskFromTaskbar command invoked for task ID:', taskId);
      
      const taskModel = treeProvider.getTaskById(taskId);
      
      if (taskModel) {
        console.log('[TaskDeck] Executing task from taskbar:', taskModel.label);
        await vscode.tasks.executeTask(taskModel.vscodeTask);
      } else {
        console.log('[TaskDeck] Task not found');
        vscode.window.showErrorMessage('Task not found');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('taskdeck.runTaskQuickPick', async () => {
      await treeProvider.ensureTasksLoaded();
      const tasks = treeProvider.getVisibleTasks();

      if (tasks.length === 0) {
        const message = treeProvider.getTasks().length > 0
          ? 'No tasks match the current filter'
          : 'No tasks found';
        vscode.window.showInformationMessage(message);
        return;
      }

      // Create quick pick items
      const items: TaskQuickPickItem[] = [];

      // Add favorites
      const favoriteTasks = treeProvider.getFavoriteTasks(tasks);
      if (favoriteTasks.length > 0) {
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
        items.push({ label: 'Favorites', kind: vscode.QuickPickItemKind.Separator });
        favoriteTasks.forEach(task => {
          const descriptionParts = [task.source];
          if (task.folderName) {
            descriptionParts.push(task.folderName);
          }
          items.push({
            label: `$(star-full) ${task.label}`,
            description: descriptionParts.join(' - '),
            detail: task.id,
            taskId: task.id
          });
        });
      }

      // Add pinned tasks
      const pinnedTasks = tasks.filter(t => treeProvider.isTaskbarPinned(t.id) && !treeProvider.isFavorite(t.id));
      if (pinnedTasks.length > 0) {
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
        items.push({ label: 'Pinned', kind: vscode.QuickPickItemKind.Separator });
        pinnedTasks.forEach(task => {
          const descriptionParts = [task.source];
          if (task.folderName) {
            descriptionParts.push(task.folderName);
          }
          items.push({
            label: `$(pinned) ${task.label}`,
            description: descriptionParts.join(' - '),
            detail: task.id,
            taskId: task.id
          });
        });
      }

      // Add recents
      const recentTasks = treeProvider.getRecentTasks(tasks);

      if (recentTasks.length > 0) {
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
        items.push({ label: 'Recent', kind: vscode.QuickPickItemKind.Separator });
        recentTasks.forEach(task => {
          const descriptionParts = [task.source];
          if (task.folderName) {
            descriptionParts.push(task.folderName);
          }
          items.push({
            label: `$(history) ${task.label}`,
            description: descriptionParts.join(' - '),
            detail: task.id,
            taskId: task.id
          });
        });
      }

      // Add all other tasks
      const favoriteIds = new Set(favoriteTasks.map(t => t.id));
      const recentIds = new Set(recentTasks.map(t => t.id));
      const pinnedIds = new Set(pinnedTasks.map(t => t.id));
      const otherTasks = tasks.filter(t => !favoriteIds.has(t.id) && !recentIds.has(t.id) && !pinnedIds.has(t.id));

      // Separate npm scripts and ant targets from other tasks
      const npmScriptTasks = otherTasks.filter(t => t.source === 'npm script');
      const antTargetTasks = otherTasks.filter(t => t.source === 'ant');
      const regularTasks = otherTasks.filter(t => t.source !== 'npm script' && t.source !== 'ant');

      // Add npm scripts section
      if (npmScriptTasks.length > 0) {
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
        items.push({ label: 'npm scripts', kind: vscode.QuickPickItemKind.Separator });
        npmScriptTasks.forEach(task => {
          const descriptionParts = [`${task.packageManager ?? 'npm'} script`];
          if (task.folderName) {
            descriptionParts.push(task.folderName);
          }
          items.push({
            label: `$(package) ${task.label}`,
            description: descriptionParts.join(' - '),
            detail: task.workspacePath ? `Workspace: ${task.workspacePath}` : undefined,
            taskId: task.id
          });
        });
      }

      // Add Ant targets section
      if (antTargetTasks.length > 0) {
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
        items.push({ label: 'Ant targets', kind: vscode.QuickPickItemKind.Separator });
        antTargetTasks.forEach(task => {
          const descriptionParts = [task.source];
          if (task.folderName) {
            descriptionParts.push(task.folderName);
          }
          items.push({
            label: `$(symbol-event) ${task.label}`,
            description: descriptionParts.join(' - '),
            detail: task.workspacePath ? `Workspace: ${task.workspacePath}` : undefined,
            taskId: task.id
          });
        });
      }

      // Add other tasks
      if (regularTasks.length > 0) {
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
        items.push({ label: 'All Tasks', kind: vscode.QuickPickItemKind.Separator });
        regularTasks.forEach(task => {
          const descriptionParts = [task.source];
          if (task.folderName) {
            descriptionParts.push(task.folderName);
          }
          items.push({
            label: `$(play-circle) ${task.label}`,
            description: descriptionParts.join(' - '),
            detail: task.id,
            taskId: task.id
          });
        });
      }

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a task to run'
      });

      if (selected?.taskId) {
        const task = tasks.find(t => t.id === selected.taskId);
        if (task) {
          await vscode.tasks.executeTask(task.vscodeTask);
        }
      }
    })
  );

  // Task event listeners
  context.subscriptions.push(
    vscode.tasks.onDidStartTask(async (event: vscode.TaskStartEvent) => {
      try {
        await treeProvider.startTask(event.execution);
        updateTaskStatus();
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to record task start: ${error}`);
      }
    })
  );

  context.subscriptions.push(
    vscode.tasks.onDidEndTaskProcess((e: vscode.TaskProcessEndEvent) => {
      treeProvider.recordTaskExitCode(e.execution, e.exitCode);
    })
  );

  context.subscriptions.push(
    vscode.tasks.onDidEndTask(async event => {
      try {
        const completedEntry = await treeProvider.finishTask(event.execution);
        updateTaskStatus(completedEntry);
      } catch (error) {
        vscode.window.showErrorMessage(`Failed to update task history: ${error}`);
      }
    })
  );

  // Initial load
  treeProvider.loadTasks().then(() => {
    treeProvider.refresh();
    updateTaskbarItems();
  });

  // Add to subscriptions
  context.subscriptions.push(treeView);
  context.subscriptions.push(statusBarItem);
  context.subscriptions.push({
    dispose: () => {
      if (completionTimeout) {
        clearTimeout(completionTimeout);
      }
      taskbarStatusBarItems.forEach(item => item.dispose());
      taskbarStatusBarItems.clear();
    }
  });
  return { treeProvider };
}

export function deactivate() {
  // Cleanup
}
