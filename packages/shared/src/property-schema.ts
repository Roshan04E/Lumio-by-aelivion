/**
 * `PropertySchema` — the canonical description of an editable object (ADR-004), first implementation.
 *
 * ADR-004 has been Provisional since 2026-07-23 with implementation deliberately deferred until a real
 * adopter needed it. ADR-023 S4 is that adopter: `TextStyle` (see `text-style-schema.ts`). This file is
 * the **minimal first cut** the ADR's own self-critique recommends and nothing more —
 * `{ id, version, metadata, groups(flat), fields[], migrations, documentation }`, with `defaults` folded
 * into a computed accessor and `presetable` folded into a field-envelope flag.
 *
 * INERT BY CONSTRUCTION. No React, no DOM, no domain logic, no imports from web. A schema describes an
 * object; an ADAPTER (ADR-005) turns it into bound `PropertyField[]`; `PropertyFieldList` (ADR-002)
 * turns those into widgets. That layering is why this lives in `shared`: the worker, the API and any
 * future AI/command-palette consumer read the same description the inspector does.
 *
 * WHAT IS DELIBERATELY ABSENT. No `x`/extension namespace, no nested groups, and only the migration
 * operations an actual migration has needed (see {@link PropertyMigration}). ADR-001/ADR-004 both say
 * not to evolve this speculatively; the founder directive on dormant code says the same. Add an
 * operation when a migration needs it — the runner's switch is exhaustive, so the compiler will name
 * the gap rather than silently no-op.
 */

/**
 * The frozen field taxonomy (ADR-003) — 15 data kinds + 2 meta escape hatches.
 *
 * This union is the **target API**, and stating it here is not the same as shipping it: the renderer
 * today implements a subset (`number`/`vec2`/`boolean`/`enum`/`color`/`text`/`reference`/`control`/
 * `custom`), and a schema field on a kind the renderer lacks is bridged by its adapter through
 * `control` — which is what that escape hatch is for. Adding a member to this union is a doctrine
 * change under ADR-003's four-part promotion rule (distinct shape, distinct editor, distinct
 * validation/keyframe semantics, two unrelated systems), never a stage decision. Metadata evolves
 * before taxonomy.
 *
 * **Promoting a kind out of the unbuilt remainder is a different act, governed by a different rule.**
 * `reference` was frozen into this union from the start and became buildable in ADR-023 S4b under the
 * renderer-subset clause ("promoted on first genuine two-system demand"), with no change to the
 * taxonomy and no four-part test. Check which of the two states a kind is in before concluding that a
 * promotion review is owed.
 */
export type PropertyFieldKind =
  // Primitive
  | "number"
  | "boolean"
  | "text"
  | "enum"
  | "color"
  // Composite
  | "vector"
  | "transform"
  | "gradient"
  | "list"
  // Reference
  | "reference"
  | "file"
  // Specialized
  | "curve"
  | "colorCurves"
  | "colorWheels"
  | "spline"
  // Meta escape hatches
  | "control"
  | "custom";

/**
 * **Interpolability is a property of the KIND** (ADR-003, Consequences), stated here once rather than
 * as a per-field flag every adapter could get wrong in a different way.
 *
 * A kind is interpolable when a value halfway between two values of it is a meaningful value of it.
 * That is the whole test, and it is why `reference` is false: half of asset A and asset B is not an
 * asset, and a font halfway between two files is not a font. Such a property can still be ANIMATED —
 * a hold/step track switches from one reference to another at a keyframe — but that is a different
 * mechanism from interpolation and no consumer should infer one from the other.
 *
 * The renderer enforces this structurally as well: the `reference` field carries no `keyframe`
 * member, so an adapter cannot hand one to a picker even by accident.
 */
export const propertyKindInterpolable: Readonly<Record<PropertyFieldKind, boolean>> = {
  number: true,
  boolean: false,
  text: false,
  enum: false,
  color: true,
  vector: true,
  transform: true,
  gradient: true,
  list: false,
  reference: false,
  file: false,
  curve: true,
  colorCurves: true,
  colorWheels: true,
  spline: true,
  // The escape hatches describe an editor, not a data shape, so the kind cannot answer this — the
  // widget owns whatever semantics it brought with it.
  control: false,
  custom: false
};

