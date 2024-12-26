import * as vscode from "vscode";
import config from "./config";
import { ForcePushMode, GitAPI, Repository, RefType } from "./git";
import { DateTime } from "luxon";
import { store } from "./store";
import { reaction } from "mobx";
import * as minimatch from "minimatch";

const REMOTE_NAME = "origin";

async function pushRepository(
  repository: Repository,
  forcePush: boolean = false
) {
  if (!(await hasRemotes(repository))) return;

  store.isPushing = true;

  try {
    if (config.autoPull === "onPush") {
      await pullRepository(repository);
    }

    const pushArgs: any[] = [REMOTE_NAME, repository.state.HEAD?.name, false];

    if (forcePush) {
      pushArgs.push(ForcePushMode.Force);
    } else if (config.pushMode !== "push") {
      const pushMode =
        config.pushMode === "forcePush"
          ? ForcePushMode.Force
          : ForcePushMode.ForceWithLease;

      pushArgs.push(pushMode);
    }

    await repository.push(...pushArgs);

    store.isPushing = false;
  } catch {
    store.isPushing = false;

    if (
      await vscode.window.showWarningMessage(
        "Remote repository contains conflicting changes.",
        "Force Push"
      )
    ) {
      await pushRepository(repository, true);
    }
  }
}

async function pullRepository(repository: Repository) {
  if (!(await hasRemotes(repository))) return;

  store.isPulling = true;

  await repository.pull();

  store.isPulling = false;
}

async function hasRemotes(repository: Repository): Promise<boolean> {
  const refs = await repository.getRefs();
  return refs.some((ref) => ref.type === RefType.RemoteHead);
}

function matches(uri: vscode.Uri) {
  return minimatch(uri.path, config.filePattern, { dot: true });
}

async function generateCommitMessage(repository: Repository, changedUris: vscode.Uri[]): Promise<string | null> {
  const diffs = await Promise.all(
    changedUris.map(async (uri) => {
      const filePath = vscode.workspace.asRelativePath(uri);
      const fileDiff = await repository.diffWithHEAD(filePath);

      return `## ${filePath}
---
${fileDiff}`;
    }));

  const model = await vscode.lm.selectChatModels({ family: config.aiModel });
  if (!model || model.length === 0) return null;

  const prompt = `# Base Instructions

* Summarize the following source code diffs into a single concise sentence that describes the essence of the changes that were made, and can be used as a commit message.
* Always start the commit message with a present tense verb such as "Update", "Fix", "Modify", "Add", "Improve", "Organize", "Arrange", etc.
* Respond in plain text, with no markdown formatting, and without any extra content. Simply respond with the commit message, and without a trailing period.
* Don't reference the file paths that were changed, but make sure summarize all significant changes.
${config.aiUseEmojis ? "* Prepend an emoji to the message that best expresses the nature of the changes, and is as specific to the subject and action of the changes as possible.\n" : ""}
# Code change diffs

${diffs.join("\n\n")}

${config.aiCustomInstructions ? `# User-Provided Instructions (Important!)
  
${config.aiCustomInstructions}
` : ""}
# Commit message

`;

  const response = await model[0].sendRequest([{
    role: vscode.LanguageModelChatMessageRole.User,
    name: "User",
    content: prompt
  }]);

  let summary = "";
  for await (const part of response.text) {
    summary += part;
  }

  return summary;
}

