#!/bin/sh
# Download the whisper.cpp model used for speech-to-text (~574 MB, MIT license).
set -eu
cd "$(dirname "$0")/.."
MODEL="${1:-ggml-large-v3-turbo-q5_0.bin}"
mkdir -p models
if [ -f "models/$MODEL" ]; then echo "models/$MODEL already exists"; exit 0; fi
curl -L --fail -o "models/$MODEL.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL"
mv "models/$MODEL.part" "models/$MODEL"
echo "saved models/$MODEL"
