# SuperSwipe — pen gestures for Supernote notes

A Supernote plugin for NOTE files, with pen gestures:

- **Loop to select:** draw a closed loop around strokes and they get
  lasso-selected. The loop disappears and the regular lasso toolbar appears,
  so you can move, resize, copy or delete the selection as usual.
- **Corners to select:** draw a ┌ and a ┘ (two strokes, either order) at
  the corners of what you want; what is inside is selected and both
  corners disappear.
- **Line to select:** draw a long straight line across the page, clear of
  the writing; everything above or below it is selected. With writing on
  both sides, the device asks which.
- **Margin wave to erase:** draw a sideways wave with three bounces or more
  (∿∿, a tilde with an extra bounce) in the margin next to a line of
  writing, left or right, and that whole line is erased, with the wave.

Built with the official plugin framework (React Native 0.79.2,
`sn-plugin-lib` 0.2.3) following https://docs.supernote.com/en.

## Behaviour

All gestures:

- Work with the ink pens (fineliner, pressure pen, calligraphy). The marker
  is ignored, so highlighter circles and lines stay ink.
- Wait for the pen to lift before changing the page, and cancel if you turn
  the page or switch files in the meantime.
- Only work in NOTE files (not PDFs/documents).
- Can each be turned on or off from the plugin screen.
- Are found even when quickly followed by more writing: the device delivers
  strokes drawn in quick succession together, and every one of them is
  checked, newest first.
- Read the page's strokes in parallel batches, which is much faster on a
  full page.

After an erase, the screen is refreshed (switch on the plugin screen), so
deleted strokes do not linger as ghosts: the note is reloaded, which
repaints the page. Safely: only once the saved file has been read back and
no longer holds the deleted strokes (a reload that reads the file before a
save has finished brings old strokes back), and only if the pen was not used
since the save (it would be lost). The loop is not followed by a refresh: it
is slow and would drop the selection.

Loop to select:

- A loop counts when the stroke ends near where it started (within ~100 px or
  20 % of its length; overshooting is fine too), is at least ~30 px wide and
  tall, actually encloses an area (back-and-forth scribbles are ignored), and
  turns at least 240° in total (so an L or a "7" is never taken for a loop).
- An element is selected when at least half of its outline is inside the
  loop, on the same layer. The loop counts as 20 px larger than drawn, so a
  loop drawn tight around writing, or slightly cutting through it, still
  selects it.
- Fast: the loop is removed with a single delete (no saving and reading the
  page back to check it) and the selection follows straight away.
- If the loop encloses nothing, it stays on the page as normal ink, so
  drawing an "O" or a circle on empty paper still works.
- Circling twice works too (inside is decided by winding, not by counting
  crossings).

Corners to select:

- Each corner is one stroke: a horizontal and a vertical leg, roughly
  straight (within 30° of the axes), each at least 30 px, drawn from either
  end. Only ┌ (top-left) and ┘ (bottom-right) count, so an "L" never does.
- When one is drawn, its partner is looked for among the 20 newest strokes
  on the page: the opposite corner, diagonally across. Order and timing do
  not matter. Without a partner, the corner stays as ink (it may be the
  first of the two).
- Selected: every element with at least half of its outline inside the
  rectangle (counted 20 px larger, as for the loop). An empty rectangle
  leaves both corners as ink.

Line to select:

- One straight stroke, within 12° of horizontal, at least 30 % of the page
  wide.
- It must not cross any writing (a strike-through) or come within 20 px of
  writing over its length (an underline): those stay ink.
- Writing on one side only: that side is selected at once. On both sides:
  a dialog asks "Above" or "Below"; no answer, nothing happens.
- Selected: every element whose centre is on that side, across the whole
  page width.
- A line shorter than 300 never causes the page to be read, so dashes and
  "t" bars cost nothing.

Margin wave to erase:

- One stroke that runs sideways (left to right or right to left, never
  going back on itself) and turns between up and down at least 3 times: a
  tilde "~" turns twice, so it stays ink. Each bounce must turn back by a
  quarter of the wave's height or more, so a shaky line is not a wave. Wider
  than tall, not flat as a line, 20–400 px wide.
- A loop always goes back on itself, so it can never be taken for the wave.
- Leave a gap: the writing must start at least 20 px (or 0.75 × the wave's
  height) away, so a wavy word written right after the line does not erase
  it.
- It has no direction: it erases the line on whichever side the writing is.
  Writing on both sides (a mark inside the text), touching it or too close:
  nothing happens. A mark with no writing next to it stays as ink.
- The line it erases: every stroke whose vertical centre is level with the
  mark (within 0.9 × its height, or at least 36 px), on that side, however
  far: dots and accents included. Strokes touching those go too (descenders,
  joined letters).
- Only handwritten strokes are erased (not text boxes, pictures, shapes).
- Nothing is read from or saved to the note unless the stroke has the shape
  of a wave (checked on the stroke as delivered, either way round, with
  ratios only, so its scale and axes do not matter).
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
- **The above/below dialog** is the device's own; which button is which
  is not documented, so the trace shows its raw answer ("dialog returned
  true/false") in case they come out swapped.
- **Circling for emphasis, or a wave next to a line.** Circling a word
  selects it, and a wave beside a line erases it. A wavy word (such as a
  cursive "mm") written alone at the end of a line, after a wide gap, can
  be taken for the mark: **Restore last erase**
  brings the line back. Use the marker for those,
  or turn a gesture off from the plugin screen.

## Using it

1. Copy `release/SuperSwipe-0.0.18.snplg` (ready to install, or your own
   build from `build/outputs/SuperSwipe.snplg`) to the `MyStyle` folder on
   the device.
2. Settings → Apps → Plugins → Add Plugin, select the file.
3. Open a note, tap the **SuperSwipe** toolbar button, then **Grant file
   access** and choose **Always allow** (needed to remove strokes).
4. Draw a loop around some writing, ┌ and ┘ around a block, a line under
   a section, or a wave beside a line.

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
| `src/geometry.ts` | Loop, corner, line and wave detection, containment, line of writing (pure) |
| `src/selector.ts` | Gesture flows on pen-up, against a `Host` interface (pure) |
| `src/host.ts` | `Host` with `sn-plugin-lib`, pen tracker, erase restore |
| `src/plugin.ts` | Wires the pen-up event to the selector with a timeout |
| `src/config.ts` | Thresholds (pen types, loop and wave tolerance, line rules) |

`PluginConfig.json` holds the plugin ID; do not change `pluginID` or the device
will treat it as a different plugin. Bump `versionCode` for each release.
