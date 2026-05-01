const express = require("express");
const cors = require("cors");
const axios = require("axios");
const puppeteer = require("puppeteer");
const Razorpay = require("razorpay");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || "rzp_live_Sk6n4kM08wtdao",
  key_secret: process.env.RAZORPAY_KEY_SECRET || "placeholder_secret",
});

app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════════════════════════

const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const BASE_HEADERS = {
  "User-Agent": BROWSER_UA,
  "Referer": "https://www.terabox.com/",
  "Origin": "https://www.terabox.com",
};

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

// dlink = full download link (must come before play_url/m3u8_url which are preview-only streams)
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
      "dlink",          // full download link — highest priority
      "download_link",
      "downloadLink",
      "stream_url",
      "video_url",
      "videoUrl",
      "m3u8_url",       // HLS stream — preview-only on unauthenticated Terabox
      "play_url",       // preview stream — only used as last resort
      "url",
      "src",
      "path",
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
//  STRATEGIES
// ═══════════════════════════════════════════════════════════════════════════

// Calls Terabox's own public share API to get the full dlink.
// This works without any account cookies for public (non-password) shares.
// The sign+timestamp are returned by shorturlinfo itself, so no auth is needed.
async function tryDirectAPI(shareUrl) {
  const surlMatch = shareUrl.match(/\/s\/([^/?&#]+)/);
  if (!surlMatch) return null;
  const surl = surlMatch[1];

  // Step 1: Get share metadata — returns shareid, uk, sign, timestamp even for anonymous users
  const infoRes = await axios.get(
    `https://www.terabox.com/api/shorturlinfo?app_id=250528&shorturl=${surl}&root=1`,
    { headers: BASE_HEADERS, timeout: 12000 }
  );
  const info = infoRes.data;
  if (info.errno !== 0 || !info.shareid || !info.uk) {
    console.log("[DirectAPI] shorturlinfo errno:", info.errno);
    return null;
  }

  // Step 2: Get file list
  const listRes = await axios.get(
    `https://www.terabox.com/share/list?app_id=250528&shorturl=${surl}&root=1&shareid=${info.shareid}&uk=${info.uk}&order=name&desc=0&showempty=0&web=1&page=1&num=20`,
    { headers: BASE_HEADERS, timeout: 12000 }
  );
  const list = listRes.data;
  if (list.errno !== 0 || !list.list?.length) {
    console.log("[DirectAPI] share/list errno:", list.errno);
    return null;
  }

  // Prefer video file by extension
  const videoFile = list.list.find(f => {
    const name = (f.server_filename || "").toLowerCase();
    return name.endsWith(".mp4") || name.endsWith(".mkv") || name.endsWith(".flv") ||
           name.endsWith(".avi") || name.endsWith(".mov") || name.endsWith(".m4v");
  }) || list.list[0];

  if (!videoFile?.fs_id) return null;

  // Step 3: Get the signed full-download link using the sign from step 1
  if (!info.sign || !info.timestamp) {
    console.log("[DirectAPI] no sign/timestamp in shorturlinfo");
    return null;
  }

  const dlRes = await axios.get(
    `https://www.terabox.com/api/download?app_id=250528&sign=${info.sign}&timestamp=${info.timestamp}&fs_id=${videoFile.fs_id}&uk=${info.uk}&shareid=${info.shareid}&channel=chunlei&web=1`,
    { headers: BASE_HEADERS, timeout: 12000 }
  );
  const found = findVideoInJson(dlRes.data);
  if (found) console.log("[DirectAPI] got dlink ✓");
  return found;
}

async function tryPublicAPI_A1(shareUrl) {
  const apiUrl = `https://terabox.hnn.workers.dev/?url=${encodeURIComponent(shareUrl)}`;
  const res = await axios.get(apiUrl, { headers: { "User-Agent": BROWSER_UA }, timeout: 10000 });
  return findVideoInJson(res.data);
}

async function tryPublicAPI_A2(shareUrl) {
  const apiUrl = `https://teraboxvideodownloader.nepcoderdevs.workers.dev/?url=${encodeURIComponent(shareUrl)}`;
  const res = await axios.get(apiUrl, { headers: { "User-Agent": BROWSER_UA }, timeout: 10000 });
  return findVideoInJson(res.data);
}

async function tryPublicAPI_A3(shareUrl) {
  const res = await axios.post(
    "https://teradownloader.vercel.app/api/get",
    { url: shareUrl },
    { headers: { "User-Agent": BROWSER_UA, "Content-Type": "application/json" }, timeout: 10000 }
  );
  return findVideoInJson(res.data);
}

async function tryPuppeteer(shareUrl) {
  const browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--disable-software-rasterizer"],
  });
  let foundVideoUrl = null;
  try {
    const page = await browser.newPage();
    await page.setUserAgent(BROWSER_UA);
    await page.setViewport({ width: 1280, height: 800 });
    page.on("response", async (response) => {
      if (foundVideoUrl) return;
      const url = response.url();
      if (response.status() !== 200) return;
      const ct = response.headers()["content-type"] || "";
      if (ct.includes("video/") && isRealVideoUrl(url)) { foundVideoUrl = url; return; }
      if (isTeraboxAPICall(url) || ct.includes("application/json")) {
        try {
          const text = await response.text();
          if (text.includes("dlink") || text.includes("download")) {
            const data = JSON.parse(text);
            const found = findVideoInJson(data);
            if (found) foundVideoUrl = found;
          }
        } catch {}
      }
    });
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const url = request.url();
      if (BLOCKED_HOSTS.some((h) => url.includes(h))) { request.abort(); return; }
      if (!foundVideoUrl && isRealVideoUrl(url)) foundVideoUrl = url;
      request.continue();
    });
    await page.goto(shareUrl, { waitUntil: "networkidle2", timeout: 35000 });
    await new Promise((r) => setTimeout(r, 5000));
  } finally {
    await browser.close();
  }
  return foundVideoUrl;
}

