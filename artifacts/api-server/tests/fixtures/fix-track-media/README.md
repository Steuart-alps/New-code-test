# FixTrack media fixtures

Used by `tests/fix-track-media-storage.mjs` (storage happy-path run). All of these are
synthetic: they contain only generated shapes and a test pattern, with no camera, location
or personal data.

| File | What it is | How it was made |
| --- | --- | --- |
| `photo.heic` | 96×64 HEIC with HEVC coding, `heic`/`mif1` brands, like an iPhone photo | Pillow with pillow-heif 1.8.1 (libheif 1.23 + x265): two shapes on a blue background, saved with `format="HEIF", quality=60` |
| `clip.mp4` | 2 s, 64×48, 10 fps MP4 (`isom` brand), AV1, no audio, index at the end | `ffmpeg -f lavfi -i testsrc=size=64x48:rate=10:duration=2 -c:v libaom-av1 -cpu-used 8 -pix_fmt yuv420p -g 5 -an clip.mp4` |
| `clip.mov` | Same clip with the QuickTime `qt  ` brand | as above, plus `-f mp4 -brand "qt  " clip.mov` |
| `clip.webm` | Same clip as WebM, VP9 | `ffmpeg -f lavfi -i testsrc=size=64x48:rate=10:duration=2 -c:v libvpx-vp9 -pix_fmt yuv420p -g 5 -an clip.webm` |

The videos use AV1 and VP9 because the open-source Chromium that runs the browser check cannot
decode H.264 or HEVC, which real phone videos use. Chrome, Edge and Safari decode those
codecs themselves; the server only stores the file and serves byte ranges, so the container
and range handling are what the check exercises.
