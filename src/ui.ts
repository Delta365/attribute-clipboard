// Attribute Clipboard — UI iframe.
//
// Renders the list of saved style entries and brokers messages with the
// plugin sandbox (figma side). All persistence lives in the sandbox; this
// file is purely presentational.

import "./ui.css";

type Attributes = Record<string, unknown>;

type ApplyMask = {
  fills: boolean;
  strokes: boolean;
  effects: boolean;
  cornerRadius: boolean;
  opacity: boolean;
  blendMode: boolean;
};

type MaskField = keyof ApplyMask;

// Visual order + label for the per-entry checkbox strip.
const MASK_FIELDS: ReadonlyArray<{ field: MaskField; label: string }> = [
  { field: "fills", label: "Fill" },
  { field: "strokes", label: "Stroke" },
  { field: "effects", label: "Effects" },
  { field: "cornerRadius", label: "Radius" },
  { field: "opacity", label: "Opacity" },
  { field: "blendMode", label: "Blend" },
];

// ----- Folder tree helpers -----
// We adopt Figma's variables-panel convention: slashes in a group's name
// imply folder structure. So "buttons/primary" sits inside the "buttons"
// folder. Storage stays a flat list of StyleEntries (no schema change);
// the tree is derived on every render from `sourceName`.

type TreeFolder = {
  name: string; // leaf segment, e.g. "buttons"
  path: string; // full path from root, e.g. "controls/buttons"
  subfolders: TreeFolder[];
  entries: StyleEntry[];
};

// Trim, split on "/", drop empty segments. Returns null for a fully-empty
// input so callers can fall back to the unaltered raw string.
function parseFullName(raw: string): { segments: string[]; leaf: string } | null {
  const parts = raw
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) return null;
  return { segments: parts.slice(0, -1), leaf: parts[parts.length - 1] };
}

// Canonical form of a user-entered name: collapses whitespace and stray
// slashes so " buttons // primary " becomes "buttons/primary".
function normalizeName(raw: string): string {
  return raw
    .split("/")
    .map((p) => p.trim())
    .filter(Boolean)
    .join("/");
}

// The visible name on a card: the last slash-separated segment.
function getLeafName(fullName: string): string {
  const parsed = parseFullName(fullName);
  return parsed ? parsed.leaf : fullName;
}

// The folder portion of a full name. "buttons/primary" -> "buttons".
// Root-level entries return "".
function getParentPath(fullName: string): string {
  const parsed = parseFullName(fullName);
  return parsed && parsed.segments.length > 0 ? parsed.segments.join("/") : "";
}

// Build a folder tree from the flat entry list. Subfolders sort alphabetically;
// entries inside a folder keep the original (newest-first) order.
function buildTree(list: StyleEntry[]): TreeFolder {
  const root: TreeFolder = { name: "", path: "", subfolders: [], entries: [] };
  for (const entry of list) {
    const parsed = parseFullName(entry.sourceName);
    if (!parsed) {
      root.entries.push(entry);
      continue;
    }
    let current = root;
    let pathSoFar = "";
    for (const seg of parsed.segments) {
      pathSoFar = pathSoFar ? pathSoFar + "/" + seg : seg;
      let next = current.subfolders.find((f) => f.name === seg);
      if (!next) {
        next = { name: seg, path: pathSoFar, subfolders: [], entries: [] };
        current.subfolders.push(next);
      }
      current = next;
    }
    current.entries.push(entry);
  }
  // Sort subfolders alphabetically at every level.
  const sortRec = (f: TreeFolder) => {
    f.subfolders.sort((a, b) => a.name.localeCompare(b.name));
    f.subfolders.forEach(sortRec);
  };
  sortRec(root);
  return root;
}

function countEntries(folder: TreeFolder): number {
  let n = folder.entries.length;
  for (const sub of folder.subfolders) n += countEntries(sub);
  return n;
}

// Collapse state for folders, keyed by full path. In-memory only — resets on
// plugin reload, which is acceptable for v1.
const collapsedFolders = new Set<string>();

