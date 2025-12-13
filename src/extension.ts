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
  vscodeTask: vscode.Task;
}

interface NpmScript {
  name: string;
  script: string;
  packageJsonPath: string;
  folderName: string;
  workspacePath: string;
}

interface HistoryEntry {
  taskId: string;
  label: string;
  runAt: number;
  exitCode?: number;
}

// Tree item types
type TreeItemType = 'group' | 'task';

class TaskTreeItem extends vscode.TreeItem {
  public taskModel?: TaskItemModel;
  public taskId?: string;
  
  constructor(
    public readonly label: string,
    public readonly collapsibleState: vscode.TreeItemCollapsibleState,
    public readonly itemType: TreeItemType,
    taskModel?: TaskItemModel
  ) {
    super(label, collapsibleState);
    this.taskModel = taskModel;

    if (itemType === 'task' && taskModel) {
      this.contextValue = 'task';
      this.id = taskModel.id; // Set unique ID for VS Code
      this.taskId = taskModel.id; // Store for command lookup
      this.tooltip = `${taskModel.label} (${taskModel.source})${taskModel.folderName ? ` - ${taskModel.folderName}` : ''}`;
      this.description = taskModel.source + (taskModel.folderName ? ` - ${taskModel.folderName}` : '');
    } else if (itemType === 'group') {
      this.contextValue = 'group';
      this.id = `group-${label}`; // Unique ID for groups
    }
  }
}

class TaskTreeProvider implements vscode.TreeDataProvider<TaskTreeItem> {
  private _onDidChangeTreeData: vscode.EventEmitter<TaskTreeItem | undefined | null | void> = new vscode.EventEmitter<TaskTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData: vscode.Event<TaskTreeItem | undefined | null | void> = this._onDidChangeTreeData.event;

  private tasks: TaskItemModel[] = [];
  private npmScriptTasks: TaskItemModel[] = [];
  private favorites: Set<string> = new Set();
  private history: HistoryEntry[] = [];
  private filterText: string = '';
  private taskbarPinned: Set<string> = new Set();

