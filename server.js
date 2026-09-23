process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const { TiktokDL } = require('@tobyg74/tiktok-api-dl');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, '../vercel front')));

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err.message || err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason.message || reason));

const SAVETUBE_KEY = Buffer.from('C5D58EF67A7584E4A29F6C35BBC4EB12', 'hex');

// Set DEBUG_DOWNLOAD=true di environment kalau mau lihat log detail tiap percobaan CDN/Cobalt
const DEBUG_DOWNLOAD = process.env.DEBUG_DOWNLOAD === 'true';
function debugLog(...args) {
  if (DEBUG_DOWNLOAD) console.log('[debug]', ...args);
}

// Cobalt public instances (fallback untuk HD YouTube)
const COBALT_INSTANCES = [
  'https://cobalt.api.timelessnesses.me',
  'https://co.wuk.sh',
  'https://cobalt.tools.gg',
  'https://api.cobalt.tools',
  'https://cbl.frge.io',
  'https://cobalt.deno.dev',
];

async function tryCobaltFallback(videoId, quality) {
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const failedInstances = [];
  for (const base of COBALT_INSTANCES) {
    try {
      const r = await fetch(`${base}/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ url: videoUrl, vQuality: String(quality), isAudioOnly: false, vCodec: 'h264', filenamePattern: 'basic' }),
        signal: AbortSignal.timeout(15000)
      });
      if (!r.ok) { failedInstances.push(base); continue; }
      const j = await r.json();
      if (j.status === 'stream' && j.url) return j.url;
      if (j.status === 'redirect' && j.url) return j.url;
      failedInstances.push(base);
    } catch (e) {
      failedInstances.push(base);
      debugLog(`Cobalt ${base} error:`, e.message);
    }
  }
  if (failedInstances.length > 0) {
    console.warn(`Cobalt fallback q${quality}: semua ${failedInstances.length} instance gagal`);
  }
  return null;
}

// ============================================================
// HELPER FUNCTIONS
// ============================================================
function detectPlatform(url) {
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
  if (/tiktok\.com/i.test(url)) return 'tiktok';
  return null;
}

function extractYTId(url) {
  const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=|shorts\/))([\w-]{11})/);
  return match ? match[1] : null;
}

function fixTikWmUrl(pathUrl) {
  if (!pathUrl) return '';
  if (pathUrl.startsWith('http://') || pathUrl.startsWith('https://')) return pathUrl;
  if (pathUrl.startsWith('//')) return `https:${pathUrl}`;
  return `https://www.tikwm.com${pathUrl.startsWith('/') ? '' : '/'}${pathUrl}`;
}

function createProxyUrl(directUrl, filename) {
  return `/api/download?url=${encodeURIComponent(directUrl)}&filename=${encodeURIComponent(filename)}`;
}

// ============================================================
// YOUTUBE HANDLER (High Definition & MP3 Engine)
// ============================================================
async function extractYouTubeSaveTube(cleanUrl, videoId) {
  // Pool CDN SaveTube (8 CDN)
  const knownCdns = [
    'cdn406.savetube.vip', 'cdn400.savetube.vip', 'cdn405.savetube.vip',
    'cdn500.savetube.vip', 'cdn501.savetube.vip', 'cdn502.savetube.vip',
    'cdn300.savetube.vip', 'cdn200.savetube.vip'
  ];
  let cdnList = [...knownCdns];

  // Ambil CDN dinamis dari API SaveTube
  try {
    const cdnRes = await fetch('https://media.savetube.vip/api/random-cdn', { signal: AbortSignal.timeout(4000) });
    if (cdnRes.ok) {
      const cdnData = await cdnRes.json();
      if (cdnData?.cdn && !cdnList.includes(cdnData.cdn)) cdnList.unshift(cdnData.cdn);
    }
  } catch (e) {}

  let videoData = null;
  let activeCdn = cdnList[0];
  const infoFailedCdns = [];

  // Coba setiap CDN untuk mendapatkan info video (retry 2x per CDN)
  for (const cdn of cdnList) {
    let attempts = 0;
    while (attempts < 2) {
      attempts++;
      try {
        const infoRes = await fetch(`https://${cdn}/v2/info`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            'Origin': 'https://yt-mp4.net',
            'Referer': 'https://yt-mp4.net/'
          },
          body: JSON.stringify({ url: cleanUrl }),
          signal: AbortSignal.timeout(15000)
        });

        if (!infoRes.ok) break;
        const infoJson = await infoRes.json();
        if (!infoJson.status || !infoJson.data) break;

        const rawBuffer = Buffer.from(infoJson.data, 'base64');
        const iv = rawBuffer.subarray(0, 16);
        const cipherText = rawBuffer.subarray(16);
        const decipher = crypto.createDecipheriv('aes-128-cbc', SAVETUBE_KEY, iv);
        let decrypted = decipher.update(cipherText, null, 'utf8');
        decrypted += decipher.final('utf8');

        videoData = JSON.parse(decrypted);
        activeCdn = cdn;
        break;
      } catch (e) {
        debugLog(`SaveTube CDN ${cdn} attempt ${attempts} error:`, e.message);
        if (attempts < 2) await new Promise(r => setTimeout(r, 800));
      }
    }
    if (videoData) break;
    infoFailedCdns.push(cdn);
  }

  if (!videoData) {
    console.warn(`SaveTube info: semua ${infoFailedCdns.length} CDN gagal untuk videoId=${videoId}`);
    throw new Error('Gagal mengekstrak info video dari semua CDN SaveTube');
  }

  // Fungsi download URL dengan rotasi CDN jika timeout
  // timeoutMs disesuaikan dari durasi video: makin panjang video, makin lama SaveTube butuh waktu transcode
  async function getDownloadUrlWithFallback(downloadType, quality, timeoutMs = 12000) {
    const isAudio = downloadType === 'audio' || String(quality) === '128';
    const body = JSON.stringify({
      downloadType: isAudio ? 'audio' : 'video',
      quality: String(quality),
      key: videoData.key
    });
    const reqHeaders = {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Origin': 'https://yt-mp4.net',
      'Referer': 'https://yt-mp4.net/'
    };

    // Coba CDN aktif dulu, lalu rotasi ke CDN lain jika gagal (max 3 CDN, 1 attempt each)
    const tryCdns = [activeCdn, ...cdnList.filter(c => c !== activeCdn)].slice(0, 3);
    const failedCdns = [];
    for (const cdn of tryCdns) {
      try {
        const r = await fetch(`https://${cdn}/download`, {
          method: 'POST', headers: reqHeaders, body,
          signal: AbortSignal.timeout(timeoutMs)
        });
        if (!r.ok) { failedCdns.push(cdn); continue; }
        const json = await r.json();
        const dlUrl = json.data?.downloadUrl || null;
        if (dlUrl) return dlUrl;
        failedCdns.push(cdn);
      } catch (e) {
        failedCdns.push(cdn);
        debugLog(`CDN ${cdn} download q${quality}:`, e.message);
      }
    }
    if (failedCdns.length > 0) {
      console.warn(`SaveTube download q${quality}: semua ${failedCdns.length} CDN gagal (${failedCdns.join(', ')})`);
    }
    return null;
  }

  const title = videoData.title || `YouTube Video (${videoId})`;
  const downloads = [];

  // Durasi video (detik) - dipakai untuk nentuin timeout & apakah perlu skip Cobalt
  const durationSec = Number(videoData.duration) || 0;
  const isLongVideo = durationSec > 3600; // > 1 jam
  // SaveTube butuh waktu transcode lebih lama untuk video panjang, jadi timeout dinaikkan bertahap
  const downloadTimeoutMs = durationSec > 7200 ? 45000   // > 2 jam
    : durationSec > 3600 ? 30000                          // 1-2 jam
    : durationSec > 1800 ? 20000                           // 30-60 menit
    : 12000;                                               // di bawah 30 menit

  // 1. Format langsung (Direct Stream - instan, tidak perlu transcode)
  const directFormats = (videoData.video_formats || []).filter(v => v.url);
  for (const df of directFormats) {
    const q = parseInt(df.quality || df.height) || 360;
    const directLink = df.url + `&title=${encodeURIComponent(videoData.titleSlug || 'video')}-ytmp4.savetube.vip`;
    downloads.push({
      type: 'video',
      quality: `${q}p MP4`,
      resolution: `${q}p`,
      url: createProxyUrl(directLink, `${title} [${q}p].mp4`)
    });
  }

  // 2. Kualitas target (1080p, 720p, 360p) - via SaveTube dengan CDN rotation
  const targetTranscoded = [1080, 720, 360];

  // Timeout wrapper per-quality agar tidak blocking terlalu lama
  // Bug fix: clearTimeout agar timer tidak jalan terus setelah promise selesai
  // Timeout total per-quality juga ikut nyesuain durasi video (+15s buffer di atas timeout fetch)
  function withTimeout(promise, ms, label) {
    let timerId;
    const timer = new Promise((_, reject) => {
      timerId = setTimeout(() => reject(new Error(`Timeout ${ms}ms`)), ms);
    });
    return Promise.race([promise, timer])
      .then(val => { clearTimeout(timerId); return val; })
      .catch(e => {
        clearTimeout(timerId);
        console.warn(`${label} timeout/error:`, e.message);
        return null;
      });
  }
  const perQualityTimeoutMs = downloadTimeoutMs + 15000;

  const videoPromises = targetTranscoded.map(q => {
    const work = (async () => {
      // Skip jika sudah ada di direct formats (dengan URL langsung)
      const hasDirectFormat = (videoData.video_formats || []).find(v => {
        const vq = parseInt(v.quality || v.height);
        return vq === q && v.url && v.url.startsWith('http');
      });
      if (hasDirectFormat) return null;

      // Coba SaveTube dulu (timeout menyesuaikan durasi video)
      let dlUrl = await getDownloadUrlWithFallback('video', q, downloadTimeoutMs);

      // Fallback ke Cobalt hanya untuk video < 1 jam.
      // Cobalt publik sudah diblokir YouTube sejak pertengahan 2025, jadi untuk video panjang
      // ini cuma buang waktu ~90 detik (6 instance x 15s) tanpa peluang berhasil.
      if (!dlUrl && !isLongVideo) {
        debugLog(`SaveTube gagal untuk ${q}p, mencoba Cobalt fallback...`);
        dlUrl = await tryCobaltFallback(videoId, q);
      }
      if (!dlUrl) {
        console.warn(`Quality ${q}p: gagal didapatkan${isLongVideo ? ' (video panjang, Cobalt di-skip)' : ' (SaveTube & Cobalt sama-sama gagal)'}`);
      }

      if (dlUrl) {
        const label = q >= 1080 ? `${q}p Full HD MP4` : q >= 720 ? `${q}p HD MP4` : `${q}p MP4`;
        return {
          type: 'video',
          quality: label,
          resolution: `${q}p`,
          url: createProxyUrl(dlUrl, `${title} [${q}p].mp4`)
        };
      }
      return null;
    })();
    // Bug fix: error hanya dicatat 1x dari withTimeout, bukan dari inner catch juga
    return withTimeout(work, perQualityTimeoutMs, `Quality ${q}p`);
  });

  // 3. Audio MP3 (timeout juga disesuaikan durasi)
  const audioPromise = (async () => {
    try {
      let dlAudio = await getDownloadUrlWithFallback('audio', 128, downloadTimeoutMs);
      if (dlAudio) {
        return {
          type: 'audio',
          quality: 'Audio Original MP3 (HQ)',
          resolution: 'MP3',
          url: createProxyUrl(dlAudio, `${title}.mp3`)
        };
      }
    } catch (e) {
      console.warn('Audio MP3 error:', e.message);
    }
    return null;
  })();

  const settled = await Promise.allSettled([...videoPromises, audioPromise]);
  for (const item of settled) {
    if (item.status === 'fulfilled' && item.value) downloads.push(item.value);
  }

  // Deduplikasi berdasarkan resolusi & tipe
  const seen = new Set();
  const uniqueDownloads = [];
  for (const d of downloads) {
    const key = `${d.type}-${d.resolution}`;
    if (!seen.has(key)) { seen.add(key); uniqueDownloads.push(d); }
  }

  uniqueDownloads.sort((a, b) => {
    if (a.type === 'video' && b.type === 'audio') return -1;
    if (a.type === 'audio' && b.type === 'video') return 1;
    if (a.type === 'video' && b.type === 'video') {
      return (parseInt(b.resolution) || 0) - (parseInt(a.resolution) || 0);
    }
    return 0;
  });

  return {
    title,
    author: 'YouTube Creator',
    duration: videoData.durationLabel || (videoData.duration ? `${videoData.duration}s` : 'HD'),
    thumbnail: videoData.thumbnail || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    downloads: uniqueDownloads,
    isLongVideo,
    durationSec
  };
}

// ============================================================
// YT-DLP ENGINE (Fallback ke-2, khusus video panjang / SaveTube down)
// Tidak spawn binary lokal (shared hosting biasanya tidak bisa) -
// server ini cuma proxy ke microservice yt-dlp yang jalan di Render/VPS.
// Set env var YTDLP_SERVICE_URL & YTDLP_SERVICE_KEY di hosting panel kamu.
// ============================================================
const YTDLP_SERVICE_URL = (process.env.YTDLP_SERVICE_URL || '').replace(/\/$/, ''); // contoh: https://ytdlp-service.onrender.com
const YTDLP_SERVICE_KEY = process.env.YTDLP_SERVICE_KEY || '';

async function extractYouTubeYtDlp(cleanUrl, videoId) {
  if (!YTDLP_SERVICE_URL) {
    debugLog('YTDLP_SERVICE_URL belum di-set, skip engine yt-dlp.');
    return null;
  }

  let info;
  try {
    const infoUrl = `${YTDLP_SERVICE_URL}/info?url=${encodeURIComponent(cleanUrl)}&key=${encodeURIComponent(YTDLP_SERVICE_KEY)}`;
    const infoRes = await fetch(infoUrl, { signal: AbortSignal.timeout(35000) });
    info = await infoRes.json();
    if (!infoRes.ok || !info.status) {
      console.warn('yt-dlp microservice info gagal:', info.message || infoRes.status);
      return null;
    }
  } catch (e) {
    console.warn('yt-dlp microservice tidak bisa diakses:', e.message);
    return null;
  }

  const availableHeights = info.availableHeights || [];
  const downloads = [];
  for (const q of [1080, 720, 360]) {
    // Hanya tawarkan quality yang benar-benar ada di source video
    const hasHeight = availableHeights.length === 0 || availableHeights.some(h => h >= q - 40 && h <= q + 40);
    if (!hasHeight) continue;
    downloads.push({
      type: 'video',
      quality: `${q}p MP4 (yt-dlp)`,
      resolution: `${q}p`,
      url: `/api/ytdlp-stream?vid=${videoId}&quality=${q}&title=${encodeURIComponent(info.title || videoId)}`
    });
  }
  downloads.push({
    type: 'audio',
    quality: 'Audio Original (yt-dlp)',
    resolution: 'MP3',
    url: `/api/ytdlp-stream?vid=${videoId}&quality=audio&title=${encodeURIComponent(info.title || videoId)}`
  });

  return {
    title: info.title || `YouTube Video (${videoId})`,
    author: info.uploader || 'YouTube Creator',
    duration: info.duration ? `${info.duration}s` : 'HD',
    thumbnail: info.thumbnail || `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`,
    downloads
  };
}

// Endpoint di server shared hosting ini: cuma proxy stream dari microservice ke user.
// API key TIDAK pernah dikirim ke browser user, karena request ke microservice terjadi di sini (server-side).
app.get('/api/ytdlp-stream', async (req, res) => {
  if (!YTDLP_SERVICE_URL) return res.status(500).send('yt-dlp microservice belum dikonfigurasi (YTDLP_SERVICE_URL kosong).');

  const { vid, quality, title } = req.query;
  if (!vid) return res.status(400).send('vid kosong.');
  const videoUrl = `https://www.youtube.com/watch?v=${vid}`;

  try {
    const streamUrl = `${YTDLP_SERVICE_URL}/stream?url=${encodeURIComponent(videoUrl)}`
      + `&quality=${encodeURIComponent(quality || '720')}`
      + `&title=${encodeURIComponent(title || vid)}`
      + `&key=${encodeURIComponent(YTDLP_SERVICE_KEY)}`;

    const upstream = await fetch(streamUrl);
    if (!upstream.ok || !upstream.body) {
      console.warn('ytdlp-stream: microservice merespons error', upstream.status);
      return res.status(502).send('Gagal mengambil stream dari yt-dlp microservice.');
    }

    res.setHeader('Content-Disposition', upstream.headers.get('content-disposition') || 'attachment');
    res.setHeader('Content-Type', upstream.headers.get('content-type') || 'video/mp4');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (e) {
    console.error('ytdlp-stream proxy error:', e.message);
    res.status(500).send('Gagal proxy stream dari yt-dlp microservice.');
  }
});

async function handleYouTube(url, res) {
  try {
    if (/[?&]list=/i.test(url) || /\/playlist\?/i.test(url)) {
      return res.status(400).json({ status: false, message: 'URL Playlist YouTube tidak didukung!' });
    }

    if (/\/live\//i.test(url) || /[?&]isLive=true/i.test(url)) {
      return res.status(400).json({ status: false, message: 'URL Live Stream YouTube tidak didukung!' });
    }

    const videoId = extractYTId(url);
    if (!videoId) {
      return res.status(400).json({ status: false, message: 'URL YouTube tidak valid atau tidak didukung!' });
    }

    const cleanUrl = `https://www.youtube.com/watch?v=${videoId}`;
    let title = `YouTube Video (${videoId})`;
    let author = 'YouTube Creator';
    let thumbnail = `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

    // Metadata via oEmbed
    try {
      const oembedRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(cleanUrl)}&format=json`);
      if (oembedRes.ok) {
        const oembedData = await oembedRes.json();
        if (oembedData.title) title = oembedData.title;
        if (oembedData.author_name) author = oembedData.author_name;
      }
    } catch (e) {}

    // Engine 1: High Definition + MP3 SaveTube Extraction (Multi-CDN & Instant Direct Stream)
    let ytResultForError = null;
    try {
      const ytResult = await extractYouTubeSaveTube(cleanUrl, videoId);
      ytResultForError = ytResult;
      if (ytResult && ytResult.downloads && ytResult.downloads.length > 0) {
        return res.json({
          status: true,
          platform: 'youtube',
          title: ytResult.title || title,
          author: ytResult.author || author,
          duration: ytResult.duration || 'HD',
          thumbnail: ytResult.thumbnail || thumbnail,
          downloads: ytResult.downloads
        });
      }
    } catch (err) {
      console.warn('SaveTube Engine Notice:', err.message);
    }

    if (ytResultForError && ytResultForError.isLongVideo) {
      // Video panjang: SaveTube (+Cobalt) memang biasanya gagal. Coba yt-dlp sebagai Engine 2.
      const ytDlpResult = await extractYouTubeYtDlp(cleanUrl, videoId);
      if (ytDlpResult && ytDlpResult.downloads.length > 0) {
        return res.json({
          status: true,
          platform: 'youtube',
          title: ytDlpResult.title || title,
          author: ytDlpResult.author || author,
          duration: ytDlpResult.duration || 'HD',
          thumbnail: ytDlpResult.thumbnail || thumbnail,
          downloads: ytDlpResult.downloads
        });
      }
      return res.status(400).json({
        status: false,
        message: 'Video terlalu panjang (durasi lebih dari 1 jam) sehingga gagal diproses oleh server. Coba video yang lebih pendek, atau ulangi beberapa saat lagi.'
      });
    }

    return res.status(500).json({
      status: false,
      message: 'Server pemroses YouTube sedang sibuk atau video dibatasi usia/hak cipta. Silakan coba video lainnya atau ulangi sesaat lagi.'
    });
  } catch (err) {
    console.error('YouTube Handler Exception:', err.message);
    return res.status(500).json({ status: false, message: 'Gagal memproses video YouTube: ' + (err.message || 'Error') });
  }
}

