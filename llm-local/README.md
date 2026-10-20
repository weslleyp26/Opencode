# LLM local para desenvolvimento (Qwen2.5-Coder 1.5B + QLoRA)

Pipeline completo para **treinar seu proprio modelo de codigo** e usa-lo no
OpenCode, rodando 100% na sua maquina.

## Hardware alvo

| Item | Valor |
|------|-------|
| GPU | RTX 4050 Laptop, 6 GB VRAM |
| RAM | 16 GB |
| CPU | i7-13620H |
| SO | Windows 11 |

Com 6 GB de VRAM **nao** da para treinar do zero. Fine-tuning QLoRA (4-bit) de
um modelo 1.5B cabe confortavelmente.

## Estrutura

```
llm-local/
  make_dataset.py     # gera data/demo.jsonl (exemplos sinteticos)
  make_prompts.py     # gera data/prompts.jsonl (corpus de perguntas p/ destilacao)
  harvest.py          # coleta respostas do big-pickle -> data/distill.jsonl
  train.py            # QLoRA: treina out/lora/  (~50 MB)
  export.py           # funde o adapter: out/merged/ (fp16 safetensors)
  build_ollama.ps1    # GGUF q8_0 (~1.6 GB) + cria o modelo no Ollama
  opencode.example.json
  data/demo.jsonl
  tools/llama.cpp/    # conversor oficial HF -> GGUF
```

## Passo a passo

```powershell
# 1. Ambiente (torch CUDA + libs de treino)
uv venv .venv --python 3.12
uv pip install --python .venv\Scripts\python.exe torch --index-url https://download.pytorch.org/whl/cu124
uv pip install --python .venv\Scripts\python.exe -r requirements.txt

# 2. Dataset de demonstracao
.venv\Scripts\python.exe make_dataset.py

# 3. Treino (primeira vez baixa ~3 GB do modelo base)
.venv\Scripts\python.exe train.py

# 4. Fundir o adapter no modelo
.venv\Scripts\python.exe export.py

# 5. Registrar no Ollama (converte para GGUF q8_0 e cria o modelo)
#    Primeira vez: git clone --depth 1 https://github.com/ggml-org/llama.cpp.git tools\llama.cpp
#    e uv pip install gguf sentencepiece
powershell -ExecutionPolicy Bypass -File .\build_ollama.ps1

# 6. Testar
ollama run llm-local-coder "Escreva uma funcao Python que valida CPF."
```

## Destilacao: clonar o big-pickle localmente

O `opencode/big-pickle` e um modelo **hosted** (codinome para um modelo grande
servido pelo OpenCode Zen). Nao da para "extrair" os pesos dele, mas da para
**destilar o comportamento**: perguntar N coisas, guardar as respostas e treinar
um modelo pequeno com elas.

```
prompts.jsonl  --(harvest.py)-->  distill.jsonl  --(train.py)-->  adapter
```

### 1. Gerar os prompts

```powershell
# sinteticos (tarefas gerais de codigo) + funcoes reais do seu repo
.venv\Scripts\python.exe make_prompts.py --count 120 --repo ..\opencode-vscode
```

### 2. Coletar as respostas do big-pickle

```powershell
# usa a API local do OpenCode (sem OPENCODE_API_KEY, sem header especial)
.venv\Scripts\python.exe harvest.py --workers 5
```

O `harvest.py` cria uma sessao por prompt em `opencode/big-pickle`, espera a
resposta e grava no mesmo formato ShareGPT do `train.py`. O arquivo de saida
funciona como checkpoint: rodar de novo so coleta o que falta.

### 3. Treinar com os dados destilados

```powershell
.venv\Scripts\python.exe train.py --data data\distill.jsonl --seq 2048 --epochs 2 --lr 1e-4 --out out\lora-distill
.venv\Scripts\python.exe export.py --adapter out\lora-distill --merged out\merged-distill
powershell -ExecutionPolicy Bypass -File .\build_ollama.ps1 `
    -Merged out\merged-distill -Gguf out\model-distill-q8_0.gguf `
    -ModelName llm-local-coder-distill
```

### O que a destilacao entrega (e o que nao entrega)

| Entrega | Nao entrega |
|---------|-------------|
| Estilo, tom, estrutura markdown, formato de codigo e de explicacao | Raciocinio do modelo original (355B) |
| Habito de responder "codigo + justificativa curta" | Conhecimento novo |
| Adequacao ao seu repo (prompts com codigo real) | Reasoning de 200k tokens |

Ou seja: o student de 1.5B **imita** o big-pickle, nao o substitui. Vale medir
antes de trocar o modelo padrao.

### Medindo o resultado

```powershell
.venv\Scripts\python.exe evaluate.py --model llm-local-coder          --out eval_demo.json
.venv\Scripts\python.exe evaluate.py --model llm-local-coder-distill  --out eval_distill.json
```

O `evaluate.py` mede latencia, tamanho da resposta, presenca de bloco de
codigo, **se o Python gerado compila** (`ast.parse`), e se o modelo emite
tool-call.

