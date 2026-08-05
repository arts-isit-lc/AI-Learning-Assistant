/**
 * Unit tests for the dependency-free User-Agent classifier used by
 * studentFunction's POST /student/session_start login-analytics route.
 *
 * Deterministic and offline: the parser is a pure function of the UA string, so
 * these lock the coarse-bucket mapping (device type / OS family / browser family)
 * and the case-insensitive header lookup. Representative real UA strings cover
 * the ordering hazards (Edge/Opera/Samsung/iOS-browsers all embed Chrome/Safari;
 * Android tablets are "Android without Mobile").
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { parseUserAgent, getHeaderCaseInsensitive } = require("../lambda/lib/userAgent.js");

const UA = {
  windowsChrome:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  windowsEdge:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
  windowsOpera:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36 OPR/105.0.0.0",
  macSafari:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  linuxFirefox: "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0",
  chromeOs:
    "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  iphoneSafari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  iphoneChrome:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0.0.0 Mobile/15E148 Safari/604.1",
  ipadSafari:
    "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  androidPhone:
    "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36",
  androidTablet:
    "Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  androidSamsung:
    "Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36",
};

describe("parseUserAgent — OS family", () => {
  it("detects Windows", () => {
    expect(parseUserAgent(UA.windowsChrome).os_name).toBe("Windows");
  });
  it("detects macOS", () => {
    expect(parseUserAgent(UA.macSafari).os_name).toBe("macOS");
  });
  it("detects Linux", () => {
    expect(parseUserAgent(UA.linuxFirefox).os_name).toBe("Linux");
  });
  it("detects ChromeOS", () => {
    expect(parseUserAgent(UA.chromeOs).os_name).toBe("ChromeOS");
  });
  it("detects iOS on iPhone (before the 'Mac OS X' token)", () => {
    expect(parseUserAgent(UA.iphoneSafari).os_name).toBe("iOS");
  });
  it("detects iOS on iPad", () => {
    expect(parseUserAgent(UA.ipadSafari).os_name).toBe("iOS");
  });
  it("detects Android before Linux (Android UAs contain 'Linux')", () => {
    expect(parseUserAgent(UA.androidPhone).os_name).toBe("Android");
  });
});

describe("parseUserAgent — browser family", () => {
  it("detects Chrome", () => {
    expect(parseUserAgent(UA.windowsChrome).browser_name).toBe("Chrome");
  });
  it("detects Edge before Chrome", () => {
    expect(parseUserAgent(UA.windowsEdge).browser_name).toBe("Edge");
  });
  it("detects Opera before Chrome", () => {
    expect(parseUserAgent(UA.windowsOpera).browser_name).toBe("Opera");
  });
  it("detects Samsung Internet before Chrome", () => {
    expect(parseUserAgent(UA.androidSamsung).browser_name).toBe("Samsung Internet");
  });
  it("detects Firefox", () => {
    expect(parseUserAgent(UA.linuxFirefox).browser_name).toBe("Firefox");
  });
  it("detects Safari (only when no Chromium token is present)", () => {
    expect(parseUserAgent(UA.macSafari).browser_name).toBe("Safari");
    expect(parseUserAgent(UA.iphoneSafari).browser_name).toBe("Safari");
  });
  it("detects Chrome on iOS (CriOS) before Safari", () => {
    expect(parseUserAgent(UA.iphoneChrome).browser_name).toBe("Chrome");
  });
});

describe("parseUserAgent — device type", () => {
  it("classifies a Windows desktop", () => {
    expect(parseUserAgent(UA.windowsChrome).device_type).toBe("desktop");
  });
  it("classifies a Mac desktop", () => {
    expect(parseUserAgent(UA.macSafari).device_type).toBe("desktop");
  });
  it("classifies an iPhone as mobile", () => {
    expect(parseUserAgent(UA.iphoneSafari).device_type).toBe("mobile");
  });
  it("classifies an Android phone (has 'Mobile') as mobile", () => {
    expect(parseUserAgent(UA.androidPhone).device_type).toBe("mobile");
  });
  it("classifies an iPad as tablet", () => {
    expect(parseUserAgent(UA.ipadSafari).device_type).toBe("tablet");
  });
  it("classifies an Android tablet (no 'Mobile') as tablet", () => {
    expect(parseUserAgent(UA.androidTablet).device_type).toBe("tablet");
  });
});

describe("parseUserAgent — safe fallbacks (never throws)", () => {
  it("returns unknown families + desktop for an empty string", () => {
    expect(parseUserAgent("")).toEqual({
      device_type: "desktop",
      os_name: "unknown",
      browser_name: "unknown",
    });
  });
  it("handles undefined", () => {
    expect(parseUserAgent(undefined)).toEqual({
      device_type: "desktop",
      os_name: "unknown",
      browser_name: "unknown",
    });
  });
  it("handles null", () => {
    expect(parseUserAgent(null)).toEqual({
      device_type: "desktop",
      os_name: "unknown",
      browser_name: "unknown",
    });
  });
  it("handles a non-string", () => {
    expect(parseUserAgent(12345 as unknown as string)).toEqual({
      device_type: "desktop",
      os_name: "unknown",
      browser_name: "unknown",
    });
  });
  it("returns unknown families for garbage input", () => {
    const r = parseUserAgent("not a real user agent");
    expect(r.os_name).toBe("unknown");
    expect(r.browser_name).toBe("unknown");
    expect(r.device_type).toBe("desktop");
  });
});

describe("getHeaderCaseInsensitive", () => {
  it("finds a canonically-cased User-Agent header", () => {
    const event = { headers: { "User-Agent": "abc" } };
    expect(getHeaderCaseInsensitive(event, "user-agent")).toBe("abc");
  });
  it("finds a lowercase user-agent header", () => {
    const event = { headers: { "user-agent": "abc" } };
    expect(getHeaderCaseInsensitive(event, "User-Agent")).toBe("abc");
  });
  it("returns '' when the header is absent", () => {
    expect(getHeaderCaseInsensitive({ headers: {} }, "user-agent")).toBe("");
  });
  it("returns '' when the event has no headers", () => {
    expect(getHeaderCaseInsensitive({}, "user-agent")).toBe("");
    expect(getHeaderCaseInsensitive(undefined, "user-agent")).toBe("");
  });
  it("returns '' for a null header value", () => {
    const event = { headers: { "user-agent": null } };
    expect(getHeaderCaseInsensitive(event, "user-agent")).toBe("");
  });
});
