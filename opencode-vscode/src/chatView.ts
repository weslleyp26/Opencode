import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import type { BusEvent, ServerManager } from "./server";
import {
  isPathInsideWorkspace,
  parseWebviewMessage,
  randomNonce,
  type WebviewMessage,
} from "./security";

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
 *
 * Segurança:
 *  #4 openFile confinado ao workspace (isPathInsideWorkspace);
 *  #5 contexto do editor anunciado ao webview antes do envio;
 *  #6 eventos sem sessionID ou de outra sessão são descartados;
 *  #7 nonce criptográfico (via security.ts);
 *  #8 toda mensagem da webview passa por parseWebviewMessage.
 */
export class ChatViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "opencode.chatView";
  private view?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel;
  private sessionId: string | null = null;
  private htmlTemplate?: string;
  /** Janela de contexto do modelo padrão (cacheada; obtida do servidor). */
  private contextLimit: number | null = null;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly server: ServerManager
  ) {
    this.disposables.push(
      this.server.onEvent((e) => this.onBusEvent(e)),
      // A UI lê o estado do servidor em `ready` e TAMBÉM a cada mudança:
      // sem isso o indicador ficava preso em "offline" quando a conexão
      // ficava pronta depois do webview carregar (spawn/modal de anexação).
      this.server.onStateChange(() => this.post(this.serverStatus()))
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.context.extensionUri],
    };
    view.webview.html = this.html(view.webview);
    this.disposables.push(
      view.webview.onDidReceiveMessage((raw: unknown) => {
        const m = parseWebviewMessage(raw);
        if (m) void this.handle(m, view.webview);
      })
    );
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
    this.disposables.push(
      panel.webview.onDidReceiveMessage((raw: unknown) => {
        const m = parseWebviewMessage(raw);
        if (m) void this.handle(m, panel.webview);
      })
    );
    panel.onDidDispose(() => (this.panel = undefined));
  }

  post(message: unknown): void {
    this.view?.webview.postMessage(message);
    this.panel?.webview.postMessage(message);
  }

  /**
   * Mensagem de estado do servidor para a webview: `state` é a fonte da
   * verdade do indicador (online/conectando…/offline); `baseUrl` fica como
   * compatibilidade com o formato antigo.
   */
  private serverStatus(): {
    type: "server";
    state: "starting" | "online" | "offline";
    baseUrl: string | null;
    sessionId: string | null;
  } {
    return {
      type: "server",
      state: this.server.connectionState,
      baseUrl: this.server.current?.baseUrl ?? null,
      sessionId: this.sessionId,
    };
  }

  /** Inicia uma nova sessão (a anterior continua no servidor, no histórico). */
  newSession(): void {
    this.sessionId = null;
    this.contextLimit = null;
    this.post({ type: "session:new" });
    // Zera a barra superior junto com a conversa.
    this.post({ type: "usage", input: 0, output: 0, contextLimit: null });
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }

  // ------------------------------------------------------------- bus -> UI

  /**
   * Barra superior dinâmica: envia à webview o uso acumulado da sessão
   * (tokens de input/output) e a janela de contexto do modelo, para o
   * cálculo do percentual de contexto atual.
   */
  private async postUsage(): Promise<void> {
    if (!this.sessionId) return;
    const usage = await this.server.getSessionUsage(this.sessionId);
    if (!usage) return;
    if (this.contextLimit === null) {
      this.contextLimit = await this.server.getModelContextLimit();
    }
    this.post({
      type: "usage",
      input: usage.input,
      output: usage.output,
      contextLimit: this.contextLimit,
    });
  }

  private onBusEvent(e: BusEvent): void {
    const data = e.data ?? {};
    const sid = typeof data.sessionID === "string" ? data.sessionID : undefined;
    // #6: filtra por sessão de forma estrita — eventos sem sessionID ou de
    // outra sessão nunca são roteados para esta UI (evita bleed entre sessões
    // quando conectado a um servidor compartilhado em modo attach).
    if (!this.sessionId || sid !== this.sessionId) return;

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
        // A barra superior mostra estado + tokens + % de contexto: repassa o
        // uso ACUMULADO da sessão (GET /session/:id) junto com o passo.
        void this.postUsage();
        break;
      case "session.execution.succeeded":
        this.post({ type: "exec:end", ok: true });
        break;
      case "session.execution.aborted":
        this.post({ type: "exec:end", ok: false, aborted: true });
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
        target.postMessage(this.serverStatus());
        break;
      case "newSession":
        this.newSession();
        break;
      case "send":
        await this.handleSend(message.text ?? "", target);
        break;
      case "abort":
        await this.handleAbort(target);
        break;
      case "pickFile":
        await this.handlePickFile(target);
        break;
      case "listSessions":
        await this.handleListSessions(target);
        break;
      case "restoreSession":
        await this.handleRestoreSession(message.sessionId ?? "", target);
        break;
      case "insertReference": {
        // O botão `@` do webview insere a referência no COMPOSER (na mensagem),
        // não no editor: o foco está no webview, então o comando `type` não
        // teria alvo. Abre um seletor de arquivos do workspace (com o arquivo
        // ativo no topo) para anexar QUALQUER arquivo, não só o já aberto.
        await this.handlePickFile(target, this.activeFileReference());
        break;
      }
      case "openFile":
        // #4: caminho já validado por parseWebviewMessage/isPathInsideWorkspace.
        await this.openFile(message.path, message.line);
        break;
    }
  }

  /**
   * Aborta a execução em andamento NO SERVIDOR (POST /session/:id/interrupt).
   * O botão de parar da UI dispara isso; a UI é liberada ao chegar o
   * evento `session.execution.aborted`/`succeeded` pelo SSE, com fallback
   * imediato para não deixar a UI travada.
   */
  private async handleAbort(target: vscode.Webview): Promise<void> {
    if (!this.sessionId) {
      target.postMessage({ type: "exec:end", ok: false });
      return;
    }
    try {
      await this.server.abortSession(this.sessionId);
    } catch (err) {
      target.postMessage({ type: "error", text: `abort: ${String(err)}` });
    }
    target.postMessage({ type: "exec:end", ok: false });
  }

  /**
   * Seletor de arquivos do workspace (estilo TUI do OpenCode): abre um
   * QuickPick com os arquivos do projeto e devolve o escolhido para o
   * webview inserir como `@arquivo` no composer.
   */
  private async handlePickFile(
    target: vscode.Webview,
    preferred?: string | null
  ): Promise<void> {
    const exclude =
      "{**/node_modules/**,**/.git/**,**/out/**,**/dist/**,**/.vscode-test/**}";
    const uris = await vscode.workspace.findFiles("**/*", exclude, 500);
    if (uris.length === 0) {
      target.postMessage({
        type: "error",
        text: "Nenhum arquivo encontrado no workspace.",
      });
      return;
    }
    const rel = (u: vscode.Uri) => vscode.workspace.asRelativePath(u);
    const preferredRel = preferred?.replace(/^@/, "") ?? null;
    const items = uris
      .map((u) => rel(u))
      .sort((a, b) => {
        // arquivo ativo sempre primeiro
        if (preferredRel) {
          if (a === preferredRel) return -1;
          if (b === preferredRel) return 1;
        }
        return a.localeCompare(b);
      })
      .map((r) => ({
        label: r,
        description: r === preferredRel ? "@arquivo (aberto)" : "@arquivo",
      }));
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: "Escolha um arquivo para anexar com @ (digite para filtrar)",
      matchOnDescription: true,
    });
    if (pick) target.postMessage({ type: "reference:insert", text: `@${pick.label}` });
  }

  /** Lista as sessões do servidor e deixa o usuário voltar para uma delas. */
  private async handleListSessions(target: vscode.Webview): Promise<void> {
    try {
      const sessions = await this.server.listSessions();
      if (sessions.length === 0) {
        target.postMessage({
          type: "error",
          text: "Nenhuma sessão anterior encontrada no servidor.",
        });
        return;
      }
      const items = sessions.map((s) => ({
        label: s.title ?? "(sem título)",
        description: s.updated
          ? new Date(s.updated).toLocaleString()
          : "",
        detail: s.id === this.sessionId ? "sessão atual" : s.id,
        sid: s.id,
      }));
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: "Voltar para uma sessão anterior",
        matchOnDescription: true,
      });
      if (!pick) return;
      this.sessionId = pick.sid;
      const messages = await this.server.getMessages(pick.sid);
      target.postMessage({
        type: "session:restore",
        sessionId: pick.sid,
        messages,
      });
      // Restaura também a barra superior com o uso acumulado da sessão.
      this.contextLimit = null;
      void this.postUsage();
    } catch (err) {
      target.postMessage({ type: "error", text: String(err) });
    }
  }

  /** Restaura uma sessão escolhida na lista (histórico). */
  private async handleRestoreSession(
    sessionId: string,
    target: vscode.Webview
  ): Promise<void> {
    try {
      this.sessionId = sessionId;
      const messages = await this.server.getMessages(sessionId);
      target.postMessage({ type: "session:restore", sessionId, messages });
      this.contextLimit = null;
      void this.postUsage();
    } catch (err) {
      target.postMessage({ type: "error", text: String(err) });
    }
  }

  private async handleSend(text: string, target: vscode.Webview): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;

    // #5: contexto do editor NÃO é anexado em silêncio — o webview recebe um
    // aviso `context:attached` com o rótulo do que será incluído no prompt.
    const { prompt: withContext, label } = await this.withEditorContext(trimmed);
    target.postMessage({ type: "context:attached", label });

    try {
      if (!this.sessionId) {
        this.sessionId = await this.server.createSession(trimmed.slice(0, 60));
        target.postMessage({ type: "session:id", sessionId: this.sessionId });
        this.contextLimit = null; // nova sessão: limite pode variar por modelo
      }
      await this.server.prompt(this.sessionId, withContext);
      // Alimenta a barra superior (tokens + % de contexto) imediatamente.
      void this.postUsage();
    } catch (err) {
      target.postMessage({ type: "error", text: String(err) });
    }
  }

  private async openFile(relPath?: string, line?: number): Promise<void> {
    if (!relPath) return;
    // #4: defesa em profundidade — mesmo com validação na entrada, garante
    // confinamento ao workspace antes de abrir o documento.
    if (!isPathInsideWorkspace(relPath)) {
      vscode.window.showWarningMessage(
        "OpenCode: caminho fora do workspace bloqueado."
      );
      return;
    }
    const root = vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!root) return;
    const uri = vscode.Uri.joinPath(root, relPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = await vscode.window.showTextDocument(doc);
    if (line) {
      const pos = new vscode.Position(Math.max(0, Math.trunc(line) - 1), 0);
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos));
    }
  }

  /** Caminho relativo do arquivo ativo no formato `@arquivo` (ou null). */
  private activeFileReference(): string | null {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return null;
    return `@${vscode.workspace.asRelativePath(editor.document.uri)}`;
  }

  /**
   * Anexa arquivo aberto / seleção no formato `@arquivo#Lx-y`.
   * Retorna o prompt final E o rótulo do anexo (para exibição na UI, #5).
   */
  private async withEditorContext(
    text: string
  ): Promise<{ prompt: string; label: string | null }> {
    const cfg = vscode.workspace.getConfiguration("opencode");
    const editor = vscode.window.activeTextEditor;
    if (!editor) return { prompt: text, label: null };

    const rel = vscode.workspace.asRelativePath(editor.document.uri);
    const sel = editor.selection;
    const attachSelection = cfg.get<boolean>("attachSelection", true);
    const attachFile = cfg.get<boolean>("attachOpenFile", true);

    if (attachSelection && !sel.isEmpty) {
      const snippet = editor.document.getText(sel);
      const range = `#L${sel.start.line + 1}-${sel.end.line + 1}`;
      return {
        prompt: `@${rel}${range}\n\`\`\`\n${snippet}\n\`\`\`\n\n${text}`,
        label: `@${rel}${range}`,
      };
    }
    if (attachFile) return { prompt: `@${rel}\n\n${text}`, label: `@${rel}` };
    return { prompt: text, label: null };
  }

  // ---------------------------------------------------------------- HTML

  private html(webview: vscode.Webview): string {
    // #7: nonce vindo de crypto.randomBytes (security.ts).
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
