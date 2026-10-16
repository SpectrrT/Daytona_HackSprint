# Antibody: notes for Claude Code

Hackathon project, submitted by 3:15 PM. Prefer small, working changes over big rewrites.

- Read README.md first: ownership by folder, the API, and the open questions.
- Stay inside your owner's folders (README "Who owns what"). `contracts/` is shared: if you change
  `contracts/models.py`, update `web/src/contracts.ts` and run `make contracts` in the same change.
- Requirement IDs (W1, A3, B4, R3, G2, M1, U1, V2…) come from the build spec. Keep them in docstrings and tests.
- `make test` must stay green. It runs on the fake backend with no keys. Tests needing real services are
  marked `daytona` or `live` and are skipped by default.
- Never put the answer key (`build/answer_key.json`) into a world or a commit. Never send numbers from
  `ARENA_BACKEND=fake` to slides.
- Model calls go through `agents/llm.py` only (Claude on Bedrock, structured output, disk cache).
- Python 3.11+, pydantic v2, ruff (`make lint`). Web: Vite + React + TypeScript + React Flow in `web/`.
