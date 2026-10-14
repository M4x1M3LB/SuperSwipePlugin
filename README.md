# SuperSwipe — pen gestures for Supernote notes

A Supernote plugin for NOTE files, with two pen gestures:

- **Loop to select:** draw a closed loop around strokes and they get
  lasso-selected. The loop disappears and the regular lasso toolbar appears,
  so you can move, resize, copy or delete the selection as usual.
- **Margin spiral to erase:** draw a small spiral (a snail shell) in the
  margin next to a line of writing, left or right, and that whole line is
  erased, with the spiral.

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
- Refresh the screen afterwards (switch on the plugin screen), so deleted
  strokes do not linger as ghosts: the note is reloaded, which repaints the
  page. Safely: only once the saved file has been read back and no longer
  holds the deleted strokes (a reload that reads the file before a save has
  finished brings old strokes back), and only if the pen was not used since
  the save (it would be lost).

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
- Circling twice works too (inside is decided by winding, not by counting
  crossings).

Margin spiral to erase:

- One stroke that turns at least 1½ times and grows: its outer end at least
  twice as far from the centre as its inner end. From the inside out or the
  outside in, either way round; 20–300 px across. A loop drawn twice does not
  grow, so it stays a loop.
- It has no direction: it erases the line on whichever side the writing is.
  Writing on both sides (a spiral inside the text) or touching it: nothing
  happens. A spiral with no writing next to it stays as ink.
- The line it erases: every stroke whose vertical centre is level with the
  spiral (within 0.9 × its height, or at least 30 px), on that side, however
  far: dots and accents included. Strokes touching those go too (descenders,
  joined letters).
- Only handwritten strokes are erased (not text boxes, pictures, shapes).
- Nothing is read from or saved to the note unless the stroke has the shape
  of a spiral (turning and growth do not depend on the coordinates, so this
  is checked on the stroke as delivered).
- **Restore last erase** on the plugin screen puts the last erased line
  back (same note; the plugin keeps it until the next erase).

## Limitations (Supernote SDK)

- **Reloading only when safe.** A reload that read the file before the save
  had finished brought back strokes erased earlier (seen on device in 0.0.5
  and 0.0.7), so the plugin reloads only after reading the saved file back.
- **Gestures clear the page's undo history.** The only SDK call that can
  delete specific strokes is `deletePageElements`, and it resets undo history
  on the page (measured on device by other plugin authors). Reading the
  page also requires saving the note first, which resets it too. For erases, use
  **Restore last erase** instead. It can fail if the device reclaimed the
  plugin's memory in the meantime.
- **The selection is a rectangle.** `lassoElements` only accepts a rectangle,
  so the selection is the bounding box of everything the loop enclosed.
  Strokes that sit inside that box but outside your loop are selected too.
- **Circling for emphasis, or a spiral next to a line.** Circling a word
  selects it, and a spiral beside a line erases it. Use the marker for those,
  or turn a gesture off from the plugin screen.

## Using it

1. Copy `build/outputs/SuperSwipe.snplg` to the `MyStyle` folder on the
   device.
2. Settings → Apps → Plugins → Add Plugin, select the file.
3. Open a note, tap the **SuperSwipe** toolbar button, then **Grant file
   access** and choose **Always allow** (needed to remove strokes).
4. Draw a loop around some writing, or a spiral beside a line.

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
| `src/geometry.ts` | Loop and spiral detection, containment, line of writing (pure) |
| `src/selector.ts` | Gesture flows on pen-up, against a `Host` interface (pure) |
| `src/host.ts` | `Host` with `sn-plugin-lib`, pen tracker, erase restore |
| `src/plugin.ts` | Wires the pen-up event to the selector with a timeout |
| `src/config.ts` | Thresholds (pen types, loop and spiral tolerance, line rules) |

`PluginConfig.json` holds the plugin ID; do not change `pluginID` or the device
will treat it as a different plugin. Bump `versionCode` for each release.
