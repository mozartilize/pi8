#!/bin/sh
# Builds the Saleor test image. The Python packages come from the lock file of the Saleor checkout at HEAD.
#   eval/images/saleor-dev/build.sh <saleor-checkout>
set -eu
here=$(cd "$(dirname "$0")" && pwd)
ctx=$(mktemp -d)
git -C "$1" show HEAD:pyproject.toml > "$ctx/pyproject.toml"
git -C "$1" show HEAD:uv.lock > "$ctx/uv.lock"
cp "$here/Containerfile" "$ctx/Containerfile"
podman build -t localhost/pi8-saleor-dev:2 "$ctx"
rm -rf "$ctx"
