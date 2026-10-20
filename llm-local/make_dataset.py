"""
Gera um dataset de demonstracao no formato ShareGPT (JSONL) para fine-tuning.

Cada linha: {"conversations": [{"from": "human", "value": ...}, {"from": "gpt", "value": ...}]}

Este dataset e SINTETICO e serve apenas para validar o pipeline.
Depois, troque por dados reais extraidos dos seus projetos (o script
extract_repo.py sera criado na proxima etapa).
"""

import json
import random
from pathlib import Path

OUT = Path(__file__).parent / "data" / "demo.jsonl"

SYSTEM = (
    "Voce e um assistente de programacao direto e tecnico. "
    "Responda sempre com codigo funcional e explicacoes curtas."
)

# (instrucao, resposta)
EXAMPLES = [
    (
        "Escreva uma funcao Python que leia um CSV e retorne uma lista de dicionarios.",
        """Use o modulo csv da biblioteca padrao.

```python
import csv

def read_csv(path: str) -> list[dict]:
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))
```

`DictReader` usa o cabecalho como chaves. Para arquivos grandes, prefira iterar linha a linha em vez de materializar a lista."""
    ),
    (
        "Como faco um endpoint FastAPI que recebe JSON e valida com Pydantic?",
        """```python
from fastapi import FastAPI
from pydantic import BaseModel, Field

app = FastAPI()

class Item(BaseModel):
    nome: str = Field(min_length=1)
    preco: float = Field(gt=0)

@app.post("/itens")
async def criar_item(item: Item) -> dict:
    return {"recebido": item.nome, "total": item.preco}
```

O Pydantic retorna 422 automaticamente quando o payload nao bate com o schema."""
    ),
    (
        "Explique a diferenca entre list.append e list.extend em Python.",
        """- `append(x)` adiciona **um** elemento (mesmo que seja uma lista) ao final.
- `extend(iteravel)` adiciona **cada item** do iteravel.

```python
a = [1, 2]
a.append([3, 4])   # [1, 2, [3, 4]]
b = [1, 2]
b.extend([3, 4])   # [1, 2, 3, 4]
```"""
    ),
    (
        "Tenho um bug: meu loop em JavaScript imprime sempre o ultimo valor. Por que?",
        """Provavelmente e o classico problema do `var` em callbacks:

```javascript
for (var i = 0; i < 3; i++) setTimeout(() => console.log(i)); // 3 3 3
```

`var` tem escopo de funcao, entao todos os callbacks veem o mesmo `i` final.
Troque por `let`, que cria um binding por iteracao:

```javascript
for (let i = 0; i < 3; i++) setTimeout(() => console.log(i)); // 0 1 2
```"""
    ),
    (
        "Escreva um teste pytest para uma funcao soma(a, b).",
        """```python
from app.calc import soma

def test_soma_positivos():
    assert soma(2, 3) == 5

def test_soma_negativos():
    assert soma(-2, -3) == -5

def test_soma_zero():
    assert soma(0, 0) == 0
```
"""
    ),
    (
        "Como remover itens duplicados de uma lista mantendo a ordem?",
        """Em Python 3.7+ use um dict, que preserva a ordem de insercao:

```python
def unicos(seq):
    return list(dict.fromkeys(seq))

unicos([3, 1, 3, 2, 1])  # [3, 1, 2]
```

Complexidade O(n) e funciona com qualquer elemento hashable."""
    ),
    (
        "Qual a diferenca entre GET e POST em HTTP?",
        """- **GET**: busca dados, parametros na URL, deve ser idempotente e cacheavel. Sem corpo.
- **POST**: envia dados no corpo, nao idempotente, usado para criar recursos ou acoes com efeito colateral.

Resumo: GET le, POST escreve."""
    ),
    (
        "Como fazer paginacao em SQL com PostgreSQL?",
        """```sql
-- Offset (simples, mas degrada em paginas grandes)
SELECT * FROM pedidos ORDER BY id LIMIT 20 OFFSET 40;

-- Keyset (melhor para tabelas grandes)
SELECT * FROM pedidos WHERE id > 40 ORDER BY id LIMIT 20;
```

Keyset/paginacao por cursor usa indice e mantem performance constante; offset precisa varrer e descartar linhas."""
    ),
    (
        "Escreva um Dockerfile para uma API Flask.",
        """```dockerfile
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
EXPOSE 5000
CMD ["gunicorn", "-b", "0.0.0.0:5000", "app:app"]
```

Use gunicorn em producao; o servidor de desenvolvimento do Flask nao e seguro."""
    ),
    (
        "Como ler variaveis de ambiente em Python de forma segura?",
        """```python
import os

DB_URL = os.environ["DATABASE_URL"]          # falha rapido se faltar
DEBUG = os.getenv("DEBUG", "false").lower() == "true"
```

Faca o parse do tipo explicitamente: tudo em `os.environ` e string. Nunca commite `.env` no git."""
    ),
    (
        "Explique o que e uma closure em JavaScript.",
        """Closure e uma funcao que lembra do escopo onde foi criada, mesmo depois que esse escopo terminou.

```javascript
function contador() {
  let n = 0;
  return () => ++n;   // acessa n do escopo externo
}

const c = contador();
c(); // 1
c(); // 2
```

A variavel `n` fica viva enquanto a funcao retornada existir."""
    ),
    (
        "Como tratar excecoes em Python sem engolir o erro?",
        """Capture apenas o que sabe tratar e sempre registre o contexto:

```python
import logging

try:
    dados = carregar_json(path)
except FileNotFoundError:
    logging.warning("arquivo ausente: %s", path)
    dados = {}
except json.JSONDecodeError as exc:
    raise ValueError(f"JSON invalido em {path}") from exc
```

Evite `except Exception: pass` — ele esconde bugs. Use `raise ... from exc` para preservar a causa."""
    ),
    (
        "Qual a complexidade de buscar em um dicionario Python?",
        """O(1) em media. Dicionarios usam tabela hash, entao a busca por chave e constante amortizada.

Pior caso teorico e O(n) por colisoes, raro na pratica com a implementacao atual do CPython."""
    ),
    (
        "Como funciona o async/await em Python?",
        """`async def` cria uma corrotina; `await` pausa ela e devolve o controle ao event loop ate o resultado ficar pronto.

```python
import asyncio

async def buscar(url):
    await asyncio.sleep(1)   # simulate I/O
    return url.upper()

async def main():
    resultados = await asyncio.gather(*(buscar(u) for u in ["a", "b", "c"]))
    print(resultados)

asyncio.run(main())
```

Use `asyncio.gather` para rodar em paralelo. Nao use `time.sleep` dentro de corrotina — ele bloqueia o loop."""
    ),
    (
        "Como escrever um Makefile simples para um projeto Python?",
        """```makefile
.PHONY: install test lint

install:
\tuv sync

test:
\tuv run pytest -q

lint:
\tuv run ruff check .
```

Atencao: as receitas precisam de TAB, nao espacos. `.PHONY` evita conflito com arquivos de mesmo nome."""
    ),
    (
        "Tenho uma API lenta. Como investigar?",
        """Ordem pratica:

1. Meça antes de otimizar: adicione logging de tempo por etapa ou use um profiler (`py-spy`, `cProfile`).
2. Verifique o banco: queries N+1 e falta de indice sao as causas mais comuns.
3. Cacheie leituras caras (Redis/memoria) se os dados mudam pouco.
4. So entao paralelize I/O com async ou threads.

Nunca otimize sem medir — o gargalo quase nunca e onde parece."""
    ),
    (
        "Como criar uma branch e fazer merge com git?",
        """```bash
git switch -c feature/login
# ... commits ...
git switch main
git pull
git merge feature/login
```

Use `git switch` (moderno) em vez de `git checkout`. Para historico linear, prefira `git rebase` antes do merge."""
    ),
    (
        "Como validar e-mail com regex em JS?",
        """```javascript
const out = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
out.test("a@b.com"); // true
```

Regex cobre o caso comum, nao todas as regras do RFC. Para garantia real, envie um e-mail de confirmacao."""
    ),
    (
        "O que e uma race condition e como evitar em Python?",
        """Acontece quando duas threads acessam um recurso compartilhado e o resultado depende da ordem de execucao.

```python
import threading
lock = threading.Lock()
contador = 0

def incrementar():
    global contador
    with lock:
        contador += 1
```

Use lock, fila (`queue.Queue`) ou evite estado compartilhado. Em asyncio, o risco existe entre pontos de `await`."""
    ),
    (
        "Como fazer upload de arquivo com FastAPI?",
        """```python
from fastapi import FastAPI, UploadFile

app = FastAPI()

@app.post("/upload")
async def upload(file: UploadFile) -> dict:
    conteudo = await file.read()
    return {"nome": file.filename, "bytes": len(conteudo)}
```

Para arquivos grandes, leia em chunks (`await file.read(1024*1024)`) e grave em disco em vez de carregar tudo na memoria."""
    ),
    (
        "Explique indexacao em banco de dados de forma simples.",
        """Indice e como o indice de um livro: permite achar linhas sem varrer a tabela inteira.

- Acelera `WHERE`, `JOIN` e `ORDER BY` nas colunas indexadas.
- Custa espaco e deixa INSERT/UPDATE mais lentos (o indice precisa ser atualizado).
- Indice composto ajuda quando as consultas filtram pelas colunas na mesma ordem.

Nao indexe tudo — indexe o que suas queries realmente usam."""
    ),
    (
        "Como converter uma lista de strings em numeros em Python?",
        """```python
nums = [int(x) for x in ["1", "2", "3"]]

# tolerante a falhas
nums = [int(x) for x in entradas if x.strip().lstrip("-").isdigit()]
```

Use list comprehension; e mais rapido e legivel que `map` com lambda na maioria dos casos."""
    ),
    (
        "Escreva um componente React que busca dados de uma API.",
        """```jsx
import { useEffect, useState } from "react";

export function Lista() {
  const [itens, setItens] = useState([]);
  const [erro, setErro] = useState(null);

  useEffect(() => {
    const ctrl = new AbortController();
    fetch("/api/itens", { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then(setItens)
      .catch((e) => e.name !== "AbortError" && setErro(String(e)));
    return () => ctrl.abort();
  }, []);

  if (erro) return <p>Erro: {erro}</p>;
  return <ul>{itens.map((i) => <li key={i.id}>{i.nome}</li>)}</ul>;
}
```

Sempre cancele o fetch no cleanup para evitar atualizar componente desmontado."""
    ),
    (
        "Como fazer um loop que espera uma condicao em Python?",
        """```python
import time

def esperar(cond, timeout=10.0, intervalo=0.2):
    fim = time.monotonic() + timeout
    while time.monotonic() < fim:
        if cond():
            return True
        time.sleep(intervalo)
    raise TimeoutError("condicao nao satisfeita")
```

Use `time.monotonic` (nao `time.time`) para medir intervalos: ele nao sofre com ajustes do relogio."""
    ),
    (
        "O que e o GIL em Python?",
        """O Global Interpreter Lock permite que so uma thread execute bytecode Python por vez.

- Threads nao aceleram codigo CPU-bound.
- Threads ajudam em I/O-bound (a liberacao ocorre nas chamadas de sistema).
- Para CPU-bound use `multiprocessing` ou libs que liberam o GIL (NumPy, C extensions)."""
    ),
    (
        "Como escrever logs estruturados em JSON em Python?",
        """```python
import json, logging, sys

class JsonFormatter(logging.Formatter):
    def format(self, record):
        return json.dumps({
            "nivel": record.levelname,
            "msg": record.getMessage(),
            "logger": record.name,
        })

h = logging.StreamHandler(sys.stdout)
h.setFormatter(JsonFormatter())
logging.basicConfig(level=logging.INFO, handlers=[h])

logging.info("iniciado")
```

Logs em JSON sao ideais para agregadores (Loki, Elastic, CloudWatch)."""
    ),
    (
        "Como deletar uma coluna no pandas?",
        """```python
import pandas as pd

df = df.drop(columns=["coluna_ruim"])

# varias de uma vez
df = df.drop(columns=["a", "b"], errors="ignore")
```

Prefira `drop(columns=...)` a `del df["x"]`, que nao funciona com nomes compostos."""
    ),
    (
        "Explique o padrao Repository.",
        """Repository isola o acesso a dados atras de uma interface, separando regras de negocio do banco.

```python
class RepoUsuarios(Protocol):
    def buscar(self, id: int) -> Usuario | None: ...

class RepoSQL(RepoUsuarios):
    def __init__(self, sessao): self._s = sessao
    def buscar(self, id):
        row = self._s.get(UserRow, id)
        return row and Usuario(row.id, row.nome)
```

Ganho: testar a logica com um repo em memoria e trocar de banco sem tocar no dominio."""
    ),
    (
        "Como usar f-strings com formatacao de numero?",
        """```python
valor = 1234.5678
print(f"{valor:.2f}")      # 1234.57
print(f"{valor:,.2f}")     # 1,234.57
print(f"{valor:>12.2f}")   # alinhado a direita
print(f"{0.25:.0%}")       # 25%
```

Depois dos dois-pontos vem a mini-linguagem de formatacao (padrao, largura, precisao, tipo)."""
    ),
    (
        "Como evitar SQL injection em Python?",
        """Use parametros, nunca concatenacao:

```python
cur.execute("SELECT * FROM users WHERE email = %s", (email,))
```

Para SQL dinamico (colunas, ORDER BY), valide contra uma allowlist:

```python
col = coluna if coluna in {"nome", "criado_em"} else "id"
cur.execute(f"SELECT * FROM users ORDER BY {col}")
```

Parametros cobrem valores; identificadores exigem allowlist."""
    ),
    (
        "Escreva um script que renomeia todos os .jpeg de uma pasta para .jpg.",
        """```python
from pathlib import Path

for p in Path("fotos").glob("*.jpeg"):
    alvo = p.with_suffix(".jpg")
    if not alvo.exists():
        p.rename(alvo)
```

`with_suffix` troca a extensao. Cheque `alvo.exists()` antes para nao sobrescrever arquivos."""
    ),
    (
        "O que faz o operador ?? em JavaScript?",
        """Nullish coalescing: retorna o lado direito apenas se o esquerdo for `null` ou `undefined`.

```javascript
0 ?? "x";        // 0
"" ?? "x";       // ""
null ?? "x";     // "x"
```

Diferente de `||`, que tambem troca por valores falsy como `0` e `""`."""
    ),
    (
        "Como implementar retry com backoff exponencial em Python?",
        """```python
import time, random

def com_retry(fn, tentativas=5, base=0.5):
    for i in range(tentativas):
        try:
            return fn()
        except Exception:
            if i == tentativas - 1:
                raise
            espera = base * 2**i + random.uniform(0, 0.1)
            time.sleep(min(espera, 30))
```

O jitter aleatorio evita que varios clientes retentem no mesmo instante (thundering herd)."""
    ),
    (
        "Qual a diferenca entre processes e threads?",
        """- **Processo**: memoria isolada, custo alto de criar, comunica via IPC. Bom para CPU-bound.
- **Thread**: memoria compartilhada, custo baixo, risco de race condition. Bom para I/O-bound.

Em Python, por causa do GIL, threads nao paralelizam CPU; processos sim."""
    ),
    (
        "Como fazer um select que traga o ultimo registro por grupo em SQL?",
        """```sql
SELECT DISTINCT ON (user_id) *
FROM eventos
ORDER BY user_id, criado_em DESC;
```

(Este e PostgreSQL; equivale ao `ROW_NUMBER() OVER (PARTITION BY ...)` em outros bancos.)

O `DISTINCT ON` depende do `ORDER BY` iniciar pelas mesmas colunas do agrupamento."""
    ),
    (
        "Como configurar CORS no FastAPI?",
        """```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://meusite.com"],
    allow_methods=["*"],
    allow_headers=["*"],
)
```

Evite `allow_origins=["*"]` com `allow_credentials=True`: os navegadores bloqueiam essa combinacao."""
    ),
    (
        "Explique como funciona o garbage collector do Python.",
        """Python usa contagem de referencias como mecanismo principal: quando a contagem de um objeto chega a zero, ele e liberado.

Ciclos de referencia nao sao cobertos pela contagem, entao um coletor ciclico periodico os detecta e libera (`gc.collect()`).

Voce pode desligar (`gc.disable()`) em scripts curtos, mas cuidado com vazamentos em processos longos."""
    ),
    (
        "Como fazer cache de uma funcao cara em Python?",
        """```python
from functools import lru_cache

@lru_cache(maxsize=128)
def fib(n: int) -> int:
    return n if n < 2 else fib(n - 1) + fib(n - 2)
```

Argumentos precisam ser hashable. Para expiracao por tempo, use `cachetools.TTLCache`."""
    ),
    (
        "Como lidar com arquivos grandes em Python sem estourar a memoria?",
        """Leia em streaming:

```python
def linhas(path, chunk=1 << 20):
    with open(path, encoding="utf-8") as f:
        while bloco := f.read(chunk):
            yield bloco

for pedaco in linhas("grande.log"):
    processar(pedaco)
```

Para CSV use `csv.reader` iterando o arquivo; para JSON, `ijson` em vez de `json.load`."""
    ),
    (
        "Como estruturar um projeto Python moderno?",
        """```
projeto/
  pyproject.toml
  src/projeto/__init__.py
  tests/
  README.md
```

- `pyproject.toml` centraliza dependencias e config de ferramentas.
- Layout `src/` evita importar o pacote por acidente.
- Use `uv` ou `poetry` para lockfile reproduzivel."""
    ),
    (
        "O que e idempotencia e por que importa em APIs?",
        """Uma operacao idempotente pode ser repetida varias vezes com o mesmo efeito final.

`GET`, `PUT` e `DELETE` devem ser idempotentes; `POST` geralmente nao e.

Importa porque retries de rede sao comuns: sem idempotencia, um retry pode criar pedido duplicado. Solucao comum: chave de idempotencia enviada pelo cliente."""
    ),
    (
        "Como converter um dicionario em query string em Python?",
        """```python
from urllib.parse import urlencode

qs = urlencode({"q": "python", "page": 2})  # q=python&page=2
print(f"https://api.exemplo.com/busca?{qs}")
```

`urlencode` faz o escape correto de espacos e caracteres especiais."""
    ),
    (
        "Explique a diferenca entre == e === em JavaScript.",
        """`==` faz coercao de tipos antes de comparar; `===` compara tipo e valor sem converter.

```javascript
"1" == 1;   // true
"1" === 1;  // false
null == undefined;  // true
null === undefined; // false
```

Regra pratica: use sempre `===`."""
    ),
    (
        "Como testar se um texto e um palindromo em Python?",
        """```python
def palindromo(s: str) -> bool:
    limpo = "".join(c.lower() for c in s if c.isalnum())
    return limpo == limpo[::-1]
```

`[::-1]` inverte a string em O(n)."""
    ),
    (
        "Como usar transacoes em SQLAlchemy?",
        """```python
from sqlalchemy.orm import Session

with Session(engine) as sessao:
    with sessao.begin():          # commit no fim, rollback em excecao
        sessao.add(Pedido(...))
        sessao.add(Item(...))
```

Se ja existe transacao, use `sessao.begin_nested()` (savepoint). Nunca deixe commit espalhado pelo codigo."""
    ),
    (
        "Como fazer um menu simples no terminal em Python?",
        """```python
opcoes = {"1": "Listar", "2": "Criar", "0": "Sair"}

while True:
    for k, v in opcoes.items():
        print(f"{k}) {v}")
    escolha = input("> ").strip()
    if escolha == "0":
        break
    acao = opcoes.get(escolha)
    if not acao:
        print("Opcao invalida")
        continue
    executar(acao)
```

`input` sempre devolve string; faca `strip()` e valide antes de usar."""
    ),
    (
        "Qual a diferenca entre deep copy e shallow copy em Python?",
        """```python
import copy

a = [[1, 2], [3, 4]]
b = copy.copy(a)      # sons compartilhados
c = copy.deepcopy(a)  # tudo copiado

b[0][0] = 99
print(a[0][0])  # 99  (b e shallow)
print(c[0][0])  # 1   (c e deep)
```

Shallow copia so a estrutura externa; deep copia recursivamente (e pode ser lento em objetos grandes)."""
    ),
    (
        "Como implementar uma fila de tarefas simples sem Celery?",
        """Use `queue.Queue` com threads consumidoras para uma fila em processo:

```python
import queue, threading

fila = queue.Queue()

def worker():
    while True:
        tarefa = fila.get()
        try:
            processar(tarefa)
        finally:
            fila.task_done()

for _ in range(4):
    threading.Thread(target=worker, daemon=True).start()

fila.put("job-1")
fila.join()
```

Para durabilidade, distribuicao ou retry, use Celery/RQ/Dramatiq."""
    ),
    (
        "Como usar o logging com rotacao de arquivos?",
        """```python
import logging
from logging.handlers import RotatingFileHandler

h = RotatingFileHandler("app.log", maxBytes=5_000_000, backupCount=3)
logging.basicConfig(level=logging.INFO, handlers=[h])
```

`maxBytes` + `backupCount` limitam o espaco em disco. Para rotacao diaria use `TimedRotatingFileHandler`."""
    ),
    (
        "Como tipar uma funcao que aceita qualquer numero de argumentos?",
        """```python
def soma(*args: float) -> float:
    return sum(args)

def config(**kwargs: str) -> dict:
    return kwargs
```

Types: `*args` vira `tuple[float, ...]`, `**kwargs` vira `dict[str, str]` na assinatura."""
    ),
    (
        "O que e um deadlock e como evitar?",
        """Duas ou mais threads esperam uma pela outra, travando para sempre.

Exemplo classico: thread A pega lock1 e espera lock2; thread B pega lock2 e espera lock1.

Como evitar:
- Adquira locks sempre na mesma ordem global.
- Use timeouts (`lock.acquire(timeout=1)`).
- Reduza a regiao critica e prefira estruturas sem lock."""
    ),
    (
        "Como gerar um grafico simples com matplotlib?",
        """```python
import matplotlib.pyplot as plt

plt.plot([1, 2, 3], [2, 5, 3], marker="o")
plt.title("Exemplo")
plt.xlabel("x")
plt.ylabel("y")
plt.grid(True)
plt.savefig("grafico.png", dpi=150)
plt.show()
```

Em ambiente sem tela (servidor), use backend `Agg` antes de importar pyplot."""
    ),
    (
        "Como funciona a anotacao de tipos em Python?",
        """Anotacoes documentam tipos e alimentam ferramentas (`mypy`, `pyright`), mas **nao** sao checadas em runtime.

```python
def media(valores: list[float]) -> float:
    return sum(valores) / len(valores)

idade: int | None = None
```

Para validacao em runtime, use `pydantic`."""
    ),
]


def build():
    random.seed(42)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8") as f:
        for instrucao, resposta in EXAMPLES:
            registro = {
                "conversations": [
                    {"from": "system", "value": SYSTEM},
                    {"from": "human", "value": instrucao},
                    {"from": "gpt", "value": resposta},
                ]
            }
            f.write(json.dumps(registro, ensure_ascii=False) + "\n")
    print(f"{len(EXAMPLES)} exemplos -> {OUT}")


if __name__ == "__main__":
    build()
