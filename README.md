# SuperSwipe — pen gestures for Supernote notes

A Supernote plugin for NOTE files, with two pen gestures:

- **Loop to select:** draw a closed loop around strokes and they get
  lasso-selected. The loop disappears and the regular lasso toolbar appears,
  so you can move, resize, copy or delete the selection as usual.
- **Margin ✕ to erase:** draw a small ✕ in the left margin, level with a
  line of writing, and that whole line is erased, with the ✕.

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

- A loop counts when the stroke ends near where it started (within ~100 px or
  20 % of its length; overshooting is fine too), is at least ~40 px wide and
  tall, and actually encloses an area (back-and-forth scribbles are ignored).
- An element is selected when at least half of its outline is inside the
  loop, on the same layer. The loop counts as 20 px larger than drawn, so a
  loop drawn tight around writing, or slightly cutting through it, still
  selects it.
- After removing the loop, the note is saved and reloaded before the
  selection is made: the device only repaints inside a lasso, so the loop
  would otherwise stay on screen as a phantom.
- If the loop encloses nothing, it stays on the page as normal ink, so
  drawing an "O" or a circle on empty paper still works.

Margin ✕ to erase:

- Draw the ✕ as two short straight strokes (each 15–200 px), crossing near
  their middles, the second within 2 seconds of the first. A "+" works too.
- The line it erases: every stroke whose vertical centre is level with the
  ✕ (within 0.9 × its height, or at least 30 px), to its right, however far:
  dots and accents included. Strokes touching those go too (descenders,
  joined letters).
- It only triggers in the margin: if anything level with the ✕ is on its
  left, or closer than 10 px to it (a written "x"), nothing happens. A ✕ with
  no writing next to it stays as ink.
- Only handwritten strokes are erased (not text boxes, pictures, shapes).
- Nothing is read from or saved to the note until a ✕ is recognised from the
  shape of the two strokes, so normal writing stays fast.
- **Restore last erase** on the plugin screen puts the last erased line
  back (same note; the plugin keeps it until the next erase).

## Limitations (Supernote SDK)

- **Gestures clear the page's undo history.** The only SDK call that can
  delete specific strokes is `deletePageElements`, and it resets undo history
  on the page (measured on device by other plugin authors). Reading the
  page also requires saving the note first, which resets it too. For erases, use
  **Restore last erase** instead. It can fail if the device reclaimed the
  plugin's memory in the meantime.
- **The selection is a rectangle.** `lassoElements` only accepts a rectangle,
  so the selection is the bounding box of everything the loop enclosed.
  Strokes that sit inside that box but outside your loop are selected too.
- **Circling for emphasis, or a cross at the start of a line.** Circling a
  word selects it, and a ✕ or "+" drawn in the margin before a line of writing
  erases that line. Use the marker for those, or turn a gesture off from the
  plugin screen.

## Using it

1. Copy `build/outputs/SuperSwipe.snplg` to the `MyStyle` folder on the
   device.
2. Settings → Apps → Plugins → Add Plugin, select the file.
3. Open a note, tap the **SuperSwipe** toolbar button, then **Grant file
   access** and choose **Always allow** (needed to remove strokes).
4. Draw a loop around some writing, or a ✕ in the margin next to a line.

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
| `src/geometry.ts` | Loop and ✕ detection, containment, line of writing (pure) |
| `src/selector.ts` | Gesture flows on pen-up, against a `Host` interface (pure) |
| `src/host.ts` | `Host` with `sn-plugin-lib`, pen tracker, erase restore |
| `src/plugin.ts` | Wires the pen-up event to the selector with a timeout |
| `src/config.ts` | Thresholds (pen types, loop tolerance, ✕ and line rules) |

`PluginConfig.json` holds the plugin ID; do not change `pluginID` or the device
will treat it as a different plugin. Bump `versionCode` for each release.
