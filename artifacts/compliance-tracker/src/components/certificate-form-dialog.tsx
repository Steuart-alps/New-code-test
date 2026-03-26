import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { 
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter 
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useAppMutations } from "@/hooks/use-app-data";
import { useUpload } from "@/hooks/use-upload";
import { Certificate } from "@workspace/api-client-react";
import { UploadCloud, FileText, CheckCircle2 } from "lucide-react";

const formSchema = z.object({
  name: z.string().min(1, "Name is required"),
  issueDate: z.string().optional().nullable(),
  expiryDate: z.string().optional().nullable(),
  notes: z.string().optional(),
});

type FormValues = z.infer<typeof formSchema>;

export function CertificateFormDialog({
  isOpen,
  onClose,
  contractorId,
  certificate = null,
}: {
  isOpen: boolean;
  onClose: () => void;
  contractorId: number;
  certificate?: Certificate | null;
}) {
  const { createCertificate, updateCertificate } = useAppMutations();
  const { uploadFile, isUploading, progress } = useUpload();
  
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  
  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: "",
      issueDate: "",
      expiryDate: "",
      notes: "",
    }
  });

  useEffect(() => {
    if (certificate) {
      form.reset({
        name: certificate.name,
        issueDate: certificate.issueDate ? new Date(certificate.issueDate).toISOString().slice(0, 16) : "",
        expiryDate: certificate.expiryDate ? new Date(certificate.expiryDate).toISOString().slice(0, 16) : "",
        notes: certificate.notes || "",
      });
      setSelectedFile(null);
    } else {
      form.reset({
        name: "",
        issueDate: "",
        expiryDate: "",
        notes: "",
      });
      setSelectedFile(null);
    }
  }, [certificate, isOpen, form]);

  const onSubmit = async (data: FormValues) => {
    try {
      let objectPath = certificate?.fileUrl;

      if (selectedFile) {
        objectPath = await uploadFile(selectedFile);
      }

      const payload = {
        ...data,
        fileUrl: objectPath,
        issueDate: data.issueDate ? new Date(data.issueDate).toISOString() : null,
        expiryDate: data.expiryDate ? new Date(data.expiryDate).toISOString() : null,
      };

      if (certificate) {
        await updateCertificate.mutateAsync({ contractorId, id: certificate.id, data: payload });
      } else {
        await createCertificate.mutateAsync({ contractorId, data: payload });
      }
      onClose();
    } catch (e) {
      console.error(e);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle className="text-xl font-display">
            {certificate ? "Edit Certificate" : "Upload Certificate"}
          </DialogTitle>
        </DialogHeader>

        <form id="certificate-form" onSubmit={form.handleSubmit(onSubmit)} className="space-y-5 py-4">
          <div className="space-y-1.5">
            <Label htmlFor="name">Certificate Name *</Label>
            <Input id="name" {...form.register("name")} placeholder="e.g. Liability Insurance 2025" />
            {form.formState.errors.name && (
              <p className="text-xs text-destructive">{form.formState.errors.name.message}</p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="issueDate">Issue Date</Label>
              <Input type="datetime-local" id="issueDate" {...form.register("issueDate")} />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="expiryDate">Expiry Date</Label>
              <Input type="datetime-local" id="expiryDate" {...form.register("expiryDate")} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Certificate File</Label>
            {!certificate?.fileUrl && !selectedFile ? (
              <div className="border-2 border-dashed border-border rounded-xl p-6 flex flex-col items-center justify-center text-center bg-muted/20 hover:bg-muted/50 transition-colors relative">
                <input 
                  type="file" 
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  onChange={(e) => setSelectedFile(e.target.files?.[0] || null)}
                  accept=".pdf,.jpg,.jpeg,.png"
                />
                <UploadCloud className="w-8 h-8 text-muted-foreground mb-2" />
                <p className="text-sm font-medium">Click or drag file to upload</p>
                <p className="text-xs text-muted-foreground mt-1">PDF, JPG, PNG up to 10MB</p>
              </div>
            ) : (
              <div className="flex items-center justify-between p-4 border border-border rounded-xl bg-card">
                <div className="flex items-center gap-3">
                  <div className="bg-primary/10 p-2 rounded-lg">
                    <FileText className="w-5 h-5 text-primary" />
                  </div>
                  <div className="flex flex-col">
                    <span className="text-sm font-medium truncate max-w-[200px]">
                      {selectedFile ? selectedFile.name : "Existing Certificate File"}
                    </span>
                    {selectedFile && <span className="text-xs text-muted-foreground">{(selectedFile.size / 1024 / 1024).toFixed(2)} MB</span>}
                  </div>
                </div>
                <Button 
                  type="button" 
                  variant="ghost" 
                  size="sm"
                  onClick={() => {
                    setSelectedFile(null);
                    if (certificate) certificate.fileUrl = null; // visual clear only
                  }}
                >
                  Change
                </Button>
              </div>
            )}
            
            {isUploading && (
              <div className="space-y-2 mt-2">
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Uploading...</span>
                  <span>{progress}%</span>
                </div>
                <div className="w-full bg-secondary h-2 rounded-full overflow-hidden">
                  <div className="bg-primary h-full transition-all duration-300" style={{ width: `${progress}%` }} />
                </div>
              </div>
            )}
          </div>
          
          <div className="space-y-1.5">
            <Label htmlFor="notes">Notes</Label>
            <Textarea id="notes" {...form.register("notes")} className="resize-none h-16" />
          </div>
        </form>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} type="button" disabled={isUploading}>Cancel</Button>
          <Button type="submit" form="certificate-form" disabled={createCertificate.isPending || updateCertificate.isPending || isUploading}>
            {createCertificate.isPending || updateCertificate.isPending || isUploading ? "Saving..." : "Save Certificate"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
