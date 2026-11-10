/* Slack's sidebar colour themes: the rail and sidebar wear one of these
   (`sidebar-<slug>` on the page root, tokens in design.css) over whatever
   creaseui preset the rest of the page uses. '' keeps the frame colours of
   the theme: Aubergine for the app's own. */

export type SidebarTheme = Readonly<{
  slug: string
  name: string
  /** rail, sidebar, highlight: for the picker. */
  swatches: ReadonlyArray<string>
}>

export const SIDEBAR_THEMES: ReadonlyArray<SidebarTheme> = [
  { slug: '', name: 'Aubergine', swatches: ['oklch(0.25 0.08 330)', 'oklch(0.31 0.1 330)', 'oklch(0.98 0.01 330)'] },
  { slug: 'clementine', name: 'Clementine', swatches: ['oklch(0.36 0.09 45)', 'oklch(0.44 0.12 45)', 'oklch(0.97 0.02 45)'] },
  { slug: 'banana', name: 'Banana', swatches: ['oklch(0.38 0.07 85)', 'oklch(0.47 0.09 85)', 'oklch(0.97 0.03 85)'] },
  { slug: 'jade', name: 'Jade', swatches: ['oklch(0.28 0.05 170)', 'oklch(0.36 0.07 170)', 'oklch(0.97 0.02 170)'] },
  { slug: 'lagoon', name: 'Lagoon', swatches: ['oklch(0.28 0.07 240)', 'oklch(0.36 0.1 240)', 'oklch(0.97 0.02 240)'] },
  { slug: 'barbra', name: 'Barbra', swatches: ['oklch(0.3 0.09 10)', 'oklch(0.38 0.12 10)', 'oklch(0.97 0.02 10)'] },
  { slug: 'gray', name: 'Gray', swatches: ['oklch(0.25 0.005 285)', 'oklch(0.32 0.006 285)', 'oklch(0.97 0 0)'] },
  { slug: 'mood-indigo', name: 'Mood Indigo', swatches: ['oklch(0.24 0.08 275)', 'oklch(0.31 0.1 275)', 'oklch(0.97 0.02 275)'] },
]

/** A slug members may store. */
export const isSidebarSlug = (slug: string): boolean => SIDEBAR_THEMES.some(theme => theme.slug === slug)
