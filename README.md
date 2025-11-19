<div align="center">
   <img src="img/biglogo.png" alt="TaskDeck Logo" style="max-width: 320px; height: auto; margin-bottom: 1em;" />
   <br/>
</div>

A control center to manage and launch VS Code tasks with an elegant side panel interface.


<div align="center">
   <img src="img/demo.gif" alt="TaskDeck Demo" style="max-width: 100%; height: auto;" />
</div>

## Features

TaskDeck provides a dedicated Activity Bar view container that brings all your VS Code tasks to your fingertips with powerful organization and management features:

### V1 Features

1. **Task Explorer Side Panel**
   - Dedicated Activity Bar icon with "TaskDeck" container
   - Tree view showing all workspace tasks
   - Task information displayed: name, source (npm, shell, workspace, etc.), and folder (in multi-root workspaces)
   - One-click task execution
   - Visual grouping: Favorites, Recent, and All Tasks

2. **Favorites & Pinning**
   - Mark tasks as favorites with a simple context menu action
   - Favorites persist across VS Code sessions
   - Favorites appear at the top of the task list with star icons
   - Toggle favorite status with "TaskDeck: Toggle Favorite" command

3. **Recent Tasks History**
   - Automatically tracks last 20 task executions
   - Shows recently run tasks in a dedicated section
   - Displays exit codes and timestamps
   - Quick access to frequently used tasks

4. **Search & Filter**
   - Filter tasks by name, source, or folder
   - "TaskDeck: Set Filter" command with input dialog
   - Real-time filtering in tree view
   - Case-insensitive search

5. **Command Palette Integration**
   - "TaskDeck: Run Task…" command for quick task execution
   - Smart ordering: Favorites → Recents → All Tasks
   - Visual icons distinguish task types

6. **Status Bar Integration**
   - Shows running task status in status bar
   - Click to focus terminal
   - Success/failure indicators with exit codes
   - Auto-hides after task completion

7. **Context Menu Actions**
   - Run Task
   - Toggle Favorite
   - Quick access from tree view

### New: Send to Taskbar

- **Pin any task to the VS Code status bar (taskbar) for one-click access!**
- Use the new **pin icon** (📌) inline action in the TaskDeck tree view to send a task to the taskbar, just like the run (▶️) and favorite (★) icons.
- Pinned tasks appear as buttons in the VS Code status bar. Click to run instantly.
- Right-click a task or use the inline pin icon to toggle pin/unpin.
- Pinned tasks persist across VS Code sessions.

## Usage

1. Click the TaskDeck icon in the Activity Bar to open the side panel
2. Browse tasks organized by Favorites, Recent, and All Tasks
3. Use the **inline icons** next to each task:
   - ▶️ Run Task
   - ★ Toggle Favorite
   - 📌 Send to Taskbar
4. Pinned tasks appear as buttons in the VS Code status bar (bottom left)
5. Click a status bar button to run the task instantly
6. Right-click tasks for context menu options
7. Use the filter icon to search for specific tasks
8. Use Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`) and type "TaskDeck" to access all commands

## Commands

- `TaskDeck: Refresh Tasks` - Reload all tasks from workspace
- `TaskDeck: Run Task…` - Open quick pick to select and run a task
- `TaskDeck: Set Filter` - Filter visible tasks
- `TaskDeck: Toggle Favorite` - Add/remove task from favorites
- `TaskDeck: Run Task` - Run a specific task (context menu)
- `TaskDeck: Send to Taskbar` - Pin/unpin a task to the VS Code status bar for quick access

## Requirements

- VS Code 1.106.0 or higher

## Extension Settings

This extension stores data in VS Code's global state:
- `taskdeck.favorites` - List of favorite task IDs
- `taskdeck.history` - Recent task execution history (last 20 entries)

## Known Issues

None at this time.

## Release Notes

### 0.9.0

Initial release of TaskDeck with all V1 features:
- Task Explorer side panel
- Favorites and pinning
- Recent tasks history
- Search and filter
- Command palette integration
- Status bar integration
- Context menu actions

### 0.10.0

- Added "Send to Taskbar" feature with inline pin icon and status bar integration

---

**Enjoy managing your tasks with TaskDeck!**
