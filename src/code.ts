// Attribute Clipboard — plugin sandbox / main thread.
//
// Responsibilities:
//   * Read styles off the currently selected FRAME ("Copy")
//   * Persist the collection across sessions via figma.clientStorage
//   * Reapply a saved style set to one or more selected FRAMEs ("Apply")
//   * Generate a small PNG thumbnail of the source frame for the UI list

type StrokeAlign = "INSIDE" | "OUTSIDE" | "CENTER";

// Node-level variable bindings we know how to re-apply via setBoundVariable.
// We deliberately skip fills/strokes/effects here — their variable links live
// inside the Paint/Effect objects themselves and survive raw assignment.
const BINDABLE_NODE_FIELDS = [
  "topLeftRadius",
  "topRightRadius",
  "bottomLeftRadius",
  "bottomRightRadius",
  "opacity",
  "strokeTopWeight",
  "strokeRightWeight",
  "strokeBottomWeight",
  "strokeLeftWeight",
] as const;
type BindableNodeField = (typeof BINDABLE_NODE_FIELDS)[number];

type StoredBoundVariables = Partial<Record<BindableNodeField, { id: string }>>;

type SerializableAttributes = {
  // Paint/effect arrays. Variable bindings *inside* Paint/Effect objects
  // (e.g., a fill color bound to a color variable) survive raw assignment, so
  // we don't need to track them separately.
  fills: ReadonlyArray<Paint>;
  strokes: ReadonlyArray<Paint>;
  effects: ReadonlyArray<Effect>;

  // Shared style links (paint style, stroke style, effect style). When the
  // target file has the same style, we re-link via setXxxStyleIdAsync so the
  // applied frame stays connected to the style. Empty string = no link.
  fillStyleId: string;
  strokeStyleId: string;
  effectStyleId: string;

  // Scalar properties — also serve as the fallback if style/variable links
  // can't be resolved in the target file.
  strokeTopWeight: number;
  strokeRightWeight: number;
  strokeBottomWeight: number;
  strokeLeftWeight: number;
  strokeAlign: StrokeAlign;
  topLeftRadius: number;
  topRightRadius: number;
  bottomLeftRadius: number;
  bottomRightRadius: number;
  cornerSmoothing: number;
  opacity: number;
  blendMode: BlendMode;

  // Node-level variable bindings (radii, opacity, per-side stroke weight).
  boundVariables: StoredBoundVariables;
};

// User-controlled per-entry mask: which attribute groups Apply will push.
// Defaults to all-true on copy; persists across reloads.
type ApplyMask = {
  fills: boolean;
  strokes: boolean;
  effects: boolean;
  cornerRadius: boolean;
  opacity: boolean;
  blendMode: boolean;
};

const DEFAULT_MASK: ApplyMask = {
  fills: true,
  strokes: true,
  effects: true,
  cornerRadius: true,
  opacity: true,
  blendMode: true,
};

type MaskField = keyof ApplyMask;

type StyleEntry = {
  id: string;
  createdAt: number;
  sourceName: string;
  thumbnail: string; // data URL
  attributes: SerializableAttributes;
  applyMask: ApplyMask;
};

type UiMessage =
  | { type: "COPY_FROM_SELECTION" }
  | { type: "APPLY_TO_SELECTION"; itemId: string }
  | { type: "DELETE_ITEM"; itemId: string }
  | { type: "CLEAR_ALL" }
  | { type: "RENAME_ITEM"; itemId: string; name: string }
  | { type: "RENAME_FOLDER"; oldPath: string; newPath: string }
  | { type: "UPDATE_MASK"; itemId: string; field: MaskField; value: boolean }
  | { type: "WELCOME_SEEN" };

const STORAGE_KEY = "attribute-clipboard-items-v1";
// Bumping the suffix retriggers the welcome modal for everyone — useful if
// we ever materially change the folder/slash UX.
const WELCOME_KEY = "attribute-clipboard:welcome-v1-seen";
const MAX_ITEMS = 30;
// Source PNG width for thumbnails. Now displayed at ~64 px square in the
// group header, so a 200 px source is ~3x retina — plenty sharp and small
// enough that 30 entries fit comfortably under any clientStorage limit.
const THUMBNAIL_WIDTH = 200;

figma.showUI(__html__, { width: 460, height: 740, themeColors: true });

(async () => {
  const items = await loadItems();
  postLoaded(items);
  postSelection();

  // First-launch popup: show only if the user hasn't dismissed it before.
  let seen = false;
  try {
    seen = (await figma.clientStorage.getAsync(WELCOME_KEY)) === true;
  } catch {
    // clientStorage failure is non-fatal — we just show the welcome again.
  }
  figma.ui.postMessage({ type: "WELCOME_INIT", show: !seen });
})();

