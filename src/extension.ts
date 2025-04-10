import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

// Define interface for directory selection items
interface DirectoryItem {
    label: string;
    description: string;
    path: string;
    isBrowseOption?: boolean;
    absolutePath?: string;
    isExternal?: boolean;
}

export function activate(context: vscode.ExtensionContext) {
    console.log('Congratulations, your extension "gitbranchfiles" is now active!');

    const disposable = vscode.commands.registerCommand('gitbranchfiles.selectBranchFiles', async () => {
        try {
            // Get the current workspace folder
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders) {
                vscode.window.showErrorMessage('No workspace folder is open.');
                return;
            }

            const workspacePath = workspaceFolders[0].uri.fsPath;

            // Get list of directories in the workspace for folder selection
            const getDirectoriesCommand = `git ls-files --directory | xargs -n 1 dirname | sort | uniq`;
            let directories: string[] = [];
            try {
                directories = cp.execSync(getDirectoriesCommand, { cwd: workspacePath })
                    .toString()
                    .split('\n')
                    .filter(dir => dir.trim() !== '');
            } catch (e) {
                // If there's an error getting directories, just use the root
            }

            // Always add the root directory as an option
            directories = [".", ...directories];
            
            const directoryItems: DirectoryItem[] = [
                {
                    label: "$(folder-opened) Browse...",
                    description: "Select folder using file browser",
                    path: "BROWSE",
                    isBrowseOption: true
                },
                {
                    label: "Current directory",
                    description: "Root of the repository",
                    path: "."
                },
                ...directories.filter(dir => dir !== ".").map(dir => ({
                    label: dir,
                    description: "",
                    path: dir
                }))
            ];

            // Show quick pick to select directory
            const directorySelection = await vscode.window.showQuickPick(directoryItems, {
                placeHolder: 'Select a folder to view files from (default: entire repository)',
            });
            
            if (!directorySelection) {
                return; // User cancelled the folder selection
            }
            
            // Handle folder browsing
            let selectedDirectory: DirectoryItem;
            if (directorySelection.isBrowseOption) {
                // Open folder picker dialog
                const options: vscode.OpenDialogOptions = {
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false,
                    openLabel: 'Select Folder',
                    defaultUri: vscode.Uri.file(workspacePath)
                };
                
                const folderUri = await vscode.window.showOpenDialog(options);
                if (!folderUri || folderUri.length === 0) {
                    // User cancelled folder selection, fall back to root directory
                    selectedDirectory = { 
                        path: ".", 
                        label: "Current directory",
                        description: "Root of the repository" 
                    };
                } else {
                    // Use the selected folder directly
                    const selectedPath = folderUri[0].fsPath;
                    
                    // Store both absolute and workspace-relative paths
                    let relativePath = path.relative(workspacePath, selectedPath);
                    if (relativePath === "") {
                        relativePath = ".";
                    }
                    
                    selectedDirectory = { 
                        path: relativePath, 
                        label: relativePath === "." ? "Current directory" : relativePath,
                        description: relativePath === "." ? "Root of the repository" : `Folder: ${relativePath}`,
                        absolutePath: selectedPath,
                        isExternal: !selectedPath.startsWith(workspacePath)
                    };
                    
                    console.log(`Selected folder: ${selectedDirectory.path}`);
                    if (selectedDirectory.isExternal) {
                        console.log(`External repository at: ${selectedDirectory.absolutePath}`);
                    }
                }
            } else {
                selectedDirectory = directorySelection;
                selectedDirectory.absolutePath = selectedDirectory.path === "." ? 
                    workspacePath : path.join(workspacePath, selectedDirectory.path);
                selectedDirectory.isExternal = false;
            }
            
            // Determine the correct repository path to use
            const repoPath = selectedDirectory.isExternal ? 
                selectedDirectory.absolutePath : workspacePath;
                
            // Check if the selected path contains a Git repository
            let hasGitRepo = false;
            try {
                // Try to execute a simple git command in the selected directory
                cp.execSync('git rev-parse --is-inside-work-tree', { cwd: repoPath });
                hasGitRepo = true;
            } catch (error) {
                if (selectedDirectory.isExternal) {
                    vscode.window.showErrorMessage(
                        `The selected folder doesn't appear to be a Git repository. Please select a different folder.`
                    );
                    return;
                }
            }
            
            // Get the list of branches for the repository
            let branches: string[];
            try {
                branches = cp.execSync('git branch --all', { cwd: repoPath }).toString().split('\n');
            } catch (error) {
                vscode.window.showErrorMessage(
                    `Failed to get Git branches: ${error instanceof Error ? error.message : 'unknown error'}`
                );
                return;
            }
            
            const branchItems = branches
                .filter(branch => branch.trim() !== '')
                .map((branch) => {
                    const branchName = branch.replace('*', '').trim();
                    return {
                        label: branchName,
                        description: branch.startsWith('*') ? 'Current branch' : ''
                    };
                });

            // Show a quick pick to select a branch
            const selectedBranch = await vscode.window.showQuickPick(branchItems, {
                placeHolder: 'Select a branch to view its changed files',
            });

            if (!selectedBranch) {
                return;
            }

            // Get the list of files changed in the selected branch's history
            // This command gets all files that have been modified in the branch compared to the merge-base with main/master
            let baseRef = 'main';
            try {
                // Try to determine if the repo uses main or master as the default branch
                cp.execSync('git show-ref --verify --quiet refs/heads/main', { cwd: repoPath });
            } catch (e) {
                baseRef = 'master';
            }
            
            // Get the merge-base (common ancestor) of the current branch and the selected branch
            try {
                // Handle branches with proper command execution that works on Windows
                let branchName = selectedBranch.label;
                
                // Clean up remote branch names (like "remotes/origin/main" to "origin/main")
                if (branchName.includes('remotes/')) {
                    branchName = branchName.replace('remotes/', '');
                }
                
                // Define folderPath based on whether we're dealing with an external repository
                let folderPath, pathForGitCommands;
                if (selectedDirectory.isExternal) {
                    // For external repos, we're already at the directory we want
                    folderPath = "";
                    pathForGitCommands = "";
                } else {
                    // For workspace repos, use the relative path
                    folderPath = selectedDirectory.path === "." ? "" : selectedDirectory.path;
                    pathForGitCommands = folderPath;
                }
                
                // Get committed files that differ between the base branch and the selected branch
                let committedFiles: string[] = [];
                try {
                    // Check if we're comparing a branch to itself
                    const isSameBranch = branchName === baseRef || branchName.endsWith('/' + baseRef);
                    
                    if (isSameBranch) {
                        // If comparing the same branch, get files from all commits
                        console.log(`Same branch detected, fetching all commits in branch`);
                        
                        // For branches with the same base, use a simpler and more reliable approach
                        // Get all changed files in the branch's history
                        const pathFilter = pathForGitCommands ? ` -- "${pathForGitCommands}"` : '';
                        const allFilesCommand = `git log --name-only --format="" ${branchName}${pathFilter} | sort | uniq`;
                        console.log(`Running command: ${allFilesCommand} in ${repoPath}`);
                        
                        committedFiles = cp.execSync(allFilesCommand, { cwd: repoPath })
                            .toString()
                            .split('\n')
                            .filter(file => file.trim() !== '');
                        
                        console.log(`Found ${committedFiles.length} unique files in branch history`);
                        
                        // If needed, also check individual commits for verification
                        const shouldVerifyCommits = false; // Set to true to double-check with commit-by-commit approach
                        
                        if (shouldVerifyCommits) {
                            // Get list of all commits in the branch
                            const commitListCommand = `git log --format="%H" ${branchName}`;
                            const commits = cp.execSync(commitListCommand, { cwd: repoPath }).toString().trim().split('\n');
                            console.log(`Found ${commits.length} commits in branch ${branchName}`);
                            
                            // Show progress notification for long operations
                            await vscode.window.withProgress({
                                location: vscode.ProgressLocation.Notification,
                                title: `Verifying ${commits.length} commits in branch ${branchName}`,
                                cancellable: false
                            }, async (progress) => {
                                // For each commit, get the files changed
                                let allCommitFiles: string[] = [];
                                const totalCommits = commits.length;
                                
                                // Include first commit explicitly
                                if (totalCommits > 0) {
                                    try {
                                        const firstCommitCmd = `git show --name-only --pretty=format:"" ${commits[totalCommits-1]}${pathFilter}`;
                                        const firstCommitFiles = cp.execSync(firstCommitCmd, { cwd: repoPath }).toString().split('\n');
                                        allCommitFiles = [...allCommitFiles, ...firstCommitFiles.filter(f => f.trim() !== '')];
                                    } catch (e) {
                                        console.log("Error processing first commit");
                                    }
                                }
                                
                                // Process all commits
                                for (let i = 0; i < totalCommits - 1; i++) {
                                    try {
                                        const commitFilesCommand = `git diff --name-only ${commits[i+1]} ${commits[i]}${pathFilter}`;
                                        const filesInCommit = cp.execSync(commitFilesCommand, { cwd: repoPath })
                                            .toString()
                                            .split('\n')
                                            .filter(f => f.trim() !== '');
                                        
                                        // Add files to the overall list
                                        allCommitFiles = [...allCommitFiles, ...filesInCommit];
                                        
                                        // Update progress
                                        if (i % 5 === 0 || i === totalCommits - 2) {
                                            progress.report({ 
                                                message: `${i+1}/${totalCommits-1} commits (${Math.round((i+1)/(totalCommits-1)*100)}%)`,
                                                increment: (5 / (totalCommits-1)) * 100
                                            });
                                        }
                                    } catch (commitErr) {
                                        console.log(`Error processing commit ${i+1}`);
                                    }
                                }
                                
                                // Combine with files found from the simpler approach
                                committedFiles = [...new Set([...committedFiles, ...allCommitFiles])];
                                console.log(`After verification, found ${committedFiles.length} unique files in all commits`);
                            });
                        }
                    } else {
                        const mergeBaseCommand = `git merge-base ${baseRef} ${branchName}`;
                        const mergeBase = cp.execSync(mergeBaseCommand, { cwd: repoPath }).toString().trim();
                        
                        // Use -- path format only if folder is specified
                        const pathFilter = pathForGitCommands ? ` -- "${pathForGitCommands}"` : '';
                        const committedFilesCommand = `git diff --name-only --recurse-submodules ${mergeBase} ${branchName}${pathFilter}`;
                        
                        console.log(`Running command: ${committedFilesCommand} in ${repoPath}`);
                        committedFiles = cp.execSync(committedFilesCommand, { cwd: repoPath }).toString().split('\n');
                        console.log(`Found ${committedFiles.length} committed files`);
                    }
                } catch (error) {
                    // If the above fails, try direct comparison or recent history
                    try {
                        console.log(`First attempt failed, trying fallback`);
                        const pathFilter = pathForGitCommands ? ` -- "${pathForGitCommands}"` : '';
                        
                        // If comparing same branch, look at all files in recent history
                        if (branchName === baseRef || branchName.endsWith('/' + baseRef)) {
                            const recentFilesCommand = `git log --name-only --pretty=format: -n 20${pathFilter}`;
                            console.log(`Running full history command: ${recentFilesCommand}`);
                            committedFiles = cp.execSync(recentFilesCommand, { cwd: repoPath }).toString().split('\n');
                        } else {
                            // Otherwise do a standard branch diff
                            const fallbackCommand = `git diff --name-only --recurse-submodules ${baseRef}...${branchName}${pathFilter}`;
                            console.log(`Running fallback command: ${fallbackCommand}`);
                            committedFiles = cp.execSync(fallbackCommand, { cwd: repoPath }).toString().split('\n');
                        }
                        console.log(`Found ${committedFiles.length} committed files with fallback`);
                    } catch (fallbackError) {
                        // If all else fails, try using git status as a last resort
                        try {
                            console.log(`Fallback failed, trying git status`);
                            const statusCommand = `git status --porcelain`;
                            const statusOutput = cp.execSync(statusCommand, { cwd: repoPath }).toString();
                            const statusFiles = statusOutput.split('\n')
                                .filter(line => line.trim() !== '')
                                .map(line => line.substring(3).trim());
                            
                            if (folderPath) {
                                committedFiles = statusFiles.filter(file => file.startsWith(folderPath));
                            } else {
                                committedFiles = statusFiles;
                            }
                            console.log(`Found ${committedFiles.length} files via git status`);
                        } catch (statusError) {
                            // If all else fails, log the error
                            console.error('All file detection methods failed:', statusError);
                        }
                    }
                }
                
                // Get currently modified files in the branch (if we're on that branch)
                let modifiedFiles: string[] = [];
                try {
                    // Check if we're on the selected branch
                    const currentBranchCommand = `git rev-parse --abbrev-ref HEAD`;
                    const currentBranch = cp.execSync(currentBranchCommand, { cwd: repoPath }).toString().trim();
                    
                    // Normalize branch names for comparison
                    const normalizedCurrentBranch = currentBranch.replace(/^(refs\/heads\/|refs\/remotes\/\w+\/)/, '');
                    const normalizedSelectedBranch = branchName.replace(/^(refs\/heads\/|refs\/remotes\/\w+\/)/, '');
                    
                    // Only get modified files if we're on the selected branch
                    const isOnSelectedBranch = normalizedCurrentBranch === normalizedSelectedBranch;
                    
                    // For remote branches, we're not likely to be on that branch
                    const isRemoteBranch = branchName.includes('/') && !branchName.startsWith('refs/heads/');
                    
                    if (isOnSelectedBranch && !isRemoteBranch) {
                        // Get modified files using git status instead - more reliable
                        console.log(`On matching branch, getting modified files`);
                        const statusCommand = `git status --porcelain`;
                        const statusOutput = cp.execSync(statusCommand, { cwd: repoPath }).toString();
                        const statusFiles = statusOutput.split('\n')
                            .filter(line => line.trim() !== '')
                            .map(line => line.substring(3).trim());
                        
                        // Add path filter if needed
                        if (folderPath) {
                            modifiedFiles = statusFiles.filter(file => file.startsWith(folderPath));
                        } else {
                            modifiedFiles = statusFiles;
                        }
                        
                        // Also get modified but unstaged files
                        const pathFilter = pathForGitCommands ? ` "${pathForGitCommands}"` : '';
                        const modifiedFilesCommand = `git ls-files --modified --recurse-submodules${pathFilter}`;
                        const additionalModified = cp.execSync(modifiedFilesCommand, { cwd: repoPath })
                            .toString()
                            .split('\n')
                            .filter(f => f.trim() !== '');
                        
                        // Combine both methods
                        modifiedFiles = [...new Set([...modifiedFiles, ...additionalModified])];
                        console.log(`Found ${modifiedFiles.length} modified files`);
                    } else {
                        console.log(`Not on branch ${branchName} (current: ${currentBranch}), skipping modified files detection`);
                    }
                } catch (e) {
                    // If there's an error getting modified files, just continue with committed files
                    console.log(`Error getting modified files: ${e instanceof Error ? e.message : 'unknown error'}`);
                }
                
                // Combine all files and remove duplicates
                const allChangedFiles = [...new Set([...committedFiles, ...modifiedFiles])];
                
                const changedFiles = allChangedFiles.filter(file => file.trim() !== '');
                
                // Sort files: folders first, then alphabetically within each category
                const sortedFiles = [...changedFiles].sort((a, b) => {
                    // Check if either path contains a trailing slash (directory)
                    const aIsDir = a.endsWith('/') || !a.includes('.');
                    const bIsDir = b.endsWith('/') || !b.includes('.');
                    
                    // If one is a directory and the other isn't, the directory comes first
                    if (aIsDir && !bIsDir) return -1;
                    if (!aIsDir && bIsDir) return 1;
                    
                    // Otherwise, sort alphabetically
                    return a.localeCompare(b, undefined, { sensitivity: 'base' });
                });
                
                // Create formatted file list with asterisks for modified files
                const formattedFiles = sortedFiles.map(file => {
                    // Check if the file is in the modified files list
                    const isModified = modifiedFiles.includes(file);
                    // Add asterisk to modified files
                    return isModified ? `* ${file}` : `  ${file}`;
                });

                // Debug information - first file details
                let firstFileInfo = "No files found";
                if (committedFiles.find(f => f.trim() !== '')) {
                    const firstCommitted = committedFiles.find(f => f.trim() !== '');
                    firstFileInfo = `First committed file: ${firstCommitted}`;
                } else if (modifiedFiles.find(f => f.trim() !== '')) {
                    const firstModified = modifiedFiles.find(f => f.trim() !== '');
                    firstFileInfo = `First modified file: ${firstModified}`;
                }

                // Create debug info regardless of whether files were found
                const debugInfo = [
                    `# Git File List for Branch: ${branchName}`,
                    `- Selected folder: ${selectedDirectory.path}`,
                    `- Working directory: ${repoPath}`,
                    `- Total files: ${changedFiles.length} (${modifiedFiles.length} currently modified)`,
                    `\n## File List`,
                    `Files with an asterisk (*) are currently modified but not yet committed.`,
                    ``
                ].join('\n');

                const content = changedFiles.length > 0 
                    ? `${debugInfo}\n${formattedFiles.join('\n')}` 
                    : `${debugInfo}\n\nNo changed files were found. Please verify your Git commands manually.`;

                const newFile = await vscode.workspace.openTextDocument({
                    content: content,
                    language: 'markdown'
                });

                // Show the new document in the editor without influencing the title
                await vscode.window.showTextDocument(newFile, { preview: false });

                // Still show the empty files message if needed
                if (changedFiles.length === 0) {
                    vscode.window.showInformationMessage(`No files have changed in branch: ${selectedBranch.label}`);
                }

            } catch (error) {
                if (error instanceof Error) {
                    vscode.window.showErrorMessage(`Failed to get changed files: ${error.message}`);
                } else {
                    vscode.window.showErrorMessage('Failed to get changed files due to an unknown error');
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
