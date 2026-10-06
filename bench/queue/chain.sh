#!/usr/bin/env bash
# usage: chain.sh <arm> <rep>   (runs the three cases one after another)
arm=$1; rep=$2
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ROOT=${PI8_FLOW_DIR:-/tmp/pi8-flow}
for cs in 1 2 3; do "$HERE/run.sh" "$arm" "$cs" "$rep"; done
echo "$(date +%T) chain done $arm r$rep" >> "$ROOT/progress.log"
