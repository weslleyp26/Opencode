# Blueprint: extensão OpenCode para VS Code (via engenharia reversa do Codex e Claude Code)

Análise estática de artefatos publicados (`.vsix` oficiais) com REA. Todos os achados
vêm de código embarcado; nada foi executado.

## Artefatos analisados

| Extensão | ID do Marketplace | Versão | `.vsix` |
|---|---|---|---|
| Codex (OpenAI) | `openai.chatgpt` | 26.51007.21434 | ~370 MB |
| Claude Code (Anthropic) | `anthropic.claude-code` | 2.1.301 | ~124 MB |

## Evidência REA

- Claude Code (host `extension.js`): `ev_aa1da79ddcea20ba9d6ca05db9dd1b87a3461178174d6ce56cb7277b5101e5d4`
  - 5 arquivos relevantes, 900.341 nós AST, **1.008 findings**.
  - `webview/index.js` (6 MB) estourou o heap do worker REA → análise parcial (limitação registrada).
- Codex (host `out/extension.js`): `ev_692b6ac12fe067e356184203cafc1ea3716ab96a4a31868470c7378aa6cd89bb`
  - 5.782 arquivos inventariados, 642.379 nós AST, **525 findings**.
  - **2 observações de validação de sender** (segurança de webview).
- Assinaturas: `bun:ffi` (Claude), `codex app-server` + WSL (Codex).

## Comparativo de arquitetura

| Dimensão | Claude Code | Codex |
|---|---|---|
| Entrada principal | `extension.js` (bundle único) | `out/extension.js` |
| UI | Webview próprio (`webview/index.js` + KaTeX) em sidebar/panel | Webview React com bundling por idioma |
| Motor | **Binário nativo embarcado** `resources/native-binary/claude` (~268 MB) | **Binários nativos embarcados**: `codex` (~294 MB), `codex-code-mode-host`, `codex-voice-host`, `rg` |
| Runtime | Usa **`bun:ffi`** (dlopen de `ntdll.dll` p/ paths longos no Windows) | Node.js clássico (`child_process`, `spawn`) |
| Resolução do binário | `native-binaries/<platform>-<arch>/claude[.exe]` → fallback `win32-x64` p/ ARM64 → `native-binary/claude` | `bin/<platform>-<arch>/codex[.exe]` + override `chatgpt.cliExecutable` |
| Rotas de abertura | `createWebviewPanel` + `registerWebviewViewProvider` | `registerWebviewViewProvider` (sidebar/secondary) |
| Diff no editor | **Virtual FS scheme** `_claude_vscode_fs_left`/`_right` + `comments` API (hunks aceitar/rejeitar) | Custom editor `chatgpt.conversationEditor` (scheme `openai-codex:`) |
| Segurança webview | — | `sender validation` observado (2 sites) |
| Integrações extras | Terminal mode (`claudeCode.useTerminal`), Python env, worktrees | **API proposals** (`chatSessionsProvider`, `languageModelProxy`), **WSL automático**, extension pack (`openai.codex-audio`) |
| Ativação | `onStartupFinished`, `onWebviewPanel:claudeVSCodePanel` | `onStartupFinished`, `onUri` |

## Padrão comum (o "como fazer")

1. **`onStartupFinished`** — ativa sem bloquear o boot.
2. **Webview view provider** na activity bar / secondary sidebar (a UI é HTML/JS próprio).
3. **Motor nativo embarcado** por plataforma — não depende de CLI global; resolve caminho por `platform`+`arch`.
4. **Canal host↔webview** (`onDidReceiveMessage`) + estado persistido em `globalState`.
5. **Integração com o editor**: `@`-mentions de arquivos, diff de mudanças propostas, comentários/hunks.

## Recomendação para o OpenCode

**Contexto:** o OpenCode **já tem extensão oficial** (`sst-dev.opencode`, comando Ctrl+Esc) e uma beta `sst-dev.opencode-v2` no Marketplace. Portanto o caminho mais eficiente é **usar/estender a oficial**, não reimplementar.

Se o objetivo for uma extensão própria/tema, o esqueleto abaixo replica o padrão dos dois:

