# Publishing Attribute Clipboard to Figma Community

Everything you need to paste into Figma's publish flow, in one place.

## Plugin name

> Attribute Clipboard

## Tagline (one-line subtitle)

> Your attributes in one place.

## Description

A persistent clipboard for frame styles. Save fills, strokes, effects, corner radius, opacity, and blend mode from any frame, then reuse them on any other frame anytime.

**What's inside**
- Save styles from any frame as a reusable group.
- Organize groups in folders by adding slashes in the name (for example, `buttons/primary`).
- Per-group checkboxes to apply only the attributes you need.
- Live style and variable links carry over when the target file has them; raw values fall back automatically.

**Use cases**
- Build a personal library of frequently-used styles.
- Pull recurring patterns out of components without breaking the layer tree.
- Move specific properties (just fills, just effects) across mockups.
- Recreate styles from older files where the source library is no longer available.

**How to use it**
1. Select a frame in Figma.
2. Click "Copy styles from selection" at the top of the plugin. The styles are saved with a thumbnail.
3. Select target frame(s). Open the saved group, uncheck any attributes you do not want.
4. Click Apply.

Slashes in a group's name create folders. Naming a group `buttons/primary` puts it inside a `buttons` folder. Folders nest as deep as you like, and folder headers can be renamed later to restructure on the fly.

All groups persist between sessions on your device. No sign-in, no network calls.

## Tags (pick 3-5 from this set)

- styles
- clipboard
- design-system
- attributes
- productivity
- utility

## Editor type

Figma (Design).

## Network access

None required. The manifest declares `"allowedDomains": ["none"]`.

## Support contact

The Figma Community publish form asks for a support URL or email. Pick whichever you want users to land on when they click "Get support":

- GitHub issues (recommended): https://github.com/Delta365/attribute-clipboard/issues
- Repo home: https://github.com/Delta365/attribute-clipboard
- Email fallback: sanjivanrane@gmail.com

## Assets

Both files in this folder are SVG source. Figma's community accepts PNG or JPEG, so before uploading:

1. Open `assets/cover.svg` in Figma.
2. Select the top-level frame (the 1920x960 group), export as PNG (1x).
3. Repeat for `assets/icon.svg` (export as PNG at 1x, 128x128).

Required dimensions per Figma's docs:
- **Cover**: 1920 x 960 px, PNG or JPEG.
- **Icon / thumbnail**: 128 x 128 px, PNG or JPEG.

## Publish flow

1. In Figma desktop, open any file.
2. Menu: **Plugins -> Development -> Manage plugins in development**.
3. Find "Attribute Clipboard" in the list, click the three-dot menu, choose **Publish new plugin**.
4. Upload the PNG-exported cover and icon.
5. Paste the tagline, description, and tags from above.
6. Set the support contact.
7. Review the preview and submit.

The first publish typically takes 1-2 days to review. Subsequent updates publish faster.

## After your first publish

- Figma assigns a real plugin ID. Replace the `id` field in `manifest.json` with that assigned ID so future updates publish to the same listing.
- Bump the version in `package.json` for each meaningful update.
- Re-run `npm run build` before submitting an update so the bundled `dist/code.js` and `dist/ui.html` reflect your latest source.
