"""
Fine-tuning QLoRA do Qwen2.5-Coder-1.5B-Instruct com dataset ShareGPT em JSONL.

Uso:
    .venv\\Scripts\\python.exe train.py
    .venv\\Scripts\\python.exe train.py --epochs 5 --seq 2048

Saida: ./out/lora  (adapter LoRA, alguns MB)

O que acontece por baixo:
  1. O modelo base e carregado em 4-bit (NF4) -> ~1 GB de VRAM em vez de ~6 GB.
  2. Sao adicionados adaptadores LoRA (matrizes pequenas que aprendem o "delta").
  3. So os adaptadores sao treinados (~1% dos parametros) -> cabe em 6 GB.
  4. No final, o adapter e salvo; depois ele e fundido ao modelo (export.py).
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import torch
from datasets import load_dataset
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from transformers import (
    AutoModelForCausalLM,
    AutoTokenizer,
    BitsAndBytesConfig,
)
from trl import SFTConfig, SFTTrainer

ROOT = Path(__file__).parent
BASE_MODEL = "Qwen/Qwen2.5-Coder-1.5B-Instruct"
OUT_DIR = ROOT / "out" / "lora"


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser()
    p.add_argument("--data", default=str(ROOT / "data" / "demo.jsonl"))
    p.add_argument("--epochs", type=float, default=3)
    p.add_argument("--seq", type=int, default=1024, help="comprimento maximo da sequencia")
    p.add_argument("--lr", type=float, default=2e-4)
    p.add_argument("--batch", type=int, default=1)
    p.add_argument("--grad-accum", type=int, default=8)
    p.add_argument("--lora-r", type=int, default=16)
    p.add_argument("--out", default=str(OUT_DIR))
    p.add_argument(
        "--drop-long",
        action="store_true",
        help="descarta exemplos maiores que --seq em vez de truncar",
    )
    return p.parse_args()


def formatar(registro: dict, tokenizer) -> dict:
    """Converte ShareGPT em texto usando o chat template oficial do Qwen."""
    mensagens = []
    papel = {"system": "system", "human": "user", "gpt": "assistant"}
    for turno in registro["conversations"]:
        mensagens.append(
            {"role": papel[turno["from"]], "content": turno["value"]}
        )
    texto = tokenizer.apply_chat_template(
        mensagens, tokenize=False, add_generation_prompt=False
    )
    return {"text": texto}


def main() -> None:
    args = parse_args()

    if not torch.cuda.is_available():
        raise SystemExit(
            "CUDA nao disponivel. Reinstale o torch com o index CUDA correto."
        )
    vram = torch.cuda.get_device_properties(0).total_memory / 1024**3
    print(f"GPU: {torch.cuda.get_device_name(0)} ({vram:.1f} GB)")

    data_path = Path(args.data)
    if not data_path.exists():
        raise SystemExit(
            f"Dataset nao encontrado: {data_path}\nRode: python make_dataset.py"
        )

    print(f"Carregando tokenizer de {BASE_MODEL} ...")
    tokenizer = AutoTokenizer.from_pretrained(BASE_MODEL, trust_remote_code=True)

    # 1) Carrega o modelo em 4-bit para economizar VRAM
    quant_config = BitsAndBytesConfig(
        load_in_4bit=True,
        bnb_4bit_quant_type="nf4",
        bnb_4bit_compute_dtype=torch.bfloat16,
        bnb_4bit_use_double_quant=True,
    )
    print("Carregando modelo base em 4-bit ...")
    modelo = AutoModelForCausalLM.from_pretrained(
        BASE_MODEL,
        quantization_config=quant_config,
        device_map={"": 0},
        torch_dtype=torch.bfloat16,
        attn_implementation="sdpa",
    )
    modelo.config.use_cache = False
    modelo = prepare_model_for_kbit_training(
        modelo, use_gradient_checkpointing=True
    )

    # 2) Adaptadores LoRA
    lora = LoraConfig(
        r=args.lora_r,
        lora_alpha=args.lora_r * 2,
        lora_dropout=0.05,
        bias="none",
        task_type="CAUSAL_LM",
        target_modules=[
            "q_proj", "k_proj", "v_proj", "o_proj",
            "gate_proj", "up_proj", "down_proj",
        ],
    )
    modelo = get_peft_model(modelo, lora)
    treinaveis = sum(p.numel() for p in modelo.parameters() if p.requires_grad)
    total = sum(p.numel() for p in modelo.parameters())
    print(f"Parametros treinaveis: {treinaveis:,} / {total:,} "
          f"({100 * treinaveis / total:.2f}%)")

    # 3) Dataset
    ds = load_dataset("json", data_files=str(data_path), split="train")
    ds = ds.map(
        lambda r: formatar(r, tokenizer),
        remove_columns=ds.column_names,
        desc="Formatando com chat template",
    )

    if args.drop_long:
        # Truncar no meio do codigo ensina o modelo a parar no meio. Melhor
        # descartar o exemplo inteiro.
        def cabe(r):
            return len(tokenizer(r["text"], add_special_tokens=False)["input_ids"]) <= args.seq

        antes = len(ds)
        ds = ds.filter(cabe, desc="Removendo exemplos acima de --seq")
        print(f"Exemplos acima de {args.seq} tokens removidos: {antes - len(ds)}")

    print(f"{len(ds)} exemplos carregados de {data_path}")
    print("--- exemplo ---")
    print(ds[0]["text"][:600])
    print("---------------")

    cfg = SFTConfig(
        output_dir=str(Path(args.out) / "checkpoints"),
        num_train_epochs=args.epochs,
        per_device_train_batch_size=args.batch,
        gradient_accumulation_steps=args.grad_accum,
        learning_rate=args.lr,
        lr_scheduler_type="cosine",
        warmup_ratio=0.03,
        logging_steps=1,
        save_strategy="epoch",
        save_total_limit=2,
        bf16=True,
        optim="paged_adamw_8bit",
        gradient_checkpointing=True,
        gradient_checkpointing_kwargs={"use_reentrant": False},
        max_length=args.seq,
        packing=False,
        report_to="none",
        dataset_text_field="text",
    )

    trainer = SFTTrainer(
        model=modelo,
        args=cfg,
        train_dataset=ds,
        processing_class=tokenizer,
    )

    print("Iniciando treino ...")
    trainer.train()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    trainer.save_model(str(out))
    tokenizer.save_pretrained(str(out))
    print(f"\nAdapter LoRA salvo em: {out}")
    print("Proximo passo: python export.py  (funde o adapter e gera o GGUF)")


if __name__ == "__main__":
    main()
