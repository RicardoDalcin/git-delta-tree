import * as vscode from 'vscode';
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const execAsync = promisify(exec);

interface ChangedFile {
  path: string;
  status: string;
}

class GitTreeCompareProvider implements vscode.TreeDataProvider<ChangedFile> {
  private _onDidChangeTreeData: vscode.EventEmitter<
    void | ChangedFile | null | undefined
  > = new vscode.EventEmitter<void | ChangedFile | null | undefined>();
  readonly onDidChangeTreeData: vscode.Event<
    void | ChangedFile | null | undefined
  > = this._onDidChangeTreeData.event;

  private changedFiles: ChangedFile[] = [];
  private mainBranch: string = '';

  constructor() {
    this.loadChangedFiles();
  }

  getTreeItem(element: ChangedFile): vscode.TreeItem {
    const treeItem = new vscode.TreeItem(element.path);
    treeItem.command = {
      command: 'gitTreeCompare.openFile',
      title: 'Open File with Diff',
      arguments: [element.path],
    };

    // Set icon based on file status
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

    return treeItem;
  }

  getChildren(): ChangedFile[] {
    return this.changedFiles;
  }

  async loadChangedFiles(): Promise<void> {
    try {
      // Get the workspace folder
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        vscode.window.showWarningMessage(
          'Git Tree Compare: No workspace folder open'
        );
        this.changedFiles = [];
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

      if (fileLines.length === 0) {
        // No changes found
        this.changedFiles = [];
      } else {
        this.changedFiles = fileLines.map((line) => {
          const [status, path] = line.split('\t');
          return { path, status };
        });
      }

      this._onDidChangeTreeData.fire();
    } catch (error) {
      console.error('Error loading changed files:', error);
      this.changedFiles = [];

      // Show user-friendly error message
      if (
        error instanceof Error &&
        error.message.includes('Not a git repository')
      ) {
        vscode.window.showWarningMessage(
          'Git Tree Compare: Not in a git repository'
        );
      } else if (
        error instanceof Error &&
        error.message.includes('No commits found')
      ) {
        vscode.window.showWarningMessage(
          'Git Tree Compare: No commits found in repository'
        );
      } else if (
        error instanceof Error &&
        error.message.includes('fatal: ambiguous argument')
      ) {
        vscode.window.showWarningMessage(
          'Git Tree Compare: No commits found or branch not found'
        );
      } else {
        vscode.window.showErrorMessage(
          'Git Tree Compare: Failed to load changed files'
        );
      }

      this._onDidChangeTreeData.fire();
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
}

export function activate(context: vscode.ExtensionContext) {
  const provider = new GitTreeCompareProvider();

  vscode.window.registerTreeDataProvider('gitTreeCompare', provider);

  context.subscriptions.push(
    vscode.commands.registerCommand('gitTreeCompare.refresh', () => {
      provider.refresh();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'gitTreeCompare.openFile',
      async (filePath: string) => {
        try {
          // Get the workspace folder to resolve relative paths
          const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
          if (!workspaceFolder) {
            vscode.window.showErrorMessage('No workspace folder open');
            return;
          }

          const workspacePath = workspaceFolder.uri.fsPath;
          const fullPath = vscode.Uri.joinPath(workspaceFolder.uri, filePath);

          // Get the main branch name from the provider
          const mainBranch = provider['mainBranch'] || 'master';

          // Use git show to get the file content from main branch
          const { stdout: mainBranchContent } = await execAsync(
            `git show ${mainBranch}:${filePath}`,
            { cwd: workspacePath }
          );

          // Create temporary files for diff
          const tempDir = os.tmpdir();
          const mainBranchFile = path.join(
            tempDir,
            `main-${path.basename(filePath)}`
          );
          const currentFile = path.join(
            tempDir,
            `current-${path.basename(filePath)}`
          );

          // Write content to temporary files
          fs.writeFileSync(mainBranchFile, mainBranchContent);
          fs.writeFileSync(currentFile, fs.readFileSync(fullPath.fsPath));

          // Open diff view
          await vscode.commands.executeCommand(
            'vscode.diff',
            vscode.Uri.file(mainBranchFile),
            vscode.Uri.file(currentFile),
            `${filePath} (${mainBranch} → HEAD)`
          );

          // Clean up temporary files after a delay
          setTimeout(() => {
            try {
              fs.unlinkSync(mainBranchFile);
              fs.unlinkSync(currentFile);
            } catch (e) {
              // Ignore cleanup errors
            }
          }, 10000);
        } catch (error) {
          vscode.window.showErrorMessage(`Failed to open file diff: ${error}`);
        }
      }
    )
  );
}

export function deactivate() {}
