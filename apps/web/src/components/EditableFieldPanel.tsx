import type { EditableFieldDefinition } from "@orreris/shared";
import { ThemedSelect } from "../editor/inspector/controls/ThemedSelect";

export function EditableFieldPanel({
  fields,
  values,
  onChange
}: {
  fields: EditableFieldDefinition[];
  values: Record<string, unknown>;
  onChange: (key: string, value: unknown) => void;
}) {
  const mergedFields = fields.length
    ? fields
    : Object.keys(values).map((key) => ({
        key,
        label: key.replace(/([A-Z])/g, " $1"),
        type: "text" as const,
        defaultValue: String(values[key] ?? "")
      }));

  return (
    <div className="field-panel">
      <div className="panel-heading">
        <h2>Fields</h2>
      </div>
      {mergedFields.map((field) => (
        <label className="field-control" key={field.key}>
          <span>{field.label}</span>
          {field.type === "select" ? (
            <ThemedSelect
              ariaLabel={field.label}
              value={String(values[field.key] ?? field.defaultValue)}
              options={(field.options ?? []).map((option) => ({ value: option, label: option }))}
              onChange={(next) => onChange(field.key, next)}
            />
          ) : field.type === "boolean" ? (
            <input
              type="checkbox"
              checked={Boolean(values[field.key] ?? field.defaultValue)}
              onChange={(event) => onChange(field.key, event.target.checked)}
            />
          ) : (
            <input
              type={field.type === "number" ? "number" : field.type === "color" ? "color" : "text"}
              value={String(values[field.key] ?? field.defaultValue)}
              onChange={(event) =>
                onChange(field.key, field.type === "number" ? Number(event.target.value) : event.target.value)
              }
            />
          )}
        </label>
      ))}
    </div>
  );
}