// ============================================================
// TIKTOK HANDLER (HD No Watermark & MP3)
// ============================================================
async function handleTikTok(url, res) {
  try {
    let targetUrl = url.trim();

    // Auto-resolve shortened links (vt.tiktok.com, vm.tiktok.com)
    if (/vt\.tiktok\.com|vm\.tiktok\.com/i.test(targetUrl)) {
      try {
        const headRes = await fetch(targetUrl, {
          redirect: 'follow',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
          },
          signal: AbortSignal.timeout(6000)
        });
        if (headRes.url) {
          targetUrl = headRes.url;
        }
      } catch (e) {
        console.warn('Redirect resolve warning:', e.message);
      }
    }

    const cleanUrl = targetUrl.split('?')[0];
    let downloads = [];
    let title = 'TikTok Video';
    let author = 'TikTok User';
    let duration = 'HD';
    let thumbnail = '';

    // Engine 1: TikWM API with HD = 1
    try {
      const formData = new URLSearchParams();
      formData.append('url', targetUrl);
      formData.append('hd', '1');

      const tikwmRes = await fetch('https://www.tikwm.com/api/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
        },
        body: formData,
        signal: AbortSignal.timeout(8000)
      });

      if (tikwmRes.ok) {
        const tikwmData = await tikwmRes.json();
        if (tikwmData && tikwmData.code === 0 && tikwmData.data) {
          const d = tikwmData.data;
          title = d.title || title;
          author = d.author?.nickname || d.author?.unique_id || author;
          duration = d.duration ? `${d.duration}s` : duration;
          thumbnail = fixTikWmUrl(d.cover);

          // 1. HD No Watermark (hdplay)
          if (d.hdplay) {
            downloads.push({
              type: 'video',
              quality: 'No Watermark (Full HD MP4)',
              resolution: 'HD 1080p',
              url: createProxyUrl(fixTikWmUrl(d.hdplay), `${title} [HD].mp4`)
            });
          }

          // 2. Standard No Watermark (play)
          const playUrl = fixTikWmUrl(d.play);
          const hdUrl = fixTikWmUrl(d.hdplay);
          if (d.play && (!d.hdplay || playUrl !== hdUrl)) {
            downloads.push({
              type: 'video',
              quality: 'No Watermark (SD MP4)',
              resolution: 'SD',
              url: createProxyUrl(playUrl, `${title}.mp4`)
            });
          } else if (!d.hdplay && d.play) {
            downloads.push({
              type: 'video',
              quality: 'No Watermark (HD MP4)',
              resolution: 'HD',
              url: createProxyUrl(playUrl, `${title}.mp4`)
            });
          }

          // 3. Original Audio (MP3)
          if (d.music) {
            downloads.push({
              type: 'audio',
              quality: 'Audio Original (MP3)',
              resolution: 'MP3',
              url: createProxyUrl(fixTikWmUrl(d.music), `${title}.mp3`)
            });
          }

          // 4. Slide Images (if photo post)
          if (d.images && Array.isArray(d.images)) {
            d.images.forEach((img, idx) => {
              downloads.push({
                type: 'image',
                quality: `Foto Slide #${idx + 1} (HD)`,
                resolution: 'JPG',
                url: createProxyUrl(fixTikWmUrl(img), `${title} - Slide ${idx + 1}.jpg`)
              });
            });
          }
        }
      }
    } catch (e) {
      console.warn('TikWM error:', e.message);
    }

    // Engine 2: Fallback TiktokDL
    if (downloads.length === 0) {
      try {
        let result = await TiktokDL(cleanUrl, { version: 'v1' });
        if (result && result.status === 'success' && result.result) {
          const data = result.result;
          title = data.desc || title;
          author = data.author?.nickname || author;
          thumbnail = data.cover || thumbnail;

          const videoUrl = data.video1 || data.video2 || data.play;
          if (videoUrl) {
            downloads.push({
              type: 'video',
              quality: 'No Watermark (HD MP4)',
              resolution: 'HD',
              url: createProxyUrl(videoUrl, `${title}.mp4`)
            });
          }
          if (data.music) {
            downloads.push({
              type: 'audio',
              quality: 'Audio Original (MP3)',
              resolution: 'MP3',
              url: createProxyUrl(data.music, `${title}.mp3`)
            });
          }
        }
      } catch (e) {}
    }

    if (downloads.length === 0) {
      return res.status(400).json({ status: false, message: 'Gagal mengekstrak video TikTok. Pastikan video publik dan link valid.' });
    }

    return res.json({
      status: true,
      platform: 'tiktok',
      title,
      author,
      duration,
      thumbnail,
      downloads
    });

  } catch (err) {
    console.error('TikTok Handler Exception:', err.message);
    return res.status(500).json({ status: false, message: 'Gagal memproses video TikTok.' });
  }
}

