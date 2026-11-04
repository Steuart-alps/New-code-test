#!/usr/bin/env bash
# Regenerates the FixTrack video fixtures used by
# tests/fixtrack-video-roundtrip-browser.test.mjs. Requires ffmpeg with libvpx
# and libx264. Each clip is a 4 s (2 s for the H.264 one) 128x96 test pattern
# with a keyframe every 5 frames, so seeking lands on decodable frames.
#
# The test browser is open-source Chromium, which decodes VP9 but not H.264,
# so the three clips the gallery plays carry VP9:
#   issue-video.mp4   ISO MP4, moov at the front (+faststart)
#   issue-video.mov   QuickTime-branded ("qt  ") ISO file, moov at the end, so
#                     the player must range-read the tail before it can start
#   issue-video.webm  WebM
# issue-video-h264.mov is a genuine `-f mov` QuickTime file with H.264, like a
# phone recording; the test attaches it and range-reads it through the API
# rather than decoding it.
set -euo pipefail
cd "$(dirname "$0")"
pattern=(-f lavfi -i testsrc2=size=128x96:rate=10:duration=4)
vp9=(-c:v libvpx-vp9 -b:v 24k -g 5 -pix_fmt yuv420p -map_metadata -1 -fflags +bitexact)
ffmpeg -hide_banner -loglevel error -y "${pattern[@]}" "${vp9[@]}" -movflags +faststart -f mp4 issue-video.mp4
ffmpeg -hide_banner -loglevel error -y "${pattern[@]}" "${vp9[@]}" -f mp4 -brand "qt  " issue-video.mov
ffmpeg -hide_banner -loglevel error -y "${pattern[@]}" "${vp9[@]}" -f webm issue-video.webm
ffmpeg -hide_banner -loglevel error -y -f lavfi -i testsrc2=size=128x96:rate=10:duration=2 \
  -c:v libx264 -preset veryslow -crf 40 -g 5 -pix_fmt yuv420p -map_metadata -1 -fflags +bitexact -f mov issue-video-h264.mov