async function followRedirects(url) {
  try {
    const res = await axios.get(url, {
      headers: BASE_HEADERS,
      maxRedirects: 10,
      timeout: 8000,
      validateStatus: s => s < 400,
    });
    return res.request?.res?.responseUrl || url;
  } catch {
    return url;
  }
}

async function extractVideoUrl(shareUrl) {
  // Direct Terabox API first — returns dlink (full file), not play_url (preview)
  try { const url = await tryDirectAPI(shareUrl); if (url) return url; } catch (e) { console.error("[DirectAPI]", e.message); }
  try { const url = await tryPublicAPI_A1(shareUrl); if (url) return url; } catch {}
  try { const url = await tryPublicAPI_A2(shareUrl); if (url) return url; } catch {}
  try { const url = await tryPublicAPI_A3(shareUrl); if (url) return url; } catch {}
  return await tryPuppeteer(shareUrl);
}

// ═══════════════════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.get("/", (req, res) => { res.json({ status: "LinkPlay backend ✅" }); });

app.post("/extract", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });
  try {
    let videoUrl = await extractVideoUrl(url);
    if (videoUrl && !videoUrl.includes(".m3u8")) {
      videoUrl = await followRedirects(videoUrl);
    }
    return res.json({ videoUrl });
  } catch (err) {
    return res.status(500).json({ error: "Extraction failed", detail: err.message });
  }
});

// Proxy — streams CDN video with Referer/Range headers so seeking works.
app.get("/proxy-video", async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "url is required" });
  try {
    const headers = { ...BASE_HEADERS };
    if (req.headers.range) headers["Range"] = req.headers.range;

    const upstream = await axios.get(decodeURIComponent(url), {
      headers,
      responseType: "stream",
      maxRedirects: 10,
      timeout: 30000,
    });

    res.setHeader("Content-Type", upstream.headers["content-type"] || "video/mp4");
    res.setHeader("Accept-Ranges", "bytes");
    if (upstream.headers["content-length"]) res.setHeader("Content-Length", upstream.headers["content-length"]);
    if (upstream.headers["content-range"]) res.setHeader("Content-Range", upstream.headers["content-range"]);
    res.status(upstream.status);
    upstream.data.pipe(res);
  } catch (err) {
    if (!res.headersSent) res.status(500).json({ error: "Proxy failed", detail: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  PAYMENT ROUTES
// ═══════════════════════════════════════════════════════════════════════════

app.post("/create-payment-link", async (req, res) => {
  const { amount } = req.body;
  try {
    const response = await razorpay.paymentLink.create({
      amount: amount * 100,
      currency: "INR",
      accept_partial: false,
      description: "LinkPlay 24-Hour Premium Pass",
      customer: { name: "LinkPlay User", email: "user@linkplay.app", contact: "" },
      notify: { sms: false, email: false },
      reminder_enable: false,
      notes: { app: "LinkPlay" },
      callback_url: "https://web-production-b1fa09.up.railway.app/payment-success",
      callback_method: "get",
    });
    res.json({ url: response.short_url, id: response.id });
  } catch (error) {
    console.error("[Razorpay] Create Link Error:", error);
    res.status(500).json({ error: "Could not create payment link" });
  }
});

app.get("/payment-success", (req, res) => {
  res.send("<h1>Payment Successful!</h1><p>You can now return to the LinkPlay app.</p>");
});

app.post("/verify-payment-status", async (req, res) => {
  const { payment_link_id } = req.body;
  try {
    const response = await razorpay.paymentLink.fetch(payment_link_id);
    if (response.status === "paid") {
      res.json({ success: true });
    } else {
      res.json({ success: false, status: response.status });
    }
  } catch (error) {
    console.error("[Razorpay] Verify Error:", error);
    res.status(500).json({ error: "Verification failed" });
  }
});

app.listen(PORT, () => { console.log(`✅ LinkPlay backend running on port ${PORT}`); });