```
package.json
  activationEvents: ["onStartupFinished"]
  main: "./out/extension.js"
  contributes.viewsContainers.activitybar -> { id, title, icon }
  contributes.views.<container> -> [{ type:"webview", id, name }]
  commands: openSidebar / newChat / addToThread ...

src/extension.ts
  activate(ctx):
    - localizar motor: path.join(extensionPath,"bin",`${platform}-${arch}`,`opencode${exe}`)
    - ctx.subscriptions.push(window.registerWebviewViewProvider(VIEW_ID, provider,
        { webviewOptions:{ retainContextWhenHidden:true } }))
  Provider.resolveWebviewView(view, ctx):
    - view.webview.options = { enableScripts:true, localResourceRoots:[dist] }
    - view.webview.html = getHtml(webviewUri)
    - view.webview.onDidReceiveMessage(handleWebviewMessage)
  - spawn do motor (child_process/spawn), stdio JSON-RPC, env sanitizado
  - diff: registerFileSystemProvider("_opencode_fs_left"/"_right")
```

### Decisões a tomar

- **Runtime do motor**: Bun+FFI (Claude) vs Node+protocolo de servidor (Codex). O OpenCode é TypeScript/Bun — `bun:ffi` é viável, mas a rota mais segura é o protocolo do servidor OpenCode já existente.
- **Binário embarcado vs CLI global**: embarcar garante "funciona ao instalar", mas infla o `.vsix` em centenas de MB (Codex faz isso, OpenCode oficial tende a usar o CLI).
- **API proposals** (`chatSessionsProvider`): dá integração nativa com o painel de Chat do VS Code, mas exige suporte do cliente.

## Entregável: esqueleto funcional

Criado em `opencode-vscode/` — compila com `tsc --strict` (0 erros) e empacota em `.vsix`.

| Arquivo | Função |
|---|---|
| `package.json` | manifest: `onStartupFinished`, activity bar, webview view, comandos, atalhos, settings |
| `src/extension.ts` | ativação, registro do view provider, comandos, auto-start |
| `src/server.ts` | spawn do `opencode serve` + health check em `/app` + restart |
| `src/chatView.ts` | `WebviewViewProvider` + painel em aba + ponte `onDidReceiveMessage` + CSP com nonce |

**Verificado:** `tsc` exit 0; `.vsix` de **28 KB** empacotado com sucesso (contra 124 MB do Claude e 370 MB do Codex — a diferença é justamente o motor embarcado, que aqui usa o CLI do OpenCode). O streaming SSE foi validado contra um servidor real (33 eventos, texto montado a partir de `session.text.delta`).

Instalação: `code --install-extension opencode-vscode-0.1.1.vsix` (v0.1.1: UI no
padrão Codex — `Enter` envia, `Shift+Enter` quebra linha, composer arredondado,
markdown, tela de boas-vindas; ver `opencode-vscode/README.md`)

O único ponto stubbed é o streaming real de resposta (SSE), documentado no `README.md`.

## Decisões tomadas no esqueleto

- **CLI do OpenCode em vez de binário embarcado** → `.vsix` de 19 KB em vez de centenas de MB. O `ServerManager` permite trocar por binário embarcado trocando `serverCommand`.
- **Webview nativo** (padrão Codex/Claude), não terminal — mas ambas as rotas convivem: o OpenCode oficial usa terminal, este usa webview.
- **Segurança**: CSP estrita com nonce (padrão observado no Codex) e `connect-src` restrito a `127.0.0.1`.

---

## Limitações da análise

- `webview/index.js` do Claude Code não foi analisado (limite de heap do worker).
- O host do Codex é webpack minificado: 576 módulos, muitos `dynamic-call`/`ambiguous-target` (86.396 unknowns semânticos).
- Análise é **estática**; nenhum código foi executado. Não prova comportamento em runtime.
- O binário nativo `claude` (268 MB) e `codex` (294 MB) não foram desmontados nesta rodada (foco no host JS).

## Próximos passos (se quiser aprofundar com REA)

1. ~~Implementar streaming SSE real~~ ✅ **feito e verificado** (ver `opencode-vscode/README.md`).
2. `open_binary` no `resources/native-binary/claude` e em `bin/linux-x86_64/codex` → análise nativa (símbolos, subcomandos, flags).
3. `analyze_javascript_application` no `webview/index.js` do Claude Code com `max_heap_mb` maior → UI completa.
4. Ferramentas de permissão/aprovação (padrão "Accept/Reject changes" dos dois).