// ============================================================
// ENDPOINT PROXY DOWNLOAD (Direct Stream Proxy with Headers)
// ============================================================
app.get('/api/download', async (req, res) => {
  try {
    const { url, filename } = req.query;
    if (!url) return res.status(400).send('URL media tidak ditemukan.');

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    };

    if (url.includes('tiktok') || url.includes('tikwm') || url.includes('tiktokcdn')) {
      headers['Referer'] = 'https://www.tiktok.com/';
    } else if (url.includes('savetube') || url.includes('googlevideo') || url.includes('youtube')) {
      headers['Referer'] = 'https://yt-mp4.net/';
    }

    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    const mediaRes = await fetch(url, {
      redirect: 'follow',
      headers
    });

    if (!mediaRes.ok && mediaRes.status !== 206) {
      throw new Error(`HTTP Error: ${mediaRes.status}`);
    }

    const rawFilename = filename || 'download.mp4';
    const cleanFilename = rawFilename.replace(/[\/\\?%*:|"<>]/g, '').replace(/\s+/g, ' ').trim();
    const asciiFilename = cleanFilename.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, '') || 'download.mp4';
    const encodedFilename = encodeURIComponent(cleanFilename);

    let contentType = mediaRes.headers.get('content-type') || 'application/octet-stream';
    if (cleanFilename.endsWith('.mp3')) contentType = 'audio/mpeg';
    else if (cleanFilename.endsWith('.mp4')) contentType = 'video/mp4';
    else if (cleanFilename.endsWith('.jpg') || cleanFilename.endsWith('.jpeg')) contentType = 'image/jpeg';

    const contentLength = mediaRes.headers.get('content-length');
    const contentRange = mediaRes.headers.get('content-range');

    res.status(mediaRes.status);
    res.setHeader('Content-Disposition', `attachment; filename="${asciiFilename}"; filename*=UTF-8''${encodedFilename}`);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Accept-Ranges', 'bytes');

    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }
    if (contentRange) {
      res.setHeader('Content-Range', contentRange);
    }

    if (mediaRes.body) {
      Readable.fromWeb(mediaRes.body).pipe(res);
    } else {
      const buffer = Buffer.from(await mediaRes.arrayBuffer());
      res.send(buffer);
    }
  } catch (err) {
    console.error('Proxy Download Error:', err.message);
    res.status(500).send('Gagal mengunduh berkas media: ' + (err.message || 'Error'));
  }
});

