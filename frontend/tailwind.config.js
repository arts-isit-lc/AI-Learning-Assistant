/** @type {import('tailwindcss').Config} */

export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        roboto: ['Roboto','ui-sans-serif', 'system-ui'],
        inter: ['Inter','ui-sans-serif', 'system-ui']
      },
      colors: {
        border: "hsl(var(--border))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
      keyframes: {
        "indeterminate-progress": {
          "0%": { transform: "translateX(-100%) scaleX(0.3)" },
          "50%": { transform: "translateX(0%) scaleX(0.3)" },
          "100%": { transform: "translateX(100%) scaleX(0.3)" },
        },
      },
      animation: {
        "indeterminate-progress": "indeterminate-progress 1.5s ease-in-out infinite",
      },
    },
  },
  plugins: [],
}
