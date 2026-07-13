import { promises as fs } from "node:fs";
import path from "node:path";
import { env } from "../config/env";

const workspaceRoot = path.resolve(process.cwd(), "../..");
const storageRoot = path.isAbsolute(env.STORAGE_ROOT)
  ? env.STORAGE_ROOT
  : path.resolve(workspaceRoot, env.STORAGE_ROOT);

export const storagePaths = {
  root: storageRoot,
  uploads: path.join(storageRoot, "uploads"),
  previews: path.join(storageRoot, "previews"),
  finals: path.join(storageRoot, "finals"),
  derived: path.join(storageRoot, "derived")
};

export async function ensureStorage() {
  await Promise.all(Object.values(storagePaths).map((folder) => fs.mkdir(folder, { recursive: true })));
}

export function getPublicUrl(relativePath: string) {
  return `${env.API_PUBLIC_URL}/storage/${relativePath.replace(/^\/+/, "")}`;
}

export async function saveUpload(file: Express.Multer.File | undefined, fallbackName: string) {
  await ensureStorage();
  const safeName = sanitizeFileName(file?.originalname ?? fallbackName);
  const fileName = `${Date.now()}-${safeName}`;
  const destination = path.join(storagePaths.uploads, fileName);

  if (file?.buffer) {
    await fs.writeFile(destination, file.buffer);
  } else {
    await fs.writeFile(destination, "Mock upload placeholder for Kimera.\n");
  }

  return getPublicUrl(`uploads/${fileName}`);
}

/** Save raw bytes (e.g. a downloaded stock file) into uploads and return its public URL. */
export async function saveBuffer(buffer: Buffer, fileName: string) {
  await ensureStorage();
  const safeName = sanitizeFileName(fileName);
  const storedName = `${Date.now()}-${safeName}`;
  await fs.writeFile(path.join(storagePaths.uploads, storedName), buffer);
  return getPublicUrl(`uploads/${storedName}`);
}

export async function saveDerivedAsset(sourceAssetId: string, type: string, data: unknown) {
  await ensureStorage();
  const fileName = `${sourceAssetId}-${type.toLowerCase()}-${Date.now()}.json`;
  await fs.writeFile(path.join(storagePaths.derived, fileName), JSON.stringify(data, null, 2));
  return getPublicUrl(`derived/${fileName}`);
}

export async function savePreview(projectId: string, payload: unknown) {
  await ensureStorage();
  const fileName = `${projectId}-preview-${Date.now()}.json`;
  await fs.writeFile(path.join(storagePaths.previews, fileName), JSON.stringify(payload, null, 2));
  return getPublicUrl(`previews/${fileName}`);
}

export async function saveFinal(projectId: string, payload: unknown) {
  await ensureStorage();
  const fileName = `${projectId}-final-${Date.now()}.json`;
  await fs.writeFile(path.join(storagePaths.finals, fileName), JSON.stringify(payload, null, 2));
  return getPublicUrl(`finals/${fileName}`);
}

export async function deleteAsset(publicUrl: string) {
  const relative = publicUrl.replace(`${env.API_PUBLIC_URL}/storage/`, "");
  const target = path.join(storageRoot, relative);
  await fs.rm(target, { force: true });
}

export function resolvePublicStoragePath(publicUrl: string) {
  if (!publicUrl.startsWith(`${env.API_PUBLIC_URL}/storage/`)) {
    throw new Error("Only API-managed uploaded media can be used for server transcription.");
  }

  const relative = publicUrl.replace(`${env.API_PUBLIC_URL}/storage/`, "");
  return path.join(storageRoot, relative);
}

function sanitizeFileName(fileName: string) {
  return fileName.replace(/[^a-z0-9._-]/gi, "-").toLowerCase();
}
