/**
 * Testes de segurança — executa com `node test/security.test.js`.
 *
 * Cobre as mitigations implementadas em `src/security.ts`:
 *   #1 servidor impostor (probe anônimo, anti-coleta, posse da porta)
 *   #3 command injection via config
 *   #4 path traversal no openFile
 *   #7 nonce criptográfico
 *   #8 validação de mensagens da webview
 *
 * Pré-requisito: `npm run compile` (usa out/security.js).
 */

const assert = require("node:assert");
const http = require("node:http");
const {
  validateCommandConfig,
  isPathInsideWorkspace,
  parseWebviewMessage,
  randomNonce,
  classifyStatus,
  probeUnauthenticated,
  tryCredentials,
  verifyServerEnforcesAuth,
  basicHeader,
} = require("../out/security.js");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✘ ${name}\n    ${err.message}`);
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✔ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ✘ ${name}\n    ${err.message}`);
  }
}

// ---------------------------------------------------------------- servidores

/** Inicia um servidor HTTP fake e retorna { url, close, requests }. */
function startFakeServer(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, auth: req.headers.authorization || null });
    handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

// ---------------------------------------------------------------- testes

async function main() {
  console.log("\n#3 — validateCommandConfig (command injection)");
  test("aceita configuração padrão legítima", () => {
    assert.strictEqual(
      validateCommandConfig("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "4096"]),
      null
    );
  });
  test("bloqueia 'opencode & calc.exe' no command", () => {
    assert.notStrictEqual(validateCommandConfig("opencode & calc.exe", ["serve"]), null);
  });
  test("bloqueia pipe e redirecionamento em args", () => {
    assert.notStrictEqual(validateCommandConfig("opencode", ["serve", "|", "curl", "evil"]), null);
    assert.notStrictEqual(validateCommandConfig("opencode", ["serve > C:\\x"]), null);
  });
  test("bloqueia %VAR% e !VAR! (expansão do cmd.exe)", () => {
    assert.notStrictEqual(validateCommandConfig("opencode", ["--port", "%PATH%"]), null);
    assert.notStrictEqual(validateCommandConfig("opencode", ["--port", "!COMSPEC!"]), null);
  });
  test("bloqueia quebra de linha e aspas", () => {
    assert.notStrictEqual(validateCommandConfig("opencode\nrm -rf", ["serve"]), null);
    assert.notStrictEqual(validateCommandConfig("opencode", ['"; rm -rf /']), null);
  });
  test("bloqueia command não-string e args não-array", () => {
    assert.notStrictEqual(validateCommandConfig(42, ["serve"]), null);
    assert.notStrictEqual(validateCommandConfig("opencode", "serve"), null);
    assert.notStrictEqual(validateCommandConfig("opencode", [null]), null);
  });

  console.log("\n#4 — isPathInsideWorkspace (path traversal)");
  test("aceita caminho relativo simples", () => {
    assert.strictEqual(isPathInsideWorkspace("src/app.ts"), true);
    assert.strictEqual(isPathInsideWorkspace("a/b/c.md"), true);
  });
  test("bloqueia '../' e '..\\' que escapam do workspace", () => {
    assert.strictEqual(isPathInsideWorkspace("../secret.txt"), false);
    assert.strictEqual(isPathInsideWorkspace("..\\..\\secret.txt"), false);
    assert.strictEqual(isPathInsideWorkspace("a/../../etc/passwd"), false);
  });
  test("bloqueia caminhos absolutos (POSIX e Windows)", () => {
    assert.strictEqual(isPathInsideWorkspace("/etc/passwd"), false);
    assert.strictEqual(isPathInsideWorkspace("C:\\Windows\\System32\\config"), false);
    assert.strictEqual(isPathInsideWorkspace("C:/Windows/win.ini"), false);
  });
  test("bloqueia UNC, vazio e NUL", () => {
    assert.strictEqual(isPathInsideWorkspace("\\\\server\\share"), false);
    assert.strictEqual(isPathInsideWorkspace(""), false);
    assert.strictEqual(isPathInsideWorkspace("a\0b"), false);
  });
  test("aceita '..' no MEIO que não escapa (normalizado)", () => {
    assert.strictEqual(isPathInsideWorkspace("a/../b.ts"), true);
    assert.strictEqual(isPathInsideWorkspace("src/../src/app.ts"), true);
  });

  console.log("\n#8 — parseWebviewMessage (validação de mensagens)");
  test("rejeita null, strings e tipos inválidos", () => {
    assert.strictEqual(parseWebviewMessage(null), null);
    assert.strictEqual(parseWebviewMessage("send"), null);
    assert.strictEqual(parseWebviewMessage(42), null);
    assert.strictEqual(parseWebviewMessage({ type: "unknown" }), null);
  });
  test("valida mensagem 'send' com texto", () => {
    const m = parseWebviewMessage({ type: "send", text: "olá" });
    assert.deepStrictEqual(m, { type: "send", text: "olá" });
  });
  test("rejeita 'send' sem texto ou com texto não-string", () => {
    assert.strictEqual(parseWebviewMessage({ type: "send" }), null);
    assert.strictEqual(parseWebviewMessage({ type: "send", text: 123 }), null);
    assert.strictEqual(parseWebviewMessage({ type: "send", text: "" }), null);
  });
  test("descarta campos extras (não passa adiante)", () => {
    const m = parseWebviewMessage({ type: "ready", evil: "payload" });
    assert.deepStrictEqual(m, { type: "ready" });
  });
  test("'openFile' com traversal é rejeitado na entrada", () => {
    assert.strictEqual(parseWebviewMessage({ type: "openFile", path: "../x" }), null);
    assert.strictEqual(parseWebviewMessage({ type: "openFile", path: "C:\\x" }), null);
  });
  test("'openFile' legítimo é aceito", () => {
    const m = parseWebviewMessage({ type: "openFile", path: "src/app.ts", line: 10 });
    assert.deepStrictEqual(m, { type: "openFile", path: "src/app.ts", line: 10 });
  });

  console.log("\n#7 — randomNonce (nonce criptográfico)");
  test("gera nonces únicos e base64url", () => {
    const set = new Set();
    for (let i = 0; i < 10_000; i++) {
      const n = randomNonce();
      assert.ok(/^[A-Za-z0-9_-]+$/.test(n), `nonce com caracteres inválidos: ${n}`);
      set.add(n);
    }
    assert.strictEqual(set.size, 10_000, "colisão de nonce detectada");
  });

  console.log("\n#1 — confiança de servidor (impostor, anti-coleta, posse)");

  await testAsync("classifyStatus mapeia corretamente", () => {
    assert.deepStrictEqual(classifyStatus(200), { kind: "open" });
    assert.deepStrictEqual(classifyStatus(401), { kind: "auth-required" });
    assert.deepStrictEqual(classifyStatus(403), { kind: "auth-required" });
    assert.deepStrictEqual(classifyStatus(500), { kind: "other", status: 500 });
    assert.deepStrictEqual(classifyStatus(null), { kind: "no-server" });
  });

  // Impostor: responde 200 a TUDO (sem auth) — coletor de credenciais.
  const impostor = await startFakeServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("[]");
  });

  await testAsync("probe anônimo detecta impostor como 'open'", async () => {
    const r = await probeUnauthenticated(impostor.url);
    assert.deepStrictEqual(r, { kind: "open" });
  });

  await testAsync("tryCredentials NÃO envia senha real a servidor que aceita qualquer coisa", async () => {
    const realCred = basicHeader("opencode", "minha-senha-secreta");
    const before = impostor.requests.length;
    const r = await tryCredentials(impostor.url, realCred);
    assert.deepStrictEqual(r, { ok: false, reason: "accepts-any" });
    // A senha real nunca deve aparecer em nenhum request ao impostor.
    const seen = impostor.requests.slice(before);
    for (const req of seen) {
      assert.ok(
        !req.auth || !req.auth.includes(Buffer.from("minha-senha-secreta").toString("base64")),
        "CREDENCIAL REAL VAZADA AO IMPOSTOR"
      );
    }
  });

  await testAsync("verifyServerEnforcesAuth rejeita impostor (aceita anônimo)", async () => {
    const r = await verifyServerEnforcesAuth(impostor.url, basicHeader("opencode", "x"));
    assert.strictEqual(r.owned, false);
    assert.match(r.detail, /sem autenticação|estranho/);
  });

  await impostor.close();

  // Servidor legítimo: exige Basic auth com senha correta.
  const REAL_PW = "s3nh4-legítima";
  const genuine = await startFakeServer((req, res) => {
    const want = basicHeader("opencode", REAL_PW);
    if (req.headers.authorization === want) {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"data":{}}');
    } else {
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="opencode"' });
      res.end();
    }
  });

  await testAsync("probe anônimo detecta servidor legítimo como 'auth-required'", async () => {
    const r = await probeUnauthenticated(genuine.url);
    assert.deepStrictEqual(r, { kind: "auth-required" });
  });

  await testAsync("tryCredentials aceita senha correta após rejeitar bogus", async () => {
    const r = await tryCredentials(genuine.url, basicHeader("opencode", REAL_PW));
    assert.deepStrictEqual(r, { ok: true });
  });

  await testAsync("tryCredentials recusa senha errada", async () => {
    const r = await tryCredentials(genuine.url, basicHeader("opencode", "errada"));
    assert.deepStrictEqual(r, { ok: false, reason: "rejected" });
  });

  await testAsync("verifyServerEnforcesAuth confirma posse de servidor legítimo", async () => {
    const r = await verifyServerEnforcesAuth(genuine.url, basicHeader("opencode", REAL_PW));
    assert.strictEqual(r.owned, true);
  });

  await genuine.close();

  await testAsync("porta morta -> 'no-server' (nenhum credencial enviada)", async () => {
    const r = await probeUnauthenticated("http://127.0.0.1:1");
    assert.deepStrictEqual(r, { kind: "no-server" });
  });

  // ---------------------------------------------------------------- resumo
  console.log(`\n${passed} aprovados, ${failed} reprovados, ${passed + failed} total`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