type StyleEntry = {
  id: string;
  createdAt: number;
  sourceName: string;
  thumbnail: string;
  attributes: Attributes;
  applyMask: ApplyMask;
};

type PluginMessage =
  | { type: "CLIPBOARD_LOADED"; items: StyleEntry[] }
  | { type: "SELECTION_CHANGED"; total: number; frames: number }
  | { type: "WELCOME_INIT"; show: boolean };

const listEl = document.getElementById("list") as HTMLElement;
const emptyEl = document.getElementById("empty") as HTMLElement;
const copyBtn = document.getElementById("copy-btn") as HTMLButtonElement;
const clearBtn = document.getElementById("clear-btn") as HTMLButtonElement;
const statusEl = document.getElementById("selection-status") as HTMLElement;
const countEl = document.getElementById("count") as HTMLElement;
const welcomeModal = document.getElementById("welcome-modal") as HTMLElement;
const welcomeClose = document.getElementById("welcome-close") as HTMLButtonElement;
const welcomeCta = document.getElementById("welcome-cta") as HTMLButtonElement;

let items: StyleEntry[] = [];
let selection = { total: 0, frames: 0 };

copyBtn.addEventListener("click", () => {
  post({ type: "COPY_FROM_SELECTION" });
});

clearBtn.addEventListener("click", () => {
  if (items.length === 0) return;
  const ok = confirm(
    "Remove all " + items.length + " saved groups? This cannot be undone."
  );
  if (ok) post({ type: "CLEAR_ALL" });
});

window.addEventListener("message", (event: MessageEvent) => {
  const msg = event.data && (event.data.pluginMessage as PluginMessage | undefined);
  if (!msg) return;
  if (msg.type === "CLIPBOARD_LOADED") {
    items = msg.items;
    render();
  } else if (msg.type === "SELECTION_CHANGED") {
    selection = { total: msg.total, frames: msg.frames };
    updateSelectionUi();
  } else if (msg.type === "WELCOME_INIT") {
    if (msg.show) showWelcome();
  }
});

// First-launch popup explaining the slash-folder convention. Dismissal
// happens through any of: Got it button, X button, backdrop click, or Esc.
// We post WELCOME_SEEN to the sandbox so we never show it again — guarded so
// the message only fires once even if the user clicks several controls.
let welcomeDismissed = false;

function showWelcome(): void {
  welcomeModal.hidden = false;
  // Move focus to the primary CTA for keyboard users.
  welcomeCta.focus();
}

function dismissWelcome(): void {
  if (welcomeDismissed) {
    welcomeModal.hidden = true;
    return;
  }
  welcomeDismissed = true;
  welcomeModal.hidden = true;
  post({ type: "WELCOME_SEEN" });
}

welcomeCta.addEventListener("click", dismissWelcome);
welcomeClose.addEventListener("click", dismissWelcome);
welcomeModal.addEventListener("click", (e) => {
  // Close on backdrop click — not on clicks inside the dialog.
  if (e.target === welcomeModal) dismissWelcome();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !welcomeModal.hidden) dismissWelcome();
});

function render() {
  listEl.innerHTML = "";

  // Parse slashes in sourceName into a folder tree, then walk it.
  const tree = buildTree(items);
  renderFolderContents(tree, listEl);

  const isEmpty = items.length === 0;
  emptyEl.hidden = !isEmpty;
  listEl.hidden = isEmpty;
  clearBtn.hidden = isEmpty;
  countEl.textContent = isEmpty
    ? ""
    : items.length + (items.length === 1 ? " group" : " groups");
}

// Render a folder's children: subfolders first (alphabetical), then any
// entries that live directly under this folder.
function renderFolderContents(folder: TreeFolder, parent: HTMLElement): void {
  for (const sub of folder.subfolders) {
    parent.appendChild(buildFolder(sub));
  }
  for (const entry of folder.entries) {
    parent.appendChild(buildItem(entry));
  }
}

