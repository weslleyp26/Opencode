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
exports.ServerManager = void 0;
exports.resolveOpencodeCommand = resolveOpencodeCommand;
const vscode = __importStar(require("vscode"));
const node_child_process_1 = require("node:child_process");
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
const node_os_1 = require("node:os");
const node_crypto_1 = require("node:crypto");
const security_1 = require("./security");
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
class ServerManager {
    log;
    info = null;
    starting = null;
    eventAbort = null;
    listeners = new Set();
    /** Última senha usada, para tentar novamente após restart. */
    password = null;
    constructor(log) {
        this.log = log;
    }
    get current() {
        return this.info;
    }
    onEvent(fn) {
        this.listeners.add(fn);
        return { dispose: () => this.listeners.delete(fn) };
    }
    async start() {
        if (this.info)
            return this.info;
        if (this.starting)
            return this.starting;
        this.starting = this.doStart().finally(() => (this.starting = null));
        return this.starting;
    }
    async doStart() {
        const cfg = vscode.workspace.getConfiguration("opencode");
        const command = cfg.get("serverCommand", "opencode");
        const args = cfg.get("serverArgs", [
            "serve",
            "--hostname",
            "127.0.0.1",
            "--port",
            "4096",
        ]);
        // #3: bloqueia command injection via config antes de qualquer spawn.
        const cfgError = (0, security_1.validateCommandConfig)(command, args);
        if (cfgError) {
            this.log.appendLine(`[server] configuração rejeitada: ${cfgError}`);
            throw new Error(`configuração do servidor rejeitada: ${cfgError}`);
        }
        const port = this.extractPort(args) ?? 4096;
        const baseUrl = `http://127.0.0.1:${port}`;
        // #1: sonda ANÔNIMA. Um servidor que responde 200 sem autenticação pode
        // ser um impostor coletor de credenciais; nunca enviamos senha a ele.
        const probe = await (0, security_1.probeUnauthenticated)(baseUrl);
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
        const child = (0, node_child_process_1.spawn)(command, args, {
            cwd: workspace,
            env: {
                ...process.env,
                ...(password ? { OPENCODE_SERVER_PASSWORD: password } : {}),
            },
            shell: process.platform === "win32",
            windowsHide: true,
        });
        child.stdout.on("data", (d) => this.log.append(d.toString()));
        child.stderr.on("data", (d) => this.log.append(d.toString()));
        child.on("exit", (code) => {
            this.log.appendLine(`[server] saiu com código ${code}`);
            if (this.info?.process === child)
                this.info = null;
        });
        await this.waitForReady(baseUrl, password);
        // #1: verificação de posse — se outro processo tomou a porta antes do
        // nosso filho binde, ele não exigirá auth => abortamos e matamos o filho.
        const ownership = await (0, security_1.verifyServerEnforcesAuth)(baseUrl, (0, security_1.basicHeader)("opencode", password));
        if (!ownership.owned) {
            this.log.appendLine(`[server] posse da porta falhou: ${ownership.detail}`);
            child.kill();
            throw new Error(`servidor em ${baseUrl} não é confiável (${ownership.detail})`);
        }
        this.info = {
            baseUrl,
            authHeader: password ? (0, security_1.basicHeader)("opencode", password) : null,
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
    async attachToExisting(baseUrl, kind) {
        const choice = await vscode.window.showWarningMessage(`OpenCode: já existe um servidor respondendo em ${baseUrl} ` +
            (kind === "open"
                ? "(sem autenticação). Anexar a ele?"
                : "(exige autenticação). Anexar usando credenciais locais?"), { modal: true }, "Anexar", "Cancelar");
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
            const result = await (0, security_1.tryCredentials)(baseUrl, (0, security_1.basicHeader)("opencode", candidate));
            if (result.ok) {
                this.log.appendLine(`[server] anexado com credencial local em ${baseUrl}`);
                this.info = {
                    baseUrl,
                    authHeader: (0, security_1.basicHeader)("opencode", candidate),
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
    extractPort(args) {
        const i = args.findIndex((a) => a === "--port" || a === "-p");
        if (i >= 0 && args[i + 1]) {
            const n = Number(args[i + 1]);
            if (Number.isFinite(n))
                return n;
        }
        return null;
    }
    async waitForReady(baseUrl, password, timeoutMs = 30_000) {
        const authHeader = password ? (0, security_1.basicHeader)("opencode", password) : null;
        const deadline = Date.now() + timeoutMs;
        let lastErr;
        let lastStatus = null;
        while (Date.now() < deadline) {
            try {
                const res = await fetch(`${baseUrl}/api/session`, {
                    headers: authHeader ? { Authorization: authHeader } : {},
                    signal: AbortSignal.timeout(2000),
                });
                if (res.ok)
                    return;
                // 401 aqui significa que a senha não está sendo aceita: é um erro,
                // não um sinal de prontidão. Reporta em vez de seguir adiante.
                lastStatus = res.status;
            }
            catch (err) {
                lastErr = err;
            }
            await new Promise((r) => setTimeout(r, 400));
        }
        throw new Error(`Servidor OpenCode não respondeu em ${timeoutMs}ms ` +
            `(status=${lastStatus ?? "n/a"}, err=${String(lastErr)})`);
    }
    /** Headers de autenticação para as chamadas da API. */
    authHeaders() {
        const h = this.info?.authHeader;
        return h ? { Authorization: h } : {};
    }
    // ---------------------------------------------------------------- API v2
    async createSession(title) {
        const info = await this.start();
        const res = await fetch(`${info.baseUrl}/api/session`, {
            method: "POST",
            headers: { "Content-Type": "application/json", ...this.authHeaders() },
            body: JSON.stringify(title ? { title } : {}),
        });
        if (!res.ok)
            throw new Error(`createSession falhou: HTTP ${res.status}`);
        const body = (await res.json());
        const id = body.data?.id;
        if (!id)
            throw new Error("createSession: resposta sem id");
        return id;
    }
    /** Envia um prompt. O retorno é imediato; o texto vem pelo SSE. */
    async prompt(sessionId, text) {
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
    async pumpEvents() {
        const info = this.info;
        if (!info)
            return;
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
                if (!res.ok || !res.body)
                    throw new Error(`HTTP ${res.status}`);
                await this.readSse(res.body, abort.signal);
            }
            catch (err) {
                if (abort.signal.aborted || this.info !== info)
                    return;
                this.log.appendLine(`[sse] reconectando após: ${String(err)}`);
                await new Promise((r) => setTimeout(r, 1000));
            }
        }
    }
    async readSse(body, signal) {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!signal.aborted) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            let idx;
            while ((idx = buffer.indexOf("\n\n")) >= 0) {
                const chunk = buffer.slice(0, idx);
                buffer = buffer.slice(idx + 2);
                const dataLine = chunk
                    .split("\n")
                    .find((l) => l.startsWith("data: "));
                if (!dataLine)
                    continue; // heartbeat / comentário
                try {
                    const event = JSON.parse(dataLine.slice(6));
                    for (const fn of this.listeners)
                        fn(event);
                }
                catch {
                    // linha malformada; ignora
                }
            }
        }
        reader.releaseLock();
    }
    async restart() {
        await this.stop();
        return this.start();
    }
    async stop() {
        this.eventAbort?.abort();
        this.eventAbort = null;
        const proc = this.info?.process;
        this.info = null;
        if (!proc)
            return;
        this.log.appendLine("[server] encerrando");
        proc.kill();
    }
}
exports.ServerManager = ServerManager;
/** Gera uma senha aleatória para o servidor que esta extensão inicia. */
function randomPassword() {
    return (0, node_crypto_1.randomBytes)(24).toString("base64url");
}
/** Lê a senha do serviço em background (~/.config/opencode/service.json). */
function readServicePassword() {
    const candidates = [
        (0, node_path_1.join)((0, node_os_1.homedir)(), ".config", "opencode", "service.json"),
    ];
    for (const file of candidates) {
        try {
            const raw = (0, node_fs_1.readFileSync)(file, "utf8");
            const parsed = JSON.parse(raw);
            if (parsed.password)
                return parsed.password;
        }
        catch {
            // ausente; tenta o próximo
        }
    }
    return null;
}
/** Localiza o executável `opencode` no PATH (fallback do CLI empacotado). */
function resolveOpencodeCommand() {
    const which = process.platform === "win32" ? "where" : "which";
    try {
        const out = (0, node_child_process_1.spawnSync)(which, ["opencode"], { encoding: "utf8" });
        const first = out.stdout?.split(/\r?\n/).find((l) => l.trim());
        return first?.trim() ?? null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=server.js.map