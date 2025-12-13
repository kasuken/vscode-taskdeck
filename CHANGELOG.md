# Change Log

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