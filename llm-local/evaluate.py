"""
Avalia um modelo local (Ollama) com metricas objetivas.

Metricas por prompt:
  - latencia (s)
  - tamanho da resposta (chars)
  - contem bloco de codigo (```)
  - codigo Python extraido e valido (ast.parse) -> "parse_ok"
  - contem preambulo de agente ("vou explorar") -> "preambulo"

Uso:
    .venv\\Scripts\\python.exe evaluate.py --model llm-local-coder --out eval_llm-local-coder.json
    .venv\\Scripts\\python.exe evaluate.py --model llm-local-coder-distill --out eval_distill.json
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import statistics
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).parent

PROMPTS = [
    "Escreva uma funcao Python que leia um CSV e retorne uma lista de dicionarios.",
    "Escreva uma funcao Python que valide um CPF.",
    "Crie uma classe Python Retry que repete uma operacao com backoff exponencial.",
    "Explique a diferenca entre list.append e list.extend em Python.",
    "Escreva testes unitarios para uma funcao Python que soma dois numeros.",
    "Corrija este bug: a[i] = a[i+1] dentro de um for em Python causa laco infinito.",
    "Escreva uma funcao Python que converta uma string para snake_case.",
    "Como eu implemento um cache LRU em Python? Mostre o codigo.",
]

RE_BLOCO = re.compile(r"```(?:python|py)?\r?\n(.*?)```", re.S)
RE_PREAMBULO = re.compile(
    r"^\s*(vou|let me|i'?ll|i will)\b.{0,200}?(explor|localiz|procur|look for|find the file)",
    re.I,
)


def perguntar(modelo: str, prompt: str, host: str, timeout: int) -> dict:
    corpo = json.dumps(
        {
            "model": modelo,
            "messages": [{"role": "user", "content": prompt}],
            "stream": False,
            "options": {"temperature": 0.3, "num_predict": 2048},
        }
    ).encode()
    req = urllib.request.Request(
        f"{host}/api/chat", data=corpo, headers={"Content-Type": "application/json"}
    )
    inicio = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        dados = json.loads(resp.read().decode("utf-8", errors="replace"))
    texto = dados.get("message", {}).get("content", "")
    return {"texto": texto, "latencia": time.time() - inicio}


def avaliar_resposta(texto: str) -> dict:
    blocos = RE_BLOCO.findall(texto)
    parse_ok = None
    for b in blocos:
        try:
            ast.parse(b)
            parse_ok = True
            break
        except SyntaxError:
            continue
    if parse_ok is None and blocos:
        parse_ok = False
    return {
        "chars": len(texto),
        "tem_bloco_codigo": bool(blocos),
        "parse_ok": parse_ok,
        "preambulo": bool(RE_PREAMBULO.match(texto)),
        "markdown": "```" in texto,
        "fechou_bloco": texto.rstrip().endswith("```"),
    }


def testar_tool_call(modelo: str, host: str, timeout: int) -> dict:
    """Verifica se o modelo emite tool_calls quando recebe um schema de tools."""
    ferramentas = [
        {
            "type": "function",
            "function": {
                "name": "read_file",
                "description": "Le o conteudo de um arquivo do projeto",
                "parameters": {
                    "type": "object",
                    "properties": {"path": {"type": "string"}},
                    "required": ["path"],
                },
            },
        }
    ]
    corpo = json.dumps(
        {
            "model": modelo,
            "messages": [
                {"role": "user", "content": "Leia o arquivo config.json e me diga o que tem dentro."}
            ],
            "tools": ferramentas,
            "stream": False,
            "options": {"temperature": 0.2, "num_predict": 512},
        }
    ).encode()
    req = urllib.request.Request(
        f"{host}/api/chat", data=corpo, headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        dados = json.loads(resp.read().decode("utf-8", errors="replace"))
    msg = dados.get("message", {})
    calls = msg.get("tool_calls") or []
    return {
        "tool_call": bool(calls),
        "nome_tool": calls[0].get("function", {}).get("name") if calls else None,
        "args_tool": calls[0].get("function", {}).get("arguments") if calls else None,
    }


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--model", required=True)
    ap.add_argument("--host", default="http://127.0.0.1:11434")
    ap.add_argument("--out", default=None)
    ap.add_argument("--timeout", type=int, default=300)
    args = ap.parse_args()

    resultados = []
    for i, p in enumerate(PROMPTS, 1):
        try:
            r = perguntar(args.model, p, args.host, args.timeout)
            m = avaliar_resposta(r["texto"])
        except Exception as exc:  # noqa: BLE001
            print(f"  [{i}] ERRO: {exc}")
            r, m = {"texto": "", "latencia": 0.0}, {"erro": True}
        m.update({"prompt": p, "latencia": round(r["latencia"], 2), "texto": r["texto"]})
        resultados.append(m)
        print(
            f"  [{i}/{len(PROMPTS)}] {m['latencia']:>6.2f}s "
            f"chars={m.get('chars', 0):>5} codigo={m.get('tem_bloco_codigo')} "
            f"parse_ok={m.get('parse_ok')} preambulo={m.get('preambulo')}"
        )

    print("\n=== teste de tool-calling ===")
    try:
        tc = testar_tool_call(args.model, args.host, args.timeout)
        print(json.dumps(tc, ensure_ascii=False, indent=2))
    except Exception as exc:  # noqa: BLE001
        tc = {"tool_call": False, "erro": str(exc)}
        print("ERRO:", exc)

    ok = [r for r in resultados if not r.get("erro")]
    resumo = {
        "model": args.model,
        "n": len(ok),
        "latencia_media": round(statistics.mean([r["latencia"] for r in ok]), 2) if ok else 0,
        "chars_medio": round(statistics.mean([r["chars"] for r in ok]), 1) if ok else 0,
        "taxa_bloco_codigo": round(
            sum(1 for r in ok if r.get("tem_bloco_codigo")) / len(ok), 3
        )
        if ok
        else 0,
        "taxa_parse_ok": round(
            sum(1 for r in ok if r.get("parse_ok") is True) / len(ok), 3
        )
        if ok
        else 0,
        "taxa_preambulo": round(
            sum(1 for r in ok if r.get("preambulo")) / len(ok), 3
        )
        if ok
        else 0,
        "taxa_bloco_fechado": round(
            sum(1 for r in ok if r.get("fechou_bloco")) / len(ok), 3
        )
        if ok
        else 0,
        "tool_call": tc.get("tool_call"),
    }
    print("\n=== resumo ===")
    print(json.dumps(resumo, indent=2, ensure_ascii=False))

    if args.out:
        Path(args.out).write_text(
            json.dumps(
                {"resumo": resumo, "tool_call": tc, "detalhe": resultados},
                indent=2,
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        print(f"\nrelatorio: {args.out}")


if __name__ == "__main__":
    main()
