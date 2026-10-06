#!/usr/bin/env bash
# usage: run.sh <arm: auto|sol|flash> <case: 1|2|3> <rep>
# Work area: $PI8_FLOW_DIR (default /tmp/pi8-flow). Run `node setup.mjs` first.
arm=$1; cs=$2; rep=$3
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
ROOT=${PI8_FLOW_DIR:-/tmp/pi8-flow}
RUN=$ROOT/runs/$arm.c$cs.r$rep
rm -rf "$RUN"; mkdir -p "$RUN"; cp -r $ROOT/case$cs "$RUN/work"
EXT=(-ne -e "$HOME/.pi/agent/git/github.com/fitchmultz/pi-cursor-sdk/dist/index.js")
case $arm in
  auto)  MODEL=router/auto; EXT+=(-e "$REPO")
         cp -r $ROOT/pi8-template "$RUN/pi8"; export PI8_DIR="$RUN/pi8" ;;
  sol)   MODEL=openai-codex/gpt-6.1-sol ;;
  flash) MODEL=deepseek/deepseek-flash ;;
esac
case $cs in
  1) PROMPT='Read docs/queue-spec.md. Plan the design of src/queue.ts first, then implement it. Add tests in test/queue.test.ts that cover each rule in the spec, and run `npm test` until all tests pass. Do not stop to ask for approval; complete the work.'; LIMIT=2400 ;;
  2) PROMPT='Review src/queue.ts against docs/queue-spec.md. Report each defect you find with its location, its impact, and a minimal fix, ordered by severity. Do not change any file.'; LIMIT=900 ;;
  3) PROMPT='Rename the queue option `retryDelayMs` to `backoffBaseMs` everywhere in this project: source, tests, and docs. Then add src/index.ts that re-exports `createQueue` and the types `QueueOptions`, `AddOptions`, `JobHandle`, and `Queue` from src/queue.ts. Run `npm test` and make sure it passes.'; LIMIT=900 ;;
esac
cd "$RUN/work"
start=$(date +%s)
echo "$(date +%T) start $arm c$cs r$rep model=$MODEL" >> $ROOT/progress.log
timeout $LIMIT pi "${EXT[@]}" --session-dir "$RUN/sessions" --model "$MODEL" -p "$PROMPT" > "$RUN/out1.txt" 2>&1; e1=$?
followup=0
if [ "$cs" = 1 ] && [ ! -f src/queue.ts ]; then
  followup=1
  timeout $LIMIT pi "${EXT[@]}" --session-dir "$RUN/sessions" -c --model "$MODEL" -p 'Continue. Implement the plan now and make `npm test` pass. Do not ask for approval.' > "$RUN/out2.txt" 2>&1
fi
end=$(date +%s)
echo "{\"arm\":\"$arm\",\"case\":$cs,\"rep\":$rep,\"exit\":$e1,\"followup\":$followup,\"seconds\":$((end-start))}" > "$RUN/meta.json"
echo "$(date +%T) end   $arm c$cs r$rep exit=$e1 followup=$followup $((end-start))s" >> $ROOT/progress.log
