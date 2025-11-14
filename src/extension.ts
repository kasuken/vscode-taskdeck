import * as vscode from 'vscode';

// Data models
interface TaskItemModel {
  id: string;
  label: string;
  source: string;
  folderName?: string;
  vscodeTask: vscode.Task;
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
  private favorites: Set<string> = new Set();
  private history: HistoryEntry[] = [];
  private filterText: string = '';

  constructor(private context: vscode.ExtensionContext) {
    this.loadFavorites();
    this.loadHistory();
  }

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  async loadTasks(): Promise<void> {
    try {
      const allTasks = await vscode.tasks.fetchTasks();
      this.tasks = allTasks.map(task => this.createTaskModel(task));
    } catch (error) {
      vscode.window.showErrorMessage(`Failed to load tasks: ${error}`);
    }
  }

  createTaskModel(task: vscode.Task): TaskItemModel {
    const folderName = task.scope && typeof task.scope !== 'number' ? task.scope.name : undefined;
    const id = this.createId(task);
    return {
      id,
      label: task.name,
      source: task.source,
      folderName,
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
      const result: TaskTreeItem[] = [];

      // Create a map of task IDs for quick lookup
      const taskMap = new Map<string, TaskItemModel>();
      filteredTasks.forEach(task => taskMap.set(task.id, task));

      // Split into favorites and others
      const favoriteTasks: TaskItemModel[] = [];
      const nonFavoriteTasks: TaskItemModel[] = [];

      filteredTasks.forEach(task => {
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

      // Recent group
      const recentTaskIds = this.history
        .slice()
        .reverse()
        .map(h => h.taskId)
        .filter((id, index, self) => self.indexOf(id) === index) // Unique
        .slice(0, 10);

      const recentTasks = recentTaskIds
        .map(id => taskMap.get(id))
        .filter(t => t && !this.favorites.has(t.id)) as TaskItemModel[];

      if (recentTasks.length > 0) {
        const recentGroup = new TaskTreeItem('Recent', vscode.TreeItemCollapsibleState.Expanded, 'group');
        recentGroup.iconPath = new vscode.ThemeIcon('history');
        result.push(recentGroup);
      }

      // Group other tasks by source
      const recentIds = new Set(recentTaskIds);
      const otherTasks = nonFavoriteTasks.filter(t => !recentIds.has(t.id));

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
      const taskMap = new Map<string, TaskItemModel>();
      filteredTasks.forEach(task => taskMap.set(task.id, task));

      if (element.label === 'Favorites') {
        const favoriteTasks = filteredTasks.filter(t => this.favorites.has(t.id));
        return favoriteTasks.map(task => {
          const item = new TaskTreeItem(task.label, vscode.TreeItemCollapsibleState.None, 'task', task);
          item.iconPath = new vscode.ThemeIcon('star-full');
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
          .filter(t => t && !this.favorites.has(t.id)) as TaskItemModel[];

        return recentTasks.map(task => {
          const item = new TaskTreeItem(task.label, vscode.TreeItemCollapsibleState.None, 'task', task);
          item.iconPath = new vscode.ThemeIcon('history');
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
          t => t.source === sourceName && !this.favorites.has(t.id) && !recentIds.has(t.id)
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
    return this.tasks;
  }

  getTaskById(taskId: string): TaskItemModel | undefined {
    return this.tasks.find(t => t.id === taskId);
  }

  getHistory(): HistoryEntry[] {
    return this.history;
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
          items.push({
            label: `$(star-full) ${task.label}`,
            description: task.source + (task.folderName ? ` - ${task.folderName}` : ''),
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
        .filter(t => t && !treeProvider.isFavorite(t.id)) as TaskItemModel[];

      if (recentTasks.length > 0) {
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
        items.push({ label: 'Recent', kind: vscode.QuickPickItemKind.Separator });
        recentTasks.forEach(task => {
          items.push({
            label: `$(history) ${task.label}`,
            description: task.source + (task.folderName ? ` - ${task.folderName}` : ''),
            detail: task.id
          });
        });
      }

      // Add all other tasks
      const favoriteIds = new Set(favoriteTasks.map(t => t.id));
      const recentIds = new Set(recentTasks.map(t => t.id));
      const otherTasks = tasks.filter(t => !favoriteIds.has(t.id) && !recentIds.has(t.id));

      if (otherTasks.length > 0) {
        items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
        items.push({ label: 'All Tasks', kind: vscode.QuickPickItemKind.Separator });
        otherTasks.forEach(task => {
          items.push({
            label: `$(play-circle) ${task.label}`,
            description: task.source + (task.folderName ? ` - ${task.folderName}` : ''),
            detail: task.id
          });
        });
      }

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a task to run'
      });

      if (selected && selected.detail) {
        const task = tasks.find(t => t.id === selected.detail);
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
  treeProvider.loadTasks().then(() => treeProvider.refresh());

  // Add to subscriptions
  context.subscriptions.push(treeView);
  context.subscriptions.push(statusBarItem);
}

export function deactivate() {
  // Cleanup
}

