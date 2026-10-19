import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { BusEvent, ServerManager } from "./server";

interface WebviewMessage {
  type: "ready" | "send" | "newSession" | "abort" | "insertReference" | "openFile";
  text?: string;
  path?: string;
  line?: number;
}

/**
 * Provider do webview com streaming real.
 *
 * Roteia os eventos `session.*` do bus SSE para o webview:
 *   session.text.delta      -> texto incremental (markdown chega aos pedaços)
 *   session.reasoning.delta -> raciocínio
 *   session.step.ended      -> fim do passo, com tokens/custo
 *   session.execution.*     -> estado da execução
 *
 * A UI fica em `media/webview.html` (separada do host, como Codex/Claude):
 * composer arredondado, `Enter` envia / `Shift+Enter` quebra linha,
 * mensagens em bolhas, markdown e tela de boas-vindas.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "opencode.chatView";
  private view?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel;
  private sessionId: string | null = null;
  private htmlTemplate?: string;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly server: ServerManager
  ) {
    this.disposables.push(
      this.server.onEvent((e) => this.onBusEvent(e))
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: WebviewMessage) => this.handle(m, view.webview));
    // Ao revelar o painel, devolve o foco ao campo de digitação (UX estilo Codex).
    this.disposables.push(
      view.onDidChangeVisibility(() => {
        if (view.visible) this.post({ type: "focus" });
      })
    );
  }

  openPanel(): void {
    if (this.panel) {
      this.panel.reveal();
      this.post({ type: "focus" });
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "opencodeChat",
      "OpenCode",
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.context.extensionUri],
      }
    );
    this.panel = panel;
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage((m: WebviewMessage) =>
      this.handle(m, panel.webview)
    );
    panel.onDidDispose(() => (this.panel = undefined));
  }

  post(message: unknown): void {
    this.view?.webview.postMessage(message);
    this.panel?.webview.postMessage(message);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  // ------------------------------------------------------------- bus -> UI

  private onBusEvent(e: BusEvent): void {
    const data = e.data ?? {};
    const sid = data.sessionID as string | undefined;
    // Ignora eventos de outras sessões para não misturar conversas.
    if (sid && this.sessionId && sid !== this.sessionId) return;

    switch (e.type) {
      case "session.execution.started":
        this.post({ type: "exec:start" });
        break;
      case "session.reasoning.delta":
        this.post({ type: "reasoning:delta", text: data.delta });
        break;
      case "session.text.delta":
        this.post({ type: "text:delta", text: data.delta });
        break;
      case "session.text.ended":
        this.post({ type: "text:ended", text: data.text });
        break;
      case "session.step.ended":
        this.post({
          type: "step:ended",
          tokens: data.tokens,
          cost: data.cost,
          finish: data.finish,
        });
        break;
      case "session.execution.succeeded":
        this.post({ type: "exec:end", ok: true });
        break;
      case "session.execution.failed":
        this.post({ type: "exec:end", ok: false });
        break;
      case "session.error":
      case "session.execution.error":
        this.post({ type: "error", text: JSON.stringify(data) });
        break;
    }
  }

  // ------------------------------------------------------------- UI -> host

  private async handle(
    message: WebviewMessage,
    target: vscode.Webview
  ): Promise<void> {
    switch (message.type) {
      case "ready":
        target.postMessage({
          type: "server",
          baseUrl: this.server.current?.baseUrl ?? null,
          sessionId: this.sessionId,
        });
        break;
      case "newSession":
        this.sessionId = null;
        target.postMessage({ type: "session:new" });
        break;
      case "send":
        await this.handleSend(message.text ?? "", target);
        break;
      case "abort":
        // `abort` da sessão está no servidor; aqui apenas liberamos a UI.
        target.postMessage({ type: "exec:end", ok: false });
        break;
      case "insertReference":
        await vscode.commands.executeCommand("opencode.insertFileReference");
        break;
      case "openFile":
        await this.openFile(message.path, message.line);
        break;
    }
  }

  private async handleSend(text: string, target: vscode.Webview): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    const withContext = await this.withEditorContext(trimmed);
    try {
      if (!this.sessionId) {
        this.sessionId = await this.server.createSession(trimmed.slice(0, 60));
        target.postMessage({ type: "session:id", sessionId: this.sessionId });
      }
      await this.server.prompt(this.sessionId, withContext);
    } catch (err) {
      target.postMessage({ type: "error", text: String(err) });
    }
  }

  private async openFile(path?: string, line?: number): Promise<void> {
    if (!path) return;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return;
    const uri = vscode.Uri.joinPath(root, path);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);
    if (line) {
      const pos = new vscode.Position(Math.max(0, line - 1), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos));
    }
  }

  /** Anexa arquivo aberto / seleção no formato `@arquivo#Lx-y`. */
  private async withEditorContext(text: string): Promise<string> {
    const cfg = vscode.workspace.getConfiguration("opencode");
    const editor = vscode.window.activeTextEditor;
    if (!editor) return text;

    const rel = vscode.workspace.asRelativePath(editor.document.uri);
    const sel = editor.selection;
    const attachSelection = cfg.get<boolean>("attachSelection", true);
    const attachFile = cfg.get<boolean>("attachOpenFile", true);

    if (attachSelection && !sel.isEmpty) {
      const snippet = editor.document.getText(sel);
      const range = `#L${sel.start.line + 1}-${sel.end.line + 1}`;
      return `@${rel}${range}\n\`\`\`\n${snippet}\n\`\`\`\n\n${text}`;
    }
    if (attachFile) return `@${rel}\n\n${text}`;
    return text;
  }

  // ---------------------------------------------------------------- HTML

  private html(webview: vscode.Webview): string {
    const nonce = randomNonce();
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return this.template()
      .replace("{{CSP}}", csp)
      .replace("{{NONCE}}", nonce);
  }

  /** Lê `media/webview.html` (cacheado) — UI desacoplada do host. */
  private template(): string {
    if (this.htmlTemplate === undefined) {
      const file = path.join(this.context.extensionPath, "media", "webview.html");
      try {
        this.htmlTemplate = fs.readFileSync(file, "utf8");
      } catch (err) {
        const msg = String(err).replace(/[&<>"]/g, (c) =>
          c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;"
        );
        this.htmlTemplate =
          `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);padding:12px">` +
          `<h3>OpenCode</h3><p>Não foi possível carregar <code>media/webview.html</code>: ${msg}</p>` +
          `</body></html>`;
      }
    }
    return this.htmlTemplate;
  }
}

function randomNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