// A folder is rendered as:
//   ┌─ folder ─────────────────────────────────────┐
//   │ ▸ Folder name                      (3)       │  ← header (clickable)
//   │   ┌─ folder-body (hidden when collapsed) ─┐  │
//   │   │   ...subfolders + entry cards...      │  │
//   │   └────────────────────────────────────── ┘  │
//   └──────────────────────────────────────────────┘
// Indentation accumulates naturally because .folder-body has padding-left.
function buildFolder(folder: TreeFolder): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "folder";
  wrap.dataset.path = folder.path;

  // Header is a div with role=button so we can nest an <input> for the
  // editable folder name without putting an input inside a button (invalid).
  const header = document.createElement("div");
  header.className = "folder-header";
  header.setAttribute("role", "button");
  header.setAttribute("tabindex", "0");
  const initiallyCollapsed = collapsedFolders.has(folder.path);
  header.setAttribute("aria-expanded", String(!initiallyCollapsed));
  header.setAttribute("aria-label", "Toggle folder " + folder.name);

  // Chevron — same Phosphor CaretRight used on group accordions.
  const chevron = document.createElement("span");
  chevron.className = "folder-chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.innerHTML =
    '<svg class="icon icon-16" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">' +
    '<polyline points="96 48 176 128 96 208" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/>' +
    "</svg>";

  // Editable folder name. Edits ONLY the current segment — the parent path is
  // preserved and the rename is broadcast as RENAME_FOLDER so the sandbox can
  // rewrite the prefix on every descendant entry.
  const nameInput = document.createElement("input");
  nameInput.className = "folder-name";
  nameInput.type = "text";
  nameInput.value = folder.name;
  nameInput.spellcheck = false;
  nameInput.addEventListener("click", (e) => e.stopPropagation());
  nameInput.addEventListener("mousedown", (e) => e.stopPropagation());
  nameInput.addEventListener("focus", () => nameInput.select());
  nameInput.addEventListener("blur", () => {
    // Strip slashes — moving across the tree is intentionally not supported
    // from the folder rename. To restructure, rename leaf entries directly.
    const newSegment = nameInput.value.replace(/\//g, "").trim();
    if (!newSegment) {
      nameInput.value = folder.name;
      return;
    }
    if (newSegment === folder.name) return;
    const parent = getParentPath(folder.path);
    const newPath = parent ? parent + "/" + newSegment : newSegment;
    post({ type: "RENAME_FOLDER", oldPath: folder.path, newPath });
    nameInput.value = newSegment; // optimistic
  });
  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      nameInput.blur();
    } else if (e.key === "Escape") {
      nameInput.value = folder.name;
      nameInput.blur();
    }
    e.stopPropagation();
  });

  const countTag = document.createElement("span");
  countTag.className = "folder-count";
  countTag.textContent = String(countEntries(folder));

  header.appendChild(chevron);
  header.appendChild(nameInput);
  header.appendChild(countTag);

  const body = document.createElement("div");
  body.className = "folder-body";
  body.hidden = initiallyCollapsed;
  renderFolderContents(folder, body);

  const toggle = () => {
    const wasCollapsed = collapsedFolders.has(folder.path);
    if (wasCollapsed) {
      collapsedFolders.delete(folder.path);
    } else {
      collapsedFolders.add(folder.path);
    }
    body.hidden = !wasCollapsed;
    header.setAttribute("aria-expanded", String(wasCollapsed));
  };

  // Click anywhere on the header toggles, EXCEPT clicks on the name input
  // (which stop propagation in their own listener). The click target check
  // is a belt-and-suspenders fallback for keyboard / synthetic clicks.
  header.addEventListener("click", (e) => {
    if (e.target === nameInput) return;
    toggle();
  });
  header.addEventListener("keydown", (e) => {
    if (e.target === nameInput) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  });

  wrap.appendChild(header);
  wrap.appendChild(body);
  return wrap;
}

