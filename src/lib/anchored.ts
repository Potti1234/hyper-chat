/* The one way to place an overlay (picker, menu, popover) next to the
   element that opened it, with CSS anchor positioning: no measuring, so no
   browser code, and it stays on screen.

   - `position-area` puts the panel on a side of the anchor and aligns it;
   - the fallbacks try the other side, the other end and both, so a panel
     opened at the right or bottom edge of the window flips instead of being
     cut off;
   - `position-try-order` picks the placement with the most room, and the
     panel is never taller than that room: a long list shrinks and scrolls
     instead of running off the bottom. Its width is never cut down to the
     room beside the trigger (it would squeeze instead of flipping).

   Overlays must use this (test/overlays.test.ts checks that no other code
   sets anchor positions); scripts/check-overlays.mjs opens every overlay in
   a browser and checks that it is on screen. */

export type AnchorSide = 'top' | 'right' | 'bottom' | 'left'
export type AnchorAlign = 'start' | 'center' | 'end'

/** Both axes: up/down, left/right, and both at once. */
export const ANCHOR_FALLBACKS = 'flip-block, flip-inline, flip-block flip-inline'

const AREA: Readonly<Record<AnchorSide, Readonly<Record<AnchorAlign, string>>>> = {
  bottom: { start: 'block-end span-inline-end', center: 'block-end', end: 'block-end span-inline-start' },
  top: { start: 'block-start span-inline-end', center: 'block-start', end: 'block-start span-inline-start' },
  right: { start: 'inline-end span-block-end', center: 'inline-end', end: 'inline-end span-block-start' },
  left: { start: 'inline-start span-block-end', center: 'inline-start', end: 'inline-start span-block-start' },
}

const GAP_MARGIN: Readonly<Record<AnchorSide, string>> = {
  bottom: 'marginTop',
  top: 'marginBottom',
  right: 'marginLeft',
  left: 'marginRight',
}

/** The style for an overlay anchored to `anchor` (a CSS anchor name such as
 *  `--anchor-status-ORB-1`): on `side` of it, aligned to its `align` edge. */
export const anchoredStyle = (
  anchor: string,
  options: Readonly<{ side?: AnchorSide; align?: AnchorAlign; gap?: string }> = {},
): Record<string, string> => {
  const side = options.side ?? 'bottom'
  const align = options.align ?? 'start'
  return {
    position: 'fixed',
    // No stray offsets from classes (top-full, -translate-x-1/2, …): the
    // area alone places the panel.
    inset: 'auto',
    translate: 'none',
    positionAnchor: anchor,
    positionArea: AREA[side][align],
    [GAP_MARGIN[side]]: options.gap ?? '4px',
    positionTryFallbacks: ANCHOR_FALLBACKS,
    positionTryOrder: side === 'top' || side === 'bottom' ? 'most-height' : 'most-width',
    // Height shrinks to the room on the chosen side (a long list scrolls);
    // width does not, so a panel near an edge flips instead of narrowing.
    maxHeight: '100%',
    maxWidth: 'calc(100vw - 16px)',
  }
}
