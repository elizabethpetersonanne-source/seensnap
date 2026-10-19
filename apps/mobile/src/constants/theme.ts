// Oct-18 Visual Design brief §3. Base canvas near-black; accent is
// pure SeenSnap yellow (not muted gold). Palette tokens are semantic
// — do not add raw hex values at component sites.
export const colors = {
  // Canvas
  background: "#080B0E",
  backgroundElevated: "#0E1317",
  surface: "#141B20",
  surfaceMuted: "#10161B",
  surfaceSoft: "#1A222A",
  // Text
  ink: "#F6F6F2",
  muted: "#B8BEC3",
  muted2: "#7F8891",
  // Accent — brand yellow, used as deliberate signal only
  accent: "#FFE600",
  accentMuted: "#C9B100",
  // Concierge aura — brief §3, soft peripheral violet→indigo→magenta
  conciergeAuraA: "#7161EF",
  conciergeAuraB: "#4349B7",
  conciergeAuraC: "#B65B89",
  // Editorial insert
  paper: "#F2EDE0",
  paperInk: "#121820",
  // States
  success: "#4ADE80",
  danger: "#E07070",
  shadow: "#010204",
  // Legacy aliases — preserved for screens not yet redesigned
  border: "rgba(255,255,255,0.12)",
  accentSoft: "#7a5f18",
  deepNavy: "#030508",
  velvet: "#080B0E",
};

export const rules = {
  default: "rgba(255,255,255,0.12)",
  gold: "rgba(255,230,0,0.32)",
  strong: "rgba(255,255,255,0.20)",
};

export const fonts = {
  // Oct-19 font standardization: `serif` and `serifBold` now point to
  // Instrument Sans so every legacy caller gets consistent UI typography
  // automatically. The real Bodoni Moda is still available via
  // `editorial` / `editorialBold` for the few intentional display
  // moments (SceneDNA headline, Premium paywall, publish composer eyebrow).
  serif: "InstrumentSans_600SemiBold",
  serifBold: "InstrumentSans_700Bold",
  editorial: "BodoniModa_500Medium",
  editorialBold: "BodoniModa_700Bold",
  sans: "InstrumentSans_400Regular",
  sansMedium: "InstrumentSans_500Medium",
  sansSemiBold: "InstrumentSans_600SemiBold",
  sansBold: "InstrumentSans_700Bold",
  sansExtraBold: "InstrumentSans_700Bold", // no 800 in InstrumentSans, use 700
  mono: "IBMPlexMono_400Regular",
  monoMedium: "IBMPlexMono_500Medium",
  monoSemiBold: "IBMPlexMono_600SemiBold",
};

export const spacing = {
  xs: 8,
  sm: 12,
  md: 16,
  lg: 20,
  xl: 24,
  xxl: 32,
};

// Restrained — engineered feel, not pillowy
export const radii = {
  sm: 4,
  md: 6,
  lg: 8,
  xl: 12,
  xxl: 16,
  pill: 999,
};

export const motion = {
  timing: {
    micro: 80,
    fast: 120,
    standard: 200,
    enter: 250,
    slow: 380,
    stagger: 40,
    maxStagger: 320,
    shimmer: 1400,
  },
  // Restrained springs — no bouncy animation
  spring: {
    react: { bounciness: 2, speed: 18, useNativeDriver: true as const },
    soft: { bounciness: 1, speed: 14, useNativeDriver: true as const },
    snap: { bounciness: 0, speed: 26, useNativeDriver: true as const },
    press: { bounciness: 0, speed: 26, useNativeDriver: true as const },
  },
};

/**
 * Header design tokens — Unified Header System brief §3 + §20. Single source
 * of truth for header geometry across every primary destination. No primary
 * screen should redefine these locally; the header component reads them via
 * `theme.header.*`.
 *
 * Two size variants exist:
 *   - STANDARD_HEIGHT: Discover, My Picks, Watch Teams, Profile, SceneDNA.
 *   - IMMERSIVE_HEIGHT: Swipe only — title artwork IS the context.
 *
 * The global rail (logo + optional contextual action + Search + Bell) uses
 * fixed positions/dimensions so switching tabs does not visibly jump.
 */
export const header = {
  // Horizontal + vertical geometry
  HORIZONTAL_PADDING: 20,
  TOP_SAFE_OFFSET: 8, // added to insets.top
  STANDARD_HEIGHT: 300,
  STANDARD_MIN_HEIGHT: 220,
  IMMERSIVE_HEIGHT: 380,
  IMMERSIVE_MIN_HEIGHT: 260,
  BOTTOM_PADDING: 28, // enough clearance below the title so descenders + the
                     // bottom fade band don't clip the H1 baseline

  // Global control rail — logo, contextual, search, bell
  LOGO_WIDTH: 56,
  LOGO_HEIGHT: 22,
  ACTION_SIZE: 40,
  ACTION_GAP: 10,
  RAIL_HEIGHT: 44,

  // Typography — fixed responsive scale, no per-screen scaling. Bodoni serif
  // needs ~1.2x line-height for descenders/ascenders to breathe; the previous
  // 44/46 ratio (1.045x) was clipping the top of tall glyphs.
  H1_SIZE: 40,
  H1_LINE_HEIGHT: 48,
  H1_LETTER_SPACING: -0.6,
  H1_LONG_SIZE: 32,
  H1_LONG_LINE_HEIGHT: 40,
  SUBTITLE_SIZE: 14,
  SUBTITLE_LINE_HEIGHT: 20,
  SUBTITLE_GAP: 8,

  // Cinematic imagery pipeline — dark overlay + bottom gradient
  OVERLAY: "rgba(4,8,14,0.55)",
  BOTTOM_GRADIENT_STOPS: [
    "rgba(8,11,14,0)",
    "rgba(8,11,14,0.30)",
    "rgba(8,11,14,0.75)",
    "#080B0E",
  ] as const,
  BOTTOM_GRADIENT_LOCATIONS: [0, 0.45, 0.82, 1] as const,

  // Scroll-collapse behavior
  COLLAPSE_DISTANCE: 140, // how far the user must scroll for full compact
} as const;

// Kept for any lingering references — remove as screens are redesigned
export const overlays = {
  dark: "rgba(2, 4, 8, 0.88)",
  medium: "rgba(4, 8, 14, 0.68)",
  light: "rgba(8, 12, 20, 0.50)",
  card: "rgba(6, 10, 18, 0.90)",
  glass: "rgba(12, 18, 28, 0.78)",
  posterGrade: "rgba(2, 4, 8, 0.0)",
  posterBottom: "rgba(2, 4, 8, 0.92)",
};

// Deprecated — do not use in new screens
export const glows = {
  accent: "rgba(255, 210, 31, 0.08)",
  accentStrong: "rgba(255, 210, 31, 0.14)",
  accentTab: "rgba(255, 210, 31, 0.10)",
  teal: "rgba(46, 196, 182, 0.06)",
  blueTop: "rgba(16, 36, 68, 0.20)",
  blueBottom: "rgba(8, 18, 36, 0.50)",
  blueDeep: "rgba(14, 28, 52, 0.18)",
};
