#!/bin/bash
# generate_release_notes.sh
# Run multi-agent release notes generator for spinnaker repo

# Exit on errors
set -e

# Path to this script's folder (assumes script is inside release_notes_package)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# Activate Python venv (create if it doesn't exist)
if [ ! -d ".venv" ]; then
    python3 -m venv .venv
fi
source .venv/bin/activate

# Install dependencies (best-effort)
pip install -r requirements.txt || true

# Load tokens from .env
if [ -f .env ]; then
    export $(grep -v '^#' .env | xargs)
else
    echo ".env file not found. Please create one with GITHUB_TOKEN and GENAI_API_KEY."
    exit 1
fi

# Fetch commits for penultimate and latest tags
START_COMMIT=$(git ls-remote --tags https://github.com/firmsoil/spinnaker.git | sort -t '/' -k3 -V | tail -2 | head -1 | awk '{print $1}')
END_COMMIT=$(git ls-remote --tags https://github.com/firmsoil/spinnaker.git | sort -t '/' -k3 -V | tail -1 | awk '{print $1}')
VERSION=$(git ls-remote --tags https://github.com/firmsoil/spinnaker.git | sort -t '/' -k3 -V | tail -1 | awk -F'/' '{print $3}')

echo "Generating release notes from $START_COMMIT to $END_COMMIT (version $VERSION)..."

# Run the multi-agent generator
python release_notes_agents.py \
  --mode github \
  --repo https://github.com/firmsoil/spinnaker.git \
  --start $START_COMMIT \
  --end $END_COMMIT \
  --version $VERSION \
  --product Spinnaker \
  --github-token $GITHUB_TOKEN \
  --genai-key $GENAI_API_KEY

echo "Release notes generated: $SCRIPT_DIR/release_notes.txt"

