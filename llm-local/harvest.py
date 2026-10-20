"""
Destilacao black-box: coleta respostas do big-pickle (servido pelo OpenCode) e
salva no formato ShareGPT que o train.py consome.

Como funciona:
  O OpenCode roda localmente (servico em 127.0.0.1). A coleta usa a API local
  do proprio OpenCode -- nao a API do provedor -- entao nao e preciso ter
  OPENCODE_API_KEY nem header especial.

  Para cada prompt:
    1. POST /api/session            -> cria sessao com model=opencode/big-pickle
    2. POST /api/session/{id}/prompt -> envia o texto
    3. GET  /api/session/{id}/message?type=assistant -> aguarda o fim e extrai o texto

  O resultado vai para data/distill.jsonl:
    {"conversations":[{"from":"system",...},{"from":"human",...},{"from":"gpt",...}]}

  O arquivo funciona como checkpoint: reexecutar o script so coleta o que falta.

Uso:
    .venv\\Scripts\\python.exe harvest.py --limit 3        # teste
    .venv\\Scripts\\python.exe harvest.py                  # coleta tudo
    .venv\\Scripts\\python.exe harvest.py --workers 4 --model opencode/big-pickle
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

ROOT = Path(__file__).parent
DEFAULT_PROMPTS = ROOT / "data" / "prompts.jsonl"
DEFAULT_OUT = ROOT / "data" / "distill.jsonl"

SYSTEM_PADRAO = (
    "Voce e um assistente de programacao direto e tecnico. "
    "Responda sempre com codigo funcional e explicacoes curtas."
)


# --------------------------------------------------------------------------
# Infra: discovering do servico local + cliente HTTP
# --------------------------------------------------------------------------


def achar_opencode() -> str | None:
    """Localiza o executavel do opencode (funciona com .cmd no Windows)."""
    candidatos = [
        os.environ.get("OPENCODE_BIN"),
        shutil.which("opencode.cmd"),
        shutil.which("opencode.exe"),
        str(Path(os.environ.get("APPDATA", "")) / "npm" / "opencode.cmd"),
        shutil.which("opencode"),
    ]
    for c in candidatos:
        if c and Path(c).exists():
            return c
    return None


def descobrir_base_url(explicito: str | None) -> str:
    if explicito:
        return explicito.rstrip("/")
    exe = achar_opencode()
    if exe:
        try:
            out = subprocess.run(
                [exe, "service", "status"],
                capture_output=True,
                text=True,
                timeout=30,
            ).stdout
            for linha in out.splitlines():
                linha = linha.strip()
                if linha.startswith("http://") or linha.startswith("https://"):
                    return linha.rstrip("/")
        except (OSError, subprocess.SubprocessError):
            pass
    raise SystemExit(
        "Nao foi possivel descobrir a URL do servico. Use --base-url "
        "(saida de `opencode service status`)."
    )


def ler_senha() -> str:
    cfg = Path.home() / ".config" / "opencode" / "service.json"
    if cfg.exists():
        try:
            return json.loads(cfg.read_text(encoding="utf-8"))["password"]
        except (OSError, ValueError, KeyError):
            pass
    env = os.environ.get("OPENCODE_SERVER_PASSWORD")
    if env:
        return env
    raise SystemExit("Senha do servico nao encontrada em ~/.config/opencode/service.json")


class Cliente:
    """Cliente HTTP minimo para a API local do OpenCode (sem dependencias)."""

    def __init__(self, base_url: str, senha: str, timeout: int = 300) -> None:
        self.base = base_url.rstrip("/")
        token = base64.b64encode(f"opencode:{senha}".encode()).decode()
        self.headers = {
            "Authorization": f"Basic {token}",
            "Content-Type": "application/json",
        }
        self.timeout = timeout

    def _req(self, metodo: str, caminho: str, corpo: dict | None = None) -> dict:
        dados = json.dumps(corpo).encode() if corpo is not None else None
        req = urllib.request.Request(
            self.base + caminho, data=dados, headers=self.headers, method=metodo
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                bruto = resp.read().decode("utf-8", errors="replace")
        except urllib.error.HTTPError as exc:
            detalhe = exc.read().decode("utf-8", errors="replace")[:400]
            raise RuntimeError(
                f"{metodo} {caminho} -> HTTP {exc.code}: {detalhe or '(corpo vazio)'}"
            ) from exc
        return json.loads(bruto) if bruto.strip() else {}

    def criar_sessao(self, titulo: str, provider: str, modelo: str, agent: str, diretorio: str) -> str:
        corpo = {
            "title": titulo,
            "model": {"providerID": provider, "id": modelo},
            "agent": agent,
            "location": {"directory": diretorio},
        }
        return self._req("POST", "/api/session", corpo)["data"]["id"]

    def enviar(self, sessao: str, texto: str) -> None:
        self._req("POST", f"/api/session/{sessao}/prompt", {"text": texto})

    def mensagens(self, sessao: str) -> list[dict]:
        return self._req("GET", f"/api/session/{sessao}/message?type=assistant&order=asc").get("data", [])

    def apagar_sessao(self, sessao: str) -> None:
        try:
            self._req("DELETE", f"/api/session/{sessao}")
        except Exception:
            pass


# --------------------------------------------------------------------------
# Extracao e limpeza
# --------------------------------------------------------------------------

RE_AMBiente = re.compile(r"<environment_details>.*?</environment_details>", re.S)
RE_Think = re.compile(r"<think>.*?</think>", re.S)
# Preambulo do agente ("Vou explorar o repositorio...") nao e resposta utilizavel.
RE_PREAMBLE = re.compile(
    r"^\s*(vou|let me|i'?ll|i will|primeiro|ok,?\s*vou)\b.{0,200}?"
    r"(explor|localiz|procur|buscar o arquivo|encontrar o arquivo|"
    r"look for|find the file|locate)",
    re.I,
)


def extrair_texto(msg: dict) -> str:
    partes = []
    for c in msg.get("content", []):
        if c.get("type") == "text" and c.get("text"):
            partes.append(c["text"])
    texto = "\n".join(partes)
    texto = RE_Think.sub("", texto)
    texto = RE_AMBiente.sub("", texto)
    return texto.strip()


def resposta_valida(texto: str, minimo: int) -> bool:
    if len(texto) < minimo:
        return False
    if "<environment_details>" in texto or "tool_use" in texto:
        return False
    if RE_PREAMBLE.match(texto):
        return False
    return True


def chave_prompt(p: str) -> str:
    """Hash estavel entre execucoes (hash() builtin muda por processo)."""
    return hashlib.sha1(p.strip().lower().encode("utf-8")).hexdigest()


# --------------------------------------------------------------------------


def coletar(
    cliente: Cliente,
    prompts: list[dict],
    args: argparse.Namespace,
    indice: int,
) -> dict | None:
    prompt = prompts["prompt"]
    sessao = None
    etapa = "criar_sessao"
    for tentativa in range(args.retries):
        try:
            sessao = cliente.criar_sessao(
                titulo=f"harvest-{indice}",
                provider=args.provider,
                modelo=args.model,
                agent=args.agent,
                diretorio=args.workdir,
            )
            etapa = "enviar"
            cliente.enviar(sessao, prompt)

            etapa = "aguardar"
            deadline = time.time() + args.timeout
            while time.time() < deadline:
                msgs = cliente.mensagens(sessao)
                if msgs:
                    ultima = msgs[-1]
                    finish = ultima.get("finish")
                    # so interessa a resposta final (finish=stop). Turnos com
                    # tool-calls sao preambulos do agente: continua aguardando.
                    if finish == "stop":
                        texto = extrair_texto(ultima)
                        if not resposta_valida(texto, args.min_chars):
                            return None
                        return {
                            "conversations": [
                                {"from": "system", "value": args.system},
                                {"from": "human", "value": prompt},
                                {"from": "gpt", "value": texto},
                            ],
                            "meta": {
                                "source": prompts.get("source", "synthetic"),
                                "tags": prompts.get("tags", []),
                                "model": f"{args.provider}/{args.model}",
                                "turnos": len(msgs),
                            },
                        }
                    if finish == "error":
                        raise RuntimeError(
                            f"erro do modelo: {ultima.get('error', {}).get('message', '')[:200]}"
                        )
                time.sleep(1.5)
            raise TimeoutError("tempo esgotado aguardando resposta")
        except Exception as exc:  # noqa: BLE001
            if tentativa == args.retries - 1:
                print(
                    f"  [falhou: {etapa}] {prompt[:55]!r}: {exc}",
                    file=sys.stderr,
                )
                return None
            time.sleep(2 * (tentativa + 1))
        finally:
            if sessao:
                cliente.apagar_sessao(sessao)
                sessao = None
    return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prompts", type=str, default=str(DEFAULT_PROMPTS))
    ap.add_argument("--out", type=str, default=str(DEFAULT_OUT))
    ap.add_argument("--provider", type=str, default="opencode")
    ap.add_argument("--model", type=str, default="big-pickle")
    ap.add_argument("--agent", type=str, default="plan", help="agente do opencode (plan = somente leitura)")
    ap.add_argument("--workdir", type=str, default=None, help="diretorio da sessao (scratch)")
    ap.add_argument("--workers", type=int, default=3)
    ap.add_argument("--limit", type=int, default=0, help="0 = todos")
    ap.add_argument("--retries", type=int, default=3)
    ap.add_argument("--timeout", type=int, default=240, help="segundos por prompt")
    ap.add_argument("--min-chars", type=int, default=150)
    ap.add_argument("--system", type=str, default=SYSTEM_PADRAO)
    ap.add_argument("--base-url", type=str, default=None)
    args = ap.parse_args()

    if not Path(args.prompts).exists():
        raise SystemExit(
            f"Prompts nao encontrados: {args.prompts}\nRode: python make_prompts.py"
        )

    prompts = [
        json.loads(l)
        for l in Path(args.prompts).read_text(encoding="utf-8").splitlines()
        if l.strip()
    ]

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # checkpoint: nao recoleta prompts ja presentes no arquivo de saida
    ja_feitos: set[str] = set()
    if out_path.exists():
        for linha in out_path.read_text(encoding="utf-8").splitlines():
            if not linha.strip():
                continue
            try:
                reg = json.loads(linha)
                conv = reg["conversations"]
                humans = [c["value"] for c in conv if c.get("from") == "human"]
                if humans:
                    ja_feitos.add(chave_prompt(humans[0]))
            except (ValueError, KeyError):
                continue
    pendentes = [p for p in prompts if chave_prompt(p["prompt"]) not in ja_feitos]
    if args.limit:
        pendentes = pendentes[: args.limit]

    base_url = descobrir_base_url(args.base_url)
    senha = ler_senha()
    cliente = Cliente(base_url, senha, timeout=args.timeout + 30)

    workdir = args.workdir or str(Path(os.environ.get("TEMP", "/tmp")) / "opencode-distill")
    Path(workdir).mkdir(parents=True, exist_ok=True)
    args.workdir = workdir  # a coleta usa args.workdir em criar_sessao()

    print(f"servico: {base_url}")
    print(f"modelo:  {args.provider}/{args.model} (agent={args.agent})")
    print(f"prompts: {len(prompts)} | ja coletados: {len(ja_feitos)} | a coletar: {len(pendentes)}")
    print(f"saida:   {out_path}\n")

    if not pendentes:
        print("Nada a fazer.")
        return

    inicio = time.time()
    coletados = 0
    ignorados = 0
    with out_path.open("a", encoding="utf-8") as saida:
        with ThreadPoolExecutor(max_workers=args.workers) as pool:
            futures = {
                pool.submit(coletar, cliente, p, args, i): p
                for i, p in enumerate(pendentes)
            }
            for fut in as_completed(futures):
                reg = fut.result()
                if reg is None:
                    ignorados += 1
                else:
                    saida.write(json.dumps(reg, ensure_ascii=False) + "\n")
                    saida.flush()
                    coletados += 1
                elapsed = time.time() - inicio
                print(
                    f"  [{coletados + ignorados}/{len(pendentes)}] ok={coletados} "
                    f"descartado={ignorados} {elapsed:.0f}s",
                    file=sys.stderr,
                    flush=True,
                )

    print(f"\nConcluido: {coletados} respostas em {out_path} ({time.time() - inicio:.0f}s)")
    if coletados:
        print(" proximo passo: .venv\\Scripts\\python.exe train.py --data data\\distill.jsonl")


if __name__ == "__main__":
    main()