figma.on("selectionchange", postSelection);

figma.ui.onmessage = async (msg: UiMessage) => {
  try {
    if (msg.type === "COPY_FROM_SELECTION") {
      await handleCopy();
    } else if (msg.type === "APPLY_TO_SELECTION") {
      await handleApply(msg.itemId);
    } else if (msg.type === "DELETE_ITEM") {
      await handleDelete(msg.itemId);
    } else if (msg.type === "CLEAR_ALL") {
      await figma.clientStorage.setAsync(STORAGE_KEY, []);
      postLoaded([]);
    } else if (msg.type === "RENAME_ITEM") {
      await handleRename(msg.itemId, msg.name);
    } else if (msg.type === "RENAME_FOLDER") {
      await handleRenameFolder(msg.oldPath, msg.newPath);
    } else if (msg.type === "UPDATE_MASK") {
      await handleUpdateMask(msg.itemId, msg.field, msg.value);
    } else if (msg.type === "WELCOME_SEEN") {
      try {
        await figma.clientStorage.setAsync(WELCOME_KEY, true);
      } catch {
        // Best-effort; user can dismiss again on next launch.
      }
    }
  } catch (err) {
    figma.notify(
      "Attribute Clipboard: " + (err instanceof Error ? err.message : String(err)),
      { error: true }
    );
  }
};

async function handleCopy() {
  const sel = figma.currentPage.selection;
  if (sel.length !== 1) {
    figma.notify("Select exactly one frame to copy styles from.", { error: true });
    return;
  }
  if (sel[0].type !== "FRAME") {
    figma.notify("Only FRAME nodes are supported (selected: " + sel[0].type + ").", {
      error: true,
    });
    return;
  }
  const frame = sel[0] as FrameNode;

  const attributes = readAttributes(frame);

  const bytes = await frame.exportAsync({
    format: "PNG",
    constraint: { type: "WIDTH", value: THUMBNAIL_WIDTH },
  });
  const thumbnail = bytesToDataUrl(bytes);

  const item: StyleEntry = {
    id: generateId(),
    createdAt: Date.now(),
    sourceName: frame.name,
    thumbnail,
    attributes,
    applyMask: Object.assign({}, DEFAULT_MASK),
  };

  const items = await loadItems();
  items.unshift(item);
  if (items.length > MAX_ITEMS) items.length = MAX_ITEMS;
  await saveItems(items);

  postLoaded(items);
  figma.notify('Copied styles from "' + frame.name + '"');
}

async function handleApply(itemId: string) {
  const sel = figma.currentPage.selection;
  const targets = sel.filter((n): n is FrameNode => n.type === "FRAME");
  if (targets.length === 0) {
    figma.notify("Select one or more frames to apply styles to.", { error: true });
    return;
  }

  const items = await loadItems();
  const item = items.find((i) => i.id === itemId);
  if (!item) {
    figma.notify("That clipboard entry no longer exists.", { error: true });
    return;
  }

  // Sequential — figma.variables.getVariableByIdAsync may need to load library
  // pages under dynamic-page access; running in parallel can stampede that.
  for (const target of targets) {
    await applyAttributes(target, item.attributes, item.applyMask);
  }

  figma.notify(
    'Applied "' +
      item.sourceName +
      '" styles to ' +
      targets.length +
      (targets.length === 1 ? " frame" : " frames")
  );
}

async function handleDelete(itemId: string) {
  const items = await loadItems();
  const filtered = items.filter((i) => i.id !== itemId);
  await saveItems(filtered);
  postLoaded(filtered);
}

// Returns the desired path if no other entry already occupies it; otherwise
// appends an ascending integer (1, 2, 3, ...) until a free path is found.
//
// "Occupies" means: an entry has sourceName equal to the candidate (leaf
// collision) OR starts with `candidate + "/"` (folder collision). This catches
// both leaf-vs-leaf and leaf-vs-folder duplicates so the tree never has two
// siblings sharing a name.
function resolveFreePath(
  desiredPath: string,
  others: ReadonlyArray<StyleEntry>
): string {
  const isTaken = (candidate: string): boolean => {
    const childPrefix = candidate + "/";
    for (const i of others) {
      if (i.sourceName === candidate) return true;
      if (i.sourceName.indexOf(childPrefix) === 0) return true;
    }
    return false;
  };
  if (!isTaken(desiredPath)) return desiredPath;

  // Split into parent + leaf so the number is appended to the LAST segment
  // only: "controls/card" -> "controls/card1", not "controls/card/1".
  const lastSlash = desiredPath.lastIndexOf("/");
  const parent = lastSlash === -1 ? "" : desiredPath.substring(0, lastSlash);
  const baseLeaf = lastSlash === -1 ? desiredPath : desiredPath.substring(lastSlash + 1);
  const prefix = parent ? parent + "/" : "";

  let n = 1;
  while (isTaken(prefix + baseLeaf + n)) n++;
  return prefix + baseLeaf + n;
}

