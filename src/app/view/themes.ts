/* Generated from the creaseui theme presets. Swatches are the light
   theme's primary/accent/muted/background tokens. */

export type ThemePreset = Readonly<{
  slug: string
  name: string
  description: string
  scheme: string
  /** primary, accent, muted, background — light scheme. */
  swatches: ReadonlyArray<string>
}>

/** A slug members may store: a preset or '' (the app's own theme). */
export const isThemeSlug = (slug: string): boolean => slug === '' || THEME_PRESETS.some(preset => preset.slug === slug)

export const THEME_PRESETS: ReadonlyArray<ThemePreset> = [
  {
    "slug": "nova",
    "name": "Nova",
    "description": "The default: neutral greys, no accent, Inter",
    "scheme": "both",
    "swatches": [
      "oklch(0.21 0 0)",
      "oklch(0.923 0 0)",
      "oklch(0.923 0 0)",
      "oklch(1 0 0)"
    ]
  },
  {
    "slug": "shadcn",
    "name": "Shadcn",
    "description": "Zinc neutrals, a near-black primary and tight headings, after shadcn/ui",
    "scheme": "light",
    "swatches": [
      "oklch(0.21 0 0)",
      "color-mix(in oklch,oklch(0.205 0.008 286) 8%,oklch(1 0.004 286))",
      "oklch(0.923 0.004 286)",
      "oklch(1 0.004 286)"
    ]
  },
  {
    "slug": "material",
    "name": "Material",
    "description": "Tonal surfaces, pill buttons, regular-weight headings, after Material 3",
    "scheme": "light",
    "swatches": [
      "oklch(0.44 0.13 293)",
      "color-mix(in oklch,oklch(0.44 0.13 293) 12%,oklch(1 0.02 293))",
      "oklch(0.937 0.02 293)",
      "oklch(1 0.02 293)"
    ]
  },
  {
    "slug": "windows-95",
    "name": "Windows 95",
    "description": "Silver grey, navy, beveled controls, dark frames and square corners",
    "scheme": "light",
    "swatches": [
      "oklch(0.3 0.19 264)",
      "color-mix(in oklch,oklch(0.205 0.006 0) 8%,oklch(0.8 0 0))",
      "oklch(0.646 0 0)",
      "oklch(0.8 0 0)"
    ]
  },
  {
    "slug": "brutalist",
    "name": "Brutalist",
    "description": "Black lines, hard shadows, heavy tight headings and a loud yellow",
    "scheme": "light",
    "swatches": [
      "oklch(0.88 0.19 100)",
      "color-mix(in oklch,oklch(0.205 0.006 0) 8%,oklch(0.98 0 0))",
      "oklch(0.861 0 0)",
      "oklch(0.98 0 0)"
    ]
  },
  {
    "slug": "solarized",
    "name": "Solarized",
    "description": "Base3 cream, blue, and type set in serif, after Ethan Schoonover’s palette",
    "scheme": "light",
    "swatches": [
      "oklch(0.6 0.14 245)",
      "oklch(0.888 0.03 56)",
      "oklch(0.888 0.03 56)",
      "oklch(0.965 0.03 56)"
    ]
  },
  {
    "slug": "nord",
    "name": "Nord",
    "description": "Frost blue on the polar night, after Nord",
    "scheme": "dark",
    "swatches": [
      "oklch(0.62 0.07 213)",
      "color-mix(in oklch,oklch(0.205 0.022 232) 8%,oklch(0.955 0.018 232))",
      "oklch(0.878 0.018 232)",
      "oklch(0.955 0.018 232)"
    ]
  },
  {
    "slug": "ocean",
    "name": "Ocean",
    "description": "A deep blue on blue-tinted surfaces",
    "scheme": "both",
    "swatches": [
      "oklch(0.5 0.14 232)",
      "oklch(0.923 0.014 232)",
      "oklch(0.923 0.014 232)",
      "oklch(1 0.014 232)"
    ]
  },
  {
    "slug": "forest",
    "name": "Forest",
    "description": "Leaf green, a little squarer",
    "scheme": "both",
    "swatches": [
      "oklch(0.48 0.12 152)",
      "oklch(0.923 0 0)",
      "oklch(0.923 0 0)",
      "oklch(1 0 0)"
    ]
  },
  {
    "slug": "ember",
    "name": "Ember",
    "description": "Warm orange, tighter",
    "scheme": "both",
    "swatches": [
      "oklch(0.6 0.17 38)",
      "oklch(0.923 0 0)",
      "oklch(0.923 0 0)",
      "oklch(1 0 0)"
    ]
  },
  {
    "slug": "orchid",
    "name": "Orchid",
    "description": "Pink, round and serif",
    "scheme": "both",
    "swatches": [
      "oklch(0.56 0.16 328)",
      "oklch(0.923 0.02 0)",
      "oklch(0.923 0.02 0)",
      "oklch(1 0.02 0)"
    ]
  },
  {
    "slug": "terminal",
    "name": "Terminal",
    "description": "Phosphor green in mono on black: sharp, still, and barely any heading scale",
    "scheme": "dark",
    "swatches": [
      "oklch(0.55 0.2 145)",
      "color-mix(in oklch,oklch(0.55 0.2 145) 12%,oklch(1 0.012 145))",
      "oklch(0.923 0.012 145)",
      "oklch(1 0.012 145)"
    ]
  }
]


export const themeBySlug = (slug: string) => THEME_PRESETS.find(p => p.slug === slug)
