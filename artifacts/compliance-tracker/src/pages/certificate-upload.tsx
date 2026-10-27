import { useEffect, useRef, useState } from "react";
import { useRoute } from "wouter";
import { CheckCircle2, FileUp, Loader2, UploadCloud } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useFileDrop } from "@/hooks/use-file-drop";
import { cn } from "@/lib/utils";

interface UploadInfo {
  companyName: string;
  itemTitle: string;
  siteName: string | null;
  contractorName: string | null;
  uploadsLeft: number;
  maxBytes: number;
}

const apiBase = import.meta.env.VITE_API_URL ?? "";
const DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function fileType(file: File): string {
  if (file.type) return file.type;
  const ext = file.name.split(".").pop()?.toLowerCase();
  return ext === "pdf" ? "application/pdf" : ext === "docx" ? DOCX_TYPE : ext === "png" ? "image/png"
    : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "heic" ? "image/heic" : "";
}

function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(new Error("The file could not be read"));
    reader.readAsDataURL(file);
  });
}

/**
 * The "Upload certificate" link in a contractor's emails: no sign-in, the
 * link is the key. The certificate goes to the business's "Certificates to
 * confirm" list, where someone checks it before it is saved.
 */
export default function CertificateUploadPage() {
  const [, params] = useRoute("/certificate-upload/:token");
  const token = params?.token;
  const input = useRef<HTMLInputElement>(null);
  const [info, setInfo] = useState<UploadInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const [sent, setSent] = useState<string[]>([]);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    fetch(`${apiBase}/api/certificate-upload/${token}`)
      .then(async (response) => {
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error ?? "This upload link is not valid.");
        return body as UploadInfo;
      })
      .then(setInfo)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [token]);

  async function upload(files: File[]) {
    if (!token || !info) return;
    setError(null);
    for (const file of files) {
      if (file.size > info.maxBytes) {
        setError(`${file.name} is over ${Math.round(info.maxBytes / 1024 / 1024)} MB. Save it as a smaller PDF and try again.`);
        continue;
      }
      setUploading(file.name);
      try {
        const response = await fetch(`${apiBase}/api/certificate-upload/${token}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileName: file.name, mimeType: fileType(file), data: await toBase64(file) }),
        });
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error ?? "The certificate could not be sent.");
        setSent((list) => [...list, file.name]);
      } catch (err) {
        setError(err instanceof Error ? err.message : "The certificate could not be sent.");
        break;
      }
    }
    setUploading(null);
    if (input.current) input.current.value = "";
  }

  const { isDragging, dropZoneProps } = useFileDrop((files) => void upload(files), !!info && !uploading);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-emerald-50 flex items-center justify-center p-4">
      <Card className="w-full max-w-lg p-6 sm:p-8 shadow-xl">
        {loading ? (
          <div className="flex items-center justify-center py-12 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin mr-2" /> Loading...
          </div>
        ) : !info ? (
          <div className="text-center py-6">
            <h1 className="text-xl font-bold mb-2">Link unavailable</h1>
            <p className="text-muted-foreground">{error}</p>
          </div>
        ) : (
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground font-semibold mb-2">{info.companyName}</p>
            <h1 className="text-2xl font-bold mb-1">Upload the certificate</h1>
            <p className="text-muted-foreground mb-6">
              {info.contractorName ? `Hi ${info.contractorName}, ` : ""}please upload the certificate or report for this visit.
            </p>

            <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 mb-6">
              <p className="font-semibold text-slate-900">{info.itemTitle}</p>
              {info.siteName && <p className="text-sm text-muted-foreground mt-1">{info.siteName}</p>}
            </div>

            <div
              {...dropZoneProps}
              className={cn(
                "border-2 border-dashed rounded-xl p-6 flex flex-col items-center justify-center text-center bg-muted/20",
                isDragging ? "border-emerald-500 bg-emerald-50" : "border-border",
              )}
            >
              {uploading ? (
                <>
                  <Loader2 className="w-8 h-8 text-emerald-600 mb-2 animate-spin" aria-hidden="true" />
                  <p className="text-sm font-medium">Sending {uploading}…</p>
                </>
              ) : (
                <>
                  <UploadCloud className="w-8 h-8 text-muted-foreground mb-2" aria-hidden="true" />
                  <p className="text-sm font-medium">Drag the certificate here, or</p>
                  <Button type="button" className="mt-2" onClick={() => input.current?.click()} disabled={info.uploadsLeft === 0}>
                    <FileUp className="w-4 h-4 mr-2" aria-hidden="true" /> Choose a file
                  </Button>
                  <p className="text-xs text-muted-foreground mt-2">A PDF or a photo, {Math.round(info.maxBytes / 1024 / 1024)} MB at most. You can send more than one.</p>
                  <input ref={input} type="file" multiple className="hidden" accept=".pdf,.jpg,.jpeg,.png,.heic,.docx,application/pdf,image/*"
                    onChange={(e) => { const files = Array.from(e.target.files ?? []); if (files.length) void upload(files); }} />
                </>
              )}
            </div>

            {sent.length > 0 && (
              <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 space-y-1">
                {sent.map((name, index) => (
                  <p key={`${name}-${index}`} className="flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4 shrink-0" aria-hidden="true" /> {name} sent. Thank you.
                  </p>
                ))}
              </div>
            )}
            {error && <p className="text-sm text-destructive mt-4" role="alert">{error}</p>}
          </div>
        )}
      </Card>
    </div>
  );
}
