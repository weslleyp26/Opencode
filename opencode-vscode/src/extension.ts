import * as vscode from "vscode";
import { ServerManager, resolveOpencodeCommand } from "./server";
import { ChatViewProvider } from "./chatView";

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("OpenCode");
  context.subscriptions.push(log);

  // Se `opencode` não está no PATH, avisa uma vez (o spawn falharia silencioso).
  if (!resolveOpencodeCommand()) {
    log.appendLine("[ext] aviso: 'opencode' não encontrado no PATH");
  }

  const server = new ServerManager(log);
  const provider = new ChatViewProvider(context, server);
  context.subscriptions.push(provider, { dispose: () => void server.stop() });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("opencode.openSidebar", () =>
      vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`)
    ),
    vscode.commands.registerCommand("opencode.openPanel", () => provider.openPanel()),
    vscode.commands.registerCommand("opencode.newSession", () => {
      provider.post({ type: "session:new" });
      vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    }),
    vscode.commands.registerCommand("opencode.restartServer", async () => {
      try {
        const info = await server.restart();
        vscode.window.showInformationMessage(`OpenCode: servidor em ${info.baseUrl}`);
      } catch (err) {
        vscode.window.showErrorMessage(`OpenCode: falha ao reiniciar — ${String(err)}`);
      }
    }),
    vscode.commands.registerCommand("opencode.insertFileReference", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const rel = vscode.workspace.asRelativePath(editor.document.uri);
      await vscode.commands.executeCommand("type", { text: `@${rel}` });
    }),
    vscode.commands.registerCommand("opencode.showLogs", () => log.show(true))
  );

  const cfg = vscode.workspace.getConfiguration("opencode");
  // #2: em um workspace não confiável ( Restricted Mode ), não inicie o
  // servidor automaticamente — a config do projeto (opencode.json) pode
  // conter plugins/comandos que executam código. O manifest também declara
  // `capabilities.untrustedWorkspaces.supported: false`.
  if (!vscode.workspace.isTrusted) {
    log.appendLine("[ext] workspace não confiável — auto-start do servidor suprimido");
  } else if (cfg.get<boolean>("autoStartServer", true)) {
    server
      .start()
      .then((info) => log.appendLine(`[ext] servidor pronto em ${info.baseUrl}`))
      .catch((err) => {
        log.appendLine(`[ext] servidor indisponível: ${String(err)}`);
        vscode.window.showWarningMessage(
          "OpenCode: não foi possível iniciar o servidor. Use 'OpenCode: Restart Server'."
        );
      });
  }
}

export function deactivate(): void {
  // O encerramento do servidor é feito pelo dispose registrado em `activate`.
}