export function isInterpolablePropertyKind(kind: PropertyFieldKind): boolean {
  return propertyKindInterpolable[kind];
}

/** What a `reference` field points at (ADR-003: reference absorbs asset/clip/composition/font/…). */
export type PropertyReferenceType =
  | "asset"
  | "clip"
  | "composition"
  | "layer"
  | "track"
  | "marker"
  | "effect"
  | "font";

/** Documentation is metadata only (ADR-004): names and hints, never behaviour. */
export interface PropertyDocumentation {
  description?: string | undefined;
  tooltip?: string | undefined;
  /** Synonyms an AI/command-palette consumer can match on — "typeface" for `fontFamily`. */
  aiSynonyms?: readonly string[] | undefined;
}

/**
 * One property of an editable object — inert metadata, no value and no handlers.
 *
 * `K` is the key union, so a schema can be typed against the object it describes and a typo becomes a
 * compile error rather than a field that silently never renders.
 */
export interface PropertySchemaField<K extends string = string> {
  key: K;
  kind: PropertyFieldKind;
  /** A `groups[].id`. Grouping is metadata; the inspector chooses layout (ADR-004). */
  group: string;
  label: string;
  /** Number envelope. `unit` is a modifier on `number`, never its own kind (ADR-003). */
  unit?: "px" | "em" | "percent" | "deg" | "seconds" | "ratio" | undefined;
  min?: number | undefined;
  max?: number | undefined;
  step?: number | undefined;
  /** `enum` options, as stable ids + display labels (localization keys off the id, never the label). */
  options?: ReadonlyArray<{ value: string; label: string }> | undefined;
  /** `reference` target type. */
  refType?: PropertyReferenceType | undefined;
  /** `vector` semantic — vec2/vec3/rect/dual-range all live on one kind (ADR-003). */
  semantic?: "vec2" | "vec3" | "rect" | "dual-range" | undefined;
  /**
   * The value this field means when absent. **Absent is not always the default**: several ADR-023
   * fields are permanently absent-means-legacy (D1a), and for those `absenceIsMeaningful` is set and
   * nothing may write the default in on load. See {@link propertySchemaDefaults}.
   */
  defaultValue?: unknown;
  /**
   * True when "no key" is a distinct, permanent state rather than shorthand for `defaultValue`
   * (ADR-023 D1a, `strokePaintOrder`/`direction`). A migration that fills these in is a bug: it
   * changes emitted CSS for a project the user never touched.
   */
  absenceIsMeaningful?: boolean | undefined;
  /** Does a preset / clipboard envelope carry this field? (ADR-004: presetable is a field flag.) */
  presetable?: boolean | undefined;
  /** The keyframe track property, when this field is animatable (e.g. `style.fontSize`). */
  animatableAs?: string | undefined;
  documentation?: PropertyDocumentation | undefined;
}

/** A flat, single-level group (ADR-004: no nesting until a real need appears). */
export interface PropertySchemaGroup {
  id: string;
  label: string;
}

/**
 * A migration operation — pure data, `(values) → values`, run at load time before any adapter or
 * renderer sees the values, and applied identically to project data, presets and clipboard (ADR-004).
 *
 * ADR-004 names six operations. Two are implemented, because two is what has been needed; the other
 * four (`splitField`, `mergeFields`, `changeDefault`, `setKind`) are added by whichever migration
 * first needs one. The runner switches exhaustively, so a new member fails to compile until it is
 * handled — the gap cannot become a silent no-op.
 */
export type PropertyMigration =
  | { op: "renameField"; from: number; to: string; field: string }
  | { op: "deprecateField"; from: number; field: string };

/** The canonical description of an editable object (ADR-004). */
export interface PropertySchema<K extends string = string> {
  id: string;
  /** Versioned independently of the UI. Bumped only alongside a migration entry. */
  version: number;
  metadata: { name: string; description?: string | undefined };
  groups: readonly PropertySchemaGroup[];
  fields: ReadonlyArray<PropertySchemaField<K>>;
  migrations: readonly PropertyMigration[];
  documentation?: PropertyDocumentation | undefined;
}

