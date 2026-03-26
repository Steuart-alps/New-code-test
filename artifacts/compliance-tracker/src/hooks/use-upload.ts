import { useState } from "react";
import { useRequestUploadUrl } from "@workspace/api-client-react";

export function useUpload() {
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const { mutateAsync: requestUrl } = useRequestUploadUrl();

  const uploadFile = async (file: File): Promise<string> => {
    setIsUploading(true);
    setProgress(10);
    try {
      // 1. Get presigned URL
      const { uploadURL, objectPath } = await requestUrl({
        data: {
          name: file.name,
          size: file.size,
          contentType: file.type || "application/octet-stream",
        }
      });
      
      setProgress(40);

      // 2. Upload file directly to GCS via the presigned URL
      const response = await fetch(uploadURL, {
        method: "PUT",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
        },
        body: file,
      });

      if (!response.ok) {
        throw new Error("Failed to upload file to storage");
      }

      setProgress(100);
      return objectPath;
    } finally {
      setIsUploading(false);
      setTimeout(() => setProgress(0), 1000);
    }
  };

  return { uploadFile, isUploading, progress };
}
