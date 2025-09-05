import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execAsync = promisify(exec);

class GitContentProvider implements vscode.TextDocumentContentProvider {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        return 'No workspace folder open';
      }

      const workspacePath = workspaceFolder.uri.fsPath;
      const filePath = uri.path.startsWith('/')
        ? uri.path.substring(1)
        : uri.path;
      const branch = uri.query;

      console.log(
        `GitContentProvider: Loading file ${filePath} from branch ${branch}`
      );
      console.log(
        `GitContentProvider: URI path: ${uri.path}, query: ${uri.query}`
      );

      const { stdout } = await execAsync(`git show ${branch}:${filePath}`, {
        cwd: workspacePath,
      });

      return stdout;
    } catch (error) {
      console.error(`GitContentProvider error:`, error);
      return `Error loading file: ${error}`;
    }
  }
}

interface ChangedFile {
  path: string;
  status: string;
}

interface TreeNode {
  name: string;
  path: string;
  status?: string;
  children: Map<string, TreeNode>;
  isFile: boolean;
  parent?: TreeNode;
}

class gitDeltaTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData: vscode.EventEmitter<
    void | TreeNode | null | undefined
  > = new vscode.EventEmitter<void | TreeNode | null | undefined>();
  readonly onDidChangeTreeData: vscode.Event<
    void | TreeNode | null | undefined
  > = this._onDidChangeTreeData.event;

  private rootNode: TreeNode = {
    name: '',
    path: '',
    children: new Map(),
    isFile: false,
  };
  private mainBranch: string = '';
  private showTreeView: boolean = true;

  constructor() {
    this.loadChangedFiles();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(element.name);

    if (element.isFile) {
      treeItem.command = {
        command: 'gitDeltaTree.openFile',
        title: 'Open File with Diff',
        arguments: [element.path],
      };
      treeItem.collapsibleState = vscode.TreeItemCollapsibleState.None;
    } else {
      treeItem.collapsibleState = vscode.TreeItemCollapsibleState.Collapsed;
    }

    // Set icon based on file status or type
    if (element.isFile && element.status) {
      switch (element.status) {
        case 'M':
          treeItem.iconPath = new vscode.ThemeIcon('diff-modified');
          break;
        case 'A':
          treeItem.iconPath = new vscode.ThemeIcon('diff-added');
          break;
        case 'D':
          treeItem.iconPath = new vscode.ThemeIcon('diff-removed');
          break;
        case 'R':
          treeItem.iconPath = new vscode.ThemeIcon('diff-renamed');
          break;
        default:
          treeItem.iconPath = new vscode.ThemeIcon('file');
      }
    } else if (element.isFile) {
      treeItem.iconPath = new vscode.ThemeIcon('file');
    } else {
      treeItem.iconPath = new vscode.ThemeIcon('folder');
    }

    return treeItem;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    if (!element) {
      // Root level - return top-level children
      return Array.from(this.rootNode.children.values()).sort((a, b) => {
        // Folders first, then files
        if (a.isFile !== b.isFile) {
          return a.isFile ? 1 : -1;
        }
        return a.name.localeCompare(b.name);
      });
    }

    // Return children of the given element
    return Array.from(element.children.values()).sort((a, b) => {
      // Folders first, then files
      if (a.isFile !== b.isFile) {
        return a.isFile ? 1 : -1;
      }
      return a.name.localeCompare(b.name);
    });
  }

  async loadChangedFiles(): Promise<void> {
    try {
      // Get the workspace folder
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showWarningMessage(
          'Git Delta Tree: No workspace folder open'
        );
        this.rootNode.children.clear();
        this._onDidChangeTreeData.fire();
        return;
      }

      const workspacePath = workspaceFolder.uri.fsPath;

      // Check if we're in a git repository
      await execAsync('git rev-parse --git-dir', { cwd: workspacePath });

      // First, detect the main branch
      await this.detectMainBranch(workspacePath);

      // Get changed files compared to main branch
      const { stdout } = await execAsync(
        `git diff --name-status ${this.mainBranch}...HEAD`,
        { cwd: workspacePath }
      );

      const fileLines = stdout
        .trim()
        .split('\n')
        .filter((line) => line.trim());

      // Clear existing tree
      this.rootNode.children.clear();

      if (fileLines.length === 0) {
        // No changes found - show full workspace structure
        if (this.showTreeView) {
          await this.buildFullWorkspaceTree(workspacePath);
        }
        // In flat view, show nothing when no changes
      } else {
        const changedFiles = fileLines.map((line) => {
          const [status, path] = line.split('\t');
          return { path, status };
        });

        if (this.showTreeView) {
          // Build tree from changed files
          this.buildTreeFromChangedFiles(changedFiles);
        } else {
          // Build flat list from changed files
          this.buildFlatListFromChangedFiles(changedFiles);
        }
      }

      this._onDidChangeTreeData.fire();
    } catch (error) {
      console.error('Error loading changed files:', error);
      this.rootNode.children.clear();

      // Show user-friendly error message
      if (
        error instanceof Error &&
        error.message.includes('Not a git repository')
      ) {
        vscode.window.showWarningMessage(
          'Git Delta Tree: Not in a git repository'
        );
      } else if (
        error instanceof Error &&
        error.message.includes('No commits found')
      ) {
        vscode.window.showWarningMessage(
          'Git Delta Tree: No commits found in repository'
        );
      } else if (
        error instanceof Error &&
        error.message.includes('fatal: ambiguous argument')
      ) {
        vscode.window.showWarningMessage(
          'Git Delta Tree: No commits found or branch not found'
        );
      } else {
        vscode.window.showErrorMessage(
          'Git Delta Tree: Failed to load changed files'
        );
      }

      this._onDidChangeTreeData.fire();
    }
  }

  private buildTreeFromChangedFiles(changedFiles: ChangedFile[]): void {
    for (const file of changedFiles) {
      this.addFileToTree(file.path, file.status);
    }
  }

  private buildFlatListFromChangedFiles(changedFiles: ChangedFile[]): void {
    for (const file of changedFiles) {
      // In flat view, just add files directly to root
      const fileNode: TreeNode = {
        name: file.path,
        path: file.path,
        status: file.status,
        children: new Map(),
        isFile: true,
        parent: this.rootNode,
      };
      this.rootNode.children.set(file.path, fileNode);
    }
  }

  private addFileToTree(filePath: string, status: string): void {
    const parts = filePath.split('/');
    let current = this.rootNode;

    // Create folder structure
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      if (!current.children.has(part)) {
        const folderNode: TreeNode = {
          name: part,
          path: parts.slice(0, i + 1).join('/'),
          children: new Map(),
          isFile: false,
          parent: current,
        };
        current.children.set(part, folderNode);
      }
      current = current.children.get(part)!;
    }

    // Add the file
    const fileName = parts[parts.length - 1];
    const fileNode: TreeNode = {
      name: fileName,
      path: filePath,
      status: status,
      children: new Map(),
      isFile: true,
      parent: current,
    };
    current.children.set(fileName, fileNode);
  }

  private async buildFullWorkspaceTree(workspacePath: string): Promise<void> {
    try {
      // Get all files from the main branch
      const { stdout } = await execAsync(
        `git ls-tree -r --name-only ${this.mainBranch}`,
        { cwd: workspacePath }
      );

      const files = stdout
        .trim()
        .split('\n')
        .filter((line) => line.trim());

      for (const file of files) {
        this.addFileToTree(file, '');
      }
    } catch (error) {
      console.error('Error building full workspace tree:', error);
      // Fallback: show empty tree
    }
  }

  private async detectMainBranch(workspacePath: string): Promise<void> {
    try {
      // First check if there are any commits at all
      try {
        await execAsync('git rev-parse HEAD', { cwd: workspacePath });
      } catch {
        // No commits yet, can't compare
        throw new Error('No commits found');
      }

      // Try to get the default branch from git config
      try {
        const { stdout } = await execAsync(
          'git config --get init.defaultBranch',
          { cwd: workspacePath }
        );
        const configBranch = stdout.trim();
        if (configBranch) {
          // Verify this branch exists
          await execAsync(`git rev-parse --verify ${configBranch}`, {
            cwd: workspacePath,
          });
          this.mainBranch = configBranch;
          return;
        }
      } catch {
        // If that fails, try common branch names
      }

      // Check if master branch exists
      try {
        await execAsync('git rev-parse --verify master', {
          cwd: workspacePath,
        });
        this.mainBranch = 'master';
        return;
      } catch {
        // Master doesn't exist, try main
      }

      // Check if main branch exists
      try {
        await execAsync('git rev-parse --verify main', { cwd: workspacePath });
        this.mainBranch = 'main';
        return;
      } catch {
        // Neither exists, try to get current branch as fallback
        try {
          const { stdout } = await execAsync(
            'git rev-parse --abbrev-ref HEAD',
            { cwd: workspacePath }
          );
          this.mainBranch = stdout.trim();
          return;
        } catch {
          // Last resort
          this.mainBranch = 'master';
        }
      }
    } catch (error) {
      console.error('Error detecting main branch:', error);
      throw error; // Re-throw to be handled by caller
    }
  }

  refresh(): void {
    this.loadChangedFiles();
  }

  toggleView(): void {
    this.showTreeView = !this.showTreeView;
    this.loadChangedFiles();
  }

  getViewMode(): string {
    return this.showTreeView ? 'Tree View' : 'Flat View';
  }
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new gitDeltaTreeProvider();
  const gitContentProvider = new GitContentProvider();

  vscode.window.registerTreeDataProvider('gitDeltaTree', provider);

  // Register the git content provider with a custom scheme
  const gitProviderDisposable =
    vscode.workspace.registerTextDocumentContentProvider(
      'git-delta',
      gitContentProvider
    );
  context.subscriptions.push(gitProviderDisposable);

  context.subscriptions.push(
    vscode.commands.registerCommand('gitDeltaTree.refresh', () => {
      provider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('gitDeltaTree.toggleView', () => {
      provider.toggleView();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'gitDeltaTree.openFile',
      async (filePath: string) => {
        try {
          // Get the workspace folder to resolve relative paths
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
          if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
          }

          const workspacePath = workspaceFolder.uri.fsPath;
          const currentFileUri = vscode.Uri.joinPath(
            workspaceFolder.uri,
            filePath
          );

          // Get the main branch name from the provider
          const mainBranch = provider['mainBranch'] || 'master';

          console.log(
            `openFile: filePath = ${filePath}, mainBranch = ${mainBranch}`
          );

          // Create a git-delta URI for the main branch version
          const mainBranchUri = vscode.Uri.from({
            scheme: 'git-delta',
            path: filePath,
            query: mainBranch,
          });

          // Open diff view using our custom content provider
          await vscode.commands.executeCommand(
            'vscode.diff',
            mainBranchUri,
            currentFileUri,
            `${filePath} (${mainBranch} → HEAD)`
          );
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to open file diff: ${error}`);
        }
      }
    )
  );
}

export function deactivate() {}
