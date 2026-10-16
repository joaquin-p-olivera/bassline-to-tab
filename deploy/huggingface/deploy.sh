#!/usr/bin/env bash
# Publishes the last commit of this repository to a Hugging Face Space.
#
# Usage: deploy/huggingface/deploy.sh https://huggingface.co/spaces/<user>/<space>
#
# Hugging Face reads the Space settings from a YAML header at the top of
# README.md. To keep the GitHub README clean, the header is added only to the
# copy that is pushed to the Space. When git asks for a password, use a
# Hugging Face access token with write permission.
set -euo pipefail

if [[ $# -ne 1 ]]; then
    echo "Usage: $0 <space-git-url>" >&2
    exit 1
fi
space_url="$1"

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if ! git diff --quiet HEAD; then
    echo "There are uncommitted changes; commit them first (only HEAD is published)." >&2
    exit 1
fi
commit="$(git rev-parse --short HEAD)"

staging="$(mktemp -d)"
trap 'rm -rf "$staging"' EXIT

echo "Cloning $space_url"
git clone --quiet "$space_url" "$staging/space"

# Replace the Space content with the files of HEAD.
find "$staging/space" -mindepth 1 -maxdepth 1 -not -name .git -exec rm -rf {} +
git archive HEAD | tar -x -C "$staging/space"
cat deploy/huggingface/space-header.yml README.md > "$staging/space/README.md"

cd "$staging/space"
git add --all
if git diff --cached --quiet; then
    echo "The Space is already up to date."
    exit 0
fi
git commit --quiet -m "Deploy bassline-to-tab $commit"
git push --quiet origin HEAD
echo "Pushed $commit. Follow the build in the Space's Logs tab."
