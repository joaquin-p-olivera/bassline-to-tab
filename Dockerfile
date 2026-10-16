# Image for the web server: runs on Hugging Face Spaces (see deploy/huggingface/)
# and anywhere else Docker does.

# --- Stage 1: build the CLI and the web server ---
FROM rust:1-slim-bookworm AS builder
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY models ./models
COPY src ./src
COPY web ./web
RUN cargo build --release --features server --bins

# --- Stage 2: runtime with Demucs on CPU-only PyTorch ---
FROM python:3.12-slim-bookworm

ENV PIP_NO_CACHE_DIR=1 \
    TORCH_HOME=/opt/torch

# Versions are pinned on purpose: PyTorch 2.6+ loads checkpoints with
# weights_only=True, which Demucs 4.0.1 does not support. build-essential is
# only needed to compile one of Demucs' dependencies.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libsndfile1 build-essential \
    && pip install torch==2.5.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cpu \
    && pip install demucs==4.0.1 soundfile \
    && python -c "from demucs.pretrained import get_model; get_model('htdemucs')" \
    && ffmpeg -loglevel error -f lavfi -i "sine=frequency=110:duration=5" /tmp/smoke.wav \
    && demucs --two-stems bass -n htdemucs -o /tmp/smoke-out /tmp/smoke.wav \
    && test -f /tmp/smoke-out/htdemucs/smoke/bass.wav \
    && rm -rf /tmp/smoke.wav /tmp/smoke-out \
    && apt-get purge -y --auto-remove build-essential \
    && rm -rf /var/lib/apt/lists/* \
    && chmod -R a+rX /opt/torch

COPY --from=builder /build/target/release/bassline-to-tab /build/target/release/bassline-to-tab-server /usr/local/bin/

# Hugging Face Spaces runs containers as user 1000.
RUN useradd --create-home --uid 1000 user
USER user

ENV PORT=7860 \
    WORK_DIR=/tmp/bassline-jobs
EXPOSE 7860
CMD ["bassline-to-tab-server"]
