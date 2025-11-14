import * as assert from 'assert';

// You can import and use all API from the 'vscode' module
// as well as import your extension to test it
import * as vscode from 'vscode';
// import * as myExtension from '../../extension';

suite('TaskDeck Extension Test Suite', () => {
	vscode.window.showInformationMessage('Start all tests.');

	test('Extension should be present and activate', async () => {
		const ext = vscode.extensions.getExtension('taskdeck');
		assert.ok(ext, 'Extension not found');
		await ext?.activate();
		assert.ok(ext.isActive, 'Extension did not activate');
	});

	test('Commands should be registered', async () => {
		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('taskdeck.runTask'), 'runTask command missing');
		assert.ok(commands.includes('taskdeck.toggleFavorite'), 'toggleFavorite command missing');
		assert.ok(commands.includes('taskdeck.refreshTasks'), 'refreshTasks command missing');
		assert.ok(commands.includes('taskdeck.setFilter'), 'setFilter command missing');
		assert.ok(commands.includes('taskdeck.runTaskQuickPick'), 'runTaskQuickPick command missing');
	});

	test('TaskTreeProvider loads and groups tasks', async () => {
		// Simulate extension activation and get the provider
		const ext = vscode.extensions.all.find(e => e.id.endsWith('taskdeck'));
		await ext?.activate();
		// @ts-ignore
		const provider = ext?.exports?.treeProvider || ext?.exports?.default?.treeProvider;
		assert.ok(provider, 'TaskTreeProvider not found');
		await provider.loadTasks();
		const rootItems = await provider.getChildren();
		assert.ok(Array.isArray(rootItems), 'getChildren should return an array');
		// Should have at least group nodes (Favorites, Recent, or source groups)
		assert.ok(rootItems.length > 0, 'No root items returned');
	});

	test('Favorites logic works', async () => {
		// @ts-ignore
		const ext = vscode.extensions.all.find(e => e.id.endsWith('taskdeck'));
		await ext?.activate();
		// @ts-ignore
		const provider = ext?.exports?.treeProvider || ext?.exports?.default?.treeProvider;
		await provider.loadTasks();
		const tasks = provider.getTasks();
		if (tasks.length === 0) return;
		const task = tasks[0];
		await provider.toggleFavorite(task);
		assert.ok(provider.isFavorite(task.id), 'Task should be favorite after toggle');
		await provider.toggleFavorite(task);
		assert.ok(!provider.isFavorite(task.id), 'Task should not be favorite after second toggle');
	});

	test('History logic works', async () => {
		// @ts-ignore
		const ext = vscode.extensions.all.find(e => e.id.endsWith('taskdeck'));
		await ext?.activate();
		// @ts-ignore
		const provider = ext?.exports?.treeProvider || ext?.exports?.default?.treeProvider;
		provider.addToHistory('test:source:label', 'Test Task', 0);
		const history = provider.getHistory();
		assert.ok(history.length > 0, 'History should have at least one entry');
		assert.strictEqual(history[history.length - 1].label, 'Test Task');
	});
});
