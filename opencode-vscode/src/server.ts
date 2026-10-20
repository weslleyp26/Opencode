import * as vscode from "vscode";
import { spawn, ChildProcessWithoutNullStreams, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";
import type { OutputChannel } from "vscode";
import {
  basicHeader,
  probeUnauthenticated,
  tryCredentials,
  verifyServerEnforcesAuth,
  validateCommandConfig,
} from "./security";

export interface ServerInfo {
  baseUrl: string;
  authHeader: string | null;
  process: ChildProcessWithoutNullStreams | null;
  owned: boolean;
}

/**
 * Estado da conexão com o servidor, espelhado na UI do webview:
 *   starting -> "conectando…", online -> "online", offline -> "offline".
 * Publicado via `onStateChange` para que a UI nunca fique presa num estado
 * antigo (o webview só consultava `current` uma vez, ao enviar `ready`).
 */
export type ConnectionState = "starting" | "online" | "offline";

/** Evento cru do stream SSE (`GET /api/event`). */
export interface BusEvent {
  id: string;
  type: string;
  created?: number;
  data: Record<string, unknown>;
}

/** Resumo de sessão vindo de `GET /session` (histórico). */
export interface SessionSummary {
  id: string;
  title: string | null;
  updated: number | null;
}

/** Mensagem simplificada de uma sessão (`GET /session/:id/message`). */
export interface SessionMessage {
  role: "user" | "assistant";
  text: string;
}

/** Tokens acumulados de uma sessão (`GET /session/:id` -> `data.tokens`). */
export interface SessionUsage {
  input: number;
  output: number;
}

/**
 * Gerencia o servidor OpenCode e o canal de eventos.
 *
 * Contrato verificado ao vivo contra `opencode serve` v2.0.32:
 *   POST /api/session                    -> { data: { id, ... } }
 *   POST /api/session/:id/prompt {text}  -> 202-ish, assíncrono
 *   GET  /api/event                      -> text/event-stream (eventos do bus)
 *   auth: HTTP Basic (OPENCODE_PASSWORD / service.json)
 *
 * Segurança (#1): nunca envia credenciais a um servidor que não provou
 * exigir autenticação; anexar a servidor existente exige confirmação
 * explícita do usuário; após spawn próprio, verifica posse da porta.
 */
export class ServerManager {
  private info: ServerInfo | null = null;
  private starting: Promise<ServerInfo> | null = null;
  private eventAbort: AbortController | null = null;
  private listeners = new Set<(e: BusEvent) => void>();
  /** Estado da conexão espelhado para a UI. */
  private state: ConnectionState = "offline";
  private stateListeners = new Set<(s: ConnectionState) => void>();
  /** Última senha usada, para tentar novamente após restart. */
  private password: string | null = null;

  constructor(private readonly log: OutputChannel) {}

  get current(): ServerInfo | null {
    return this.info;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  onEvent(fn: (e: BusEvent) => void): vscode.Disposable {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  /** Notifica a UI sempre que a conexão muda (início, pronta, queda, stop). */
  onStateChange(fn: (s: ConnectionState) => void): vscode.Disposable {
    this.stateListeners.add(fn);
    return { dispose: () => this.stateListeners.delete(fn) };
  }

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    for (const fn of this.stateListeners) fn(state);
  }

  /** Atribui `info` e publica o estado correspondente (online/offline). */
  private setInfo(info: ServerInfo | null): void {
    this.info = info;
    this.setState(info ? "online" : "offline");
  }

  async start(): Promise<ServerInfo> {
    if (this.info) return this.info;
    if (this.starting) return this.starting;
    this.setState("starting");
    const pending = this.doStart().finally(() => (this.starting = null));
    this.starting = pending;
    try {
      return await pending;
    } catch (err) {
      // Falha (spawn, timeout, anexação recusada): a UI precisa sair de
      // "conectando…" e mostrar o estado real.
      this.setState("offline");
      throw err;
    }
  }

  private async doStart(): Promise<ServerInfo> {
    const cfg = vscode.workspace.getConfiguration("opencode");
    const command = cfg.get<string>("serverCommand", "opencode");
    const args = cfg.get<string[]>("serverArgs", [
      "serve",
      "--hostname",
      "127.0.0.1",
      "--port",
      "4096",
    ]);

    // #3: bloqueia command injection via config antes de qualquer spawn.
    const cfgError = validateCommandConfig(command, args);
    if (cfgError) {
      this.log.appendLine(`[server] configuração rejeitada: ${cfgError}`);
      throw new Error(`configuração do servidor rejeitada: ${cfgError}`);
    }

    const port = this.extractPort(args) ?? 4096;
    const baseUrl = `http://127.0.0.1:${port}`;

    // #1: sonda ANÔNIMA. Um servidor que responde 200 sem autenticação pode
    // ser um impostor coletor de credenciais; nunca enviamos senha a ele.
    const probe = await probeUnauthenticated(baseUrl);
    if (probe.kind === "open" || probe.kind === "auth-required") {
      return await this.attachToExisting(baseUrl, probe.kind);
    }
    if (probe.kind === "other") {
      throw new Error(`porta ${port} respondeu inesperadamente (HTTP ${probe.status})`);
    }

    const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    // A senha do service.json pertence ao SERVIÇO EM BACKGROUND e é rejeitada
    // por um `serve` iniciado por nós (verificado empiricamente). Portanto:
    //  - se o usuário definiu OPENCODE_PASSWORD, respeitamos;
    //  - caso contrário, geramos uma senha própria para este processo.
    const password = process.env.OPENCODE_PASSWORD || randomPassword();
    this.password = password;

    this.log.appendLine(`[server] iniciando: ${command} ${args.join(" ")}`);
    const child = spawn(command, args, {
      cwd: workspace,
      env: {
        ...process.env,
        ...(password ? { OPENCODE_SERVER_PASSWORD: password } : {}),
      },
      shell: process.platform === "win32",
      windowsHide: true,
    });
    child.stdout.on("data", (d: Buffer) => this.log.append(d.toString()));
    child.stderr.on("data", (d: Buffer) => this.log.append(d.toString()));
    child.on("exit", (code) => {
      this.log.appendLine(`[server] saiu com código ${code}`);
      if (this.info?.process === child) this.setInfo(null);
    });

    await this.waitForReady(baseUrl, password);

    // #1: verificação de posse — se outro processo tomou a porta antes do
    // nosso filho binde, ele não exigirá auth => abortamos e matamos o filho.
    const ownership = await verifyServerEnforcesAuth(
      baseUrl,
      basicHeader("opencode", password)
    );
    if (!ownership.owned) {
      this.log.appendLine(`[server] posse da porta falhou: ${ownership.detail}`);
      child.kill();
      throw new Error(`servidor em ${baseUrl} não é confiável (${ownership.detail})`);
    }

    const info: ServerInfo = {
      baseUrl,
      authHeader: password ? basicHeader("opencode", password) : null,
      process: child,
      owned: true,
    };
    this.setInfo(info);
    this.log.appendLine(`[server] pronto em ${baseUrl}`);
    void this.pumpEvents();
    return info;
  }

  /**
   * Anexa a um servidor que já responde na porta. Exige confirmação
   * explícita do usuário (#1) e só envia credenciais armazenadas quando
   * o servidor demonstrou exigir autenticação.
   */
  private async attachToExisting(
    baseUrl: string,
    kind: "open" | "auth-required"
  ): Promise<ServerInfo> {
    const choice = await vscode.window.showWarningMessage(
      `OpenCode: já existe um servidor respondendo em ${baseUrl} ` +
        (kind === "open"
          ? "(sem autenticação). Anexar a ele?"
          : "(exige autenticação). Anexar usando credenciais locais?"),
      { modal: true },
      "Anexar",
      "Cancelar"
    );
    if (choice !== "Anexar") {
      throw new Error(`anexação a ${baseUrl} recusada pelo usuário`);
    }

    if (kind === "open") {
      // Servidor sem auth: anexa sem enviar nenhum segredo.
      this.log.appendLine(`[server] conectado a servidor existente (sem auth) em ${baseUrl}`);
      const info: ServerInfo = { baseUrl, authHeader: null, process: null, owned: false };
      this.setInfo(info);
      void this.pumpEvents();
      return info;
    }

    // Servidor exige auth: tenta credenciais locais. `tryCredentials`
    // primeiro verifica que ele rejeita senhas erradas (anti-coleta).
    const servicePassword = readServicePassword();
    const candidates = [
      ...(process.env.OPENCODE_PASSWORD ? [process.env.OPENCODE_PASSWORD] : []),
      ...(servicePassword ? [servicePassword] : []),
    ];
    for (const candidate of candidates) {
      const result = await tryCredentials(baseUrl, basicHeader("opencode", candidate));
      if (result.ok) {
        this.log.appendLine(`[server] anexado com credencial local em ${baseUrl}`);
        const info: ServerInfo = {
          baseUrl,
          authHeader: basicHeader("opencode", candidate),
          process: null,
          owned: false,
        };
        this.setInfo(info);
        void this.pumpEvents();
        return info;
      }
      this.log.appendLine(`[server] credencial local recusada (${result.reason})`);
    }
    throw new Error(`nenhuma credencial local aceita por ${baseUrl}`);
  }

  private extractPort(args: string[]): number | null {
    const i = args.findIndex((a) => a === "--port" || a === "-p");
    if (i >= 0 && args[i + 1]) {
      const n = Number(args[i + 1]);
      if (Number.isFinite(n)) return n;
    }
    return null;
  }

  private async waitForReady(
    baseUrl: string,
    password: string,
    timeoutMs = 30_000
  ): Promise<void> {
    const authHeader = password ? basicHeader("opencode", password) : null;
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    let lastStatus: number | null = null;
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${baseUrl}/api/session`, {
          headers: authHeader ? { Authorization: authHeader } : {},
          signal: AbortSignal.timeout(2000),
        });
        if (res.ok) return;
        // 401 aqui significa que a senha não está sendo aceita: é um erro,
        // não um sinal de prontidão. Reporta em vez de seguir adiante.
        lastStatus = res.status;
      } catch (err) {
        lastErr = err;
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    throw new Error(
      `Servidor OpenCode não respondeu em ${timeoutMs}ms ` +
        `(status=${lastStatus ?? "n/a"}, err=${String(lastErr)})`
    );
  }

  /** Headers de autenticação para as chamadas da API. */
  authHeaders(): Record<string, string> {
    const h = this.info?.authHeader;
    return h ? { Authorization: h } : {};
  }

  // ---------------------------------------------------------------- API v2

  async createSession(title?: string): Promise<string> {
    const info = await this.start();
    const res = await fetch(`${info.baseUrl}/api/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.authHeaders() },
      body: JSON.stringify(title ? { title } : {}),
    });
    if (!res.ok) throw new Error(`createSession falhou: HTTP ${res.status}`);
    const body = (await res.json()) as { data?: { id?: string } };
    const id = body.data?.id;
    if (!id) throw new Error("createSession: resposta sem id");
    return id;
  }

  /**
   * Aborta a execução em andamento da sessão.
   * Contrato v2 verificado ao vivo: POST /session/:id/interrupt -> { interrupted }
   * (o antigo `/abort` da doc v1 responde 404 neste servidor).
   */
  async abortSession(sessionId: string): Promise<void> {
    const info = await this.start();
    const res = await fetch(`${info.baseUrl}/api/session/${sessionId}/interrupt`, {
      method: "POST",
      headers: this.authHeaders(),
    });
    if (!res.ok) throw new Error(`interrupt falhou: HTTP ${res.status}`);
  }

  /**
   * Lista as sessões existentes no servidor (histórico).
   * Contrato: GET /session -> { data: Session[] }.
   */
  async listSessions(): Promise<SessionSummary[]> {
    const info = await this.start();
    const res = await fetch(`${info.baseUrl}/api/session`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) throw new Error(`listSessions falhou: HTTP ${res.status}`);
    const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
    const raw = Array.isArray(body.data) ? body.data : [];
    return raw
      .filter((s) => typeof s.id === "string")
      .map((s) => ({
        id: s.id as string,
        title: typeof s.title === "string" && s.title.trim() ? s.title.trim() : null,
        updated:
          typeof (s.time as Record<string, unknown> | undefined)?.updated === "number"
            ? ((s.time as { updated: number }).updated)
            : typeof s.updated === "number"
              ? s.updated
              : null,
      }))
      .sort((a, b) => (b.updated ?? 0) - (a.updated ?? 0));
  }

  /**
   * Carrega o histórico de mensagens de uma sessão para restaurar a UI.
   * Contrato v2 verificado ao vivo:
   *   GET /session/:id/message -> { data: [{ type: "user"|"assistant",
   *                                          content: [{ type: "text", text }] }] }
   * Também aceita o formato antigo `{ info: { role }, parts }` por robustez.
   */
  async getMessages(sessionId: string): Promise<SessionMessage[]> {
    const info = await this.start();
    const res = await fetch(`${info.baseUrl}/api/session/${sessionId}/message`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) throw new Error(`getMessages falhou: HTTP ${res.status}`);
    const body = (await res.json()) as {
      data?: Array<
        | {
            type?: string;
            content?: Array<{ type?: string; text?: string }>;
            info?: { role?: string };
            parts?: Array<{ type?: string; text?: string }>;
          }
        | undefined
      >;
    };
    const raw = Array.isArray(body.data) ? body.data : [];
    const out: SessionMessage[] = [];
    for (const msg of raw) {
      if (!msg) continue;
      const role = msg.info?.role ?? msg.type;
      if (role !== "user" && role !== "assistant") continue;
      const parts = msg.content ?? msg.parts ?? [];
      const text = parts
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p) => p.text)
        .join("");
      if (text) out.push({ role, text });
    }
    return out;
  }

  /**
   * Tokens acumulados da sessão (custo da conversa inteira).
   * Contrato v2 verificado ao vivo: GET /session/:id -> { data: { tokens } }.
   */
  async getSessionUsage(sessionId: string): Promise<SessionUsage | null> {
    try {
      const info = await this.start();
      const res = await fetch(`${info.baseUrl}/api/session/${sessionId}`, {
        headers: this.authHeaders(),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        data?: { tokens?: { input?: number; output?: number } };
      };
      const t = body.data?.tokens;
      if (!t) return null;
      return { input: t.input ?? 0, output: t.output ?? 0 };
    } catch {
      return null;
    }
  }

  /**
   * Janela de contexto do modelo padrão, para o percentual de contexto.
   * Contrato v2 verificado ao vivo:
   *   GET /model/default -> { data: { limit: { context } } }.
   */
  async getModelContextLimit(): Promise<number | null> {
    try {
      const info = await this.start();
      const res = await fetch(`${info.baseUrl}/api/model/default`, {
        headers: this.authHeaders(),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as {
        data?: { limit?: { context?: number } };
      };
      const limit = body.data?.limit?.context;
      return typeof limit === "number" && limit > 0 ? limit : null;
    } catch {
      return null;
    }
  }

  /** Envia um prompt. O retorno é imediato; o texto vem pelo SSE. */
  async prompt(sessionId: string, text: string): Promise<void> {
    const info = await this.start();
    const res = await fetch(`${info.baseUrl}/api/session/${sessionId}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...this.authHeaders() },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`prompt falhou: HTTP ${res.status} ${detail}`);
    }
  }

  /** Abre o stream SSE e repassa cada evento aos inscritos. */
  private async pumpEvents(): Promise<void> {
    const info = this.info;
    if (!info) return;
    this.eventAbort?.abort();
    const abort = new AbortController();
    this.eventAbort = abort;

    // #6: o loop morre junto com o `info` (servidor encerrado), evitando
    // reconexão infinita contra qualquer processo que ocupe a porta depois.
    while (!abort.signal.aborted && this.info === info) {
      try {
        const res = await fetch(`${info.baseUrl}/api/event`, {
          headers: { Accept: "text/event-stream", ...this.authHeaders() },
          signal: abort.signal,
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        await this.readSse(res.body, abort.signal);
      } catch (err) {
        if (abort.signal.aborted || this.info !== info) return;
        this.log.appendLine(`[sse] reconectando após: ${String(err)}`);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  private async readSse(
    body: ReadableStream<Uint8Array>,
    signal: AbortSignal
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = chunk
          .split("\n")
          .find((l) => l.startsWith("data: "));
        if (!dataLine) continue; // heartbeat / comentário
        try {
          const event = JSON.parse(dataLine.slice(6)) as BusEvent;
          for (const fn of this.listeners) fn(event);
        } catch {
          // linha malformada; ignora
        }
      }
    }
    reader.releaseLock();
  }

  async restart(): Promise<ServerInfo> {
    await this.stop();
    return this.start();
  }

  async stop(): Promise<void> {
    this.eventAbort?.abort();
    this.eventAbort = null;
    const proc = this.info?.process;
    this.setInfo(null);
    if (!proc) return;
    this.log.appendLine("[server] encerrando");
    proc.kill();
  }
}

/** Gera uma senha aleatória para o servidor que esta extensão inicia. */
function randomPassword(): string {
  return randomBytes(24).toString("base64url");
}

/** Lê a senha do serviço em background (~/.config/opencode/service.json). */
function readServicePassword(): string | null {
  const candidates = [
    join(homedir(), ".config", "opencode", "service.json"),
  ];
  for (const file of candidates) {
    try {
      const raw = readFileSync(file, "utf8");
      const parsed = JSON.parse(raw) as { password?: string };
      if (parsed.password) return parsed.password;
    } catch {
      // ausente; tenta o próximo
    }
  }
  return null;
}

/** Localiza o executável `opencode` no PATH (fallback do CLI empacotado). */
export function resolveOpencodeCommand(): string | null {
  const which = process.platform === "win32" ? "where" : "which";
  try {
    const out = spawnSync(which, ["opencode"], { encoding: "utf8" });
    const first = out.stdout?.split(/\r?\n/).find((l) => l.trim());
    return first?.trim() ?? null;
  } catch {
    return null;
  }
}
