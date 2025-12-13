# TaskDeck Extension - AI Coding Instructions

## Project Overview
TaskDeck is a VS Code extension that provides an elegant side panel UI for managing and launching workspace tasks. It surfaces VS Code's task system with features like favorites, pinning, history tracking, and search filtering. The extension discovers both built-in tasks and npm scripts from `package.json` files.

## Architecture

### Core Components

**TaskTreeProvider** (`src/extension.ts`) - The central data model and tree view controller:
- Manages task discovery and caching (`tasks[]` for VS Code tasks, `npmScriptTasks[]` for npm scripts)
- Persists user preferences in VS Code global state: favorites, history, taskbar pins
- Organizes tasks into logical groups: Favorites, Pinned, Recent, npm scripts, and source-based (npm, shell, workspace, etc.)
- Implements tree view hierarchy with collapsible source groups

**Data Flow:**
1. Tasks are discovered via `vscode.tasks.fetchTasks()` (built-in tasks) and file-system scanning for npm scripts
2. Each task becomes a `TaskItemModel` (id, label, source, folder, vscodeTask reference)
3. User actions (favorites, pinning, history) update the provider and persist via `context.globalState`
4. Tree view refreshes trigger `getChildren()` which re-organizes tasks based on current filters and selections

### Key Data Models
- `TaskItemModel`: Complete task metadata including unique ID (`folderName:source:taskName`)
- `NpmScript`: npm package.json script with folder/workspace context
- `HistoryEntry`: Execution record with timestamp and exit code
- `TaskTreeItem`: VS Code tree item wrapper with optional taskModel reference

## Developer Workflows

### Build & Test
- **Watch mode**: `npm run watch` (TypeScript compilation in background)
- **Compile**: `npm run compile` (one-time build to `out/extension.js`)
- **Test**: `npm test` (runs tests in `src/test/extension.test.ts` using @vscode/test-electron)
- **Lint**: `npm run lint` (ESLint with TypeScript parser)

### Task ID Generation
Critical for persistence: IDs are generated as `folderName:source:taskName`
```typescript
createId(task: vscode.Task): string {
  const folderName = task.scope && typeof task.scope !== 'number' ? task.scope.name : 'global';
  return `${folderName}:${task.source}:${task.name}`;
}
```

## Project-Specific Patterns

### Tree Organization Logic
The tree uses a **collapsible group pattern** at root level:
- **Fixed groups**: Favorites (always at top if exists), Pinned, Recent (last 10 unique tasks)
- **Source groups**: Dynamically created for each task source type (npm, shell, workspace, etc.)
- **Filtering**: Applied globally before grouping via `getFilteredTasks()` and `getFilteredNpmScripts()`
- **Deduplication**: npm scripts are filtered from built-in task list and shown with enhanced folder/workspace context

### npm Scripts Discovery
- Scans all `**/package.json` files (excluding `node_modules`) using `vscode.workspace.findFiles()`
- For each package.json, parses scripts and preserves folder context (relative path from workspace)
- Creates synthetic tasks via `createNpmTask()` with ShellExecution running `npm run scriptName`
- Stores workspace path in `TaskItemModel.workspacePath` for quick identification

### Command Handlers Pattern
All commands follow this pattern:
1. Accept `item: TaskTreeItem` parameter from context menu
2. Extract `TaskItemModel` directly from `item.taskModel` (avoids ID lookup bugs)
3. Look up full task object for execution or state changes
4. Call `treeProvider.refresh()` to rebuild tree
5. Show user feedback via `vscode.window.showInformationMessage()`

Example:
```typescript
vscode.commands.registerCommand('taskdeck.toggleFavorite', async (item: TaskTreeItem) => {
  if (item?.taskModel) {
    await treeProvider.toggleFavorite(item.taskModel);
    // Refresh and notify user...
  }
});
```

### Persistence Pattern
All user selections persist in VS Code global state:
- Load in constructor: `this.context.globalState.get<Type[]>('taskdeck.key', [])`
- Save on change: `this.context.globalState.update('taskdeck.key', data)`
- Three separate data stores: `favorites`, `history`, `taskbarPinned`

### Status Bar Integration
- Task execution shows live status in status bar (center-left area)
- Taskbar (pinned tasks) creates individual status bar items
- Status updates on task start (`onDidStartTaskProcess`) and end (`onDidEndTaskProcess`)
- Exit codes tracked: success (0) shows checkmark, failure shows error icon

## Integration Points

### External Dependencies
- **VS Code API**: Tasks system (`vscode.tasks.*`), tree views, commands, global state, status bar
- **Built-in npm tasks**: Filtered out to avoid duplication with our enhanced npm scripts

### Cross-Component Communication
- Commands dispatch actions → TreeProvider updates state → Tree refreshes
- Task execution fires events → History updated → Status bar updated
- Filter input propagates through `setFilter()` → triggers `getFilteredTasks()`

## Testing Strategy
Tests in `src/test/extension.test.ts`:
1. **Activation**: Verify extension loads and commands register
2. **Task loading**: Confirm tree provides task groups and hierarchy
3. **State management**: Test favorites toggle and history tracking
4. Prefer integration tests (full extension activation) over unit tests

## Configuration & Scripts

### package.json Contribution Points
- **Activity Bar**: "taskdeck" container with tree view
- **Commands**: 6 public commands (runTask, toggleFavorite, refreshTasks, setFilter, runTaskQuickPick, sendToTaskbar)
- **Menus**: Context menu for tasks (inline icons) and command palette integration
- **Activation**: `onView:taskdeck.tasksView`, `onCommand:taskdeck.*`, `onStartupFinished`

### Source Icon Mapping
Different task sources get visual icons:
- npm/package: $(package)
- gulp/grunt: $(tools)
- shell: $(terminal)
- workspace: $(workspace-trusted)
- Default: $(gear)

## Common Patterns to Preserve

1. **ID-based lookups**: Always use task IDs as stable references across persistence
2. **Deduplication**: Check Set membership before adding (favorites, pinned, recent)
3. **Collapsible groups**: Use `TreeItemCollapsibleState.Expanded/Collapsed` to organize
4. **Rich tooltips**: Include source, folder, and workspace context
5. **Event-driven updates**: Tree refresh triggered by command completion, not polling
