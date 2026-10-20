"""
Gera o corpus de PROMPTS que serao enviados ao big-pickle (fonte da destilacao).

Duas fontes:
  1. Sintetica  -- templates x dominios x linguagens (tarefas gerais de codigo).
  2. Repositorio -- funcoes reais do seu projeto, com o trecho de codigo embutido
                    no prompt (grounded: o modelo responde sobre codigo que existe).

Saida: data/prompts.jsonl  (uma linha por prompt)
    {"prompt": "...", "source": "synthetic|repo", "tags": ["python", "test"]}

Uso:
    .venv\\Scripts\\python.exe make_prompts.py
    .venv\\Scripts\\python.exe make_prompts.py --count 160 --repo ..\\opencode-vscode
"""

from __future__ import annotations

import argparse
import json
import random
import re
from pathlib import Path

ROOT = Path(__file__).parent
OUT = ROOT / "data" / "prompts.jsonl"

# --------------------------------------------------------------------------
# 1) Fonte sintetica
# --------------------------------------------------------------------------

DOMINIOS = [
    "leitura de CSV com delimitador customizado",
    "validacao de CPF e CNPJ",
    "normalizacao de telefones",
    "retry com backoff exponencial em HTTP",
    "rate limiter de janela deslizante",
    "cache LRU com limite de memoria",
    "paginação com cursor",
    "cliente de WebSocket com reconexao",
    "watcher de arquivos que ignora .git",
    "parser de argumentos de CLI",
    "configuracao por variaveis de ambiente com validacao",
    "logging estruturado em JSON",
    "serializacao/deserializacao de dataclasses",
    "injecao de dependencias simples",
    "circuit breaker para chamadas externas",
    "fila de tarefas com worker pool",
    "dicionario de traducoes com fallback",
    "sanitizacao de entrada para HTML",
    "hash de senha com salt",
    "calculo de checksum de arquivo",
    "diff entre duas versoes de texto",
    "geracao de slug a partir de titulo",
    "download de arquivo com progresso e retry",
    "processamento de imagens em lote",
    "extracao de metadados de PDF",
    "consulta de API REST com paginacao",
    "roteamento simples de URLs",
    "middleware de autenticacao",
    "migracao de schema de banco",
    "consulta SQL para ranking com janela",
    "upsert em lote",
    "transacao com rollback",
    "pool de conexoes com timeout",
    "processamento de streams de bytes",
    "parser de data com fusos horarios",
    "calculo de distancia entre coordenadas",
    "geracao de senha forte",
    "arredondamento monetario seguro",
    "estado global de aplicacao sem dependencias",
    "ordemacao de resultados com chave composta",
    "debounce e throttle em eventos",
    "indexacao de texto para busca",
    "editor de undo/redo",
    "formatacao de numeros e moedas",
]

LINGUAGENS = {
    "python": "Python",
    "typescript": "TypeScript",
    "javascript": "JavaScript",
    "go": "Go",
    "rust": "Rust",
    "sql": "SQL",
    "bash": "Bash",
}

TEMPLATES = [
    "Escreva uma funcao {lang} que resolve o seguinte: {dominio}. Retorne apenas o codigo, com type hints.",
    "Implemente em {lang} a solucao para: {dominio}. Explique em 2 linhas o porque da escolha.",
    "Qual a melhor forma de lidar com {dominio} em {lang}? Mostre o codigo e as alternativas.",
    "Refatore um trecho meu que faz {dominio}. Antes de responder, liste 3 riscos comuns nesse cenario.",
    "Escreva testes unitarios (em {lang}) para a logica de: {dominio}.",
    "Revise este requisito: o sistema precisa lidar com {dominio}. Quais casos de borda devo cobrir?",
    "Crie uma classe {lang} que encapsule {dominio} e exponha uma API simples.",
    "Do ponto de vista de performance, como implementar {dominio} em {lang}? Inclua complexidade e trade-offs.",
    "Escreva a documentacao (docstring) e o codigo {lang} para: {dominio}.",
    "Qual framework/ferramenta {lang} eu usaria para {dominio}? Compare com uma alternativa.",
    "Escreva um exemplo {lang} completo, executavel, que resolva: {dominio}.",
    "Como eu depuro problemas de {dominio} em {lang}? Liste os pontos de observacao.",
]

# Codigos com bug proposital (para o modelo aprender a explicar e corrigir)
BUGS = [
    (
        "python",
        "```python\ndef media(lista):\n    return sum(lista) / len(lista)\n```",
        "Esse codigo quebra com lista vazia. Corrija e explique a causa.",
    ),
    (
        "typescript",
        "```typescript\nasync function carrega(url: string) {\n  const r = await fetch(url);\n  return r.json();\n}\n```",
        "Falta tratar erro de rede. Corrija e explique o que mudou.",
    ),
    (
        "python",
        "```python\ndef loopa(items):\n    for i in range(len(items)):\n        items.append(i)\n```",
        "Esse loop nunca termina. Ache o bug e corrija.",
    ),
    (
        "sql",
        "```sql\nSELECT nome, COUNT(*) FROM pedidos GROUP BY nome;\n```",
        "Essa query conta errado quando ha nomes iguais. Corrija.",
    ),
    (
        "javascript",
        "```javascript\nfor (var i = 0; i < arr.length; i++) {\n  setTimeout(() => console.log(arr[i]), 100);\n}\n```",
        "Imprime os valores errados. Explique o porquê e corrija.",
    ),
]


