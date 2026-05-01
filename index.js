const express = require("express");
const cors = require("cors");
const axios = require("axios");
const puppeteer = require("puppeteer");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════════════

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const BLOCKED_HOSTS = [
  "google-analytics.com",
  "googletagmanager.com",
  "doubleclick.net",
  "facebook.com",
  "hotjar.com",
  "clarity.ms",
  "mixpanel.com",
  "amplitude.com",
];

/** Returns true ONLY for genuine video CDN stream URLs (not analytics/tracker junk) */
function isRealVideoUrl(url) {
  if (!url || !url.startsWith("http")) return false;
  if (BLOCKED_HOSTS.some((h) => url.includes(h))) return false;
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    const hasVideoPath =
      path.endsWith(".mp4") ||
      path.endsWith(".m3u8") ||
      path.endsWith(".flv") ||
      path.endsWith(".mkv") ||
      path.endsWith(".ts") ||
      path.includes("/file/") ||
      path.includes("/stream/") ||
      path.includes("/media/") ||
      path.includes("/play/") ||
      path.includes("/video/");
    if (!hasVideoPath) return false;
    const junk = ["poster", "thumbnail", "preview", "icon", "logo", "avatar", "sprite"];
    if (junk.some((j) => path.includes(j))) return false;
    return true;
  } catch {
    return false;
  }
}

/** True if this looks like a Terabox internal API call that may contain dlink */
function isTeraboxAPICall(url) {
  return (
    url.includes("terabox.com/api/") ||
    url.includes("terabox.app/api/") ||
    url.includes("teraboxapp.com/api/") ||
    url.includes("/api/shorturlinfo") ||
    url.includes("/api/list") ||
    url.includes("/api/getfileinfo") ||
    url.includes("/share/list") ||
    url.includes("/share/download") ||
    url.includes("bdstoken")
  );
}

/** Recursively search JSON object for a real video URL */
function findVideoInJson(obj, depth = 0) {
  if (depth > 10 || !obj) return null;
  if (typeof obj === "string") return isRealVideoUrl(obj) ? obj : null;
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const found = findVideoInJson(item, depth + 1);
      if (found) return found;
    }
  }
  if (typeof obj === "object") {
    const priority = [
      "dlink", "download_link", "videoUrl", "video_url",
      "url", "src", "path", "downloadLink", "play_url", "m3u8_url",
    ];
    for (const key of priority) {
      if (obj[key]) {
        const found = findVideoInJson(obj[key], depth + 1);
        if (found) return found;
      }
    }
    for (const key of Object.keys(obj)) {
      if (!priority.includes(key)) {
        const found = findVideoInJson(obj[key], depth + 1);
        if (found) return found;
      }
    }
  }
  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  OPTION A — PUBLIC EXTRACTOR APIS  (fast, ~2-5 seconds)
// ═══════════════════════════════════════════════════════════════════════════

async function tryPublicAPI_A1(shareUrl) {
  const apiUrl = `https://terabox.hnn.workers.dev/?url=${encodeURIComponent(shareUrl)}`;
  console.log("[A1]", apiUrl);
  const res = await axios.get(apiUrl, {
    headers: { "User-Agent": BROWSER_UA },
    timeout: 10000,
  });
  const found = findVideoInJson(res.data);
  if (found) return found;
  if (typeof res.data === "string") {
    const m = res.data.match(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/i);
    if (m && isRealVideoUrl(m[0])) return m[0];
  }
  throw new Error("No video URL in A1 response");
}

async function tryPublicAPI_A2(shareUrl) {
  const apiUrl = `https://teraboxvideodownloader.nepcoderdevs.workers.dev/?url=${encodeURIComponent(shareUrl)}`;
  console.log("[A2]", apiUrl);
  const res = await axios.get(apiUrl, {
    headers: { "User-Agent": BROWSER_UA },
    timeout: 10000,
  });
  const found = findVideoInJson(res.data);
  if (found) return found;
  throw new Error("No video URL in A2 response");
}

async function tryPublicAPI_A3(shareUrl) {
  console.log("[A3] teradownloader.vercel.app");
  const res = await axios.post(
    "https://teradownloader.vercel.app/api/get",
    { url: shareUrl },
    {
      headers: { "User-Agent": BROWSER_UA, "Content-Type": "application/json" },
      timeout: 10000,
    }
  );
  const found = findVideoInJson(res.data);
  if (found) return found;
  throw new Error("No video URL in A3 response");
}

// ═══════════════════════════════════════════════════════════════════════════
//  OPTION B — PUPPETEER HEADLESS BROWSER  (slower, ~10-20s, most reliable)
// ═══════════════════════════════════════════════════════════════════════════

