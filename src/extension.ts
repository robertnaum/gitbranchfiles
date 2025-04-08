import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "gitcommitfiles" is now active!');

    const disposable = vscode.commands.registerCommand('gitcommitfiles.selectCommitFiles', async () => {
        try {
            // Get the current workspace folder
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) {
                vscode.window.showErrorMessage('No workspace folder is open.');
                return;
            }

            const workspacePath = workspaceFolders[0].uri.fsPath;

            // Get the list of commits in descending chronological order (newest first) with dates
            const commits = cp.execSync('git log --format="%h %ad %s" --date=short', { cwd: workspacePath }).toString().split('\n');
            const commitItems = commits
                .filter(commit => commit.trim() !== '')
                .map((commit) => {
                    const parts = commit.split(' ');
                    if (parts.length >= 3) {
                        const hash = parts[0];
                        const date = parts[1];
                        const message = parts.slice(2).join(' ');
                        return { 
                            label: `${hash} (${date})`, 
                            description: message,
                            hash: hash // Store original hash for later use
                        };
                    }
                    return null;
                })
                .filter((item): item is { label: string; description: string; hash: string } => item !== null);

            // Show a quick pick to select a commit
            const selectedCommit = await vscode.window.showQuickPick(commitItems, {
                placeHolder: 'Select a commit to view its files',
            });

            if (!selectedCommit) {
                return;
            }

            // Get the files for the selected commit
            const gitCommand = `git show --name-only --pretty=format: ${selectedCommit.hash}`;
            console.log(`Executing git command: ${gitCommand}`);
            const files = cp.execSync(gitCommand, { cwd: workspacePath })
                .toString()
                .split('\n')
                .filter((file) => file);

            console.log(`Files found in commit: ${files.length}`);
            console.log(`Files: ${files.join(', ')}`);

            if (files.length === 0) {
                vscode.window.showInformationMessage('No files found in the selected commit.');
                return;
            }

            try {
                // Collect URIs of existing files from the commit
                const existingFileUris: vscode.Uri[] = [];
                
                for (const file of files) {
                    // Use the file path as returned by Git - don't join with workspace path
                    // as Git already provides paths relative to repo root
                    const filePath = path.join(workspacePath, file);
                    const fileUri = vscode.Uri.file(filePath);
                    
                    try {
                        // Check if the file exists
                        await vscode.workspace.fs.stat(fileUri);
                        existingFileUris.push(fileUri);
                        console.log(`File exists: ${file}`);
                    } catch (err) {
                        // Try to find the file in the workspace by searching for the filename
                        const fileName = path.basename(file);
                        console.log(`Looking for file ${fileName} in workspace...`);
                        
                        // If the file doesn't exist at the direct path, it could be in a different location
                        // For now, still mark it as not found but add better logging
                        console.log(`File not found at expected path: ${file}`);
                    }
                }
                
                if (existingFileUris.length === 0) {
                    vscode.window.showInformationMessage('None of the files in this commit exist in the workspace.');
                    return;
                }
                
                // Create content for a temporary file listing all the commit files
                const fileListContent = `# Files in commit ${selectedCommit.label}\n\n` + 
                    files.map((file, index) => {
                        // Improve path comparison - check if any URI ends with the file path
                        // This handles cases where files might be in different subdirectories
                        const exists = existingFileUris.some(uri => {
                            // Normalize paths for accurate comparison
                            const normalizedUriPath = uri.fsPath.replace(/\\/g, '/');
                            const normalizedFile = file.replace(/\\/g, '/');
                            
                            // Check if the URI path ends with the file path
                            // This will correctly identify files in subdirectories
                            return normalizedUriPath.endsWith(normalizedFile);
                        });
                        return `${index + 1}. ${file} ${exists ? '(exists)' : '(not found)'}`;
                    }).join('\n');
                
                // Create a temporary untitled document to show the file list
                const untitledDoc = await vscode.workspace.openTextDocument({ 
                    content: fileListContent,
                    language: 'markdown' 
                });
                await vscode.window.showTextDocument(untitledDoc, { preview: false });
                
                console.log(fileListContent);
            } catch (error) {
                if (error instanceof Error) {
                    vscode.window.showErrorMessage(`An error occurred: ${error.message}`);
                } else {
                    vscode.window.showErrorMessage('An unknown error occurred.');
                }
            }
        } catch (error) {
            if (error instanceof Error) {
                vscode.window.showErrorMessage(`An error occurred: ${error.message}`);
            } else {
                vscode.window.showErrorMessage('An unknown error occurred.');
            }
        }
    });

    context.subscriptions.push(disposable);
}

export function deactivate() {}
