FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends verilator g++ make git python3 ca-certificates && rm -rf /var/lib/apt/lists/*
RUN useradd -m -s /bin/bash daytona
USER daytona
WORKDIR /home/daytona