async function tryPuppeteer(shareUrl) {
  console.log("[Puppeteer] Launching headless Chrome for:", shareUrl);

  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-software-rasterizer",
    ],
  });

  let foundVideoUrl = null;

  try {
    const page = await browser.newPage();
    await page.setUserAgent(BROWSER_UA);
    await page.setViewport({ width: 1280, height: 800 });
    await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

    // B1 — Intercept internal Terabox API JSON responses for dlink
    page.on("response", async (response) => {
      if (foundVideoUrl) return;
      const url = response.url();
      if (response.status() !== 200) return;
      const ct = response.headers()["content-type"] || "";

      // Direct video stream
      if (ct.includes("video/") && isRealVideoUrl(url)) {
        console.log("[Puppeteer] B1 video stream:", url);
        foundVideoUrl = url;
        return;
      }

      // Terabox API calls or JSON responses containing dlink
      if (isTeraboxAPICall(url) || ct.includes("application/json")) {
        try {
          const text = await response.text();
          if (text.includes("dlink") || text.includes("download")) {
            let data;
            try { data = JSON.parse(text); } catch { return; }
            const found = findVideoInJson(data);
            if (found) {
              console.log("[Puppeteer] B1 found in API response:", found);
              foundVideoUrl = found;
            }
          }
        } catch { /* response body may not be readable */ }
      }
    });

    // B2 — Block trackers and intercept real video requests
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const url = request.url();
      if (BLOCKED_HOSTS.some((h) => url.includes(h))) {
        request.abort();
        return;
      }
      if (!foundVideoUrl && isRealVideoUrl(url)) {
        console.log("[Puppeteer] B2 intercepted video request:", url);
        foundVideoUrl = url;
      }
      request.continue();
    });

    // Navigate and wait for network to settle
    await page.goto(shareUrl, { waitUntil: "networkidle2", timeout: 35000 });

    // Give lazy loaders extra time
    await new Promise((r) => setTimeout(r, 5000));

    // B3 — Scan DOM if still not found
    if (!foundVideoUrl) {
      foundVideoUrl = await page.evaluate(() => {
        const video = document.querySelector("video");
        if (video && video.src && video.src.startsWith("http")) return video.src;
        const source = document.querySelector("source[src]");
        if (source && source.src) return source.src;

        const scripts = Array.from(document.querySelectorAll("script"));
        for (const s of scripts) {
          const text = s.textContent || "";
          const dlink = text.match(/"dlink"\s*:\s*"(https?[^"]+)"/);
          if (dlink) return dlink[1].replace(/\\\//g, "/");
          const mp4 = text.match(/(https?:\/\/(?!.*google)[^\s"'<>]+\.mp4)/);
          if (mp4) return mp4[1];
        }

        const raw = document.documentElement.innerHTML;
        const dl = raw.match(/"dlink"\s*:\s*"(https?[^"\\]+(?:\\.[^"\\]*)*)"/);
        if (dl) return dl[1].replace(/\\u002F/g, "/").replace(/\\\//g, "/");
        return null;
      });
    }

  } finally {
    await browser.close();
  }

  if (foundVideoUrl) {
    console.log("[Puppeteer] ✅ Final URL:", foundVideoUrl);
    return foundVideoUrl;
  }

  throw new Error("Puppeteer: no video URL found. Link may require login or is private.");
}

// ═══════════════════════════════════════════════════════════════════════════
//  ORCHESTRATOR — Option A first, then Option B
// ═══════════════════════════════════════════════════════════════════════════

async function extractVideoUrl(shareUrl) {
  const publicAPIs = [
    { name: "Public API A1 (hnn worker)",   fn: () => tryPublicAPI_A1(shareUrl) },
    { name: "Public API A2 (nepcoderdevs)", fn: () => tryPublicAPI_A2(shareUrl) },
    { name: "Public API A3 (teradownloader)",fn: () => tryPublicAPI_A3(shareUrl) },
  ];

  for (const api of publicAPIs) {
    try {
      console.log(`\n[extract] ⚡ Trying ${api.name}...`);
      const url = await api.fn();
      if (url) {
        console.log(`[extract] ✅ ${api.name} succeeded!`);
        return url;
      }
    } catch (err) {
      console.warn(`[extract] ❌ ${api.name}: ${err.message}`);
    }
  }

  console.log("\n[extract] 🔄 All public APIs failed — launching Puppeteer fallback...");
  return await tryPuppeteer(shareUrl);
}

// ═══════════════════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.get("/", (req, res) => {
  res.json({
    status: "LinkPlay backend ✅",
    strategies: ["Public APIs A1-A3 (fast)", "Puppeteer headless browser (reliable fallback)"],
  });
});

app.post("/extract", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url is required in request body" });

  console.log(`\n${"═".repeat(60)}\n[extract] ${url}\n${"═".repeat(60)}`);

  try {
    const videoUrl = await extractVideoUrl(url);
    console.log(`[extract] 🎉 Returning: ${videoUrl}\n`);
    return res.json({ videoUrl });
  } catch (err) {
    console.error(`[extract] 💥 All strategies failed: ${err.message}\n`);
    return res.status(500).json({
      error: "Could not extract video. The link may be expired, private, or require login.",
      detail: err.message,
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  START
// ═══════════════════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  console.log(`\n✅ LinkPlay backend running on port ${PORT}`);
  console.log(`   Strategy: Public APIs (fast) → Puppeteer (fallback)\n`);
});
