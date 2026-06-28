import { UploadCloud } from "lucide-react";
import { useRef } from "react";
import { Button } from "./Button";

export function UploadDropzone({
  file,
  onFile,
  accept = "video/*"
}: {
  file?: File | null;
  onFile: (file: File | null) => void;
  accept?: string;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  return (
    <div className="dropzone" onClick={() => inputRef.current?.click()}>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        onChange={(event) => onFile(event.currentTarget.files?.[0] ?? null)}
      />
      <UploadCloud size={28} />
      <div>
        <strong>{file ? file.name : accept.includes("image") ? "Upload media" : "Upload video"}</strong>
        <span>Video or image, portrait works best</span>
      </div>
      <Button type="button" variant="secondary">
        Choose File
      </Button>
    </div>
  );
}
