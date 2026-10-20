# Registra o modelo treinado no Ollama.
# Requer: export.py ja executado (out/merged com safetensors fp16).
#
# Uso:  powershell -ExecutionPolicy Bypass -File .\build_ollama.ps1

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Merged = Join-Path $Root "out\merged"
$ModelName = "llm-local-coder"

if (-not (Test-Path (Join-Path $Merged "config.json"))) {
    throw "Nao encontrei $Merged\config.json. Rode export.py primeiro."
}

$ollama = Get-Command ollama -ErrorAction SilentlyContinue
if (-not $ollama) {
    throw "Ollama nao encontrado no PATH. Abra um terminal novo ou reinstale."
}

# Garante que o servidor esta rodando e o modelo base esta baixado (usado como referencia do template).
Write-Host "Baixando modelo base de referencia (qwen2.5-coder:1.5b)..."
ollama pull qwen2.5-coder:1.5b

Write-Host "Extraindo TEMPLATE do modelo base..."
$template = @()
try {
    $raw = ollama show --modelfile qwen2.5-coder:1.5b
    $capture = $false
    foreach ($linha in $raw) {
        if ($linha -match '^TEMPLATE\s') { $capture = $true; $template += $linha; continue }
        if ($capture -and $linha -match '^(PARAMETER|SYSTEM|FROM|LICENSE|ADAPTER)\s') { $capture = $false }
        if ($capture) { $template += $linha }
    }
} catch {
    Write-Warning "Nao consegui extrair o template; o Ollama tentara usar o do tokenizer."
}

$modelfile = Join-Path $Root "Modelfile"
$linhas = @()
if ($template.Count -gt 0) { $linhas += $template }
$linhas += "FROM ./out/merged"
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

# --quantize converte fp16 safetensors -> q4_K_M (~1 GB) durante o import.
Write-Host "Criando modelo $ModelName (pode levar alguns minutos)..."
ollama create $ModelName -f $modelfile --quantize q4_K_M

Write-Host ""
Write-Host "Pronto. Teste:"
Write-Host "  ollama run $ModelName `"Escreva uma funcao Python que valida CPF.`""
