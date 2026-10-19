"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const server_1 = require("./server");
const chatView_1 = require("./chatView");
function activate(context) {
    const log = vscode.window.createOutputChannel("OpenCode");
    context.subscriptions.push(log);
    // Se `opencode` não está no PATH, avisa uma vez (o spawn falharia silencioso).
    if (!(0, server_1.resolveOpencodeCommand)()) {
        log.appendLine("[ext] aviso: 'opencode' não encontrado no PATH");
    }
    const server = new server_1.ServerManager(log);
    const provider = new chatView_1.ChatViewProvider(context, server);
    context.subscriptions.push(provider, { dispose: () => void server.stop() });
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(chatView_1.ChatViewProvider.viewType, provider, {
        webviewOptions: { retainContextWhenHidden: true },
    }));
    context.subscriptions.push(vscode.commands.registerCommand("opencode.openSidebar", () => vscode.commands.executeCommand(`${chatView_1.ChatViewProvider.viewType}.focus`)), vscode.commands.registerCommand("opencode.openPanel", () => provider.openPanel()), vscode.commands.registerCommand("opencode.newSession", () => {
        provider.post({ type: "session:new" });
        vscode.commands.executeCommand(`${chatView_1.ChatViewProvider.viewType}.focus`);
    }), vscode.commands.registerCommand("opencode.restartServer", async () => {
        try {
            const info = await server.restart();
            vscode.window.showInformationMessage(`OpenCode: servidor em ${info.baseUrl}`);
        }
        catch (err) {
            vscode.window.showErrorMessage(`OpenCode: falha ao reiniciar — ${String(err)}`);
        }
    }), vscode.commands.registerCommand("opencode.insertFileReference", async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor)
            return;
        const rel = vscode.workspace.asRelativePath(editor.document.uri);
        await vscode.commands.executeCommand("type", { text: `@${rel}` });
    }), vscode.commands.registerCommand("opencode.showLogs", () => log.show(true)));
    const cfg = vscode.workspace.getConfiguration("opencode");
    if (cfg.get("autoStartServer", true)) {
        server
            .start()
            .then((info) => log.appendLine(`[ext] servidor pronto em ${info.baseUrl}`))
            .catch((err) => {
            log.appendLine(`[ext] servidor indisponível: ${String(err)}`);
            vscode.window.showWarningMessage("OpenCode: não foi possível iniciar o servidor. Use 'OpenCode: Restart Server'.");
        });
    }
}
function deactivate() {
    // O encerramento do servidor é feito pelo dispose registrado em `activate`.
}
//# sourceMappingURL=extension.js.map