"""Builds the prod sandbox that every world is forked from (W1). Owner: Tensae.

    python -m world.seed --out build          # seed.sql + answer_key.json, on the host
    python -m scripts.build_snapshot          # creates/refreshes the antibody-prod sandbox

Steps (TODO(Tensae) — fill in the commands, then time a fork):
  1. Create the prod sandbox (vm-small, network on so it can install packages).
  2. Install Postgres + Python deps (psycopg, fastapi, uvicorn, pydantic, httpx).
  3. Upload world/ and contracts/ to /opt/antibody (NOT build/answer_key.json — W3), plus build/seed.sql.
  4. Create the database `shop`, load world/schema.sql then seed.sql.
  5. Write /opt/antibody/start_services.sh (Postgres, refund app :8080, payments mock :8090) and run it.
  6. Health check (W1): GET :8080/health.
  7. Optionally sandbox.create_snapshot("antibody-prod-v1") so worlds can be created from a snapshot
     if fork misbehaves.
"""

from __future__ import annotations

import io
import os
import tarfile
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parent.parent
HP = "/opt/antibody"


def _tar_project() -> bytes:
    """world/ + contracts/ + build/seed.sql, never the answer key."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for folder in ("world", "contracts"):
            tar.add(ROOT / folder, arcname=folder, filter=lambda t: None if "__pycache__" in t.name else t)
        tar.add(ROOT / "build" / "seed.sql", arcname="seed.sql")
    return buf.getvalue()


def main() -> None:
    load_dotenv()
    from daytona import CreateSandboxFromImageParams, Daytona

    name = os.getenv("PROD_SANDBOX_NAME", "antibody-prod")
    daytona = Daytona()
    prod = daytona.create(
        CreateSandboxFromImageParams(name=name, image="python:3.11-slim", labels={"antibody": "prod"}),
        timeout=300,
    )
    print(f"created {name} ({prod.id})")

    prod.process.exec(f"mkdir -p {HP}")
    prod.fs.upload_file(_tar_project(), f"{HP}/project.tgz")
    prod.process.exec(f"tar -xzf {HP}/project.tgz -C {HP}")
    raise NotImplementedError("TODO(Tensae): steps 2, 4-7 above")


if __name__ == "__main__":
    main()
