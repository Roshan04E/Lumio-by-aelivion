import type { ToolArtifact } from "@kimera-by-aelivion/shared";

export interface StoredToolArtifact extends ToolArtifact {
  blob?: Blob | undefined;
}

export interface ToolArtifactStore {
  kind: "opfs" | "memory";
  put: (artifact: StoredToolArtifact) => Promise<ToolArtifact>;
  get: (artifactId: string) => Promise<StoredToolArtifact | undefined>;
  remove: (artifactId: string) => Promise<void>;
  clearRun: (runId: string) => Promise<void>;
}

const memoryArtifacts = new Map<string, StoredToolArtifact>();

export async function createToolArtifactStore(): Promise<ToolArtifactStore> {
  const storage = navigator.storage as
    | (StorageManager & {
        getDirectory?: () => Promise<FileSystemDirectoryHandle>;
      })
    | undefined;

  if (!storage?.getDirectory) {
    return createMemoryArtifactStore();
  }

  try {
    const root = await storage.getDirectory();
    const directory = await root.getDirectoryHandle("kimera-tool-artifacts", { create: true });
    return createOpfsArtifactStore(directory);
  } catch {
    return createMemoryArtifactStore();
  }
}

function createMemoryArtifactStore(): ToolArtifactStore {
  return {
    kind: "memory",
    async put(artifact) {
      memoryArtifacts.set(artifact.id, artifact);
      return stripBlob(artifact);
    },
    async get(artifactId) {
      return memoryArtifacts.get(artifactId);
    },
    async remove(artifactId) {
      memoryArtifacts.delete(artifactId);
    },
    async clearRun(runId) {
      for (const artifact of memoryArtifacts.values()) {
        if (artifact.metadata.runId === runId) {
          memoryArtifacts.delete(artifact.id);
        }
      }
    }
  };
}

function createOpfsArtifactStore(directory: FileSystemDirectoryHandle): ToolArtifactStore {
  const metadata = new Map<string, StoredToolArtifact>();

  return {
    kind: "opfs",
    async put(artifact) {
      const nextArtifact = { ...artifact };
      if (artifact.blob) {
        const fileName = `${artifact.id}.bin`;
        const file = await directory.getFileHandle(fileName, { create: true });
        const writable = await file.createWritable();
        await writable.write(artifact.blob);
        await writable.close();
        nextArtifact.uri = `opfs://kimera-tool-artifacts/${fileName}`;
      }
      metadata.set(artifact.id, nextArtifact);
      return stripBlob(nextArtifact);
    },
    async get(artifactId) {
      const artifact = metadata.get(artifactId);
      if (!artifact) {
        return undefined;
      }

      const fileName = artifact.uri?.replace("opfs://kimera-tool-artifacts/", "");
      if (!fileName) {
        return artifact;
      }

      try {
        const fileHandle = await directory.getFileHandle(fileName);
        const file = await fileHandle.getFile();
        return { ...artifact, blob: file };
      } catch {
        return artifact;
      }
    },
    async remove(artifactId) {
      const artifact = metadata.get(artifactId);
      metadata.delete(artifactId);
      const fileName = artifact?.uri?.replace("opfs://kimera-tool-artifacts/", "");
      if (fileName) {
        await directory.removeEntry(fileName).catch(() => undefined);
      }
    },
    async clearRun(runId) {
      for (const artifact of metadata.values()) {
        if (artifact.metadata.runId === runId) {
          await this.remove(artifact.id);
        }
      }
    }
  };
}

function stripBlob(artifact: StoredToolArtifact): ToolArtifact {
  const { blob: _blob, ...rest } = artifact;
  return rest;
}
