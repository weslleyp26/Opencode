# OpenCode for VS Code (esqueleto funcional)

Extensão que integra o OpenCode ao VS Code com **painel webview nativo e streaming
real**, seguindo o padrão arquitetural observado no Codex (`openai.chatgpt`) e no
Claude Code (`anthropic.claude-code`) durante a análise com REA.

## Estado

| Item | Status |
|---|---|
| Compilação (`tsc --strict`) | ✅ 0 erros |
| Empacotamento (`.vsix`) | ✅ |
| UI webview + CSP com nonce | ✅ |
| Criação de sessão | ✅ |
| **Streaming real (SSE)** | ✅ verificado contra servidor real |
| Anexo de arquivo/seleção (`@arquivo#Lx-y`) | ✅ |
| Atalhos (Ctrl+Esc, Ctrl+Alt+K) | ✅ |
| Autenticação (Basic / service.json) | ✅ |

## Instalar

```powershell
code --install-extension opencode-vscode-0.1.1.vsix
```

`Ctrl+Esc` abre o painel. `OpenCode: Show Logs` mostra o log (canal "OpenCode").

## UI (v0.1.1, layout no padrão Codex)

A UI fica em `media/webview.html` (desacoplada do host, como o `webview/index.js`
do Claude e o webview React do Codex):

| Reciplina | Comportamento |
|---|---|
| **Enter envia** | `Enter` envia a mensagem; `Shift+Enter` quebra linha (`Ctrl+Enter` também envia) |
| Composer arredondado | caixa de entrada que cresce sozinha (até 170px), botão de envio circular `↑`, atalhos `@` e `＋` como ícones |
| Tela de boas-vindas | logo + sugestões clicáveis + atalho de teclado; some na 1ª mensagem e volta em "Nova sessão" |
| Mensagens em bolhas | do usuário à direita (fundo de widget), assistente com rótulo e largura máxima de 860px |
| Markdown | negrito, itálico, `inline code`, fences, listas, títulos, citações e links (render seguro: HTML escapado + CSP com nonce) |
| Raciocínio | `<details>` colapsável, abre durante o streaming e fecha no fim do passo |
| Pensamento | três pontos animados durante a execução |
| Rolagem inteligente | autoscroll só enquanto o usuário está no fim da conversa |
| Foco | o campo de digitação recebe foco ao abrir/revelar o painel |
| Status | dot verde/vermelho online/offline, id da sessão no tooltip |

## Protocolo (verificado ao vivo, `opencode serve` v2.0.32)

A API v2 **não** é a `/session` da doc v1 — é prefixada por `/api` e protegida por
HTTP Basic. Contrato real descoberto por sondagem:

| Método | Rota | Função |
|---|---|---|
| `POST` | `/api/session` | cria sessão → `{ data: { id } }` |
| `POST` | `/api/session/:id/prompt` | envia `{ "text": "..." }` (**assíncrono**) |
| `GET` | `/api/event` | stream SSE com o bus de eventos |
| `GET` | `/api/session` | lista/health (usado no readiness) |

Autenticação: HTTP Basic, usuário `opencode`. A senha vem de `OPENCODE_PASSWORD`
ou de `~/.config/opencode/service.json` (serviço em background).

Eventos SSE relevantes para streaming:

```
session.execution.started   -> execução começa
session.reasoning.delta     -> raciocínio incremental
session.text.delta          -> texto incremental   <-- streaming principal
session.text.ended          -> texto final
session.step.ended          -> tokens/custo/finish
session.execution.succeeded -> fim
```

## Estrutura

```
src/extension.ts   ativação, comandos, auto-start
src/server.ts      spawn/conexão + auth + API v2 + cliente SSE
src/chatView.ts    WebviewViewProvider + painel + roteamento de eventos
media/webview.html UI do webview (CSS, JS, markdown, boas-vindas)
```

## Configurações

- `opencode.serverCommand` — executável (padrão `opencode`)
- `opencode.serverArgs` — padrão `["serve","--hostname","127.0.0.1","--port","4096"]`
- `opencode.autoStartServer` — inicia no boot (padrão `true`)
- `opencode.attachOpenFile` / `opencode.attachSelection`

## Verificação

O protocolo foi validado com um teste de integração contra um `opencode serve`
real: sessão criada, prompt aceito, 33 eventos recebidos, texto `PONG` montado a
partir de `session.text.delta`. Se houver um servidor já rodando na porta, a
extensão **conecta** em vez de iniciar outro (`ServerManager.probe`).
