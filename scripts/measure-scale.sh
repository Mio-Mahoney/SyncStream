#!/usr/bin/env bash
# Runs the PLAN.md Phase 2 acceptance measurement (tests/e2e/scale.spec.ts)
# N times and summarises, so the numbers STATUS.md quotes are a distribution
# on an otherwise idle machine rather than one lucky run.
#
#   scripts/measure-scale.sh 10
#
# Needs tests/fixtures/large-2gb.mp4 (bash tests/fixtures/gen.sh --large).
# Each run appends one line to $SCALE_LOG; the summary is computed from it.
set -euo pipefail
cd "$(dirname "$0")/.."

runs=${1:-10}
log=${SCALE_LOG:-/tmp/syncstream-scale-$(date +%Y%m%d-%H%M%S).log}
export SCALE_LOG="$log"
: >"$log"

for i in $(seq 1 "$runs"); do
	echo "==> run $i of $runs"
	# One run per Playwright invocation so each gets a fresh browser; the
	# webServer is reused across them (reuseExistingServer).
	caffeinate -i bunx playwright test tests/e2e/scale.spec.ts --reporter=line >/dev/null 2>&1 || echo "    (assertion failed; the measurement is still logged)"
done

echo
echo "runs logged to $log"
echo
awk '
	function stats(name, arr, n,  i, sum, min, max, sorted, med) {
		if (n == 0) return
		sum = 0; min = arr[1]; max = arr[1]
		for (i = 1; i <= n; i++) { sum += arr[i]; if (arr[i] < min) min = arr[i]; if (arr[i] > max) max = arr[i]; sorted[i] = arr[i] }
		asort(sorted)
		med = (n % 2) ? sorted[(n + 1) / 2] : (sorted[n / 2] + sorted[n / 2 + 1]) / 2
		printf "  %-10s n=%d  min=%.0f  median=%.0f  mean=%.0f  max=%.0f\n", name, n, min, med, sum / n, max
	}
	{
		for (i = 2; i <= NF; i++) {
			split($i, kv, "=")
			if (kv[1] == "ttff") ttff[++nt] = kv[2]
			if (kv[1] == "seek") seek[++ns] = kv[2]
			if (kv[1] == "rss") rss[++nr] = kv[2]
			if (kv[1] == "hostHeap") hh[++nh] = kv[2]
			if (kv[1] == "guestHeap") gh[++ng] = kv[2]
			if (kv[1] == "stalls") st[++nst] = kv[2]
			if (kv[1] == "probe") pr[++npr] = kv[2]
			if (kv[1] == "origin") og[++nog] = kv[2]
			if (kv[1] == "load") ld[++nld] = kv[2]
		}
	}
	END {
		stats("ttff ms", ttff, nt)
		stats("seek ms", seek, ns)
		stats("rss MB", rss, nr)
		stats("hostHeap", hh, nh)
		stats("guestHeap", gh, ng)
		stats("stalls", st, nst)
		stats("probe ms", pr, npr)
		stats("origin ms", og, nog)
		stats("load ms", ld, nld)
	}
' "$log"
