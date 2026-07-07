/**
 * Rasterizes inline SVG markup to a PNG File, so a Graphics-tab pick (bundled shape or Iconify icon)
 * becomes a real, editable image `SourceAsset` through the normal `createAsset` upload path — not a
 * special-cased vector layer type. Renders on a solid-color-friendly transparent canvas at a fixed
 * square size; callers needing a specific aspect just accept the natural SVG viewBox distortion (all
 * bundled shapes and Iconify icons are effectively square already).
 */
export async function rasterizeSvgToFile(svg: string, fileName: string, size = 512): Promise<File> {
  const blob = new Blob([svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Failed to decode graphic SVG"));
      img.src = url;
    });
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(image, 0, 0, size, size);
    const pngBlob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!pngBlob) throw new Error("Failed to encode graphic PNG");
    return new File([pngBlob], fileName, { type: "image/png" });
  } finally {
    URL.revokeObjectURL(url);
  }
}
