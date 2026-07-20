import { cn } from "@/lib/utils"

/**
 * OCELIA icon primitive.
 *
 * Thin wrapper around a tree-shakeable per-icon SVG component (Google Material
 * icons via `react-icons/md`). Import the specific icon and pass it as `icon`,
 * so only the glyphs actually used land in the bundle:
 *
 *   import { MdHome } from "react-icons/md"
 *   <Icon icon={MdHome} label="Home" />
 *
 * Do NOT ship the Material Symbols variable web font (loads every glyph, not
 * tree-shakeable) and do NOT use `@mui/icons-material` (pulls in MUI/emotion).
 *
 * Colour inherits from the surrounding text colour (`currentColor`), so drive
 * it with a token class — `<Icon icon={MdWarning} className="text-warning" />`.
 *
 * Accessibility: decorative by default (`aria-hidden`), which is correct when an
 * adjacent text label already names the action. Pass `label` for an icon-only
 * control to expose an accessible name (`role="img"`, `aria-label`).
 *
 * @param {object} props
 * @param {React.ComponentType<{ size?: number|string, className?: string }>} props.icon
 *   The per-icon SVG component (e.g. `MdHome` from `react-icons/md`).
 * @param {number} [props.size=20] Rendered width/height in px.
 * @param {string} [props.className] Extra classes (e.g. a `text-*` token for colour).
 * @param {string} [props.label] Accessible name; omit for decorative icons.
 * @returns {JSX.Element|null}
 */
export function Icon({ icon: IconComponent, size = 20, className, label, ...props }) {
  if (!IconComponent) return null

  const a11yProps = label
    ? { role: "img", "aria-label": label }
    : { "aria-hidden": "true", focusable: "false" }

  return (
    <IconComponent
      size={size}
      className={cn("inline-block shrink-0", className)}
      {...a11yProps}
      {...props}
    />
  )
}
