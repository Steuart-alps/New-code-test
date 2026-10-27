import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { privateObjectUrl, VIDEO_PATH } from "@/lib/media-upload";

// Thumbnails of private photos and videos; tapping one opens a full-screen viewer.
export function MediaGallery({ urls, clientId, onDelete, label = "issue media", testIdPrefix = "issue-media" }: {
  urls: string[];
  clientId: number | null | undefined;
  /** FixTrack shows this to owners and admins once the issue is resolved or closed. */
  onDelete?: (url: string) => Promise<void>;
  /** Names each item for screen readers, e.g. "Open issue media 1". */
  label?: string;
  testIdPrefix?: string;
}) {
  const [viewerOpen, setViewerOpen] = useState(false);
  const [initialIndex, setInitialIndex] = useState(0);
  const [deleting, setDeleting] = useState<string | null>(null);

  if (!urls || urls.length === 0) return null;

  const confirmDelete = async (url: string, isVideo: boolean) => {
    if (!onDelete) return;
    const what = isVideo ? "video" : "photo";
    if (!window.confirm(`Delete this ${what} for good to free up storage? The issue and its history stay, and the history will show that you deleted it.`)) return;
    setDeleting(url);
    try {
      await onDelete(url);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <>
      <div className="flex gap-3 overflow-x-auto pb-2 snap-x">
        {urls.map((url, idx) => {
          const isVideo = VIDEO_PATH.test(url);
          const src = privateObjectUrl(url, clientId);
          
          return (
            <div key={url} className="relative flex-shrink-0 snap-start">
            <button
              type="button"
              onClick={() => { setInitialIndex(idx); setViewerOpen(true); }}
              aria-label={`Open ${label} ${idx + 1}`}
              data-testid={`button-open-${testIdPrefix}-${idx}`}
              className="relative w-28 h-28 rounded-xl overflow-hidden border border-border bg-muted/30 active:scale-95 transition-transform"
            >
              {isVideo ? (
                <div className="w-full h-full bg-black/10 flex items-center justify-center">
                  <div className="w-8 h-8 rounded-full bg-background/80 flex items-center justify-center backdrop-blur-sm">
                    <div className="w-0 h-0 border-t-4 border-t-transparent border-l-6 border-l-foreground border-b-4 border-b-transparent ml-1" />
                  </div>
                </div>
              ) : (
                <img src={src} alt={label} className="w-full h-full object-cover" />
              )}
            </button>
            {onDelete && (
              <button
                type="button"
                onClick={() => { void confirmDelete(url, isVideo); }}
                disabled={deleting !== null}
                aria-label={`Delete ${label} ${idx + 1}`}
                data-testid={`button-delete-${testIdPrefix}-${idx}`}
                className="absolute top-1.5 right-1.5 w-8 h-8 rounded-full bg-background/90 border border-border flex items-center justify-center text-red-600 shadow-sm disabled:opacity-50"
              >
                {deleting === url ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              </button>
            )}
            </div>
          );
        })}
      </div>

      {viewerOpen && (
        <div className="fixed inset-0 z-50 bg-background/95 backdrop-blur-sm flex flex-col animate-in fade-in duration-200">
          <div className="p-4 flex justify-between items-center bg-background/50 border-b absolute top-0 left-0 right-0 z-10">
            <p className="font-medium text-sm">Media Viewer</p>
            <Button variant="ghost" size="sm" onClick={() => setViewerOpen(false)}>Close</Button>
          </div>
          
          <div className="flex-1 flex overflow-x-auto snap-x snap-mandatory pt-16">
            {urls.map((url, idx) => {
              const isVideo = VIDEO_PATH.test(url);
              const src = privateObjectUrl(url, clientId);
              
              return (
                <div 
                  key={url} 
                  className="w-full flex-shrink-0 flex items-center justify-center p-4 snap-center"
                  ref={el => { if (el && idx === initialIndex) el.scrollIntoView(); }}
                >
                  {isVideo ? (
                    <video src={src} controls playsInline preload="metadata" className="max-w-full max-h-full rounded-lg" autoPlay={idx === initialIndex} />
                  ) : (
                    <img src={src} alt="Full view" className="max-w-full max-h-full object-contain rounded-lg shadow-xl" />
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </>
  );
}