// Each group renders as a self-contained accordion card:
//   ┌ card ─────────────────────────────────────┐
//   │ ┌─ header (always visible, click to ──┐   │
//   │ │  toggle) ─ thumbnail above name +   │   │
//   │ │  chevron + delete button overlay    │   │
//   │ └─────────────────────────────────────┘   │
//   │ ── body (hidden by default) ────────────  │
//   │   attribute checkboxes (one per row)      │
//   │   ── divider ──                           │
//   │   [ Apply to selection ]                  │
//   └───────────────────────────────────────────┘
function buildItem(item: StyleEntry): HTMLElement {
  const card = document.createElement("article");
  card.className = "group";
  card.dataset.id = item.id;

  // ---------- Header (always visible) ----------
  // One horizontal row:  [thumb]  [name + meta]   [delete]  [chevron]
  const header = document.createElement("div");
  header.className = "group-header";
  header.setAttribute("role", "button");
  header.setAttribute("tabindex", "0");
  header.setAttribute("aria-expanded", "false");
  header.setAttribute("aria-label", "Expand or collapse this group");

  // Thumbnail — small square to the left of the name.
  const thumb = document.createElement("div");
  thumb.className = "thumb";
  const img = document.createElement("img");
  img.src = item.thumbnail;
  img.alt = "";
  img.draggable = false;
  thumb.appendChild(img);

  // Name + meta column, takes remaining horizontal space.
  const titleText = document.createElement("div");
  titleText.className = "group-title-text";

  // Card name input edits ONLY the leaf segment. The folder portion of the
  // path is preserved automatically: if the entry is "buttons/primary" and
  // the user renames here to "primaryLarge", the stored name becomes
  // "buttons/primaryLarge". To change the folder, the user renames the
  // folder header itself (one level up in the tree).
  const name = document.createElement("input");
  name.className = "name";
  name.type = "text";
  name.value = getLeafName(item.sourceName);
  name.spellcheck = false;
  // Clicking / focusing the name should not toggle the accordion.
  name.addEventListener("click", (e) => e.stopPropagation());
  name.addEventListener("mousedown", (e) => e.stopPropagation());
  name.addEventListener("focus", () => name.select());
  name.addEventListener("blur", () => {
    // Strip any slashes the user typed — folder restructuring happens via the
    // folder header, not here. Trim whitespace too.
    const newLeaf = name.value.replace(/\//g, "").trim();
    if (!newLeaf) {
      name.value = getLeafName(item.sourceName);
      return;
    }
    const parentPath = getParentPath(item.sourceName);
    const newFullName = parentPath ? parentPath + "/" + newLeaf : newLeaf;
    if (newFullName !== item.sourceName) {
      post({ type: "RENAME_ITEM", itemId: item.id, name: newFullName });
      name.value = newLeaf; // optimistic
    } else {
      name.value = getLeafName(item.sourceName);
    }
  });
  name.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      name.blur();
    } else if (e.key === "Escape") {
      // Revert to current leaf so blur sees "no change" and bails.
      name.value = getLeafName(item.sourceName);
      name.blur();
    }
    // Don't bubble up to header (e.g., Enter would otherwise toggle).
    e.stopPropagation();
  });

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = relativeTime(item.createdAt);

  titleText.appendChild(name);
  titleText.appendChild(meta);

  // Delete — inline icon-only button, visible on card hover.
  // Button is 24x24 (comfortable hit area) but the Phosphor Trash glyph
  // inside is sized at 16x16 per the user's preference for this icon.
  const del = document.createElement("button");
  del.className = "delete-btn icon-btn-24";
  del.type = "button";
  del.title = "Remove group";
  del.setAttribute("aria-label", "Remove group");
  del.innerHTML =
    '<svg class="icon icon-16" viewBox="0 0 256 256" aria-hidden="true" xmlns="http://www.w3.org/2000/svg">' +
    // Top horizontal bar
    '<path d="M216,48H40" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/>' +
    // Two interior ridges
    '<line x1="104" y1="104" x2="104" y2="168" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<line x1="152" y1="104" x2="152" y2="168" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/>' +
    // Bin body
    '<path d="M200,48V208a8,8,0,0,1-8,8H64a8,8,0,0,1-8-8V48" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/>' +
    // Handle / lid top
    '<path d="M168,48V32a16,16,0,0,0-16-16H104A16,16,0,0,0,88,32V48" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/>' +
    "</svg>";
  del.addEventListener("click", (e) => {
    e.stopPropagation(); // don't trigger header toggle
    post({ type: "DELETE_ITEM", itemId: item.id });
  });

  // Chevron — Phosphor CaretRight (regular), 16x16. Rotates 90° via CSS when
  // the body expands. Sits at the far left of the header as the disclosure
  // control.
  const chevron = document.createElement("span");
  chevron.className = "chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.innerHTML =
    '<svg class="icon icon-16" viewBox="0 0 256 256" xmlns="http://www.w3.org/2000/svg">' +
    '<polyline points="96 48 176 128 96 208" fill="none" stroke="currentColor" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/>' +
    "</svg>";

  header.appendChild(chevron);
  header.appendChild(thumb);
  header.appendChild(titleText);
  header.appendChild(del);

  // ---------- Body (collapsible, default hidden) ----------
  const body = document.createElement("div");
  body.className = "group-body";
  body.hidden = true;

  const checks = document.createElement("div");
  checks.className = "checks";
  for (const { field, label } of MASK_FIELDS) {
    checks.appendChild(buildMaskRow(item, field, label));
  }

  const apply = document.createElement("button");
  apply.className = "apply-btn";
  apply.type = "button";
  apply.textContent = "Apply";
  apply.addEventListener("click", () => {
    post({ type: "APPLY_TO_SELECTION", itemId: item.id });
  });

  // Footer row aligns the Apply button to the right inside the card body
  // rather than running edge-to-edge across the whole card.
  const applyRow = document.createElement("div");
  applyRow.className = "apply-row";
  applyRow.appendChild(apply);

  body.appendChild(checks);
  body.appendChild(applyRow);

  // ---------- Accordion toggle ----------
  const toggle = () => {
    const expanded = header.getAttribute("aria-expanded") === "true";
    header.setAttribute("aria-expanded", String(!expanded));
    body.hidden = expanded;
  };
  header.addEventListener("click", toggle);
  header.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  });

  card.appendChild(header);
  card.appendChild(body);
  return card;
}

