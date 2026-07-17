#!/usr/bin/env bash
# Test fixtures (PLAN.md 7, Phase 0).
#
# Each file here exists because it is a real-world shape the media path must
# not choke on, not because it is convenient to generate. The small ones are
# committed; large-2gb.mp4 is generated on demand and gitignored.
#
# Requires ffmpeg. `brew install ffmpeg` on macOS.
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v ffmpeg >/dev/null 2>&1; then
	echo "gen.sh: ffmpeg not found. Install it (brew install ffmpeg) and re-run." >&2
	exit 1
fi

# A deterministic, visually legible source: a moving pattern plus a burned-in
# timecode, so drift is measurable by eye and by screenshot in the e2e tests.
src_video() {
	local dur=$1 size=$2 fps=$3
	echo "-f lavfi -i testsrc2=size=${size}:rate=${fps}:duration=${dur}"
}
src_audio() {
	local dur=$1
	echo "-f lavfi -i sine=frequency=440:sample_rate=48000:duration=${dur}"
}

# Keyframe every 2s so segmentation has sync samples to align to at our 4s
# target (PLAN.md 4.1). -g is in frames.
#
# crf 34 keeps the committed fixtures a few MB each. They are parsed, segmented,
# and transcoded by the tests; nobody watches them, so quality past "decodes and
# has legible motion" is bytes in git for nothing.
h264_common="-c:v libx264 -preset veryfast -pix_fmt yuv420p -g 60 -keyint_min 60 -sc_threshold 0 -crf 34"

echo "==> tiny-60s.mp4 (H.264/AAC, faststart, 1080p) - the happy path"
# Capped rather than crf: this one is 1080p for a full minute and is the fixture
# most tests touch, so it earns the extra squeeze to stay ~5MB in git.
# shellcheck disable=SC2046
ffmpeg -y -loglevel error $(src_video 60 1920x1080 30) $(src_audio 60) \
	-c:v libx264 -preset veryfast -pix_fmt yuv420p -g 60 -keyint_min 60 -sc_threshold 0 \
	-b:v 550k -maxrate 800k -bufsize 1200k \
	-c:a aac -b:a 96k -movflags +faststart tiny-60s.mp4

echo "==> moov-at-end.mp4 - exercises the tail-read path"
# The single most common real-world shape we must not choke on. No +faststart,
# so moov lands after mdat and the head read yields nothing.
# shellcheck disable=SC2046
ffmpeg -y -loglevel error $(src_video 30 1280x720 30) $(src_audio 30) \
	$h264_common -c:a aac -b:a 128k moov-at-end.mp4

echo "==> ac3-audio.mp4 - THE 4.4 CASE: browsers cannot decode AC-3"
# MP4s remuxed from MKV very commonly carry AC-3. An earlier draft of the plan
# assumed audio is always passthrough, which would produce silent video with no
# diagnostic on a large fraction of exactly the files people watch together.
# shellcheck disable=SC2046
ffmpeg -y -loglevel error $(src_video 30 1280x720 30) $(src_audio 30) \
	$h264_common -c:a ac3 -b:a 192k -strict -2 ac3-audio.mp4

echo "==> no-audio.mp4"
# shellcheck disable=SC2046
ffmpeg -y -loglevel error $(src_video 30 1280x720 30) \
	$h264_common -movflags +faststart no-audio.mp4

echo "==> vfr.mp4 - variable frame rate, so nbSamples-from-fps is a lie"
# shellcheck disable=SC2046
ffmpeg -y -loglevel error $(src_video 30 1280x720 30) $(src_audio 30) \
	-vf "setpts='if(lt(random(0),0.5),PTS+0.02/TB,PTS)'" -fps_mode vfr \
	$h264_common -c:a aac -b:a 128k -movflags +faststart vfr.mp4

echo "==> surround-5.1.mp4"
# shellcheck disable=SC2046
ffmpeg -y -loglevel error $(src_video 30 1280x720 30) \
	-f lavfi -i "sine=frequency=440:sample_rate=48000:duration=30" \
	$h264_common -af "pan=5.1|c0=c0|c1=c0|c2=c0|c3=c0|c4=c0|c5=c0" \
	-c:a aac -b:a 384k -movflags +faststart surround-5.1.mp4

echo "==> hevc.mp4 - tier 2 unless the platform decodes HEVC"
# shellcheck disable=SC2046
ffmpeg -y -loglevel error $(src_video 30 1280x720 30) $(src_audio 30) \
	-c:v libx265 -preset ultrafast -pix_fmt yuv420p -tag:v hvc1 -crf 34 \
	-x265-params "keyint=60:min-keyint=60:scenecut=0:log-level=error" \
	-c:a aac -b:a 128k -movflags +faststart hevc.mp4

if [[ "${1:-}" == "--large" ]]; then
	echo "==> large-2gb.mp4 (gitignored, slow) - the Phase 0 reproduction file"
	# shellcheck disable=SC2046
	ffmpeg -y -loglevel error $(src_video 1800 1920x1080 30) $(src_audio 1800) \
		-c:v libx264 -preset ultrafast -pix_fmt yuv420p -g 60 -keyint_min 60 -sc_threshold 0 \
		-b:v 9500k -c:a aac -b:a 192k -movflags +faststart large-2gb.mp4
fi

echo
ls -lh ./*.mp4
