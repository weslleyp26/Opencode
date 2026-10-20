# Registra o modelo treinado no Ollama a partir de um GGUF.
# Requer: export.py executado (out/merged) e llama.cpp em tools/llama.cpp.
#
# Uso:  powershell -ExecutionPolicy Bypass -File .\build_ollama.ps1
#       powershell -ExecutionPolicy Bypass -File .\build_ollama.ps1 `
#              -Merged out\merged-distill -Gguf out\model-distill-q8_0.gguf `
#              -ModelName llm-local-coder-distill

param(
    [string]$Merged = "",
    [string]$Gguf = "",
    [string]$ModelName = "llm-local-coder"
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
if (-not $Merged) { $Merged = Join-Path $Root "out\merged" }
if (-not $Gguf) { $Gguf = Join-Path $Root "out\model-q8_0.gguf" }
$Merged = Join-Path $Root $Merged
$Gguf = Join-Path $Root $Gguf

$ollama = (Get-Command ollama -ErrorAction SilentlyContinue).Source
if (-not $ollama) {
    $fallback = Join-Path $env:LOCALAPPDATA "Programs\Ollama\ollama.exe"
    if (Test-Path $fallback) { $ollama = $fallback } else {
        throw "Ollama nao encontrado. Instale em https://ollama.com/download"
    }
}

if (-not (Test-Path (Join-Path $Merged "config.json"))) {
    throw "Nao encontrei $Merged\config.json. Rode export.py primeiro."
}

# 1) Converte safetensors fp16 -> GGUF q8_0 (se ainda nao existir)
if (-not (Test-Path $Gguf)) {
    $converter = Join-Path $Root "tools\llama.cpp\convert_hf_to_gguf.py"
    if (-not (Test-Path $converter)) {
        throw "Conversor nao encontrado em $converter. Rode: git clone --depth 1 https://github.com/ggml-org/llama.cpp.git tools\llama.cpp"
    }
    Write-Host "Convertendo para GGUF q8_0 (~1.6 GB)..."
    & (Join-Path $Root ".venv\Scripts\python.exe") $converter $Merged --outfile $Gguf --outtype q8_0
    if ($LASTEXITCODE -ne 0) { throw "conversao para GGUF falhou" }
} else {
    Write-Host "GGUF ja existe: $Gguf"
}

# 2) Template de chat do modelo base
Write-Host "Garantindo modelo base de referencia (qwen2.5-coder:1.5b)..."
& $ollama pull qwen2.5-coder:1.5b
if ($LASTEXITCODE -ne 0) { throw "ollama pull falhou" }

Write-Host "Extraindo TEMPLATE ..."
$template = @()
try {
    $raw = & $ollama show --modelfile qwen2.5-coder:1.5b
    $capture = $false
    foreach ($linha in $raw) {
        if ($linha -match '^TEMPLATE\s') { $capture = $true; $template += $linha; continue }
        if ($capture -and $linha -match '^(PARAMETER|SYSTEM|FROM|LICENSE|ADAPTER)\s') { $capture = $false }
        if ($capture) { $template += $linha }
    }
} catch {
    Write-Warning "Nao consegui extrair o template; o Ollama tentara usar o do tokenizer."
}

# 3) Modelfile
$modelfile = Join-Path $Root "Modelfile"
$linhas = @()
if ($template.Count -gt 0) { $linhas += $template }
$linhas += "FROM `"$Gguf`""
$linhas += ""
$linhas += "PARAMETER temperature 0.3"
$linhas += "PARAMETER top_p 0.9"
$linhas += "PARAMETER top_k 40"
$linhas += "PARAMETER repeat_penalty 1.05"
$linhas += "PARAMETER num_ctx 8192"
$linhas += ""
$linhas += 'SYSTEM """Voce e um assistente de programacao direto e tecnico. Responda em portugues quando a pergunta for em portugues, com codigo funcional e explicacoes curtas."""'

Set-Content -Path $modelfile -Value $linhas -Encoding UTF8
Write-Host "Modelfile gerado em $modelfile"

# 4) Cria o modelo
Write-Host "Criando modelo $ModelName ..."
& $ollama create $ModelName -f $modelfile
if ($LASTEXITCODE -ne 0) { throw "ollama create falhou (exit $LASTEXITCODE)" }

Write-Host ""
Write-Host "Pronto. Teste:"
Write-Host "  ollama run $ModelName `"Escreva uma funcao Python que valida CPF.`""