function buildMaskRow(item: StyleEntry, field: MaskField, label: string): HTMLElement {
  const wrap = document.createElement("label");
  wrap.className = "mask-row";
  // Clicking the label shouldn't bubble up to the header (which would toggle).
  wrap.addEventListener("click", (e) => e.stopPropagation());

  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = item.applyMask[field];
  input.addEventListener("change", () => {
    // Optimistic local update so the UI stays snappy; sandbox persists.
    item.applyMask[field] = input.checked;
    post({ type: "UPDATE_MASK", itemId: item.id, field, value: input.checked });
  });

  const text = document.createElement("span");
  text.textContent = label;

  wrap.appendChild(input);
  wrap.appendChild(text);
  return wrap;
}

function updateSelectionUi() {
  const { total, frames } = selection;
  copyBtn.disabled = !(total === 1 && frames === 1);

  if (total === 0) {
    statusEl.textContent = "Select a frame to begin.";
  } else if (frames === 0) {
    statusEl.textContent =
      total === 1 ? "Selected node is not a frame." : "No frames in selection.";
  } else if (frames === 1 && total === 1) {
    statusEl.textContent = "1 frame selected — ready to copy or apply.";
  } else {
    statusEl.textContent =
      frames + " frames selected — Apply will affect all of them.";
  }

  // Reflect apply availability on each row.
  const canApply = frames > 0;
  const buttons = listEl.querySelectorAll<HTMLButtonElement>(".apply-btn");
  buttons.forEach((b) => {
    b.disabled = !canApply;
  });
}

function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "just now";
  if (m < 60) return m + "m ago";
  const h = Math.floor(m / 60);
  if (h < 24) return h + "h ago";
  const d = Math.floor(h / 24);
  return d + "d ago";
}

function post(message: unknown) {
  parent.postMessage({ pluginMessage: message }, "*");
}
