PY := .venv/bin/python

.PHONY: setup check-keys test test-daytona lint contracts arena web fake-run seed surreal

setup:            ## venv + Python deps + web deps + .env
	python3 -m venv .venv
	.venv/bin/pip install -q --upgrade pip
	.venv/bin/pip install -q -e ".[dev]"
	cd web && npm install
	@test -f .env || (cp .env.example .env && echo "created .env — fill in your keys")

check-keys:       ## every key in .env works (first 15 minutes)
	$(PY) -m scripts.check_keys

test:             ## fast tests (fake backend, no network)
	$(PY) -m pytest -q

test-daytona:     ## lifecycle tests on real sandboxes
	RUN_DAYTONA_TESTS=1 $(PY) -m pytest -q -m daytona

lint:
	.venv/bin/ruff check . && .venv/bin/ruff format --check .

contracts:        ## re-export contracts/schemas after editing contracts/models.py
	$(PY) -m scripts.export_contracts

arena:            ## API on :8000 (live events for the web app)
	.venv/bin/uvicorn arena.app:app --reload --port 8000

web:              ## web app on :5173 (proxies /api to :8000)
	cd web && npm run dev

fake-run:         ## a full run on the fake backend, recorded to runs/
	ARENA_BACKEND=fake $(PY) -m scripts.run_generation --generations 4

seed:             ## build/seed.sql + build/answer_key.json (host only)
	$(PY) -m world.seed --out build

surreal:          ## local SurrealDB on :8001 (MEMORY_BACKEND=surreal)
	docker run --rm -p 8001:8000 surrealdb/surrealdb:latest start --user root --pass root memory
