# Change Log

## [0.12.0] - 2026-04-10
### Added
- Detect `build.xml` files across the workspace and extract Ant `<target>` entries as tasks (skips private targets starting with `-`).
- New "Ant targets" group in the TaskDeck tree and Quick Pick; running an Ant target executes `ant <target>` from the build.xml directory.
- Ant targets participate in Favorites, Pinned, Recent, and filtering features just like other tasks.

## [0.11.1] - 2025-12-13
### Fixed
- Fixed issue where clicking a task in the sidebar would run the wrong task (the first task from the category instead of the selected one). Commands now use the task reference directly instead of ID lookup.

## [0.11.0] - 2025-12-13
### Added
- Dedicated "npm scripts" category that auto-detects scripts from package.json across the workspace.
- Enhanced npm script metadata: shows folder (relative to workspace) and workspace path.
- New "Pinned" category: pinned tasks appear below Favorites for quick access in the tree view.

### Changed
- Avoid duplicate npm entries by filtering out VS Code's built-in npm tasks and using enhanced TaskDeck npm scripts instead.
- Quick Pick now includes separate sections for Favorites, Pinned, Recent, npm scripts, and All Tasks.

### Fixed
- Excluded pinned tasks from Recent and other source groups to prevent duplicates.

## [0.9.0] - 2025-11-14
### Added
- TaskDeck Activity Bar panel with grouped task explorer (Favorites, Recents, and by type/source)
- One-click run and favorite toggle buttons for each task
- Context menu actions: Run Task, Toggle Favorite
- Search/filter tasks by label, source, or folder
- Recents tracking and display
- Status bar integration for running tasks
- Command palette integration (Quick Pick)
- Persistent favorites and history
- Categories and keywords in package.json for marketplace discoverability

### Fixed
- Prevented infinite reload loop in the task tree
- Improved reliability of inline action buttons