  constructor(private context: vscode.ExtensionContext) {
    this.loadFavorites();
    this.loadHistory();
    this.loadTaskbarPinned();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  async loadTasks(): Promise<void> {
    try {
      const allTasks = await vscode.tasks.fetchTasks();
      // Filter out built-in npm tasks since we load them separately with enhanced info
      this.tasks = allTasks
        .filter(task => task.source !== 'npm')
        .map(task => this.createTaskModel(task));
      
      // Load npm scripts separately with enhanced workspace/folder info
      await this.loadNpmScripts();
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to load tasks: ${error}`);
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
          
          if (packageJson.scripts) {
            const packageDir = path.dirname(file.fsPath);
            const relativePath = path.relative(folder.uri.fsPath, packageDir);
            const folderName = relativePath || folder.name;
            
            for (const [scriptName, scriptCommand] of Object.entries(packageJson.scripts)) {
              npmScripts.push({
                name: scriptName,
                script: scriptCommand as string,
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
      path: packageDir
    };

    const task = new vscode.Task(
      definition,
      workspaceFolder || vscode.TaskScope.Workspace,
      npmScript.name,
      'npm script',
      new vscode.ShellExecution(`npm run ${npmScript.name}`, { cwd: packageDir })
    );

    return task;
  }

  createTaskModel(task: vscode.Task): TaskItemModel {
    const folderName = task.scope && typeof task.scope !== 'number' ? task.scope.name : undefined;
    const id = this.createId(task);
    return {
      id,
      label: task.name,
      source: task.source,
      folderName,
      workspacePath: undefined,
      vscodeTask: task
    };
  }

  createId(task: vscode.Task): string {
    const folderName = task.scope && typeof task.scope !== 'number' ? task.scope.name : 'global';
    return `${folderName}:${task.source}:${task.name}`;
  }

  getTreeItem(element: TaskTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: TaskTreeItem): Promise<TaskTreeItem[]> {
    if (!element) {
      // Root level - show top-level groups
      // Only load tasks if not already loaded
      if (this.tasks.length === 0) {
        await this.loadTasks();
      }

      const filteredTasks = this.getFilteredTasks();
      const filteredNpmScripts = this.getFilteredNpmScripts();
      const allFilteredTasks = [...filteredTasks, ...filteredNpmScripts];
      const result: TaskTreeItem[] = [];

      // Create a map of task IDs for quick lookup
      const taskMap = new Map<string, TaskItemModel>();
      allFilteredTasks.forEach(task => taskMap.set(task.id, task));

      // Split into favorites and others
      const favoriteTasks: TaskItemModel[] = [];
      const nonFavoriteTasks: TaskItemModel[] = [];

      allFilteredTasks.forEach(task => {
        if (this.favorites.has(task.id)) {
          favoriteTasks.push(task);
        } else {
          nonFavoriteTasks.push(task);
        }
      });

      // Favorites group
      if (favoriteTasks.length > 0) {
        const favGroup = new TaskTreeItem('Favorites', vscode.TreeItemCollapsibleState.Expanded, 'group');
        favGroup.iconPath = new vscode.ThemeIcon('star-full');
        result.push(favGroup);
      }

      // Pinned group
      const pinnedTasks = allFilteredTasks.filter(t => this.taskbarPinned.has(t.id) && !this.favorites.has(t.id));
      if (pinnedTasks.length > 0) {
        const pinnedGroup = new TaskTreeItem('Pinned', vscode.TreeItemCollapsibleState.Expanded, 'group');
        pinnedGroup.iconPath = new vscode.ThemeIcon('pinned');
        result.push(pinnedGroup);
      }

      // Recent group
      const recentTaskIds = this.history
        .slice()
        .reverse()
        .map(h => h.taskId)
        .filter((id, index, self) => self.indexOf(id) === index) // Unique
        .slice(0, 10);

      const recentTasks = recentTaskIds
        .map(id => taskMap.get(id))
        .filter(t => t && !this.favorites.has(t.id) && !this.taskbarPinned.has(t.id)) as TaskItemModel[];

      if (recentTasks.length > 0) {
        const recentGroup = new TaskTreeItem('Recent', vscode.TreeItemCollapsibleState.Expanded, 'group');
        recentGroup.iconPath = new vscode.ThemeIcon('history');
        result.push(recentGroup);
      }

      // npm scripts group (only show if there are npm scripts)
      const recentIds = new Set(recentTaskIds);
      const pinnedIds = new Set(pinnedTasks.map(t => t.id));
      
      if (filteredNpmScripts.length > 0) {
        const npmScriptsToShow = filteredNpmScripts.filter(t => !this.favorites.has(t.id) && !pinnedIds.has(t.id) && !recentIds.has(t.id));
        
        if (npmScriptsToShow.length > 0) {
          const npmScriptsGroup = new TaskTreeItem('npm scripts', vscode.TreeItemCollapsibleState.Expanded, 'group');
          npmScriptsGroup.iconPath = new vscode.ThemeIcon('package');
          result.push(npmScriptsGroup);
        }
      }

      // Group other tasks by source
      const otherTasks = nonFavoriteTasks.filter(t => !pinnedIds.has(t.id) && !recentIds.has(t.id) && t.source !== 'npm script');

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
            'group'
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
      const allFilteredTasks = [...filteredTasks, ...filteredNpmScripts];
      const taskMap = new Map<string, TaskItemModel>();
      allFilteredTasks.forEach(task => taskMap.set(task.id, task));

      if (element.label === 'Favorites') {
        const favoriteTasks = allFilteredTasks.filter(t => this.favorites.has(t.id));
        return favoriteTasks.map(task => {
          const item = new TaskTreeItem(task.label, vscode.TreeItemCollapsibleState.None, 'task', task);
          item.iconPath = new vscode.ThemeIcon('star-full');
          return item;
        });
      } else if (element.label === 'Pinned') {
        const pinnedTasks = allFilteredTasks.filter(t => this.taskbarPinned.has(t.id) && !this.favorites.has(t.id));
        return pinnedTasks.map(task => {
          const item = new TaskTreeItem(task.label, vscode.TreeItemCollapsibleState.None, 'task', task);
          item.iconPath = new vscode.ThemeIcon('pinned');
          return item;
        });
      } else if (element.label === 'Recent') {
        const recentTaskIds = this.history
          .slice()
          .reverse()
          .map(h => h.taskId)
          .filter((id, index, self) => self.indexOf(id) === index)
          .slice(0, 10);

        const recentTasks = recentTaskIds
          .map(id => taskMap.get(id))
          .filter(t => t && !this.favorites.has(t.id) && !this.taskbarPinned.has(t.id)) as TaskItemModel[];

        return recentTasks.map(task => {
          const item = new TaskTreeItem(task.label, vscode.TreeItemCollapsibleState.None, 'task', task);
          item.iconPath = new vscode.ThemeIcon('history');
          return item;
        });
      } else if (element.label === 'npm scripts') {
        // Show npm script tasks
        const recentTaskIds = this.history
          .slice()
          .reverse()
          .map(h => h.taskId)
          .filter((id, index, self) => self.indexOf(id) === index)
          .slice(0, 10);
        const recentIds = new Set(recentTaskIds);

        const npmScriptTasks = filteredNpmScripts.filter(
          t => !this.favorites.has(t.id) && !this.taskbarPinned.has(t.id) && !recentIds.has(t.id)
        );

        return npmScriptTasks.map(task => {
          const item = new TaskTreeItem(task.label, vscode.TreeItemCollapsibleState.None, 'task', task);
          item.iconPath = new vscode.ThemeIcon('package');
          
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
        // This is a source group - show tasks for this source
        const sourceName = this.getSourceFromDisplayName(element.label);
        const recentTaskIds = this.history
          .slice()
          .reverse()
          .map(h => h.taskId)
          .filter((id, index, self) => self.indexOf(id) === index)
          .slice(0, 10);
        const recentIds = new Set(recentTaskIds);

        const sourceTasks = filteredTasks.filter(
          t => t.source === sourceName && !this.favorites.has(t.id) && !this.taskbarPinned.has(t.id) && !recentIds.has(t.id)
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
      'other': 'question'
    };
    return new vscode.ThemeIcon(iconMap[source] || 'gear');
  }

  private getFilteredTasks(): TaskItemModel[] {
    if (!this.filterText) {
      return this.tasks;
    }

    const lowerFilter = this.filterText.toLowerCase();
    return this.tasks.filter(task => {
      return (
        task.label.toLowerCase().includes(lowerFilter) ||
        task.source.toLowerCase().includes(lowerFilter) ||
        (task.folderName && task.folderName.toLowerCase().includes(lowerFilter))
      );
    });
  }

  private getFilteredNpmScripts(): TaskItemModel[] {
    if (!this.filterText) {
      return this.npmScriptTasks;
    }

    const lowerFilter = this.filterText.toLowerCase();
    return this.npmScriptTasks.filter(task => {
      return (
        task.label.toLowerCase().includes(lowerFilter) ||
        task.source.toLowerCase().includes(lowerFilter) ||
        (task.folderName && task.folderName.toLowerCase().includes(lowerFilter)) ||
        (task.workspacePath && task.workspacePath.toLowerCase().includes(lowerFilter))
      );
    });
  }

  async setFilter(filterText: string): Promise<void> {
    this.filterText = filterText;
    this.refresh();
  }

  async toggleFavorite(taskModel: TaskItemModel): Promise<void> {
    console.log('[TaskDeck] Toggling favorite for task:', taskModel.id);
    if (this.favorites.has(taskModel.id)) {
      console.log('[TaskDeck] Removing from favorites');
      this.favorites.delete(taskModel.id);
    } else {
      console.log('[TaskDeck] Adding to favorites');
      this.favorites.add(taskModel.id);
    }
    await this.saveFavorites();
    console.log('[TaskDeck] Favorites saved, refreshing tree');
    this.refresh();
  }

  isFavorite(taskId: string): boolean {
    return this.favorites.has(taskId);
  }

  addToHistory(taskId: string, label: string, exitCode?: number): void {
    const entry: HistoryEntry = {
      taskId,
      label,
      runAt: Date.now(),
      exitCode
    };

    this.history.push(entry);

    // Keep only last 20 entries
    if (this.history.length > 20) {
      this.history = this.history.slice(-20);
    }

    this.saveHistory();
    this.refresh();
  }

  private loadFavorites(): void {
    const saved = this.context.globalState.get<string[]>('taskdeck.favorites', []);
    this.favorites = new Set(saved);
  }

  private async saveFavorites(): Promise<void> {
    await this.context.globalState.update('taskdeck.favorites', Array.from(this.favorites));
  }

  private loadHistory(): void {
    this.history = this.context.globalState.get<HistoryEntry[]>('taskdeck.history', []);
  }

  private async saveHistory(): Promise<void> {
    await this.context.globalState.update('taskdeck.history', this.history);
  }

  getTasks(): TaskItemModel[] {
    return [...this.tasks, ...this.npmScriptTasks];
  }

  getTaskById(taskId: string): TaskItemModel | undefined {
    return this.tasks.find(t => t.id === taskId) || this.npmScriptTasks.find(t => t.id === taskId);
  }

  getHistory(): HistoryEntry[] {
    return this.history;
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
  }

  isTaskbarPinned(taskId: string): boolean {
    return this.taskbarPinned.has(taskId);
  }

  getTaskbarPinnedTasks(): TaskItemModel[] {
    const allTasks = [...this.tasks, ...this.npmScriptTasks];
    return allTasks.filter(t => this.taskbarPinned.has(t.id));
  }

  private loadTaskbarPinned(): void {
    const saved = this.context.globalState.get<string[]>('taskdeck.taskbarPinned', []);
    this.taskbarPinned = new Set(saved);
  }

  private async saveTaskbarPinned(): Promise<void> {
    await this.context.globalState.update('taskdeck.taskbarPinned', Array.from(this.taskbarPinned));
  }
}

export function activate(context: vscode.ExtensionContext) {
  console.log('TaskDeck extension is now active!');

  // Create the tree data provider
  const treeProvider = new TaskTreeProvider(context);

  // Create the tree view
  const treeView = vscode.window.createTreeView('taskdeck.tasksView', {
    treeDataProvider: treeProvider
  });

  // Status bar item
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  let currentRunningTask: vscode.TaskExecution | undefined;

  // Taskbar status bar items for pinned tasks
  const taskbarStatusBarItems: Map<string, vscode.StatusBarItem> = new Map();

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
      context.subscriptions.push(item);
    });
  }

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('taskdeck.refreshTasks', async () => {
      await treeProvider.loadTasks();
      treeProvider.refresh();
      vscode.window.showInformationMessage('Tasks refreshed');
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('taskdeck.runTask', async (item?: TaskTreeItem) => {
      try {
        console.log('[TaskDeck] runTask command invoked with item:', item);
        
        let taskModel: TaskItemModel | undefined;
        
        if (item && item.taskId) {
          console.log('[TaskDeck] Looking up task by ID:', item.taskId);
          taskModel = treeProvider.getTaskById(item.taskId);
        }
        
        if (!taskModel) {
          console.log('[TaskDeck] No task found, showing quick pick');
          // No task provided, show quick pick
          await vscode.commands.executeCommand('taskdeck.runTaskQuickPick');
          return;
        }

        console.log('[TaskDeck] Executing task:', taskModel.label);
        await vscode.tasks.executeTask(taskModel.vscodeTask);
        vscode.window.showInformationMessage(`Running task: ${taskModel.label}`);
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
      
      if (item && item.taskId) {
        console.log('[TaskDeck] Looking up task by ID:', item.taskId);
        taskModel = treeProvider.getTaskById(item.taskId);
      }
      
      if (taskModel) {
        console.log('[TaskDeck] Task model found:', taskModel.id);
        await treeProvider.toggleFavorite(taskModel);
        const isFav = treeProvider.isFavorite(taskModel.id);
        vscode.window.showInformationMessage(
          `Task ${isFav ? 'added to' : 'removed from'} favorites: ${taskModel.label}`
        );
      } else {
        console.log('[TaskDeck] No task model found');
        vscode.window.showErrorMessage('No task selected');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('taskdeck.setFilter', async () => {
      const filterText = await vscode.window.showInputBox({
        prompt: 'Enter filter text (searches task name, source, and folder)',
        placeHolder: 'Filter tasks...'
      });

      if (filterText !== undefined) {
        await treeProvider.setFilter(filterText);
        if (filterText) {
          vscode.window.showInformationMessage(`Filter applied: ${filterText}`);
        } else {
          vscode.window.showInformationMessage('Filter cleared');
        }
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('taskdeck.sendToTaskbar', async (item: TaskTreeItem) => {
      console.log('[TaskDeck] sendToTaskbar command invoked with item:', item);
      
      let taskModel: TaskItemModel | undefined;
      
      if (item && item.taskId) {
        console.log('[TaskDeck] Looking up task by ID:', item.taskId);
        taskModel = treeProvider.getTaskById(item.taskId);
      }
      
      if (taskModel) {
        console.log('[TaskDeck] Task model found:', taskModel.id);
        await treeProvider.toggleTaskbarPin(taskModel);
        updateTaskbarItems();
        const isPinned = treeProvider.isTaskbarPinned(taskModel.id);
        vscode.window.showInformationMessage(
          `Task ${isPinned ? 'pinned to' : 'unpinned from'} taskbar: ${taskModel.label}`
        );
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
        vscode.window.showInformationMessage(`Running task: ${taskModel.label}`);
      } else {
        console.log('[TaskDeck] Task not found');
        vscode.window.showErrorMessage('Task not found');
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('taskdeck.runTaskQuickPick', async () => {
      const tasks = treeProvider.getTasks();
      const history = treeProvider.getHistory();

      if (tasks.length === 0) {
        vscode.window.showInformationMessage('No tasks found');
        return;
      }

      // Create quick pick items
      const items: vscode.QuickPickItem[] = [];

      // Add favorites
      const favoriteTasks = tasks.filter(t => treeProvider.isFavorite(t.id));
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
            detail: task.id
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
            detail: task.id
          });
        });
      }

      // Add recents
      const recentTaskIds = history
        .slice()
        .reverse()
        .map(h => h.taskId)
        .filter((id, index, self) => self.indexOf(id) === index)
        .slice(0, 10);

      const recentTasks = recentTaskIds
        .map(id => tasks.find(t => t.id === id))
        .filter(t => t && !treeProvider.isFavorite(t.id) && !treeProvider.isTaskbarPinned(t.id)) as TaskItemModel[];

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
            detail: task.id
          });
        });
      }

      // Add all other tasks
      const favoriteIds = new Set(favoriteTasks.map(t => t.id));
      const recentIds = new Set(recentTasks.map(t => t.id));
      const pinnedIds = new Set(pinnedTasks.map(t => t.id));
      const otherTasks = tasks.filter(t => !favoriteIds.has(t.id) && !recentIds.has(t.id) && !pinnedIds.has(t.id));

      // Separate npm scripts from other tasks
      const npmScriptTasks = otherTasks.filter(t => t.source === 'npm script');
      const regularTasks = otherTasks.filter(t => t.source !== 'npm script');

      // Add npm scripts section
      if (npmScriptTasks.length > 0) {
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
        items.push({ label: 'npm scripts', kind: vscode.QuickPickItemKind.Separator });
        npmScriptTasks.forEach(task => {
          const descriptionParts = [task.source];
          if (task.folderName) {
            descriptionParts.push(task.folderName);
          }
          const detailParts = [task.id];
          if (task.workspacePath) {
            detailParts.push(`Workspace: ${task.workspacePath}`);
          }
          items.push({
            label: `$(package) ${task.label}`,
            description: descriptionParts.join(' - '),
            detail: detailParts.join(' | ')
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
            detail: task.id
          });
        });
      }

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a task to run'
      });

      if (selected && selected.detail) {
        const taskId = selected.detail.split(' | ')[0]; // Extract task ID from detail
        const task = tasks.find(t => t.id === taskId);
        if (task) {
          await vscode.tasks.executeTask(task.vscodeTask);
        }
      }
    })
  );

  // Task event listeners
  context.subscriptions.push(
    vscode.tasks.onDidStartTaskProcess((e: vscode.TaskProcessStartEvent) => {
      currentRunningTask = e.execution;
      const task = e.execution.task;
      const taskId = treeProvider.createId(task);

      // Update status bar
      statusBarItem.text = `$(terminal) Task: ${task.name}`;
      statusBarItem.tooltip = `Running: ${task.name}\nClick to show terminal`;
      statusBarItem.command = 'workbench.action.terminal.focus';
      statusBarItem.show();

      // Add to history (start)
      treeProvider.addToHistory(taskId, task.name);
    })
  );

  context.subscriptions.push(
    vscode.tasks.onDidEndTaskProcess((e: vscode.TaskProcessEndEvent) => {
      const task = e.execution.task;
      const taskId = treeProvider.createId(task);

      // Update history with exit code
      treeProvider.addToHistory(taskId, task.name, e.exitCode);

      // Update/hide status bar
      if (currentRunningTask === e.execution) {
        if (e.exitCode === 0) {
          statusBarItem.text = `$(check) Task: ${task.name}`;
          statusBarItem.tooltip = 'Task completed successfully';
        } else {
          statusBarItem.text = `$(error) Task: ${task.name}`;
          statusBarItem.tooltip = `Task failed with exit code ${e.exitCode}`;
        }

        // Hide after 5 seconds
        setTimeout(() => {
          if (currentRunningTask === e.execution) {
            statusBarItem.hide();
            currentRunningTask = undefined;
          }
        }, 5000);
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
}

export function deactivate() {
  // Cleanup
}

