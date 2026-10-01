#!/bin/sh
# Download the speech-to-text models into models/ (both MIT license). Files you already have are skipped, so it is
# safe to run again after an update.
#   1st argument: whisper.cpp model, default ggml-large-v3-turbo-q5_0.bin (~574 MB)
#   2nd argument: Silero VAD model, default ggml-silero-v6.2.0.bin (<1 MB; needs whisper.cpp 1.8.3 or newer,
#                 use ggml-silero-v5.1.2.bin with 1.7.6 to 1.8.2)
set -eu
cd "$(dirname "$0")/.."
MODEL="${1:-ggml-large-v3-turbo-q5_0.bin}"
VAD="${2:-ggml-silero-v6.2.0.bin}"
mkdir -p models
fetch() { # <file> <url>
  if [ -f "models/$1" ]; then echo "models/$1 already exists"; return; fi
  curl -L --fail -o "models/$1.part" "$2"
  mv "models/$1.part" "models/$1"
  echo "saved models/$1"
}
fetch "$MODEL" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL"
fetch "$VAD" "https://huggingface.co/ggml-org/whisper-vad/resolve/main/$VAD"
