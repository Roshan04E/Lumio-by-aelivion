import { useState } from "react";
import type { AttributeGroup } from "@kimera-by-aelivion/shared";
import { Modal } from "./Modal";
import { Button } from "./Button";

const GROUP_OPTIONS: { id: AttributeGroup; label: string; hint: string }[] = [
  { id: "transform", label: "Transform", hint: "position, scale, rotation, opacity, fades" },
  { id: "effects", label: "Effects", hint: "the whole effect stack" },
  { id: "fit", label: "Fit", hint: "cover / contain / stretch (video, image)" },
  { id: "masks", label: "Masks", hint: "clip masks" },
  { id: "content", label: "Content / Crop", hint: "source pan, zoom, crop" },
  { id: "speed", label: "Speed", hint: "playback rate" }
];

const STORAGE_KEY = "kimera_paste_attributes_groups";

export function loadPasteAttributeGroups(): Set<AttributeGroup> {
  if (typeof window === "undefined") return new Set(GROUP_OPTIONS.map((g) => g.id));
  try {
    const raw = window.localStorage?.getItem(STORAGE_KEY);
    if (!raw) return new Set(GROUP_OPTIONS.map((g) => g.id));
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed) || !parsed.length) return new Set(GROUP_OPTIONS.map((g) => g.id));
    const valid = new Set(GROUP_OPTIONS.map((g) => g.id));
    const filtered = parsed.filter((id): id is AttributeGroup => typeof id === "string" && valid.has(id as AttributeGroup));
    return filtered.length ? new Set(filtered) : new Set(GROUP_OPTIONS.map((g) => g.id));
  } catch {
    return new Set(GROUP_OPTIONS.map((g) => g.id));
  }
}

function saveGroups(groups: Set<AttributeGroup>): void {
  try {
    window.localStorage?.setItem(STORAGE_KEY, JSON.stringify([...groups]));
  } catch {
    /* quota/private mode — selection just won't persist this session */
  }
}

export function PasteAttributesModal({
  open,
  targetCount,
  onClose,
  onApply
}: {
  open: boolean;
  targetCount: number;
  onClose: () => void;
  onApply: (groups: Set<AttributeGroup>) => void;
}) {
  const [groups, setGroups] = useState<Set<AttributeGroup>>(() => loadPasteAttributeGroups());

  function toggle(id: AttributeGroup) {
    setGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function apply() {
    saveGroups(groups);
    onApply(groups);
    onClose();
  }

  return (
    <Modal title="Paste Attributes" open={open} onClose={onClose} className="paste-attributes-modal">
      <form
        className="paste-attributes-body"
        onSubmit={(event) => {
          event.preventDefault();
          if (groups.size > 0) apply();
        }}
      >
        <p className="paste-attributes-hint">
          Choose which attributes to paste onto {targetCount} clip{targetCount === 1 ? "" : "s"}.
        </p>
        <div className="paste-attributes-groups">
          {GROUP_OPTIONS.map((option) => (
            <label key={option.id} className="paste-attributes-group">
              <input type="checkbox" checked={groups.has(option.id)} onChange={() => toggle(option.id)} />
              <span>
                <strong>{option.label}</strong>
                <small>{option.hint}</small>
              </span>
            </label>
          ))}
        </div>
        <div className="paste-attributes-actions">
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={groups.size === 0}>
            Paste
          </Button>
        </div>
      </form>
    </Modal>
  );
}