async function handleRename(itemId: string, name: string) {
  const items = await loadItems();
  const trimmed = name.trim();
  if (!trimmed) return;
  const target = items.find((i) => i.id === itemId);
  if (!target || target.sourceName === trimmed) return;

  const others = items.filter((i) => i.id !== itemId);
  const resolved = resolveFreePath(trimmed, others);
  if (resolved === target.sourceName) return;
  if (resolved !== trimmed) {
    figma.notify('"' + trimmed + '" already exists. Renamed to "' + resolved + '".');
  }

  const updated = items.map((i) =>
    i.id === itemId ? Object.assign({}, i, { sourceName: resolved }) : i
  );
  await saveItems(updated);
  postLoaded(updated);
}

// Folder rename: rewrite the prefix on every entry that lives under oldPath.
// Folders are virtual in our storage model — they exist only because some
// entries' sourceName starts with the folder's path. Renaming the folder
// therefore means rewriting that prefix on each matching entry.
//
// If the requested newPath collides with a sibling folder/entry, append an
// ascending integer ("card" -> "card1", "card2", ...). Descendants follow
// whichever resolved path we ended up with.
async function handleRenameFolder(oldPath: string, newPath: string) {
  if (!oldPath || !newPath || oldPath === newPath) return;
  const items = await loadItems();
  const oldPrefix = oldPath + "/";

  // Conflict check should ignore the entries that are about to move, since
  // their old paths are being replaced anyway.
  const others = items.filter(
    (i) => i.sourceName !== oldPath && i.sourceName.indexOf(oldPrefix) !== 0
  );
  const resolved = resolveFreePath(newPath, others);
  if (resolved !== newPath) {
    figma.notify('"' + newPath + '" already exists. Renamed to "' + resolved + '".');
  }

  const resolvedPrefix = resolved + "/";
  let changed = false;
  const updated = items.map((i) => {
    let next = i.sourceName;
    if (i.sourceName === oldPath) {
      next = resolved;
    } else if (i.sourceName.indexOf(oldPrefix) === 0) {
      next = resolvedPrefix + i.sourceName.substring(oldPrefix.length);
    }
    if (next === i.sourceName) return i;
    changed = true;
    return Object.assign({}, i, { sourceName: next });
  });
  if (!changed) return;
  await saveItems(updated);
  postLoaded(updated);
}

async function handleUpdateMask(itemId: string, field: MaskField, value: boolean) {
  const items = await loadItems();
  const updated = items.map((i) => {
    if (i.id !== itemId) return i;
    const nextMask = Object.assign({}, i.applyMask, { [field]: value });
    return Object.assign({}, i, { applyMask: nextMask });
  });
  await saveItems(updated);
  // No postLoaded — UI already reflects the toggle optimistically.
}

function readAttributes(frame: FrameNode): SerializableAttributes {
  // FrameNode.fills/strokes are own arrays (never figma.mixed for a single frame).
  return {
    fills: frame.fills as ReadonlyArray<Paint>,
    strokes: frame.strokes,
    effects: frame.effects,
    fillStyleId: asStyleId(frame.fillStyleId),
    strokeStyleId: asStyleId(frame.strokeStyleId),
    effectStyleId: asStyleId(frame.effectStyleId),
    strokeTopWeight: frame.strokeTopWeight,
    strokeRightWeight: frame.strokeRightWeight,
    strokeBottomWeight: frame.strokeBottomWeight,
    strokeLeftWeight: frame.strokeLeftWeight,
    strokeAlign: frame.strokeAlign,
    topLeftRadius: frame.topLeftRadius,
    topRightRadius: frame.topRightRadius,
    bottomLeftRadius: frame.bottomLeftRadius,
    bottomRightRadius: frame.bottomRightRadius,
    cornerSmoothing: frame.cornerSmoothing,
    opacity: frame.opacity,
    blendMode: frame.blendMode,
    boundVariables: extractBoundVariables(frame),
  };
}

// Which node-level bindable fields belong to which mask group. Keeps the
// variable re-bind step gated on the same checkbox the user toggled.
const FIELD_TO_GROUP: Record<BindableNodeField, MaskField> = {
  topLeftRadius: "cornerRadius",
  topRightRadius: "cornerRadius",
  bottomLeftRadius: "cornerRadius",
  bottomRightRadius: "cornerRadius",
  opacity: "opacity",
  strokeTopWeight: "strokes",
  strokeRightWeight: "strokes",
  strokeBottomWeight: "strokes",
  strokeLeftWeight: "strokes",
};

