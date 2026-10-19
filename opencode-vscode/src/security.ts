import { randomBytes } from "node:crypto";
import * as nodePath from "node:path";

/**
 * Lógica de segurança da extensão, livre de dependência do `vscode`,
 * para permitir testes automatizados fora do host (ver `test/security.test.js`).
 *
 * Mitiga:
 *  #1 servidor impostor na porta (probe sem credenciais + verificação de posse);
 *  #3 command injection via shell (allowlist de caracteres);
 *  #4 path traversal no openFile;
 *  #7 nonce fraco (Math.random -> crypto.randomBytes);
 *  #8 mensagens não validadas da webview.
 */

/** Mensagem validada vind da webview. Campos desconhecidos são descartados. */
export interface WebviewMessage {
  type: "ready" | "send" | "newSession" | "abort" | "insertReference" | "openFile";
  text?: string;
  path?: string;
  line?: number;
}

/** Allowlist: letras, dígitos, ponto, espaço, barra, dois-pontos, arroba, vírgula, hífen. */
const SAFE_PART = /^[\w .:\\/@+,-]+$/;

/**
 * Valida `serverCommand`/`serverArgs` antes de spawn com `shell: true`.
 * Retorna mensagem de erro ou `null` se seguro. Bloqueia `& | < > ^ " % ( ) !`
 * e quebras de linha — todos interpretados pelo cmd.exe no Windows (#3).
 */
export function validateCommandConfig(command: unknown, args: unknown): string | null {
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
export function isPathInsideWorkspace(rel: unknown): boolean {
  if (typeof rel !== "string" || rel.length === 0 || rel.includes("\0")) return false;
  if (nodePath.isAbsolute(rel) || nodePath.win32.isAbsolute(rel)) return false;
  return !nodePath.normalize(rel).startsWith("..");
}

/** Nonce criptograficamente seguro (#7). */
export function randomNonce(): string {
  return randomBytes(16).toString("base64url");
}

/** Header Basic para autenticação HTTP. */
export function basicHeader(user: string, password: string): string {
  return `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
}

/**
 * Valida e normaliza uma mensagem crua da webview (#8).
 * Retorna `null` para qualquer coisa fora do contrato.
 */
export function parseWebviewMessage(raw: unknown): WebviewMessage | null {
  if (typeof raw !== "object" || raw === null) return null;
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case "ready":
    case "newSession":
    case "abort":
    case "insertReference":
      return { type: m.type };
    case "send":
      return typeof m.text === "string" && m.text.length > 0 && m.text.length <= 1_000_000
        ? { type: "send", text: m.text }
        : null;
    case "openFile": {
      if (!isPathInsideWorkspace(m.path)) return null;
      const line = m.line === undefined ? undefined : Number(m.line);
      if (line !== undefined && (!Number.isFinite(line) || line < 0 || line > 10_000_000)) return null;
      return { type: "openFile", path: m.path as string, line };
    }
    default:
      return null;
  }
}

// ----------------------------------------------------- confiança de servidor (#1)

export type ProbeOutcome =
  | { kind: "no-server" }
  | { kind: "open" } // respondeu 200 SEM autenticação => NÃO confiável
  | { kind: "auth-required" } // 401/403 => exige credenciais
  | { kind: "other"; status: number };

export function classifyStatus(status: number | null): ProbeOutcome {
  if (status === null) return { kind: "no-server" };
  if (status === 200) return { kind: "open" };
  if (status === 401 || status === 403) return { kind: "auth-required" };
  return { kind: "other", status };
}

type FetchFn = typeof fetch;

/**
 * Sonda `/api/session` SEM nenhuma credencial. Nunca envia segredos aqui:
 * um servidor que aceita requisição anônima pode ser um processo impostor
 * coletor de credenciais. Cabe ao chamador decidir se anexa (com confirmação
 * do usuário) e nunca enviar senha a um resultado "open".
 */
export async function probeUnauthenticated(
  baseUrl: string,
  fetchFn: FetchFn = fetch
): Promise<ProbeOutcome> {
  try {
    const res = await fetchFn(`${baseUrl}/api/session`, {
      headers: {},
      signal: AbortSignal.timeout(2500),
    });
    return classifyStatus(res.status);
  } catch {
    return { kind: "no-server" };
  }
}

export type CredentialResult =
  | { ok: true }
  | { ok: false; reason: "accepts-any" | "rejected" | "network-error" };

/**
 * Tenta credenciais com proteção anti-coleta ("verify the verifier"):
 * 1) envia uma credencial FALSA; se for aceita, o servidor não valida
 *    senhas => possível coletor => NUNCA envia a credencial real;
 * 2) só então envia a credencial real.
 */
export async function tryCredentials(
  baseUrl: string,
  authHeader: string,
  fetchFn: FetchFn = fetch
): Promise<CredentialResult> {
  const url = `${baseUrl}/api/session`;
  const bogus = basicHeader("opencode", `bogus-${randomBytes(8).toString("hex")}`);
  try {
    const probe = await fetchFn(url, {
      headers: { Authorization: bogus },
      signal: AbortSignal.timeout(2500),
    });
    if (probe.status >= 200 && probe.status < 300) {
      return { ok: false, reason: "accepts-any" };
    }
  } catch {
    return { ok: false, reason: "network-error" };
  }
  try {
    const res = await fetchFn(url, {
      headers: { Authorization: authHeader },
      signal: AbortSignal.timeout(2500),
    });
    return res.status >= 200 && res.status < 300 ? { ok: true } : { ok: false, reason: "rejected" };
  } catch {
    return { ok: false, reason: "network-error" };
  }
}

/**
 * Verificação de posse pós-spawn: o processo que NÓS iniciamos deve
 * rejeitar requisições anônimas (401/403) e aceitar a nossa senha.
 * Se a porta foi tomada por um impostor antes do nosso filho binde,
 * ele falha aqui => matamos o filho e abortamos (#1).
 */
export async function verifyServerEnforcesAuth(
  baseUrl: string,
  authHeader: string,
  fetchFn: FetchFn = fetch
): Promise<{ owned: boolean; detail: string }> {
  const url = `${baseUrl}/api/session`;
  let unauthStatus: number;
  try {
    const unauth = await fetchFn(url, { headers: {}, signal: AbortSignal.timeout(2500) });
    unauthStatus = unauth.status;
  } catch {
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
  } catch {
    return { owned: false, detail: "servidor não respondeu à credencial própria" };
  }
}