export async function commit(repository: Repository, message?: string) {
  const changes = [
    ...repository.state.workingTreeChanges,
    ...repository.state.mergeChanges,
    ...repository.state.indexChanges,
  ];

  if (changes.length === 0) return;

  const changedUris = changes
    .filter((change) => matches(change.uri))
    .map((change) => change.uri);

  if (changedUris.length === 0) return;

  if (config.commitValidationLevel !== "none") {
    const diagnostics = vscode.languages
      .getDiagnostics()
      .filter(([uri, diagnostics]) => {
        const isChanged = changedUris.find(
          (changedUri) =>
            changedUri.toString().localeCompare(uri.toString()) === 0
        );

        return isChanged
          ? diagnostics.some(
            (diagnostic) =>
              diagnostic.severity === vscode.DiagnosticSeverity.Error ||
              (config.commitValidationLevel === "warning" &&
                diagnostic.severity === vscode.DiagnosticSeverity.Warning)
          )
          : false;
      });

    if (diagnostics.length > 0) {
      return;
    }
  }

  let currentTime = DateTime.now();

  // Ensure that the commit dates are formatted
  // as UTC, so that other clients can properly
  // re-offset them based on the user's locale.
  const commitDate = currentTime.toUTC().toString();
  process.env.GIT_AUTHOR_DATE = commitDate;
  process.env.GIT_COMMITTER_DATE = commitDate;

  if (config.timeZone) {
    currentTime = currentTime.setZone(config.timeZone);
  }

  let commitMessage = message || currentTime.toFormat(config.commitMessageFormat);

  if (config.aiEnabled) {
    const aiMessage = await generateCommitMessage(repository, changedUris);
    if (aiMessage) {
      commitMessage = aiMessage;
    }
  }

  await repository.commit(commitMessage, { all: true, noVerify: config.noVerify });

  delete process.env.GIT_AUTHOR_DATE;
  delete process.env.GIT_COMMITTER_DATE;

  if (config.autoPush === "onCommit") {
    await pushRepository(repository);
  }

  if (config.autoPull === "onCommit") {
    await pullRepository(repository);
  }
}

function debounce(fn: Function, delay: number) {
  let timeout: NodeJS.Timeout | null = null;

  return (...args: any[]) => {
    if (timeout) {
      clearTimeout(timeout);
    }

    timeout = setTimeout(() => {
      fn(...args);
    }, delay);
  };
}

const commitMap = new Map();
function debouncedCommit(repository: Repository) {
  if (!commitMap.has(repository)) {
    commitMap.set(
      repository,
      debounce(() => commit(repository), config.autoCommitDelay)
    );
  }

  return commitMap.get(repository);
}

let statusBarItem: vscode.StatusBarItem | null = null;
export function ensureStatusBarItem() {
  if (!statusBarItem) {
    statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left
    );

    statusBarItem.text = "$(mirror)";
    statusBarItem.tooltip = "GitDoc: Auto-commiting files on save";
    statusBarItem.command = "gitdoc.disable";
    statusBarItem.show();
  }

  return statusBarItem;
}

let disposables: vscode.Disposable[] = [];
export function watchForChanges(git: GitAPI): vscode.Disposable {
  const commitAfterDelay = debouncedCommit(git.repositories[0]);
  disposables.push(git.repositories[0].state.onDidChange(commitAfterDelay));

  ensureStatusBarItem();

  disposables.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor && matches(editor.document.uri)) {
        statusBarItem?.show();
      } else {
        statusBarItem?.hide();
      }
    })
  );

  if (
    vscode.window.activeTextEditor &&
    matches(vscode.window.activeTextEditor.document.uri)
  ) {
    statusBarItem?.show();
  } else {
    statusBarItem?.hide();
  }

  disposables.push({
    dispose: () => {
      statusBarItem?.dispose();
      statusBarItem = null;
    },
  });

  if (config.autoPush === "afterDelay") {
    const interval = setInterval(async () => {
      pushRepository(git.repositories[0]);
    }, config.autoPushDelay);

    disposables.push({
      dispose: () => {
        clearInterval(interval);
      },
    });
  }

  if (config.autoPull === "afterDelay") {
    const interval = setInterval(
      async () => pullRepository(git.repositories[0]),
      config.autoPullDelay
    );

    disposables.push({
      dispose: () => clearInterval(interval),
    });
  }

  const reactionDisposable = reaction(
    () => [store.isPushing, store.isPulling],
    () => {
      const suffix = store.isPushing
        ? " (Pushing...)"
        : store.isPulling
          ? " (Pulling...)"
          : "";
      statusBarItem!.text = `$(mirror)${suffix}`;
    }
  );

  disposables.push({
    dispose: reactionDisposable,
  });

  if (config.pullOnOpen) {
    pullRepository(git.repositories[0]);
  }

  return {
    dispose: () => {
      disposables.forEach((disposable) => disposable.dispose());
      disposables = [];
    },
  };
}