/**
 * The one serialized shape (ADR-004 / ADR-023 T-10): **project data, presets and clipboard are the
 * same envelope** and pass through the same migrations. A preset saved today therefore still loads
 * after the schema changes, which is the entire reason presets are schema-shaped rather than a bag.
 */
export interface PropertyValuesEnvelope<V = Record<string, unknown>> {
  schemaId: string;
  version: number;
  values: V;
}

/**
 * Values a field-by-field default lookup produces. Fields whose absence is meaningful are OMITTED, not
 * defaulted — the ADR-023 D1a rule, expressed once here rather than at each consumer.
 */
export function propertySchemaDefaults<K extends string>(schema: PropertySchema<K>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of schema.fields) {
    if (field.absenceIsMeaningful) continue;
    if (field.defaultValue === undefined) continue;
    out[field.key] = field.defaultValue;
  }
  return out;
}

/** The keys a preset / clipboard envelope carries for this schema (`presetable` fields, in order). */
export function propertySchemaPresetKeys<K extends string>(schema: PropertySchema<K>): K[] {
  return schema.fields.filter((field) => field.presetable).map((field) => field.key);
}

export function propertySchemaField<K extends string>(
  schema: PropertySchema<K>,
  key: K
): PropertySchemaField<K> | undefined {
  return schema.fields.find((field) => field.key === key);
}

/** Fields in one group, in declaration order. */
export function propertySchemaGroupFields<K extends string>(
  schema: PropertySchema<K>,
  groupId: string
): Array<PropertySchemaField<K>> {
  return schema.fields.filter((field) => field.group === groupId);
}

export type PropertyMigrationResult<V> =
  | { ok: true; values: V; migrated: boolean }
  | { ok: false; reason: string };

/**
 * Run a schema's migrations over an envelope, oldest first.
 *
 * Refuses rather than guesses in the two cases where guessing loses data:
 *
 * - **Wrong schema.** A `text-style` envelope pasted onto a shape is not a value to coerce.
 * - **A version from the future.** Values written by a newer build may carry fields this build has no
 *   migration for; applying them anyway would silently keep whatever it did not understand and drop
 *   whatever it did. The caller gets a reason it can show, which is the ADR-023 D3 posture (degrade
 *   visibly, never silently) applied to data rather than to fonts.
 *
 * Nothing is written for a field that is simply absent — migration moves values, it never fills in
 * defaults, because "absent" is load-bearing for the D1a fields.
 */
export function migratePropertyValues<V extends object>(
  schema: PropertySchema<string>,
  envelope: PropertyValuesEnvelope<V>
): PropertyMigrationResult<V> {
  if (envelope.schemaId !== schema.id) {
    return { ok: false, reason: `expected schema "${schema.id}", got "${envelope.schemaId}"` };
  }
  if (!Number.isInteger(envelope.version) || envelope.version < 0) {
    return { ok: false, reason: `unreadable schema version ${String(envelope.version)}` };
  }
  if (envelope.version > schema.version) {
    return {
      ok: false,
      reason: `saved at schema version ${envelope.version}, which is newer than this build's ${schema.version}`
    };
  }

  const pending = schema.migrations
    .filter((migration) => migration.from >= envelope.version)
    .sort((a, b) => a.from - b.from);
  if (!pending.length) return { ok: true, values: envelope.values, migrated: false };

  const values: Record<string, unknown> = { ...(envelope.values as Record<string, unknown>) };
  for (const migration of pending) {
    switch (migration.op) {
      case "renameField": {
        if (migration.field in values) {
          const carried = values[migration.field];
          delete values[migration.field];
          // A rename never clobbers a value already sitting under the new name — that would be the
          // newer field losing to the older one, which is backwards.
          if (!(migration.to in values)) values[migration.to] = carried;
        }
        break;
      }
      case "deprecateField": {
        delete values[migration.field];
        break;
      }
    }
  }
  return { ok: true, values: values as V, migrated: true };
}
