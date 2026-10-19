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
exports.validateCommandConfig = validateCommandConfig;
exports.isPathInsideWorkspace = isPathInsideWorkspace;
exports.randomNonce = randomNonce;
exports.basicHeader = basicHeader;
exports.parseWebviewMessage = parseWebviewMessage;
exports.classifyStatus = classifyStatus;
exports.probeUnauthenticated = probeUnauthenticated;
exports.tryCredentials = tryCredentials;
exports.verifyServerEnforcesAuth = verifyServerEnforcesAuth;
const node_crypto_1 = require("node:crypto");
const nodePath = __importStar(require("node:path"));
/** Allowlist: letras, dígitos, ponto, espaço, barra, dois-pontos, arroba, vírgula, hífen. */
const SAFE_PART = /^[\w .:\\/@+,-]+$/;
/**
 * Valida `serverCommand`/`serverArgs` antes de spawn com `shell: true`.
 * Retorna mensagem de erro ou `null` se seguro. Bloqueia `& | < > ^ " % ( ) !`
 * e quebras de linha — todos interpretados pelo cmd.exe no Windows (#3).
 */
function validateCommandConfig(command, args) {
    if (typeof command !== "string" || command.length === 0 || !SAFE_PART.test(command)) {
        return `serverCommand inválido ou com caracteres não seguros: ${JSON.stringify(command)}`;
    }
    if (!Array.isArray(args)) {
        return `serverArgs precisa ser um array: ${JSON.stringify(args)}`;
    }
    for (const a of args) {
        if (typeof a !== "string" || a.length === 0 || !SAFE_PART.test(a)) {
            return `serverArgs contém argumento inválido ou inseguro: ${JSON.stringify(a)}`;
        }
    }
    return null;
}
/**
 * Caminho vindo da webview deve ficar DENTRO do workspace (#4).
 * Rejeita: vazio, NUL, absoluto (POSIX/Windows/UNC) e qualquer `..` após normalização.
 */
function isPathInsideWorkspace(rel) {
    if (typeof rel !== "string" || rel.length === 0 || rel.includes("\0"))
        return false;
    if (nodePath.isAbsolute(rel) || nodePath.win32.isAbsolute(rel))
        return false;
    return !nodePath.normalize(rel).startsWith("..");
}
/** Nonce criptograficamente seguro (#7). */
function randomNonce() {
    return (0, node_crypto_1.randomBytes)(16).toString("base64url");
}
/** Header Basic para autenticação HTTP. */
function basicHeader(user, password) {
    return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}
/**
 * Valida e normaliza uma mensagem crua da webview (#8).
 * Retorna `null` para qualquer coisa fora do contrato.
 */
function parseWebviewMessage(raw) {
    if (typeof raw !== "object" || raw === null)
        return null;
    const m = raw;
    switch (m.type) {
        case "ready":
        case "newSession":
        case "abort":
        case "insertReference":
        case "pickFile":
        case "listSessions":
            return { type: m.type };
        case "restoreSession":
            // ID vindo da webview: só caracteres de ID opencode (ex.: ses_xxxx),
            // com limite de tamanho — nunca chega a path/URL sem esse formato.
            return typeof m.sessionId === "string" &&
                /^[A-Za-z0-9_-]{1,128}$/.test(m.sessionId)
                ? { type: "restoreSession", sessionId: m.sessionId }
                : null;
        case "send":
            return typeof m.text === "string" && m.text.length > 0 && m.text.length <= 1_000_000
                ? { type: "send", text: m.text }
                : null;
        case "openFile": {
            if (!isPathInsideWorkspace(m.path))
                return null;
            const line = m.line === undefined ? undefined : Number(m.line);
            if (line !== undefined && (!Number.isFinite(line) || line < 0 || line > 10_000_000))
                return null;
            return { type: "openFile", path: m.path, line };
        }
        default:
            return null;
    }
}
function classifyStatus(status) {
    if (status === null)
        return { kind: "no-server" };
    if (status === 200)
        return { kind: "open" };
    if (status === 401 || status === 403)
        return { kind: "auth-required" };
    return { kind: "other", status };
}
/**
 * Sonda `/api/session` SEM nenhuma credencial. Nunca envia segredos aqui:
 * um servidor que aceita requisição anônima pode ser um processo impostor
 * coletor de credenciais. Cabe ao chamador decidir se anexa (com confirmação
 * do usuário) e nunca enviar senha a um resultado "open".
 */
async function probeUnauthenticated(baseUrl, fetchFn = fetch) {
    try {
        const res = await fetchFn(`${baseUrl}/api/session`, {
            headers: {},
            signal: AbortSignal.timeout(2500),
        });
        return classifyStatus(res.status);
    }
    catch {
        return { kind: "no-server" };
    }
}
/**
 * Tenta credenciais com proteção anti-coleta ("verify the verifier"):
 * 1) envia uma credencial FALSA; se for aceita, o servidor não valida
 *    senhas => possível coletor => NUNCA envia a credencial real;
 * 2) só então envia a credencial real.
 */
async function tryCredentials(baseUrl, authHeader, fetchFn = fetch) {
    const url = `${baseUrl}/api/session`;
    const bogus = basicHeader("opencode", `bogus-${(0, node_crypto_1.randomBytes)(8).toString("hex")}`);
    try {
        const probe = await fetchFn(url, {
            headers: { Authorization: bogus },
            signal: AbortSignal.timeout(2500),
        });
        if (probe.status >= 200 && probe.status < 300) {
            return { ok: false, reason: "accepts-any" };
        }
    }
    catch {
        return { ok: false, reason: "network-error" };
    }
    try {
        const res = await fetchFn(url, {
            headers: { Authorization: authHeader },
            signal: AbortSignal.timeout(2500),
        });
        return res.status >= 200 && res.status < 300 ? { ok: true } : { ok: false, reason: "rejected" };
    }
    catch {
        return { ok: false, reason: "network-error" };
    }
}
/**
 * Verificação de posse pós-spawn: o processo que NÓS iniciamos deve
 * rejeitar requisições anônimas (401/403) e aceitar a nossa senha.
 * Se a porta foi tomada por um impostor antes do nosso filho binde,
 * ele falha aqui => matamos o filho e abortamos (#1).
 */
async function verifyServerEnforcesAuth(baseUrl, authHeader, fetchFn = fetch) {
    const url = `${baseUrl}/api/session`;
    let unauthStatus;
    try {
        const unauth = await fetchFn(url, { headers: {}, signal: AbortSignal.timeout(2500) });
        unauthStatus = unauth.status;
    }
    catch {
        return { owned: false, detail: "servidor não respondeu à sonda anônima" };
    }
    if (unauthStatus !== 401 && unauthStatus !== 403) {
        return {
            owned: false,
            detail: `porta aceita requisições sem autenticação (HTTP ${unauthStatus}) — possível processo estranho`,
        };
    }
    try {
        const auth = await fetchFn(url, {
            headers: { Authorization: authHeader },
            signal: AbortSignal.timeout(2500),
        });
        return auth.status >= 200 && auth.status < 300
            ? { owned: true, detail: "servidor valida autenticação" }
            : { owned: false, detail: `credencial própria recusada (HTTP ${auth.status})` };
    }
    catch {
        return { owned: false, detail: "servidor não respondeu à credencial própria" };
    }
}
//# sourceMappingURL=security.js.map