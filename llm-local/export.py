"""
Funde o adapter LoRA no modelo base e salva o modelo final em fp16 (safetensors).

Uso:
    .venv\\Scripts\\python.exe export.py

Saida: ./out/merged

Depois use build_ollama.ps1 para converter/registrar no Ollama.
"""

from pathlib import Path

import torch
from peft import PeftModel
from transformers import AutoModelForCausalLM, AutoTokenizer

ROOT = Path(__file__).parent
BASE_MODEL = "Qwen/Qwen2.5-Coder-1.5B-Instruct"
ADAPTER = ROOT / "out" / "lora"
MERGED = ROOT / "out" / "merged"


def main() -> None:
    if not ADAPTER.exists():
        raise SystemExit(f"Adapter nao encontrado em {ADAPTER}. Rode train.py antes.")

    print("Carregando tokenizer ...")
    tok = AutoTokenizer.from_pretrained(BASE_MODEL, trust_remote_code=True)

    print("Carregando modelo base em fp16 (CPU, sem quantizacao) ...")
    modelo = AutoModelForCausalLM.from_pretrained(
        BASE_MODEL,
        torch_dtype=torch.float16,
        device_map="cpu",
        attn_implementation="sdpa",
    )

    print("Aplicando adapter ...")
    modelo = PeftModel.from_pretrained(modelo, str(ADAPTER))

    print("Fundindo pesos (merge_and_unload) ...")
    modelo = modelo.merge_and_unload()

    MERGED.mkdir(parents=True, exist_ok=True)
    print(f"Salvando em {MERGED} ...")
    modelo.save_pretrained(str(MERGED), safe_serialization=True)
    tok.save_pretrained(str(MERGED))

    print("Pronto.")
    print("Proximo passo: .\\build_ollama.ps1")


if __name__ == "__main__":
    main()
