# SuperSwipe — loop to select

A Supernote plugin for NOTE files: **draw a closed loop around strokes with a
pen, and they get lasso-selected.** The loop you drew disappears and the
regular lasso toolbar appears, so you can move, resize, copy or delete the
selection as usual.

Built with the official plugin framework (React Native 0.79.2,
`sn-plugin-lib` 0.2.3) following https://docs.supernote.com/en.

## Behaviour

- Works with the ink pens (fineliner, pressure pen, calligraphy). The marker
  is ignored, because circling with the highlighter is usually emphasis.
- A loop counts when the stroke ends near where it started (overshooting or
  stopping a little short is fine), is at least ~40 px wide and tall, and
  actually encloses an area (back-and-forth scribbles are ignored).
- An element is selected when at least 85 % of its outline is inside the
  loop, on the same layer as the loop.
- If the loop encloses nothing, it stays on the page as normal ink, so
  drawing an "O" or a circle on empty paper still works.
- The plugin waits for the pen to lift before changing the page, and cancels
  if you turn the page or switch files in the meantime.
- PDFs/documents are not supported (NOTE files only).

## Limitations (Supernote SDK)

- **Removing the loop clears the page's undo history.** The only SDK call
  that can delete one specific stroke is `deletePageElements`, and it resets
  undo history on the page (measured on device by other plugin authors).
- **The selection is a rectangle.** `lassoElements` only accepts a rectangle,
  so the selection is the bounding box of everything the loop enclosed.
  Strokes that sit inside that box but outside your loop are selected too.
- **Circling for emphasis.** Circling a word to highlight it will select it
  instead. Turn the feature off from the plugin screen while annotating, or
  use the marker for emphasis circles.

## Using it

1. Copy `build/outputs/SuperSwipe.snplg` to the `MyStyle` folder on the
   device.
2. Settings → Apps → Plugins → Add Plugin, select the file.
3. Open a note, tap the **SuperSwipe** toolbar button, then **Grant file
   access** and choose **Always allow** (needed to remove the loop stroke).
4. Draw a loop around some writing.

The plugin screen (toolbar button, or Settings → Apps → Plugins → SuperSwipe)
has an on/off switch and shows what happened to the last stroke. The on/off
state resets when the plugin host restarts.

## Development

```sh
npm install
npm test          # unit tests (geometry + selection flow with a fake host)
npm run typecheck
npm run lint
npm run build     # -> build/outputs/SuperSwipe.snplg
```

Layout:

| File | Purpose |
| --- | --- |
| `index.js` | Plugin entry: `PluginManager.init()`, buttons, starts the listener |
| `App.tsx` | Plugin screen (on/off, file access, last result) |
| `src/geometry.ts` | Loop detection, point-in-polygon, boxes (pure) |
| `src/selector.ts` | Decision flow on pen-up, against a `Host` interface (pure) |
| `src/host.ts` | `Host` implemented with `sn-plugin-lib`, pen up/down tracker |
| `src/plugin.ts` | Wires the pen-up event to the selector with a timeout |
| `src/config.ts` | Thresholds (pen types, loop tolerance, inside fraction) |

`PluginConfig.json` holds the plugin ID; do not change `pluginID` or the device
will treat it as a different plugin. Bump `versionCode` for each release.
