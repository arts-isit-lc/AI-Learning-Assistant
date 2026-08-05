/**
 * Dependency-free, coarse User-Agent classifier for login/session analytics.
 *
 * Returns only three low-cardinality buckets — device type, OS family, and
 * browser family — and deliberately NOT precise versions or device models.
 * Coarse buckets answer product questions like "what % of student sessions are
 * mobile?" without edging into device fingerprinting (this is an education
 * platform whose primary users are students).
 *
 * Why hand-rolled instead of `ua-parser-js`: the student Lambda ships as a plain
 * `lambda/lib` asset whose only third-party dependency (`postgres`) arrives via a
 * prebuilt Lambda layer — there is no per-function `npm install`/bundling step.
 * Adding a parser dependency would mean building and wiring a whole new layer for
 * three buckets. This ~50-line classifier avoids that, stays deterministic, and
 * is trivially unit-testable. Order of checks matters (see comments): many UA
 * strings contain multiple tokens (Edge/Opera/Chrome-on-iOS all mention Safari),
 * so the more specific match must come first.
 *
 * Never throws: non-string / empty / unrecognized input yields "unknown"
 * families and "desktop" as the safe device default.
 */

const UNKNOWN = "unknown";

/** OS family. Order: Windows, then Android BEFORE Linux (Android UAs contain
 *  "Linux"), then iOS, macOS, ChromeOS, Linux. */
function detectOs(ua) {
  if (/windows/i.test(ua)) return "Windows";
  if (/android/i.test(ua)) return "Android";
  if (/(iphone|ipad|ipod)/i.test(ua)) return "iOS";
  if (/mac os x|macintosh/i.test(ua)) return "macOS";
  if (/cros/i.test(ua)) return "ChromeOS";
  if (/linux/i.test(ua)) return "Linux";
  return UNKNOWN;
}

/** Browser family. Order matters: Edge/Opera/Samsung and the iOS browsers
 *  (CriOS/FxiOS/EdgiOS) all embed "Chrome" and/or "Safari", so the specific
 *  brands are matched before Chrome, and Safari is the last resort. */
function detectBrowser(ua) {
  if (/edg(a|ios)?\//i.test(ua)) return "Edge"; // Edg/ EdgA/ EdgiOS/
  if (/opr\/|opera/i.test(ua)) return "Opera";
  if (/samsungbrowser/i.test(ua)) return "Samsung Internet";
  if (/firefox|fxios/i.test(ua)) return "Firefox";
  if (/chrome|crios|chromium/i.test(ua)) return "Chrome";
  if (/safari/i.test(ua)) return "Safari";
  return UNKNOWN;
}

/** Device type. Tablet is checked first because Android tablets are identified
 *  by the ABSENCE of "Mobile" in an Android UA; phones include it. */
function detectDeviceType(ua) {
  if (/ipad|tablet|silk|kindle|playbook/i.test(ua)) return "tablet";
  if (/android(?!.*mobile)/i.test(ua)) return "tablet"; // Android without "Mobile" => tablet
  if (/mobi|iphone|ipod|windows phone|blackberry/i.test(ua)) return "mobile";
  if (/android.*mobile/i.test(ua)) return "mobile";
  return "desktop";
}

/**
 * Classify a raw User-Agent string into coarse analytics buckets.
 *
 * @param {string} ua raw User-Agent header value
 * @returns {{device_type: string, os_name: string, browser_name: string}}
 */
function parseUserAgent(ua) {
  const s = typeof ua === "string" ? ua : "";
  if (!s.trim()) {
    return { device_type: "desktop", os_name: UNKNOWN, browser_name: UNKNOWN };
  }
  return {
    device_type: detectDeviceType(s),
    os_name: detectOs(s),
    browser_name: detectBrowser(s),
  };
}

/**
 * Read a header from an API Gateway proxy event, case-insensitively. API Gateway
 * preserves the original header casing in `event.headers`, and clients send
 * either "User-Agent" or "user-agent", so match without regard to case.
 *
 * @param {object} event API Gateway proxy event
 * @param {string} name header name to find
 * @returns {string} the header value, or "" if absent
 */
function getHeaderCaseInsensitive(event, name) {
  const headers = (event && event.headers) || {};
  const target = String(name).toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === target) {
      return headers[key] == null ? "" : String(headers[key]);
    }
  }
  return "";
}

module.exports = { parseUserAgent, getHeaderCaseInsensitive };
