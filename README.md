# SuperSwipe — pen gestures for Supernote notes

A Supernote plugin for NOTE files, with two pen gestures:

- **Loop to select:** draw a closed loop around strokes and they get
  lasso-selected. The loop disappears and the regular lasso toolbar appears,
  so you can move, resize, copy or delete the selection as usual.
- **Margin mark to erase:** draw a small ┌ in the left margin, or a ┘ in the
  right margin, level with a line of writing, and that whole line is erased,
  with the mark.

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
- Are found even when quickly followed by more writing: the device delivers
  strokes drawn in quick succession together, and every one of them is
  checked, newest first.
- Refresh the screen afterwards (switch on the plugin screen): the plugin
  view opens fully transparent for a quarter of a second and closes, which
  makes the device repaint the page, so deleted strokes do not linger as
  ghosts. Any tap closes it at once. The note's data is not touched.

Loop to select:

- A loop counts when the stroke ends near where it started (within ~100 px or
  20 % of its length; overshooting is fine too), is at least ~30 px wide and
  tall, actually encloses an area (back-and-forth scribbles are ignored), and
  turns at least 240° in total (so an L or a "7" is never taken for a loop).
- An element is selected when at least half of its outline is inside the
  loop, on the same layer. The loop counts as 20 px larger than drawn, so a
  loop drawn tight around writing, or slightly cutting through it, still
  selects it.
- If the loop encloses nothing, it stays on the page as normal ink, so
  drawing an "O" or a circle on empty paper still works.

Margin mark to erase:

- Left margin: a ┌ (across the top, then down; or up, then right) erases the
  line on its right. Right margin: a ┘ (down, then left; or right, then up)
  erases the line on its left. One stroke each, like brackets around the
  line.
- Both legs roughly straight, 15–250 px, the shorter at least a fifth of the
  longer, meeting at 50–130°, leaning at most 35° off vertical/horizontal. A
  written "L", "7" or "4" has its corner elsewhere and is left alone. If a
  mark is not recognised, the plugin screen says why.
- The line it erases: every stroke whose vertical centre is level with the
  mark (within 0.9 × its height, or at least 30 px), on its writing side,
  however far: dots and accents included. Strokes touching those go too
  (descenders, joined letters).
- There is no fixed margin zone: the mark only has to be beyond the line.
  If anything level with it is on its other side (outside the line), or if
  it overlaps the writing, nothing happens. A mark with no writing next to
  it stays as ink.
- Only handwritten strokes are erased (not text boxes, pictures, shapes).
- Nothing is read from or saved to the note unless the stroke has the shape
  of a corner. From the first gesture on, the plugin also learns whether
  strokes arrive in page coordinates; if so, it checks which corner it is up
  front, so an "L" never costs a save.
- **Restore last erase** on the plugin screen puts the last erased line
  back (same note; the plugin keeps it until the next erase).

## Limitations (Supernote SDK)

- **No reloading.** The plugin never reloads the note: a reload that read the
  file before the save had finished brought back strokes erased earlier
  (seen on device in 0.0.5 and 0.0.7).
- **Gestures clear the page's undo history.** The only SDK call that can
  delete specific strokes is `deletePageElements`, and it resets undo history
  on the page (measured on device by other plugin authors). Reading the
  page also requires saving the note first, which resets it too. For erases, use
  **Restore last erase** instead. It can fail if the device reclaimed the
  plugin's memory in the meantime.
- **The selection is a rectangle.** `lassoElements` only accepts a rectangle,
  so the selection is the bounding box of everything the loop enclosed.
  Strokes that sit inside that box but outside your loop are selected too.
- **Circling for emphasis, or a corner next to a line.** Circling a word
  selects it, and a ┌ before a line or a ┘ after it erases that line. Use the marker for those, or turn a gesture off from the
  plugin screen.

## Using it

1. Copy `build/outputs/SuperSwipe.snplg` to the `MyStyle` folder on the
   device.
2. Settings → Apps → Plugins → Add Plugin, select the file.
3. Open a note, tap the **SuperSwipe** toolbar button, then **Grant file
   access** and choose **Always allow** (needed to remove strokes).
4. Draw a loop around some writing, or a ┌ before / ┘ after a line.

The plugin screen (toolbar button, or Settings → Apps → Plugins → SuperSwipe)
has an on/off switch per gesture, **Restore last erase**, and shows what
happened to the last stroke, with a step-by-step trace, the number of
strokes the plugin has received, and the last 8 strokes with why each was or
was not taken as a gesture (useful when a gesture is missed). The switches
reset when the plugin host restarts.

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
| `src/geometry.ts` | Loop and ┌ ┘ detection, containment, line of writing (pure) |
| `src/selector.ts` | Gesture flows on pen-up, against a `Host` interface (pure) |
| `src/host.ts` | `Host` with `sn-plugin-lib`, pen tracker, erase restore |
| `src/plugin.ts` | Wires the pen-up event to the selector with a timeout |
| `src/config.ts` | Thresholds (pen types, loop tolerance, mark and line rules) |

`PluginConfig.json` holds the plugin ID; do not change `pluginID` or the device
will treat it as a different plugin. Bump `versionCode` for each release.
