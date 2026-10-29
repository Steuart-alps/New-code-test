import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Camera, Circle, FolderOpen, Loader2, RotateCcw, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// Longest clip the camera window records: about 55 MB at the bitrate below,
// well inside the upload limit.
const MAX_RECORDING_SECONDS = 180;
const VIDEO_BITS_PER_SECOND = 2_500_000;

/**
 * Phones and tablets open their own camera from a file box with `capture`;
 * laptops and desktops ignore `capture` and show a file picker, so they get
 * the camera window instead. Browsers that can't reach a camera keep the
 * file box.
 */
function usesOwnCameraApp() {
  if (typeof window === "undefined") return true;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) return true;
  return window.matchMedia?.("(pointer: coarse)").matches ?? false;
}

function videoRecordingType(): string | null {
  if (typeof MediaRecorder === "undefined") return null;
  return ["video/mp4", "video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]
    .find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");

function cameraProblem(error: unknown): string {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "ComplyTrack isn't allowed to use the camera. Allow the camera for this site in your browser's settings, or choose a file instead.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera was found on this computer. Choose a file instead.";
  if (name === "NotReadableError") return "The camera is being used by another app. Close that app and try again, or choose a file instead.";
  return "The camera couldn't be started. Choose a file instead.";
}

type Shot = { file: File; url: string };

function CameraDialog({ open, video, onClose, onShot, onChooseFile }: {
  open: boolean;
  video: boolean;
  onClose: () => void;
  onShot: (file: File) => void;
  onChooseFile: () => void;
}) {
  const preview = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const [stage, setStage] = useState<"starting" | "live" | "recording" | "review" | "error">("starting");
  const [problem, setProblem] = useState("");
  const [mirrored, setMirrored] = useState(false);
  const [shot, setShot] = useState<Shot | null>(null);
  const [seconds, setSeconds] = useState(0);
  const recordingType = video ? videoRecordingType() : null;

  const stopCamera = useCallback(() => {
    if (recorder.current?.state === "recording") {
      recorder.current.ondataavailable = null;
      recorder.current.onstop = null;
      recorder.current.stop();
    }
    recorder.current = null;
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  }, []);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStage("starting");
    setShot(null);
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    }).then((media) => {
      if (cancelled) { media.getTracks().forEach((track) => track.stop()); return; }
      stream.current = media;
      // A laptop's camera faces the user, so show it like a mirror. The
      // photo itself is never flipped.
      setMirrored(media.getVideoTracks()[0]?.getSettings().facingMode !== "environment");
      if (preview.current) {
        preview.current.srcObject = media;
        // Not awaited: some browsers only settle play() once the video is
        // shown. The camera counts as live once the first frame's size is
        // known (onLoadedMetadata below), so a photo always has a picture.
        void preview.current.play().catch(() => {});
      }
    }).catch((error) => {
      if (cancelled) return;
      setProblem(cameraProblem(error));
      setStage("error");
    });
    return () => { cancelled = true; stopCamera(); };
  }, [open, stopCamera]);

  useEffect(() => () => { if (shot) URL.revokeObjectURL(shot.url); }, [shot]);

  useEffect(() => {
    if (stage !== "recording") return;
    const started = Date.now();
    const timer = window.setInterval(() => {
      const elapsed = Math.floor((Date.now() - started) / 1000);
      setSeconds(elapsed);
      if (elapsed >= MAX_RECORDING_SECONDS) recorder.current?.stop();
    }, 250);
    return () => window.clearInterval(timer);
  }, [stage]);

  function takePhoto() {
    const source = preview.current;
    if (!source || !source.videoWidth) return;
    const canvas = document.createElement("canvas");
    canvas.width = source.videoWidth;
    canvas.height = source.videoHeight;
    canvas.getContext("2d")?.drawImage(source, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const file = new File([blob], `photo-${stamp()}.jpg`, { type: "image/jpeg" });
      setShot({ file, url: URL.createObjectURL(file) });
      setStage("review");
    }, "image/jpeg", 0.92);
  }

  async function startRecording() {
    if (!stream.current || !recordingType) return;
    // Sound is optional: if the microphone is refused, record without it.
    let audio: MediaStreamTrack[] = [];
    try {
      const microphone = await navigator.mediaDevices.getUserMedia({ audio: true });
      audio = microphone.getAudioTracks();
      audio.forEach((track) => stream.current?.addTrack(track));
    } catch { /* video only */ }
    const chunks: Blob[] = [];
    const container = recordingType.split(";")[0]!;
    let media: MediaRecorder;
    try {
      media = new MediaRecorder(new MediaStream([...stream.current.getVideoTracks(), ...audio]), {
        mimeType: recordingType,
        videoBitsPerSecond: VIDEO_BITS_PER_SECOND,
      });
    } catch {
      setProblem("This browser can't record video. Take a photo, or choose a video file instead.");
      setStage("error");
      return;
    }
    media.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
    media.onstop = () => {
      audio.forEach((track) => { stream.current?.removeTrack(track); track.stop(); });
      const file = new File(chunks, `video-${stamp()}.${container === "video/mp4" ? "mp4" : "webm"}`, { type: container });
      setShot({ file, url: URL.createObjectURL(file) });
      setStage("review");
    };
    recorder.current = media;
    media.start(1000);
    setSeconds(0);
    setStage("recording");
  }

  function close() {
    stopCamera();
    onClose();
  }

  const isVideo = shot?.file.type.startsWith("video/");
  const minutes = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent className="sm:max-w-2xl" data-testid="camera-dialog">
        <DialogHeader>
          <DialogTitle>{video ? "Take a photo or video" : "Take a photo"}</DialogTitle>
          <DialogDescription>
            {stage === "review" ? `Check the ${isVideo ? "video" : "photo"}, then use it or try again.` : "Point the camera at what you want to show."}
          </DialogDescription>
        </DialogHeader>
        <div className="relative overflow-hidden rounded-md bg-black aspect-video">
          <video ref={preview} muted playsInline aria-label="Camera"
            onLoadedMetadata={() => setStage((current) => current === "starting" ? "live" : current)}
            className={`h-full w-full object-contain ${mirrored ? "-scale-x-100" : ""} ${stage === "review" || stage === "error" ? "hidden" : ""}`} />
          {stage === "starting" && (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-white/80">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />Starting the camera… your browser may ask to allow it.
            </div>
          )}
          {stage === "recording" && (
            <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-xs font-medium text-white" role="status">
              <span className="h-2 w-2 animate-pulse rounded-full bg-red-500" />Recording {minutes}
            </div>
          )}
          {stage === "review" && shot && (isVideo
            ? <video src={shot.url} controls playsInline className="h-full w-full object-contain" data-testid="camera-review" />
            : <img src={shot.url} alt="The photo you took" className="h-full w-full object-contain" data-testid="camera-review" />)}
          {stage === "error" && (
            <p role="alert" className="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-white">{problem}</p>
          )}
        </div>
        <DialogFooter className="flex-wrap gap-2 sm:justify-between">
          <Button type="button" variant="ghost" onClick={() => { close(); onChooseFile(); }}>
            <FolderOpen className="mr-1.5 h-4 w-4" />Choose a file instead
          </Button>
          <div className="flex flex-wrap gap-2">
            {stage === "live" && (
              <>
                {recordingType && (
                  <Button type="button" variant="outline" onClick={() => void startRecording()}>
                    <Circle className="mr-1.5 h-4 w-4 fill-red-500 text-red-500" />Record video
                  </Button>
                )}
                <Button type="button" onClick={takePhoto}><Camera className="mr-1.5 h-4 w-4" />Take photo</Button>
              </>
            )}
            {stage === "recording" && (
              <Button type="button" onClick={() => recorder.current?.stop()}><Square className="mr-1.5 h-4 w-4" />Stop recording</Button>
            )}
            {stage === "review" && shot && (
              <>
                <Button type="button" variant="outline" onClick={() => { setShot(null); setStage("live"); void preview.current?.play().catch(() => {}); }}>
                  <RotateCcw className="mr-1.5 h-4 w-4" />Try again
                </Button>
                <Button type="button" onClick={() => { const file = shot.file; close(); onShot(file); }}>
                  {isVideo ? "Use this video" : "Use this photo"}
                </Button>
              </>
            )}
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Take photo" for any attach box. `open` uses the phone's or tablet's own
 * camera through `fileInput` (a hidden file box with `capture`), and on a
 * laptop or desktop opens a camera window using the computer's camera, with
 * "Choose a file instead" falling back to `fileInput`. Render `dialog`
 * somewhere in the box. With `video`, the window can also record a clip.
 */
export function useCameraCapture(onFiles: (files: File[]) => void, { video = false, fileInput }: {
  video?: boolean;
  fileInput: () => HTMLInputElement | null;
}): { open: () => void; dialog: ReactNode } {
  const [isOpen, setIsOpen] = useState(false);
  const open = () => {
    if (usesOwnCameraApp()) fileInput()?.click();
    else setIsOpen(true);
  };
  const dialog = (
    <CameraDialog open={isOpen} video={video}
      onClose={() => setIsOpen(false)}
      onShot={(file) => onFiles([file])}
      onChooseFile={() => fileInput()?.click()} />
  );
  return { open, dialog };
}