## Usar no OpenCode (100% local)

O OpenCode V2 descobre o Ollama automaticamente em `http://127.0.0.1:11434`:
basta o Ollama estar rodando e ele lista os modelos em `/models`. Nenhum dado
sai da sua maquina.

1. Garanta o Ollama rodando (`ollama serve` ou o app aberto).
2. Abra o OpenCode e use `/models`, escolha `ollama/llm-local-coder`.
3. Opcional: fixe como padrao em `~/.config/opencode/opencode.json`:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "model": "ollama/llm-local-coder",
  "update": "disable"
}
```

O `providers.ollama.settings.baseURL` do `opencode.example.json` so e necessario
se você apontar para outro host/porta. `"update": "disable"` evita checagens de
atualizacao na rede.

Notas:
- O OpenCode usa arquitetura cliente-servidor, mas o "servidor" e um processo
  local seu (`opencode service status`), nao um servico externo.
- O catalogo de modelos da nuvem vem de models.dev; com Ollama isso e dispensavel.
- Busca web e MCP sao opcionais e podem ficar desligados.

## O que cada etapa faz (a parte educativa)

1. **4-bit NF4**: pesos guardados com 4 bits por valor + escala. Reduz 1.5B de
   ~3 GB (fp16) para ~1 GB, viabilizando treino em 6 GB.
2. **LoRA**: em vez de atualizar todos os pesos, adiciona duas matrizes pequenas
   (ranking `r`) em cada camada linear. ~1% dos parametros treinaveis.
3. **QLoRA**: modelo base congelado em 4-bit + adaptadores em bf16. E o que cabe
   no seu hardware.
4. **Gradient checkpointing**: recalcula ativacoes no backward em vez de guardar
   todas — troca VRAM por tempo.
5. **Merge**: `W + BA` volta a ser um modelo normal de 1.5B, exportavel.
6. **GGUF q8_0**: formato de inferencia do llama.cpp/Ollama; 8 bits por peso,
   ~1.6 GB. (O Ollama 0.40 nao importa safetensors de Qwen2 diretamente.)

## Medindo o aprendizado

O dataset demo tem ~50 exemplos: serve para **validar o pipeline**, nao para
mudar o comportamento do modelo de forma significativa. Sinais de que o treino
funcionou:

- A loss cai de ~1.0 para ~0.5-0.7 em 3 epocas.
- O modelo passa a responder no formato/estilo dos exemplos.
- Em perguntas fora do dataset, ele pode piorar levemente (overfitting) — por
  isso misture dados gerais com seus dados.

## Trocar pelos seus dados

Formato esperado (`data/meu.jsonl`):

```json
{"conversations": [
  {"from": "system", "value": "Voce e um assistente de programacao."},
  {"from": "human", "value": "Como inicializo o banco neste projeto?"},
  {"from": "gpt", "value": "Rode `make db-up` ..."}
]}
```

Gere pares a partir dos seus repos (pergunta = intencao, resposta = trecho real
do codigo + explicacao). Regras praticas:

- 300 a 2000 exemplos ja mostram diferenca clara.
- Variedade > volume: varias perguntas sobre o mesmo arquivo.
- Nunca inclua segredos (`.env`, chaves).
- Segure ~5% dos exemplos para avaliacao.

## Limitacoes honestas

- 1.5B e um modelo pequeno: bom para tarefas curtas (funcoes, explicacoes,
  testes). Nao substitui Claude/GPT para refatoracoes grandes.
- Fine-tuning ensina **estilo e conhecimento do seu projeto**, nao raciocinio
  novo.
- 6 GB de VRAM limita o tamanho do contexto no treino (`--seq 1024` padrao;
  tente 2048 se nao der OOM). Para o dataset destilado use `--seq 3072
  --drop-long`.
- **Tool-calling:** nem o modelo base consegue emitir tool-call nativa no
  Ollama (ele devolve o JSON da chamada dentro de um bloco ```json). O
  OpenCode nao executa isso como ferramenta, entao o modelo local responde
  texto em vez de editar arquivos. Destilacao nao muda isso.
- Destilar o big-pickle para treinar um substituto pode violar os termos de
  uso do OpenCode Zen. Confira antes de publicar o resultado.

## Solucao de problemas

| Erro | Causa / solucao |
|------|-----------------|
| `CUDA out of memory` | Feche jogos/navegador, use `--seq 768 --batch 1`, ou `--lora-r 8` |
| `torch.cuda.is_available() == False` | torch instalado sem index CUDA |
| `bitsandbytes` falha | Reinstale com `uv pip install --force-reinstall bitsandbytes` |
| `ollama create` erro de arquitetura | Ollama 0.40 nao importa safetensors Qwen2; use o fluxo GGUF do `build_ollama.ps1` |
| Modelo responde mal | Dataset pequeno ou taxa de aprendizado alta; reduza `--lr 1e-4` |