// Layered apply, gated by the per-entry mask:
//   1. Raw values   — fallback if no style/variable link resolves.
//   2. Style links  — re-link fills/strokes/effects to the matching style.
//   3. Node vars    — re-bind radii / opacity / per-side stroke weight.
// Each step only runs for groups the mask enables.
async function applyAttributes(
  frame: FrameNode,
  a: SerializableAttributes,
  mask: ApplyMask
): Promise<void> {
  // 1. Raw values per group.
  if (mask.fills) {
    frame.fills = a.fills;
  }
  if (mask.strokes) {
    frame.strokes = a.strokes;
    frame.strokeTopWeight = a.strokeTopWeight;
    frame.strokeRightWeight = a.strokeRightWeight;
    frame.strokeBottomWeight = a.strokeBottomWeight;
    frame.strokeLeftWeight = a.strokeLeftWeight;
    frame.strokeAlign = a.strokeAlign;
  }
  if (mask.effects) {
    frame.effects = a.effects;
  }
  if (mask.cornerRadius) {
    frame.topLeftRadius = a.topLeftRadius;
    frame.topRightRadius = a.topRightRadius;
    frame.bottomLeftRadius = a.bottomLeftRadius;
    frame.bottomRightRadius = a.bottomRightRadius;
    frame.cornerSmoothing = a.cornerSmoothing;
  }
  if (mask.opacity) {
    frame.opacity = a.opacity;
  }
  if (mask.blendMode) {
    frame.blendMode = a.blendMode;
  }

  // 2. Shared style links — silently no-op if the style id doesn't resolve.
  if (mask.fills) {
    await trySetStyle(() => frame.setFillStyleIdAsync(a.fillStyleId), a.fillStyleId);
  }
  if (mask.strokes) {
    await trySetStyle(() => frame.setStrokeStyleIdAsync(a.strokeStyleId), a.strokeStyleId);
  }
  if (mask.effects) {
    await trySetStyle(() => frame.setEffectStyleIdAsync(a.effectStyleId), a.effectStyleId);
  }

  // 3. Node-level variable bindings — gated by the group each field belongs to.
  for (const field of BINDABLE_NODE_FIELDS) {
    if (!mask[FIELD_TO_GROUP[field]]) continue;
    const alias = a.boundVariables[field];
    if (!alias || !alias.id) continue;
    try {
      const variable = await figma.variables.getVariableByIdAsync(alias.id);
      if (variable) {
        frame.setBoundVariable(field, variable);
      }
    } catch {
      // Variable lookup failed — leave the raw value in place.
    }
  }
}

function asStyleId(value: string | typeof figma.mixed): string {
  return typeof value === "string" ? value : "";
}

function extractBoundVariables(frame: FrameNode): StoredBoundVariables {
  const out: StoredBoundVariables = {};
  const bv = frame.boundVariables;
  if (!bv) return out;
  for (const field of BINDABLE_NODE_FIELDS) {
    const alias = (bv as Record<string, unknown>)[field] as VariableAlias | undefined;
    if (alias && typeof alias === "object" && typeof alias.id === "string") {
      out[field] = { id: alias.id };
    }
  }
  return out;
}

async function trySetStyle(fn: () => Promise<void>, id: string): Promise<void> {
  if (!id) {
    // Empty string means "no shared style on source" — call still clears any
    // pre-existing style link on the target so raw values win.
    try {
      await fn();
    } catch {
      // ignore
    }
    return;
  }
  try {
    await fn();
  } catch {
    // Style not found in target file — raw value from step 1 stays. This is
    // the intentional cross-file fallback.
  }
}

async function loadItems(): Promise<StyleEntry[]> {
  const raw = await figma.clientStorage.getAsync(STORAGE_KEY);
  if (!Array.isArray(raw)) return [];
  // Backfill applyMask on entries saved before the mask feature existed.
  return (raw as StyleEntry[]).map((i) =>
    i.applyMask
      ? i
      : Object.assign({}, i, { applyMask: Object.assign({}, DEFAULT_MASK) })
  );
}

async function saveItems(items: StyleEntry[]): Promise<void> {
  await figma.clientStorage.setAsync(STORAGE_KEY, items);
}

function postLoaded(items: StyleEntry[]) {
  figma.ui.postMessage({ type: "CLIPBOARD_LOADED", items });
}

function postSelection() {
  const sel = figma.currentPage.selection;
  const frames = sel.filter((n) => n.type === "FRAME").length;
  figma.ui.postMessage({
    type: "SELECTION_CHANGED",
    total: sel.length,
    frames,
  });
}

function bytesToDataUrl(bytes: Uint8Array): string {
  // figma.base64Encode is the sandbox-native path — bulletproof for binary
  // PNG data of any size, no manual chunking or fromCharCode dance required.
  return "data:image/png;base64," + figma.base64Encode(bytes);
}

function generateId(): string {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
}
