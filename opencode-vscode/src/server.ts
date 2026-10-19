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

/** Evento cru do stream SSE (`GET /api/event`). */
export interface BusEvent {
  id: string;
  type: string;
  created?: number;
  data: Record<string, unknown>;
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
  /** Última senha usada, para tentar novamente após restart. */
  private password: string | null = null;

  constructor(private readonly log: OutputChannel) {}

  get current(): ServerInfo | null {
    return this.info;
  }

  onEvent(fn: (e: BusEvent) => void): vscode.Disposable {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  }

  async start(): Promise<ServerInfo> {
    if (this.info) return this.info;
    if (this.starting) return this.starting;
    this.starting = this.doStart().finally(() => (this.starting = null));
    return this.starting;
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
      if (this.info?.process === child) this.info = null;
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

    this.info = {
      baseUrl,
      authHeader: password ? basicHeader("opencode", password) : null,
      process: child,
      owned: true,
    };
    this.log.appendLine(`[server] pronto em ${baseUrl}`);
    void this.pumpEvents();
    return this.info;
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
      this.info = { baseUrl, authHeader: null, process: null, owned: false };
      void this.pumpEvents();
      return this.info;
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
        this.info = {
          baseUrl,
          authHeader: basicHeader("opencode", candidate),
          process: null,
          owned: false,
        };
        void this.pumpEvents();
        return this.info;
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
    this.info = null;
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
