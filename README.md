# OpenCode for VS Code

**Converse com o agente OpenCode direto dentro do VS Code** — em um painel de chat nativo, com streaming em tempo real, sem precisar sair do editor.

A extensão conecta o VS Code ao servidor OpenCode (`opencode serve`) e entrega uma interface de chat limpa no padrão Codex/Claude Code: você digita, o agente responde em streaming enquanto trabalha no seu código, e tudo acontece ao lado do seu editor.

---

## Para que serve?

O OpenCode é um agente de IA que lê, escreve e executa código na sua máquina. Normalmente você usa ele pelo terminal. Esta extensão traz essa experiência para dentro do VS Code:

- **Um painel de chat na barra lateral** (ou em uma aba separada) onde você conversa com o agente
- **Respostas em tempo real** — o texto aparece conforme o modelo gera, com indicador de "pensando"
- **Contexto automático do editor** — o arquivo aberto ou o trecho selecionado são anexados à sua mensagem (você vê o que foi anexado)
- **Markdown completo** — negrito, listas, blocos de código, links e mais, renderizados de forma segura

## Por que instalar?

| Benefício | Detalhe |
|---|---|
| **Fique no fluxo** | Nada de alternar entre terminal e editor — o agente trabalha ao lado do seu código |
| **Streaming real** | Veja a resposta ser gerada em tempo real via SSE, não só no final |
| **Referência rápida de arquivos** | Botão `@` (ou `Ctrl+Alt+K`) insere `@arquivo` na mensagem com um clique |
| **Contexto transparente** | A extensão mostra na UI exatamente o que será anexado (`@arquivo`, `@arquivo#L10-20`) — nada em silêncio |
| **Seguro por padrão** | CSP com nonce, comandos validados, servidor em `127.0.0.1` com senha aleatória, verificação de identidade do servidor (v0.1.2+) |
| **Leve** | Zero dependências de runtime, UI HTML/CSS/JS pura, empacotamento mínimo (~24 KB) |

## Requisitos

- **VS Code 1.94+**
- **OpenCode CLI instalado** e no `PATH` (`npm install -g @opencode/cli`)
- **Node.js 20+** (para o CLI)

## Instalação

### Opção 1 — Arquivo `.vsix` (mais simples)

1. Baixe o arquivo `opencode-vscode-0.1.2.vsix`
2. No VS Code: **Extensões** → `⋯` → **"Install from VSIX..."** → selecione o arquivo

Ou pela linha de comando:

```powershell
code --install-extension opencode-vscode-0.1.2.vsix
```

### Opção 2 — Compilar a partir do código

```powershell
cd opencode-vscode
npm install
npm run compile
npm run package          # gera o .vsix
code --install-extension opencode-vscode-0.1.2.vsix
```

## Como usar

1. **Abra o painel**: `Ctrl+Esc` ou clique no ícone OpenCode na barra lateral
2. **Digite sua pergunta** e pressione `Enter` (use `Shift+Enter` para quebrar linha)
3. **Acompanhe o agente**: o streaming mostra a resposta em tempo real; o raciocínio aparece em um bloco colapsável
4. **Anexe contexto**: clique em `@` para referenciar um arquivo, ou selecione um trecho no editor — a extensão anexa automaticamente e mostra o aviso na UI
5. **Nova sessão**: clique em `＋` para começar uma conversa do zero

### Atalhos

| Atalho | Ação |
|---|---|
| `Ctrl+Esc` | Abrir o painel OpenCode |
| `Ctrl+Alt+K` | Inserir referência `@arquivo` |
| `Enter` | Enviar mensagem |
| `Shift+Enter` | Quebrar linha |

### Comandos disponíveis

| Comando | Ação |
|---|---|
| `OpenCode: Open Sidebar` | Abrir o painel na barra lateral |
| `OpenCode: Open in New Tab` | Abrir em uma aba separada |
| `OpenCode: New Session` | Criar nova sessão |
| `OpenCode: Insert File Reference` | Inserir `@arquivo` no cursor |
| `OpenCode: Restart Server` | Reiniciar o servidor OpenCode |
| `OpenCode: Show Logs` | Ver logs (canal "OpenCode") |

## Configurações

| Setting | Padrão | Descrição |
|---|---|---|
| `opencode.serverCommand` | `opencode` | Executável usado para iniciar o servidor |
| `opencode.serverArgs` | `["serve","--hostname","127.0.0.1","--port","4096"]` | Argumentos do servidor |
| `opencode.autoStartServer` | `true` | Iniciar o servidor automaticamente |
| `opencode.attachOpenFile` | `true` | Anexar o arquivo aberto às mensagens |
| `opencode.attachSelection` | `true` | Anexar a seleção do editor às mensagens |

> **Dica**: se você já tem um servidor OpenCode rodando na porta 4096, a extensão pergunta antes de conectar a ele (em vez de iniciar outro).

## Segurança (v0.1.2)

A extensão foi auditada e endurecida contra os vetores mais comuns:

- **Servidor verificado** — antes de conectar a um servidor existente, a extensão faz probe anônimo e pede confirmação; credenciais nunca são enviadas a um servidor que não exige autenticação; após iniciar o próprio servidor, ela confirma que a porta é realmente dele
- **Anti-injeção de comandos** — `serverCommand`/`serverArgs` passam por allowlist de caracteres antes de qualquer `spawn`
- **Webview blindada** — CSP com `default-src 'none'` + nonce criptográfico, todas as mensagens validadas em runtime, caminhos confinados ao workspace (sem path traversal)
- **Workspace Trust** — a extensão não inicia o servidor em workspaces não confiáveis
- **Zero dependências de runtime** — superfície de supply-chain mínima

Rodar os testes de segurança:

```powershell
npm run compile
npm test
```

---

## Para desenvolvedores

### Estrutura

```
src/extension.ts     ativação, comandos, auto-start
src/server.ts        spawn/conexão + auth + API v2 + cliente SSE
src/chatView.ts      WebviewViewProvider + painel + roteamento de eventos
src/security.ts      lógica de segurança (testável sem vscode)
media/webview.html   UI do webview (CSS, JS, markdown, boas-vindas)
test/                testes de segurança (27 casos)
```

### API do servidor (verificada ao vivo com `opencode serve` v2.0.32)

| Método | Rota | Função |
|---|---|---|
| `POST` | `/api/session` | cria sessão → `{ data: { id } }` |
| `POST` | `/api/session/:id/prompt` | envia `{ "text": "..." }` (assíncrono) |
| `GET` | `/api/event` | stream SSE com o bus de eventos |
| `GET` | `/api/session` | listagem/health (readiness) |

Autenticação: HTTP Basic, usuário `opencode`. A senha vem de `OPENCODE_PASSWORD` ou é gerada aleatoriamente com `crypto.randomBytes(24)`.

### Eventos SSE usados no streaming

```
session.execution.started   -> execução começa
session.reasoning.delta     -> raciocínio incremental
session.text.delta          -> texto incremental (streaming principal)
session.text.ended          -> texto final
session.step.ended          -> tokens/custo/finish
session.execution.succeeded -> fim
```

### Roadmap

- [ ] Suporte a abortar sessão pelo servidor (hoje apenas limpa a UI)
- [ ] Seletor de modelo na UI
- [ ] Exibição de diffs no chat
- [ ] Suporte a múltiplos workspaces
- [ ] Publicação no Marketplace / Open VSX

## Licença

MIT