# --------------------------------------------------------------------------
# 2) Fonte repositorio
# --------------------------------------------------------------------------

EXTENSOES = {".ts", ".tsx", ".js", ".py"}

# Padroes de declaracao de funcao por linguagem
PADROES = [
    re.compile(r"^\s*(?:export\s+)?(?:async\s+)?function\s+(\w+)"),
    re.compile(r"^\s*(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\("),
    re.compile(r"^\s*def\s+(\w+)"),
    re.compile(r"^\s*(?:export\s+)?class\s+(\w+)"),
]

IGNORAR_DIR = {"node_modules", "dist", "out", ".git", ".venv", "build", "coverage"}


def coletar_funcoes(repo: Path, limite_arquivos: int = 60) -> list[tuple[str, str]]:
    """Retorna [(nome, trecho_de_codigo)] extraidos do repositorio."""
    achados: list[tuple[str, str]] = []
    arquivos = []
    for p in sorted(repo.rglob("*")):
        if not p.is_file() or p.suffix.lower() not in EXTENSOES:
            continue
        if any(parte in IGNORAR_DIR for parte in p.parts):
            continue
        arquivos.append(p)
        if len(arquivos) >= limite_arquivos:
            break

    for arquivo in arquivos:
        try:
            linhas = arquivo.read_text(encoding="utf-8", errors="replace").splitlines()
        except OSError:
            continue
        for i, linha in enumerate(linhas):
            for padrao in PADROES:
                m = padrao.match(linha)
                if not m:
                    continue
                nome = m.group(1)
                if nome.startswith("_") or len(nome) < 3:
                    continue
                trecho = "\n".join(linhas[i : i + 45])
                if len(trecho.strip()) < 40:
                    break
                achados.append((f"{arquivo.name}:{nome}", trecho))
                break
    return achados


def prompts_do_repo(repo: Path, limite: int) -> list[dict]:
    # Sem essa instrucao o agente responde "vou explorar o repositorio" e a
    # coleta captura o preambulo em vez da resposta final.
    anti_explore = (
        "\n\nResponda usando APENAS o trecho acima. "
        "Nao explore o repositorio e nao use ferramentas."
    )
    templates_repo = [
        "Explique o que a funcao `{nome}` faz, passo a passo, e aponte um possivel bug:\n```\n{codigo}\n```",
        "Escreva testes unitarios para `{nome}`:\n```\n{codigo}\n```",
        "Refatore `{nome}` para ficar mais testavel e legivel. Explique as mudancas:\n```\n{codigo}\n```",
        "O que acontece se `{nome}` receber entradas inesperadas? Liste os casos de borda:\n```\n{codigo}\n```",
        "Otimize `{nome}` sem mudar o comportamiento observavel:\n```\n{codigo}\n```",
    ]
    saida = []
    for nome, codigo in coletar_funcoes(repo)[:limite]:
        for t in templates_repo:
            saida.append(
                {
                    "prompt": t.format(nome=nome, codigo=codigo) + anti_explore,
                    "source": "repo",
                    "tags": ["repo", "codigo-real"],
                }
            )
    return saida


# --------------------------------------------------------------------------


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=120, help="quantos prompts sinteticos")
    ap.add_argument("--repo", type=str, default=None, help="caminho do repo para extrair prompts")
    ap.add_argument("--repo-limit", type=int, default=25, help="maximo de funcoes do repo")
    ap.add_argument("--out", type=str, default=str(OUT))
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    rng = random.Random(args.seed)
    registros: list[dict] = []

    # Sinteticos: amostragem sem repeticao de (template, dominio, linguagem)
    vistos = set()
    tentativas = 0
    while len(registros) < args.count and tentativas < args.count * 40:
        tentativas += 1
        tpl = rng.choice(TEMPLATES)
        dom = rng.choice(DOMINIOS)
        lang = rng.choice(list(LINGUAGENS))
        chave = (tpl, dom, lang)
        if chave in vistos:
            continue
        vistos.add(chave)
        prompt = tpl.format(lang=LINGUAGENS[lang], dominio=dom)
        registros.append({"prompt": prompt, "source": "synthetic", "tags": [lang, "geral"]})

    # Bugs propositais
    for lang, codigo, pergunta in BUGS:
        registros.append(
            {"prompt": f"{pergunta}\n\n{codigo}", "source": "synthetic", "tags": [lang, "debug"]}
        )

    # Repositorio
    if args.repo:
        repo = Path(args.repo).resolve()
        if not repo.exists():
            raise SystemExit(f"Repositorio nao encontrado: {repo}")
        registros.extend(prompts_do_repo(repo, args.repo_limit))

    rng.shuffle(registros)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as f:
        for r in registros:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")

    por_fonte: dict[str, int] = {}
    for r in registros:
        por_fonte[r["source"]] = por_fonte.get(r["source"], 0) + 1
    print(f"{len(registros)} prompts escritos em {out}")
    print("  por fonte:", por_fonte)


if __name__ == "__main__":
    main()
