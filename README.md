# SuperSwipe — pen gestures for Supernote notes

A Supernote plugin for NOTE files, with two pen gestures:

- **Loop to select:** draw a closed loop around strokes and they get
  lasso-selected. The loop disappears and the regular lasso toolbar appears,
  so you can move, resize, copy or delete the selection as usual.
- **Scribble to erase:** scribble back and forth over words (four passes or
  more) and they disappear with the scribble, like crossing out on paper.
  Strokes touching the scribbled-over ones go too, so whole words are
  erased.

Built with the official plugin framework (React Native 0.79.2,
`sn-plugin-lib` 0.2.3) following https://docs.supernote.com/en.

## Behaviour

Both gestures:

- Work with the ink pens (fineliner, pressure pen, calligraphy). The marker
  is ignored, so highlighter circles and shading stay ink.
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

Scribble to erase:

- A scribble counts when the pen goes back and forth horizontally at least
  four times, each pass covering at least 40 % of the scribble's width (the
  small backtracks of handwriting do not count).
- Every stroke the scribble passes over (within 4 px) is erased, plus every
  stroke that crosses or touches one of those (the bar of a "t", joined-up
  letters). Strokes that touch nothing erased, like the dot of an "i", stay.
- A scribble over nothing (shading on empty paper) stays as ink.
- It is fast: the plugin works on the page in memory (lasso), without
  saving or reloading the note, and erasing through the lasso keeps
  Supernote's undo history, so the normal undo button brings the words back.
  When the lasso rectangle would also take strokes you did not scribble over,
  it deletes stroke by stroke instead, which clears the undo history: use
  **Restore last erase** on the plugin screen then.

## Limitations (Supernote SDK)

- **Loop to select clears the page's undo history.** The only SDK call that
  can delete one specific stroke (the loop) is `deletePageElements`, and it
  resets undo history on the page (measured on device by other plugin
  authors). Erases that fall back to it do too; use **Restore last erase**
  for those. It can fail if the device reclaimed the plugin's memory in the
  meantime.
- **The selection is a rectangle.** `lassoElements` only accepts a rectangle,
  so the selection is the bounding box of everything the loop enclosed.
  Strokes that sit inside that box but outside your loop are selected too.
- **Circling for emphasis, or shading over writing.** Circling a word selects
  it, and hatching over writing erases it. Use the marker for those, or turn
  a gesture off from the plugin screen.

## Using it

1. Copy `build/outputs/SuperSwipe.snplg` to the `MyStyle` folder on the
   device.
2. Settings → Apps → Plugins → Add Plugin, select the file.
3. Open a note, tap the **SuperSwipe** toolbar button, then **Grant file
   access** and choose **Always allow** (needed to remove strokes).
4. Draw a loop around some writing, or scribble over a word.

The plugin screen (toolbar button, or Settings → Apps → Plugins → SuperSwipe)
has an on/off switch per gesture, **Restore last erase**, and shows what
happened to the last stroke, with a step-by-step trace and the number of
strokes the plugin has received (useful when reporting a problem). The
switches reset when the plugin host restarts.

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
| `src/geometry.ts` | Loop and scribble detection, containment, touching (pure) |
| `src/selector.ts` | Gesture flows on pen-up, against a `Host` interface (pure) |
| `src/host.ts` | `Host` with `sn-plugin-lib`, pen tracker, erase restore |
| `src/plugin.ts` | Wires the pen-up event to the selector with a timeout |
| `src/config.ts` | Thresholds (pen types, loop/scribble tolerance, erase rules) |

`PluginConfig.json` holds the plugin ID; do not change `pluginID` or the device
will treat it as a different plugin. Bump `versionCode` for each release.