// ============================================================
// MAIN ROUTE
// ============================================================
app.post('/api/fetch', async (req, res) => {
  try {
    const { url } = req.body || {};
    if (!url) return res.status(400).json({ status: false, message: 'URL tidak boleh kosong!' });

    const platform = detectPlatform(url);

    if (platform === 'tiktok') {
      return await handleTikTok(url, res);
    }

    if (platform === 'youtube') {
      return await handleYouTube(url, res);
    }

    return res.status(400).json({ status: false, message: 'URL tidak didukung! Masukkan tautan YouTube atau TikTok yang valid.' });
  } catch (err) {
    return res.status(500).json({ status: false, message: 'Terjadi kesalahan pada server.' });
  }
});

app.get('/', (req, res) => {
  res.json({
    status: true,
    message: 'SaweriaFetch Backend API Running!',
    features: ['YouTube HD 1080p/720p', 'YouTube MP3 Audio', 'TikTok HD No Watermark', 'TikTok MP3 Audio']
  });
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`🚀 Server aktif di Port ${PORT}`);
  try {
    const ipRes = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(4000) });
    if (ipRes.ok) {
      const ipData = await ipRes.json();
      console.log(`\n======================================================`);
      console.log(`🌐 IP Server Nexus Anda : ${ipData.ip}`);
      console.log(`🔗 Link Website Anda    : http://${ipData.ip}:${PORT}`);
      console.log(`======================================================\n`);
    }
  } catch (e) {
    console.log(`💡 Buka website menggunakan IP Nexus Anda di port ${PORT}`);
  }
});
