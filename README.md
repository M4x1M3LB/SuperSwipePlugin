# SuperSwipe — pen gestures for Supernote notes

A Supernote plugin for NOTE files, with two pen gestures:

- **Loop to select:** draw a closed loop around strokes and they get
  lasso-selected. The loop disappears and the regular lasso toolbar appears,
  so you can move, resize, copy or delete the selection as usual.
- **Line to erase:** draw a straight line through 3 or more strokes and the
  line and every stroke it cut through are erased.

Built with the official plugin framework (React Native 0.79.2,
`sn-plugin-lib` 0.2.3) following https://docs.supernote.com/en.

## Behaviour

Both gestures:

- Work with the ink pens (fineliner, pressure pen, calligraphy). The marker
  is ignored, so highlighter circles and lines stay ink.
- Wait for the pen to lift before changing the page, and cancel if you turn
  the page or switch files in the meantime.
- Only work in NOTE files (not PDFs/documents).
- Can each be turned on or off from the plugin screen.

Loop to select:

- A loop counts when the stroke ends near where it started (overshooting or
  stopping a little short is fine), is at least ~40 px wide and tall, and
  actually encloses an area (back-and-forth scribbles are ignored).
- An element is selected when at least 85 % of its outline is inside the
  loop, on the same layer as the loop.
- If the loop encloses nothing, it stays on the page as normal ink, so
  drawing an "O" or a circle on empty paper still works.

Line to erase:

- A line counts when it is at least ~100 px long and stays within ~5 % of
  its length from the straight path between its ends.
- A stroke counts as crossed only when the line cuts through it, with at
  least 20 % of the stroke on each side of the line. An underline that only
  clips the tails of "g", "y" or "p" does not erase them.
- Fewer than 3 crossed strokes: the line stays on the page as ink
  (dividers, crossing out a single letter).
- Only handwritten strokes are erased (not text boxes, pictures, shapes).
- **Restore last erase** on the plugin screen puts the last erased strokes
  back (same note; the plugin keeps them until the next erase).

## Limitations (Supernote SDK)

- **Gestures clear the page's undo history.** The only SDK call that can
  delete specific strokes is `deletePageElements`, and it resets undo history
  on the page (measured on device by other plugin authors). For erases, use
  **Restore last erase** instead. It can fail if the device reclaimed the
  plugin's memory in the meantime.
- **The selection is a rectangle.** `lassoElements` only accepts a rectangle,
  so the selection is the bounding box of everything the loop enclosed.
  Strokes that sit inside that box but outside your loop are selected too.
- **Circling or striking through for emphasis.** Circling a word selects it,
  and a strike-through across 3+ strokes erases them. Use the marker for
  emphasis, or turn a gesture off from the plugin screen.

## Using it

1. Copy `build/outputs/SuperSwipe.snplg` to the `MyStyle` folder on the
   device.
2. Settings → Apps → Plugins → Add Plugin, select the file.
3. Open a note, tap the **SuperSwipe** toolbar button, then **Grant file
   access** and choose **Always allow** (needed to remove strokes).
4. Draw a loop around some writing, or a line through it.

The plugin screen (toolbar button, or Settings → Apps → Plugins → SuperSwipe)
has an on/off switch per gesture, **Restore last erase**, and shows what
happened to the last stroke. The switches reset when the plugin host
restarts.

## Development

```sh
npm install
npm test          # unit tests (geometry + gesture flows with a fake host)
npm run typecheck
npm run lint
npm run build     # -> build/outputs/SuperSwipe.snplg
```

Layout:

| File | Purpose |
| --- | --- |
| `index.js` | Plugin entry: `PluginManager.init()`, buttons, starts the listener |
| `App.tsx` | Plugin screen (switches, restore, file access, last result) |
| `src/geometry.ts` | Loop and line detection, containment, line cuts (pure) |
| `src/selector.ts` | Gesture flows on pen-up, against a `Host` interface (pure) |
| `src/host.ts` | `Host` with `sn-plugin-lib`, pen tracker, erase restore |
| `src/plugin.ts` | Wires the pen-up event to the selector with a timeout |
| `src/config.ts` | Thresholds (pen types, loop/line tolerance, erase rules) |

`PluginConfig.json` holds the plugin ID; do not change `pluginID` or the device
will treat it as a different plugin. Bump `versionCode` for each release.
