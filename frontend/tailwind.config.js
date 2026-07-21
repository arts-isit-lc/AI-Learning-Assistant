/** @type {import('tailwindcss').Config} */

// OCELIA design system — Tailwind surface for the tokens defined in
// src/index.css (the single source of truth for values). Categories: colour,
// typography, spacing, radius, shadow, motion, z-index + breakpoints (screens).
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    // Breakpoints — desktop-first, built responsive. md (768px) is the tablet
    // floor we protect; dedicated mobile layouts are deferred (see plan §5).
    screens: {
      sm: "640px",
      md: "768px",
      lg: "1024px",
      xl: "1280px",
      "2xl": "1536px",
    },
    extend: {
      fontFamily: {
        sans: ["var(--font-sans)"],
        // Legacy MUI aliases — removed with MUI in Phase 8.
        roboto: ["Roboto", "ui-sans-serif", "system-ui"],
        inter: ["Inter", "ui-sans-serif", "system-ui"],
      },
      fontSize: {
        // OCELIA named type scale: [size, { lineHeight, fontWeight }].
        h2: ["var(--text-h2)", { lineHeight: "var(--text-h2-lh)", fontWeight: "600" }],
        h4: ["var(--text-h4)", { lineHeight: "var(--text-h4-lh)", fontWeight: "600" }],
        body: ["var(--text-body)", { lineHeight: "var(--text-body-lh)", fontWeight: "400" }],
        caption: ["var(--text-caption)", { lineHeight: "var(--text-caption-lh)", fontWeight: "400" }],
      },
      fontWeight: {
        book: "var(--font-weight-book)",
        semibold: "var(--font-weight-semibold)",
      },
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
          subtle: "hsl(var(--primary-subtle))",
        },
        // Raw UBC / Arts ISIT neutrals — used where the design fills with a
        // specific neutral (e.g. the inactive Card/Course = #BFBFBF).
        neutral: {
          0: "hsl(var(--neutral-0))",
          300: "hsl(var(--neutral-300))",
          500: "hsl(var(--neutral-500))",
          700: "hsl(var(--neutral-700))",
          900: "hsl(var(--neutral-900))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        navy: {
          DEFAULT: "hsl(var(--navy))",
          foreground: "hsl(var(--navy-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
          muted: "hsl(var(--destructive-muted))",
          "muted-foreground": "hsl(var(--destructive-muted-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        warning: {
          DEFAULT: "hsl(var(--warning))",
          foreground: "hsl(var(--warning-foreground))",
        },
        info: {
          DEFAULT: "hsl(var(--info))",
          foreground: "hsl(var(--info-foreground))",
        },
      },
      spacing: {
        xs: "var(--space-xs)",
        sm: "var(--space-sm)",
        md: "var(--space-md)",
        lg: "var(--space-lg)",
        xl: "var(--space-xl)",
      },
      borderRadius: {
        sm: "var(--radius-sm)",
        md: "var(--radius-md)",
        lg: "var(--radius-lg)",
      },
      boxShadow: {
        card: "var(--shadow-card)",
        dropdown: "var(--shadow-dropdown)",
        modal: "var(--shadow-modal)",
      },
      transitionDuration: {
        fast: "var(--transition-fast)",
        normal: "var(--transition-normal)",
      },
      transitionTimingFunction: {
        standard: "var(--ease-standard)",
      },
      zIndex: {
        base: "var(--z-base)",
        dropdown: "var(--z-dropdown)",
        sticky: "var(--z-sticky)",
        overlay: "var(--z-overlay)",
        modal: "var(--z-modal)",
        toast: "var(--z-toast)",
      },
      keyframes: {
        "indeterminate-progress": {
          "0%": { transform: "translateX(-100%) scaleX(0.3)" },
          "50%": { transform: "translateX(0%) scaleX(0.3)" },
          "100%": { transform: "translateX(100%) scaleX(0.3)" },
        },
        "fade-in": {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
        "accordion-down": {
          from: { height: "0" },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: "0" },
        },
      },
      animation: {
        "indeterminate-progress": "indeterminate-progress 1.5s ease-in-out infinite",
        "fade-in": "fade-in var(--transition-normal) var(--ease-standard)",
        "accordion-down": "accordion-down var(--transition-fast) var(--ease-standard)",
        "accordion-up": "accordion-up var(--transition-fast) var(--ease-standard)",
      },
    },
  },
  plugins: [],
}
