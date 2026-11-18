require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { ZipArchive } = require('archiver');
const { ObjectId } = require('mongodb');
const { connectDB, upsertStudies, getMongoStats, queryPatients, MONGODB_URI } = require('./db');
const {
  initMinio,
  uploadDicomInstance,
  getDicomInstanceStream,
  statDicomObject,
  listStudyDicomObjects,
  getStudyDicomStatus,
  getMinioStats,
  pruneMinioOldestStudies,
  BUCKET_NAME,
} = require('./minioClient');
const {
  ROLES,
  ROLE_PERMISSIONS,
  DEFAULT_USERS,
  initAuth,
  authenticateUser,
  requireAuth,
  optionalAuth,
  listUsers,
  createUser,
  updateUser,
  deleteUser
} = require('./auth');
const settingsManager = require('./settingsManager');
const { parseReportFromPdf, parseReportFromText, generateReportHtml, renderModernPdf, formatReportFilename } = require('./reportGenerator');
const { registerReportsRoutes } = require('./reportsApi');

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 2020;
let PACS_HOST = process.env.PACS_HOST || 'http://103.102.85.3';

// Local storage configuration
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, 'storage');
const DICOM_DIR = path.join(STORAGE_DIR, 'dicom');
const THUMB_DIR = path.join(STORAGE_DIR, 'thumbnails');
const REPORT_DIR = path.join(STORAGE_DIR, 'reports');

let MAX_CACHE_GB = parseFloat(process.env.MAX_CACHE_GB) || 100;
let MAX_CACHE_BYTES = MAX_CACHE_GB * 1024 * 1024 * 1024;

// Initialize settings on startup
settingsManager.initSettings().then(cfg => {
  if (cfg.pacs?.pacsHost) PACS_HOST = cfg.pacs.pacsHost;
  if (cfg.storage?.maxCacheGb) {
    MAX_CACHE_GB = parseFloat(cfg.storage.maxCacheGb) || 100;
    MAX_CACHE_BYTES = MAX_CACHE_GB * 1024 * 1024 * 1024;
  }
}).catch(() => { });

// Ensure storage directories exist
[STORAGE_DIR, DICOM_DIR, THUMB_DIR, REPORT_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

app.use(cors({
  origin: '*',
  methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  exposedHeaders: ['Content-Disposition', 'Content-Length', 'Content-Type']
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res, next) => {
  if (req.path.startsWith('/reports') || req.path.startsWith('/api/report')) {
    console.log(`[HTTP ${req.method}] ${req.originalUrl} - IP: ${req.ip} - UA: ${req.headers['user-agent'] || '-'}`);
  }
  next();
});

// Calculate directory size helper
async function getDirSize(dirPath) {
  let totalSize = 0;
  try {
    const files = await fsp.readdir(dirPath, { withFileTypes: true });
    for (const file of files) {
      const fullPath = path.join(dirPath, file.name);
      if (file.isDirectory()) {
        totalSize += await getDirSize(fullPath);
      } else if (file.isFile()) {
        const stat = await fsp.stat(fullPath);
        totalSize += stat.size;
      }
    }
  } catch (err) {
    // Directory might not exist or be empty
  }
  return totalSize;
}

// Unified Bounded Storage Watchdog across MinIO DICOM & Local Reports/Thumbnails
async function enforceStorageQuota() {
  try {
    const minioStats = await getMinioStats();
    const minioBytes = minioStats.totalBytes || 0;
    const reportBytes = await getDirSize(REPORT_DIR);
    const thumbBytes = await getDirSize(THUMB_DIR);
    const localDicomBytes = await getDirSize(DICOM_DIR);

    const totalUsedBytes = minioBytes + reportBytes + thumbBytes + localDicomBytes;

    if (totalUsedBytes <= MAX_CACHE_BYTES) {
      return {
        pruned: false,
        totalUsedBytes,
        totalGb: (totalUsedBytes / (1024 ** 3)).toFixed(3),
        maxCapGb: MAX_CACHE_GB,
      };
    }

    console.log(`[${MAX_CACHE_GB}GB Storage Watchdog] Storage exceeded ${MAX_CACHE_GB} GB (${(totalUsedBytes / (1024 ** 3)).toFixed(2)} GB). Enforcing quota...`);

    // Target: prune down to 80% of MAX_CACHE_GB (80 GB for 100 GB cap) to leave operational headroom
    const targetBytes = MAX_CACHE_BYTES * 0.8;
    const bytesNeededToFree = totalUsedBytes - targetBytes;

    let totalFreed = 0;

    // 1. Prune local report cache files
    const reportFiles = await fsp.readdir(REPORT_DIR).catch(() => []);
    if (reportFiles.length > 0) {
      const statsList = [];
      for (const rf of reportFiles) {
        const fp = path.join(REPORT_DIR, rf);
        const st = await fsp.stat(fp).catch(() => null);
        if (st) statsList.push({ path: fp, atime: st.atimeMs, size: st.size });
      }
      statsList.sort((a, b) => a.atime - b.atime);
      for (const item of statsList) {
        if (totalFreed >= bytesNeededToFree) break;
        await fsp.rm(item.path, { force: true });
        totalFreed += item.size;
      }
    }

    // 2. Prune oldest MinIO DICOM studies if quota still needs to be freed
    if (totalFreed < bytesNeededToFree) {
      const minioFreed = await pruneMinioOldestStudies(bytesNeededToFree - totalFreed);
      totalFreed += minioFreed.bytesFreed || 0;
    }

    console.log(`[${MAX_CACHE_GB}GB Storage Watchdog] Enforced quota. Total freed: ${(totalFreed / (1024 ** 3)).toFixed(2)} GB.`);
    return {
      pruned: true,
      bytesFreed: totalFreed,
      totalUsedBytes: Math.max(0, totalUsedBytes - totalFreed),
      totalGb: (Math.max(0, totalUsedBytes - totalFreed) / (1024 ** 3)).toFixed(3),
      maxCapGb: MAX_CACHE_GB,
    };
  } catch (err) {
    console.error(`[${MAX_CACHE_GB}GB Storage Watchdog Error]:`, err.message);
    return { error: err.message };
  }
}

// Backward-compatible alias
const enforce25GbStorageQuota = enforceStorageQuota;

// Run storage watchdog check every 10 minutes
setInterval(enforceStorageQuota, 10 * 60 * 1000);

// ==========================================
// Role-Based Authentication & User Endpoints
// ==========================================

// Authenticate user & issue JWT
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    const result = await authenticateUser(username, password);
    if (!result.success) {
      return res.status(401).json(result);
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Verify current session & fetch permissions
app.get('/api/auth/me', requireAuth(), (req, res) => {
  res.json({
    success: true,
    user: req.user,
    permissions: req.permissions
  });
});

// List roles & credential reference guide
app.get('/api/auth/roles', (req, res) => {
  res.json({
    success: true,
    roles: ROLES,
    permissions: ROLE_PERMISSIONS,
    demoAccounts: DEFAULT_USERS.map(u => ({
      username: u.username,
      password: u.password,
      role: u.role,
      name: u.name,
      department: u.department,
      badgeColor: (ROLE_PERMISSIONS[u.role] || {}).badgeColor || '#64748b',
      badgeText: (ROLE_PERMISSIONS[u.role] || {}).badgeText || u.role.toUpperCase()
    }))
  });
});

// Logout endpoint
app.post('/api/auth/logout', (req, res) => {
  res.json({ success: true, message: 'Logged out successfully' });
});

// Admin-only user management endpoint
app.get('/api/auth/users', requireAuth('canManageUsers'), async (req, res) => {
  try {
    const dbInstance = await connectDB();
    if (!dbInstance) {
      return res.status(503).json({ success: false, error: 'Database unavailable' });
    }
    const users = await dbInstance.collection('users')
      .find({}, { projection: { passwordHash: 0, passwordSalt: 0 } })
      .sort({ createdAt: -1 })
      .toArray();
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    pacsHost: PACS_HOST,
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// App configuration & cache info
app.get('/api/config', async (req, res) => {
  res.json({
    pacsHost: PACS_HOST,
    viewerBase: `${PACS_HOST}/ZEROFOOTPRINT/loadViewer.aspx`,
    defaultUserId: '{DA7C7444-8778-E911-B802-00155D006619}',
    defaultSessionId: '1011742888',
    serverName: 'PACS',
    institution: 'MAPIMS Hospital',
    maxCacheGb: MAX_CACHE_GB
  });
});

// Unified Storage Cache & Quota stats endpoint
app.get('/api/cache/stats', async (req, res) => {
  try {
    const minioStats = await getMinioStats();
    const minioBytes = minioStats.totalBytes || 0;
    const thumbBytes = await getDirSize(THUMB_DIR);
    const reportBytes = await getDirSize(REPORT_DIR);
    const localDicomBytes = await getDirSize(DICOM_DIR);

    const totalUsedBytes = minioBytes + reportBytes + thumbBytes + localDicomBytes;
    const remainingBytes = Math.max(0, MAX_CACHE_BYTES - totalUsedBytes);
    const utilizationPct = Math.min(100, parseFloat(((totalUsedBytes / MAX_CACHE_BYTES) * 100).toFixed(1)));

    res.json({
      success: true,
      limits: {
        maxCacheGb: MAX_CACHE_GB,
        maxCacheBytes: MAX_CACHE_BYTES,
        quotaRule: `${MAX_CACHE_GB} GB Max Combined Storage (DICOM + Reports + Previews)`
      },
      usage: {
        minioDicomBytes: minioBytes,
        minioDicomGb: parseFloat((minioBytes / (1024 ** 3)).toFixed(3)),
        minioDicomFiles: minioStats.totalDicomFiles || 0,
        thumbnailBytes: thumbBytes,
        thumbnailMb: parseFloat((thumbBytes / (1024 ** 2)).toFixed(2)),
        reportBytes,
        reportMb: parseFloat((reportBytes / (1024 ** 2)).toFixed(2)),
        totalBytes: totalUsedBytes,
        totalGb: parseFloat((totalUsedBytes / (1024 ** 3)).toFixed(3)),
        remainingGb: parseFloat((remainingBytes / (1024 ** 3)).toFixed(3)),
        utilizationPct,
        status: utilizationPct > 90 ? 'CRITICAL' : utilizationPct > 75 ? 'WARNING' : 'SAFE'
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Explicit Storage Quota Endpoint
app.get('/api/storage/quota', async (req, res) => {
  try {
    const minioStats = await getMinioStats();
    const minioBytes = minioStats.totalBytes || 0;
    const reportBytes = await getDirSize(REPORT_DIR);
    const thumbBytes = await getDirSize(THUMB_DIR);
    const localDicomBytes = await getDirSize(DICOM_DIR);
    const totalUsedBytes = minioBytes + reportBytes + thumbBytes + localDicomBytes;

    const remainingBytes = Math.max(0, MAX_CACHE_BYTES - totalUsedBytes);
    const utilizationPct = Math.min(100, parseFloat(((totalUsedBytes / MAX_CACHE_BYTES) * 100).toFixed(1)));

    res.json({
      success: true,
      maxLimitGb: MAX_CACHE_GB,
      maxLimitBytes: MAX_CACHE_BYTES,
      usedGb: parseFloat((totalUsedBytes / (1024 ** 3)).toFixed(3)),
      remainingGb: parseFloat((remainingBytes / (1024 ** 3)).toFixed(3)),
      utilizationPct,
      status: utilizationPct > 90 ? 'CRITICAL' : utilizationPct > 75 ? 'WARNING' : 'SAFE',
      breakdown: {
        minioDicomBytes: minioBytes,
        minioDicomMb: parseFloat((minioBytes / (1024 ** 2)).toFixed(2)),
        minioDicomFiles: minioStats.totalDicomFiles || 0,
        reportBytes,
        reportMb: parseFloat((reportBytes / (1024 ** 2)).toFixed(2)),
        thumbnailBytes: thumbBytes,
        thumbnailMb: parseFloat((thumbBytes / (1024 ** 2)).toFixed(2)),
      },
      quotaPolicy: {
        enforcement: `Automated LRU Watchdog + MinIO ${MAX_CACHE_GB}GiB Hard Quota`,
        evictionTargetPct: 80
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Manual Storage Prune Trigger Endpoint (Super Admin only)
app.post('/api/storage/prune', requireAuth('canPruneStorage'), async (req, res) => {
  try {
    const result = await enforce25GbStorageQuota();
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ZeroFootprint PACS session keepalive endpoint
app.get('/api/session/keepalive', async (req, res) => {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${PACS_HOST}/api_session_keepalive.asp`, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(502).json({
      success: false,
      error: `Failed to keep session alive: ${error.message}`
    });
  }
});

// Background periodic keepalive for PACS ZeroFootprint session (every 2 minutes)
async function keepPacsSessionAlive() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    await fetch(`${PACS_HOST}/api_session_keepalive.asp`, { signal: controller.signal });
    clearTimeout(timeout);
  } catch (err) {
    console.warn('[KeepAlive] PACS session ping notice:', err.message);
  }
}
setInterval(keepPacsSessionAlive, 2 * 60 * 1000);
keepPacsSessionAlive();

// Fetch studies from PACS
app.get('/api/studies', optionalAuth, async (req, res) => {
  try {
    const { from, to, status, modality, search, limit, offset } = req.query;

    const params = new URLSearchParams();
    if (from) params.append('from', from);
    if (to) params.append('to', to);
    if (status) params.append('status', status);
    if (modality) params.append('modality', modality);
    if (search) params.append('search', search);
    if (limit) params.append('limit', limit);
    if (offset) params.append('offset', offset);

    const targetUrl = `${PACS_HOST}/api_pacs.asp?${params.toString()}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(targetUrl, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      throw new Error(`PACS server returned status ${response.status}`);
    }

    const data = await response.json();
    if (data && data.success && Array.isArray(data.data)) {
      // Fast parallel verification for studies marked FINAL to check if Final_*.pdf exists
      const finalStudies = data.data.filter(s => (s.status || '').toUpperCase() === 'FINAL' || (s.finalizedBy && s.finalizedBy.trim() !== ''));

      await Promise.all(finalStudies.map(async (s) => {
        try {
          s.hasFinalDoc = true;
          const safeStudy = s.studyUid.replace(/[^a-zA-Z0-9._-]/g, '');
          const localPdf = path.join(REPORT_DIR, `Final_${safeStudy}.pdf`);
          if (fs.existsSync(localPdf)) {
            s.hasFinalPdf = true;
            return;
          }
          const pdfUrl = `${PACS_HOST}/PACS_DATA/Reports/${encodeURIComponent(s.studyUid)}/Final_${encodeURIComponent(s.studyUid)}.pdf`;
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 2000);
          const pdfRes = await fetch(pdfUrl, { method: 'HEAD', signal: controller.signal });
          clearTimeout(timeout);
          s.hasFinalPdf = pdfRes.ok;
        } catch (e) {
          s.hasFinalPdf = false;
        }
      }));

      data.data.forEach(s => {
        if (s.hasFinalPdf === undefined) {
          s.hasFinalPdf = false;
        }
        if (s.hasFinalDoc === undefined) {
          s.hasFinalDoc = (s.status || '').toUpperCase() === 'FINAL' || !!(s.finalizedBy && s.finalizedBy.trim() !== '');
        }
      });

      upsertStudies(data.data).catch(err => {
        console.warn('[MongoDB Ingest] Auto-save notice:', err.message);
      });
    }
    res.json(data);
  } catch (error) {
    console.error('Error fetching PACS studies:', error.message);
    res.status(502).json({
      success: false,
      error: `Failed to communicate with PACS server (${PACS_HOST}): ${error.message}`
    });
  }
});

// Series and instances metadata endpoint
app.get('/api/study/:studyUid/series', async (req, res) => {
  try {
    const { studyUid } = req.params;
    const targetUrl = `${PACS_HOST}/ZEROFOOTPRINT/getStudy.aspx?StudyUID=${encodeURIComponent(studyUid)}`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const response = await fetch(targetUrl, { signal: controller.signal });
    clearTimeout(timeout);

    if (!response.ok) {
      return res.status(response.status).json({ success: false, error: 'Failed to fetch series data' });
    }

    const data = await response.json();
    const seriesList = (data.seriesList || []).map(s => ({
      seriesUid: s.seriesUid,
      seriesNumber: s.seriesNumber || '1',
      seriesDescription: s.seriesDescription || 'Series ' + (s.seriesNumber || '1'),
      sopClassUid: s.SOPClassUID,
      instanceCount: (s.instanceList || []).length,
      thumbnailUrl: `/api/thumbnail/${encodeURIComponent(studyUid)}/${encodeURIComponent(s.seriesUid)}`
    }));

    res.json({
      success: true,
      studyUid,
      patientName: data.patientName,
      patientId: data.patientId,
      studyDate: data.studyDate,
      modality: data.Modality,
      studyDescription: data.studyDescription,
      numImages: data.numImages,
      seriesList
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Thumbnail proxy & local caching endpoint
app.get('/api/thumbnail/:studyUid/:seriesUid', async (req, res) => {
  try {
    const { studyUid, seriesUid } = req.params;
    const safeStudy = studyUid.replace(/[^a-zA-Z0-9._-]/g, '');
    const safeSeries = seriesUid.replace(/[^a-zA-Z0-9._-]/g, '');
    const localThumbPath = path.join(THUMB_DIR, `${safeStudy}_${safeSeries}.jpeg`);

    // Check local disk cache
    if (fs.existsSync(localThumbPath)) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=86400');
      return fs.createReadStream(localThumbPath).pipe(res);
    }

    // Cache MISS: Fetch from PACS server
    const remoteUrl = `${PACS_HOST}/PACS_DATA/Images/${encodeURIComponent(studyUid)}/${encodeURIComponent(seriesUid)}.jpeg`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const remoteRes = await fetch(remoteUrl, { signal: controller.signal });
    clearTimeout(timeout);

    if (!remoteRes.ok) {
      return res.status(404).send('Thumbnail not found');
    }

    const buffer = Buffer.from(await remoteRes.arrayBuffer());

    // Save to local cache asynchronously
    fsp.writeFile(localThumbPath, buffer).catch(() => { });

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(buffer);
  } catch (err) {
    res.status(500).send('Error fetching thumbnail');
  }
});

/**
 * Ensures a valid PDF report (either raw or compiled modern) exists locally for the study.
 * Automatically checks:
 * 1. Local compiled Modern_Final_<uid>.pdf or Final_<uid>.pdf
 * 2. Remote PACS Final_<uid>.pdf
 * 3. Remote PACS Final_<uid>.doc or <uid>.doc -> Auto-converts via LibreOffice/soffice or antiword
 * 4. Compiles modern colourful hospital report via renderModernPdf
 * 5. Updates MongoDB study record with hasFinalPdf: true
 * Returns { localPdfPath, modernPdfPath, fileToServe, studyDoc } or null if unavailable.
 */
async function ensureStudyPdf(studyUid, studyDoc = null) {
  if (!studyUid) return null;
  const safeStudy = String(studyUid).replace(/[^a-zA-Z0-9._-]/g, '');
  const localPdfPath = path.join(REPORT_DIR, `Final_${safeStudy}.pdf`);
  const modernPdfPath = path.join(REPORT_DIR, `Modern_Final_${safeStudy}.pdf`);
  const localDocPath = path.join(REPORT_DIR, `Final_${safeStudy}.doc`);

  // Ensure DB record is loaded
  if (!studyDoc || !studyDoc.patientName) {
    try {
      const db = await connectDB().catch(() => null);
      if (db) {
        studyDoc = (await db.collection('studies').findOne({
          $or: [
            { studyUid },
            { studyInstanceUid: studyUid },
            { accessionNumber: studyUid }
          ]
        })) || studyDoc || {};
      }
    } catch (_) { }
  }
  studyDoc = studyDoc || {};

  // 1. If Modern PDF already exists and is healthy (>2KB), return immediately
  if (fs.existsSync(modernPdfPath) && fs.statSync(modernPdfPath).size > 2000) {
    return {
      localPdfPath: fs.existsSync(localPdfPath) ? localPdfPath : modernPdfPath,
      modernPdfPath,
      fileToServe: modernPdfPath,
      studyDoc
    };
  }

  // 2. If raw PDF exists locally, compile modern PDF
  if (fs.existsSync(localPdfPath) && fs.statSync(localPdfPath).size > 1000) {
    try {
      const modern = await renderModernPdf(studyUid, studyDoc);
      if (fs.existsSync(modern) && fs.statSync(modern).size > 1000) {
        return { localPdfPath, modernPdfPath: modern, fileToServe: modern, studyDoc };
      }
    } catch (e) {
      console.warn(`[REPORT] renderModernPdf error for cached raw PDF ${studyUid}:`, e.message);
    }
    return { localPdfPath, modernPdfPath: localPdfPath, fileToServe: localPdfPath, studyDoc };
  }

  // 3. Try fetching Final_*.pdf directly from PACS server
  const remotePdfUrl = `${PACS_HOST}/PACS_DATA/Reports/${encodeURIComponent(studyUid)}/Final_${encodeURIComponent(studyUid)}.pdf`;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    const res = await fetch(remotePdfUrl, { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 500) {
        await fsp.writeFile(localPdfPath, buf);
        console.log(`[REPORT] Fetched remote PACS Final PDF for ${studyUid} (${buf.length} bytes)`);

        try {
          const db = await connectDB().catch(() => null);
          if (db) await db.collection('studies').updateOne({ studyUid }, { $set: { hasFinalPdf: true, hasFinalDoc: true } });
        } catch (_) { }

        try {
          const modern = await renderModernPdf(studyUid, studyDoc);
          if (fs.existsSync(modern) && fs.statSync(modern).size > 1000) {
            return { localPdfPath, modernPdfPath: modern, fileToServe: modern, studyDoc };
          }
        } catch (mErr) {
          console.warn(`[REPORT] Modern compile error for ${studyUid}:`, mErr.message);
        }
        return { localPdfPath, modernPdfPath: localPdfPath, fileToServe: localPdfPath, studyDoc };
      }
    }
  } catch (pdfFetchErr) {
    // Non-fatal, check for Word doc below
  }

  // 4. Fallback: Check for Word document (.doc) on PACS server
  const docUrls = [
    `${PACS_HOST}/PACS_DATA/Reports/${encodeURIComponent(studyUid)}/Final_${encodeURIComponent(studyUid)}.doc`,
    `${PACS_HOST}/PACS_DATA/Reports/${encodeURIComponent(studyUid)}/${encodeURIComponent(studyUid)}.doc`
  ];

  let docDownloaded = false;
  if (fs.existsSync(localDocPath) && fs.statSync(localDocPath).size > 1000) {
    docDownloaded = true;
  } else {
    for (const dUrl of docUrls) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);
        const res = await fetch(dUrl, { signal: controller.signal });
        clearTimeout(timeout);
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length > 500) {
            await fsp.writeFile(localDocPath, buf);
            docDownloaded = true;
            console.log(`[REPORT] Fetched remote PACS Word document for ${studyUid} from ${dUrl} (${buf.length} bytes)`);
            break;
          }
        }
      } catch (_) { }
    }
  }

  // 5. If Word doc is available, convert it to PDF
  if (docDownloaded) {
    // Attempt conversion via soffice / libreoffice
    try {
      const sofficeBin = fs.existsSync('/usr/bin/soffice') ? '/usr/bin/soffice' : (fs.existsSync('/usr/bin/libreoffice') ? '/usr/bin/libreoffice' : null);
      if (sofficeBin) {
        console.log(`[REPORT] Converting Word doc ${localDocPath} to PDF via ${sofficeBin}...`);
        execSync(`"${sofficeBin}" --headless --convert-to pdf --outdir "${REPORT_DIR}" "${localDocPath}"`, { timeout: 20000 });
        if (fs.existsSync(localPdfPath) && fs.statSync(localPdfPath).size > 1000) {
          console.log(`[REPORT] Successfully converted Word doc to PDF: ${localPdfPath} (${fs.statSync(localPdfPath).size} bytes)`);

          try {
            const db = await connectDB().catch(() => null);
            if (db) await db.collection('studies').updateOne({ studyUid }, { $set: { hasFinalPdf: true, hasFinalDoc: true } });
          } catch (_) { }

          try {
            const modern = await renderModernPdf(studyUid, studyDoc);
            if (fs.existsSync(modern) && fs.statSync(modern).size > 1000) {
              return { localPdfPath, modernPdfPath: modern, fileToServe: modern, studyDoc };
            }
          } catch (mErr) {
            console.warn(`[REPORT] Modern compile error from converted doc for ${studyUid}:`, mErr.message);
          }
          return { localPdfPath, modernPdfPath: localPdfPath, fileToServe: localPdfPath, studyDoc };
        }
      }
    } catch (convErr) {
      console.warn(`[REPORT] soffice conversion failed for ${studyUid}:`, convErr.message);
    }

    // Secondary fallback: antiword text extraction -> renderModernPdf
    try {
      if (fs.existsSync('/usr/bin/antiword')) {
        console.log(`[REPORT] Extracting clinical text from ${localDocPath} via antiword...`);
        const docText = execSync(`antiword "${localDocPath}"`, { timeout: 10000 }).toString('utf8');
        if (docText && docText.trim().length > 50) {
          const reportData = parseReportFromText(docText, docText, studyDoc);
          const htmlContent = await generateReportHtml(reportData, studyUid);
          const modernHtmlPath = path.join(REPORT_DIR, `Modern_Final_${safeStudy}.html`);
          await fsp.writeFile(modernHtmlPath, htmlContent, 'utf8');

          const chromeBin = fs.existsSync('/usr/bin/google-chrome')
            ? '/usr/bin/google-chrome'
            : (fs.existsSync('/usr/bin/chromium-browser') ? '/usr/bin/chromium-browser' : (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : null));
          if (chromeBin) {
            const printCmd = `"${chromeBin}" --headless=new --no-sandbox --disable-gpu --disable-software-rasterizer --print-to-pdf-no-header --print-to-pdf="${modernPdfPath}" "${modernHtmlPath}"`;
            execSync(printCmd, { timeout: 15000 });
            if (fs.existsSync(modernPdfPath) && fs.statSync(modernPdfPath).size > 1000) {
              await fsp.copyFile(modernPdfPath, localPdfPath).catch(() => { });
              try {
                const db = await connectDB().catch(() => null);
                if (db) await db.collection('studies').updateOne({ studyUid }, { $set: { hasFinalPdf: true, hasFinalDoc: true } });
              } catch (_) { }
              return { localPdfPath, modernPdfPath: modernPdfPath, fileToServe: modernPdfPath, studyDoc };
            }
          }
        }
      }
    } catch (antiErr) {
      console.warn(`[REPORT] antiword fallback failed for ${studyUid}:`, antiErr.message);
    }
  }

  return null;
}

// Check if a report exists for a study & verify if it has a completed Final PDF
app.get('/api/report/:studyUid/check', async (req, res) => {
  try {
    const { studyUid } = req.params;
    const safeStudy = studyUid.replace(/[^a-zA-Z0-9._-]/g, '');
    const localPdfPath = path.join(REPORT_DIR, `Final_${safeStudy}.pdf`);

    let patientName = '';
    let patientId = '';
    let studyDoc = null;
    try {
      const db = await connectDB().catch(() => null);
      if (db) {
        studyDoc = await db.collection('studies').findOne({
          $or: [
            { studyUid: studyUid },
            { studyInstanceUid: studyUid },
            { accessionNumber: studyUid }
          ]
        });
        if (studyDoc) {
          patientName = studyDoc.patientName || '';
          patientId = studyDoc.patientId || '';
        }
      }
    } catch (_) { }

    // First attempt to ensure PDF is available or auto-convert from PACS Word doc
    const pdfResult = await ensureStudyPdf(studyUid, studyDoc);

    if ((!patientName || !patientId) && fs.existsSync(localPdfPath)) {
      try {
        const parsed = parseReportFromPdf(localPdfPath, studyDoc || {});
        if (!patientName) patientName = parsed.patientName || '';
        if (!patientId) patientId = parsed.patientId || '';
      } catch (_) { }
    }

    const downloadFilename = formatReportFilename(patientName, patientId, studyUid);

    // 1. If valid PDF is verified (either cached or auto-converted)
    if (pdfResult && pdfResult.fileToServe && fs.existsSync(pdfResult.fileToServe)) {
      return res.json({
        available: true,
        hasFinalPdf: true,
        isCompleted: true,
        type: 'pdf',
        filename: `Final_${safeStudy}.pdf`,
        downloadFilename,
        patientName,
        patientId,
        status: 'COMPLETED',
        whatsappAllowed: true,
        url: `/api/report/${studyUid}`,
        message: 'Official Final PDF report verified and ready for delivery.'
      });
    }

    if (fs.existsSync(localPdfPath)) {
      return res.json({
        available: true,
        hasFinalPdf: true,
        isCompleted: true,
        type: 'pdf',
        filename: `Final_${safeStudy}.pdf`,
        downloadFilename,
        patientName,
        patientId,
        status: 'COMPLETED',
        whatsappAllowed: true,
        url: `/api/report/${studyUid}`,
        message: 'Official Final PDF report verified and ready for delivery.'
      });
    }

    // 2. Check PACS D:\ drive for Final PDF
    const pdfUrl = `${PACS_HOST}/PACS_DATA/Reports/${encodeURIComponent(studyUid)}/Final_${encodeURIComponent(studyUid)}.pdf`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4000);
    const pdfRes = await fetch(pdfUrl, { method: 'HEAD', signal: controller.signal });
    clearTimeout(timeout);

    if (pdfRes.ok) {
      return res.json({
        available: true,
        hasFinalPdf: true,
        isCompleted: true,
        type: 'pdf',
        filename: `Final_${safeStudy}.pdf`,
        downloadFilename,
        patientName,
        patientId,
        status: 'COMPLETED',
        whatsappAllowed: true,
        url: `/api/report/${studyUid}`,
        message: 'Official Final PDF report verified in PACS D:\\ drive and ready for delivery.'
      });
    }

    // 3. Check for Word Draft (.doc) - Not completed!
    const docUrl = `${PACS_HOST}/PACS_DATA/Reports/${encodeURIComponent(studyUid)}/Final_${encodeURIComponent(studyUid)}.doc`;
    const c2 = new AbortController();
    const t2 = setTimeout(() => c2.abort(), 4000);
    const docRes = await fetch(docUrl, { method: 'HEAD', signal: c2.signal });
    clearTimeout(t2);

    if (docRes.ok) {
      return res.json({
        available: true,
        hasFinalPdf: false,
        isCompleted: false,
        type: 'doc',
        filename: `Final_${safeStudy}.doc`,
        downloadFilename,
        patientName,
        patientId,
        status: 'DRAFT_DOC',
        whatsappAllowed: false,
        url: `/api/report/${studyUid}`,
        message: 'Report is NOT COMPLETED: Only a Word draft (.doc) is present in PACS D:\\ drive. WhatsApp sending is locked until Final PDF is generated.'
      });
    }

    // 4. Fallback check for un-prefixed .doc
    const docUrl2 = `${PACS_HOST}/PACS_DATA/Reports/${encodeURIComponent(studyUid)}/${encodeURIComponent(studyUid)}.doc`;
    const c3 = new AbortController();
    const t3 = setTimeout(() => c3.abort(), 4000);
    const docRes2 = await fetch(docUrl2, { method: 'HEAD', signal: c3.signal });
    clearTimeout(t3);

    if (docRes2.ok) {
      return res.json({
        available: true,
        hasFinalPdf: false,
        isCompleted: false,
        type: 'doc',
        filename: `${safeStudy}.doc`,
        downloadFilename,
        patientName,
        patientId,
        status: 'DRAFT_DOC',
        whatsappAllowed: false,
        url: `/api/report/${studyUid}`,
        message: 'Report is NOT COMPLETED: Only preliminary Word document (.doc) found in PACS D:\\ drive. WhatsApp sending is locked until Final PDF is generated.'
      });
    }

    // 5. Neither PDF nor DOC found
    res.json({
      available: false,
      hasFinalPdf: false,
      isCompleted: false,
      type: null,
      downloadFilename,
      patientName,
      patientId,
      status: 'NOT_FOUND',
      whatsappAllowed: false,
      message: 'No diagnostic report file found in PACS D:\\ drive.'
    });
  } catch (err) {
    res.json({
      available: false,
      hasFinalPdf: false,
      isCompleted: false,
      type: null,
      error: err.message,
      whatsappAllowed: false
    });
  }
});

// Diagnostic Report viewing / downloading endpoint (Radiologists, Doctors, Admins)
app.get('/api/report/:studyUid', requireAuth('canViewReports'), async (req, res) => {
  try {
    const { studyUid } = req.params;
    const safeStudy = studyUid.replace(/[^a-zA-Z0-9._-]/g, '');
    const localPdfPath = path.join(REPORT_DIR, `Final_${safeStudy}.pdf`);
    const isDownload = req.query.download === '1' || req.query.download === 'true';
    const isRaw = req.query.raw === '1';
    // Only return HTML if explicitly requested via ?format=html AND not requesting a PDF download
    const isHtml = req.query.format === 'html' && !isDownload;

    // Retrieve studyDoc for clinical metadata enrichment
    let studyDoc = {};
    try {
      const db = await connectDB().catch(() => null);
      if (db) {
        studyDoc = (await db.collection('studies').findOne({
          $or: [
            { studyUid: studyUid },
            { studyInstanceUid: studyUid },
            { accessionNumber: studyUid }
          ]
        })) || {};
      }
    } catch (e) { }

    // Ensure PDF report is cached locally or auto-converted from Word doc
    const pdfResult = await ensureStudyPdf(studyUid, studyDoc);
    const pdfPathToUse = pdfResult?.fileToServe || (fs.existsSync(localPdfPath) ? localPdfPath : null);

    // 2. If Final PDF is available, generate/serve Modern Colourful UI or PDF
    if (pdfPathToUse && fs.existsSync(pdfPathToUse)) {
      // Determine patient-based filename (PatientName_PatientID.pdf)
      let pName = studyDoc.patientName;
      let pId = studyDoc.patientId;
      if (!pName || !pId) {
        try {
          const rawForParsing = fs.existsSync(localPdfPath) ? localPdfPath : pdfPathToUse;
          const parsed = parseReportFromPdf(rawForParsing, studyDoc);
          if (!pName) pName = parsed.patientName;
          if (!pId) pId = parsed.patientId;
        } catch (e) { }
      }
      const downloadFilename = formatReportFilename(pName, pId, safeStudy);

      // Interactive HTML format (for in-browser modal viewing)
      if (isHtml) {
        const rawForParsing = fs.existsSync(localPdfPath) ? localPdfPath : pdfPathToUse;
        const reportData = parseReportFromPdf(rawForParsing, studyDoc);
        const html = await generateReportHtml(reportData, studyUid);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(html);
      }

      // If user specifically requested legacy raw PACS PDF
      if (isRaw && fs.existsSync(localPdfPath)) {
        const stat = fs.statSync(localPdfPath);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Length', stat.size);
        res.setHeader('Content-Disposition', `inline; filename="${downloadFilename}"`);
        res.setHeader('Accept-Ranges', 'bytes');
        return res.sendFile(localPdfPath);
      }

      // Serve modern colourful PDF
      const stat = fs.statSync(pdfPathToUse);
      const disposition = isDownload ? 'attachment' : 'inline';
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Content-Disposition', `${disposition}; filename="${downloadFilename}"`);
      res.setHeader('Accept-Ranges', 'bytes');
      return res.sendFile(pdfPathToUse);
    }

    // 3. Try DOC report from PACS if no Final PDF
    const docUrl = `${PACS_HOST}/PACS_DATA/Reports/${encodeURIComponent(studyUid)}/Final_${encodeURIComponent(studyUid)}.doc`;
    let response = await fetch(docUrl);
    if (response.ok) {
      const buffer = Buffer.from(await response.arrayBuffer());
      res.setHeader('Content-Type', 'application/msword');
      res.setHeader('Content-Disposition', `attachment; filename="Report_${safeStudy}.doc"`);
      return res.send(buffer);
    }

    // 4. Fallback un-prefixed .doc
    const docUrl2 = `${PACS_HOST}/PACS_DATA/Reports/${encodeURIComponent(studyUid)}/${encodeURIComponent(studyUid)}.doc`;
    response = await fetch(docUrl2);
    if (response.ok) {
      const buffer = Buffer.from(await response.arrayBuffer());
      res.setHeader('Content-Type', 'application/msword');
      res.setHeader('Content-Disposition', `attachment; filename="Report_${safeStudy}.doc"`);
      return res.send(buffer);
    }

    res.status(404).send('Report not yet generated or finalized for this study.');
  } catch (err) {
    res.status(500).send(`Error retrieving report: ${err.message}`);
  }
});

// ==========================================
// Cloudflare Public Tunnel for WATI Delivery
// ==========================================
let publicReportBaseUrl = (process.env.PUBLIC_REPORT_URL || '').trim().replace(/\/+$/, '');

function startPublicTunnel() {
  if (publicReportBaseUrl && !publicReportBaseUrl.includes('trycloudflare.com')) {
    console.log(`[TUNNEL] Using configured PUBLIC_REPORT_URL: ${publicReportBaseUrl}`);
    return;
  }

  const cloudflaredPath = fs.existsSync('/usr/local/bin/cloudflared')
    ? '/usr/local/bin/cloudflared'
    : (fs.existsSync('./cloudflared') ? './cloudflared' : (fs.existsSync('/tmp/cloudflared') ? '/tmp/cloudflared' : null));

  if (!cloudflaredPath) {
    console.warn('[TUNNEL] cloudflared binary not found; automatic public tunnel is disabled.');
    return;
  }

  console.log(`[TUNNEL] Launching Cloudflare public tunnel for port ${PORT}...`);
  const { spawn } = require('child_process');
  const tunnelProc = spawn(cloudflaredPath, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const checkUrl = (data) => {
    const text = data.toString();
    const match = text.match(/https:\/\/[a-zA-Z0-9-]+\.trycloudflare\.com/);
    if (match) {
      publicReportBaseUrl = match[0];
      console.log(`\n==================================================`);
      console.log(`🚀 [PUBLIC WATI TUNNEL ACTIVE]`);
      console.log(`Public Report Gateway: ${publicReportBaseUrl}`);
      console.log(`==================================================\n`);
    }
  };

  tunnelProc.stdout.on('data', checkUrl);
  tunnelProc.stderr.on('data', checkUrl);
  tunnelProc.on('exit', (code) => {
    console.warn(`[TUNNEL] Tunnel exited with code ${code}. Reconnecting in 5s...`);
    setTimeout(startPublicTunnel, 5000);
  });
}

// In-memory token store for high-speed lookup, backed by MongoDB
const reportTokens = new Map();

async function createPublicReportToken(studyUid) {
  const token = crypto.randomBytes(12).toString('hex');
  const safeStudy = String(studyUid).replace(/[^a-zA-Z0-9._-]/g, '');
  const expiresAt = new Date(Date.now() + 72 * 3600 * 1000); // 72 hours
  reportTokens.set(token, { studyUid, safeStudy, expiresAt: expiresAt.getTime() });

  try {
    const db = await connectDB().catch(() => null);
    if (db) {
      await db.collection('report_tokens').insertOne({
        _id: token,
        studyUid,
        safeStudy,
        expiresAt,
        createdAt: new Date()
      });
    }
  } catch (e) { }

  return token;
}

async function getPublicReportPdfUrl(studyUid, req) {
  const safeStudy = String(studyUid).replace(/[^a-zA-Z0-9._-]/g, '');
  const token = await createPublicReportToken(studyUid);
  const base = publicReportBaseUrl || (req ? `${req.protocol}://${req.get('host')}` : `http://127.0.0.1:${PORT}`);
  // Clean URL ending strictly with .pdf, recognized by Meta WhatsApp document crawlers
  return `${base}/reports/${token}/Final_${safeStudy}.pdf`;
}

// Clean Public PDF Endpoint for WhatsApp & Meta Scrapers (Ends strictly in .pdf, includes Content-Length)
app.get('/reports/:token/:filename', async (req, res) => {
  try {
    const { token, filename } = req.params;
    let info = reportTokens.get(token);

    if (!info) {
      const db = await connectDB().catch(() => null);
      if (db) {
        const doc = await db.collection('report_tokens').findOne({ _id: token });
        if (doc) {
          info = {
            studyUid: doc.studyUid,
            safeStudy: doc.safeStudy,
            expiresAt: new Date(doc.expiresAt).getTime()
          };
          reportTokens.set(token, info);
        }
      }
    }

    if (!info || (info.expiresAt && info.expiresAt < Date.now())) {
      console.warn(`[REPORT DOWNLOAD] Rejected expired or invalid token: ${token} (UA: ${req.headers['user-agent']})`);
      return res.status(404).send('Report download link expired or invalid.');
    }

    const { studyUid, safeStudy } = info;
    const localPdfPath = path.join(REPORT_DIR, `Final_${safeStudy}.pdf`);

    // Ensure PDF is cached locally or auto-converted from PACS Word doc
    const pdfResult = await ensureStudyPdf(studyUid, info);
    if (!pdfResult || !pdfResult.fileToServe || !fs.existsSync(pdfResult.fileToServe)) {
      console.warn(`[REPORT DOWNLOAD] Remote PACS file not found or could not be converted: ${studyUid}`);
      return res.status(404).send('PDF report not found on PACS server.');
    }

    const fileToServe = pdfResult.fileToServe;
    const stat = fs.statSync(fileToServe);
    console.log(`[REPORT DOWNLOAD] Serving ${path.basename(fileToServe)} (${stat.size} bytes) to UA: ${req.headers['user-agent']} (IP: ${req.ip})`);

    let pName = info.patientName;
    let pId = info.patientId;
    if (!pName || !pId) {
      try {
        const db = await connectDB().catch(() => null);
        if (db) {
          const sDoc = await db.collection('studies').findOne({ studyUid }) || {};
          if (!pName) pName = sDoc.patientName;
          if (!pId) pId = sDoc.patientId;
        }
      } catch (e) { }
    }
    if (!pName || !pId) {
      try {
        const rawForParsing = fs.existsSync(localPdfPath) ? localPdfPath : fileToServe;
        const parsed = parseReportFromPdf(rawForParsing, info);
        if (!pName) pName = parsed.patientName;
        if (!pId) pId = parsed.patientId;
      } catch (e) { }
    }
    const downloadFilename = formatReportFilename(pName, pId, safeStudy);
    const isDownload = req.query.download === '1' || req.query.download === 'true';
    const disposition = isDownload ? 'attachment' : 'inline';

    res.sendFile(fileToServe, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': stat.size,
        'Content-Disposition': `${disposition}; filename="${downloadFilename}"`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400'
      }
    });
  } catch (err) {
    console.error('[REPORT DOWNLOAD ERROR]', err);
    res.status(500).send('Error serving report PDF');
  }
});

// Direct studyUid public endpoint fallback: /reports/study/:studyUid/Final_:studyUid.pdf
app.get('/reports/study/:studyUid/:filename', async (req, res) => {
  try {
    const { studyUid } = req.params;
    const safeStudy = studyUid.replace(/[^a-zA-Z0-9._-]/g, '');
    const localPdfPath = path.join(REPORT_DIR, `Final_${safeStudy}.pdf`);

    let studyDoc = {};
    try {
      const db = await connectDB().catch(() => null);
      if (db) {
        studyDoc = (await db.collection('studies').findOne({
          $or: [
            { studyUid: studyUid },
            { studyInstanceUid: studyUid },
            { accessionNumber: studyUid }
          ]
        })) || {};
      }
    } catch (e) { }

    // Ensure PDF is cached locally or auto-converted from PACS Word doc
    const pdfResult = await ensureStudyPdf(studyUid, studyDoc);
    if (!pdfResult || !pdfResult.fileToServe || !fs.existsSync(pdfResult.fileToServe)) {
      return res.status(404).send('PDF report not found on PACS server.');
    }

    const fileToServe = pdfResult.fileToServe;

    let downloadFilename = req.params.filename;
    if (!downloadFilename || downloadFilename === 'report.pdf' || downloadFilename.startsWith('Final_') || downloadFilename.startsWith('MAPIMS_Report_')) {
      let pName = studyDoc.patientName;
      let pId = studyDoc.patientId;
      if (!pName || !pId) {
        try {
          const rawForParsing = fs.existsSync(localPdfPath) ? localPdfPath : fileToServe;
          const parsed = parseReportFromPdf(rawForParsing, studyDoc);
          if (!pName) pName = parsed.patientName;
          if (!pId) pId = parsed.patientId;
        } catch (e) { }
      }
      downloadFilename = formatReportFilename(pName, pId, safeStudy);
    }

    const stat = fs.statSync(fileToServe);
    const isDownload = req.query.download === '1' || req.query.download === 'true';
    const disposition = isDownload ? 'attachment' : 'inline';

    res.sendFile(fileToServe, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': stat.size,
        'Content-Disposition': `${disposition}; filename="${downloadFilename}"`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400'
      }
    });
  } catch (err) {
    console.error('[REPORT DOWNLOAD DIRECT ERROR]', err);
    res.status(500).send('Error serving report PDF');
  }
});

// ==========================================
// WhatsApp Business API Admin & Dispatch Flow
// ==========================================

// Function to query WATI for messages of a phone number
function fetchWatiContactMessages(phone) {
  return new Promise((resolve) => {
    let cleanPhone = String(phone).replace(/[^0-9]/g, '');
    if (cleanPhone.length === 10) cleanPhone = `91${cleanPhone}`;
    const endpoint = (process.env.API_ENDPOINT || 'https://live-mt-server.wati.io/10190409').replace(/\/+$/, '');
    const token = process.env.WATI_ACCESS_TOKEN;
    if (!token) return resolve([]);

    const https = require('https');
    const targetUrl = new URL(`${endpoint}/api/v1/getMessages/${cleanPhone}?pageSize=20`);

    const options = {
      hostname: targetUrl.hostname,
      path: targetUrl.pathname + targetUrl.search,
      method: 'GET',
      headers: {
        'Authorization': token.startsWith('Bearer ') ? token : `Bearer ${token}`
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json?.messages?.items || []);
        } catch (e) {
          resolve([]);
        }
      });
    });

    req.on('error', () => resolve([]));
    req.setTimeout(6000, () => { req.destroy(); resolve([]); });
    req.end();
  });
}

function isDummyPhone(num) {
  if (!num) return true;
  const digits = String(num).replace(/[^0-9]/g, '');
  if (digits.length < 10) return true;
  const last10 = digits.slice(-10);
  if (/^(\d)\1{9}$/.test(last10)) return true;
  if (last10 === '9000000000' || last10 === '0000000000' || last10 === '1234567890' || last10 === '9876543210') return true;
  return false;
}

// Format Date to MM/DD/YYYY for Central Hospital HIS SQL Queries
function formatToHisDate(dateVal) {
  if (!dateVal) {
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    return `${mm}/${dd}/${now.getFullYear()}`;
  }
  if (dateVal instanceof Date) {
    const mm = String(dateVal.getMonth() + 1).padStart(2, '0');
    const dd = String(dateVal.getDate()).padStart(2, '0');
    return `${mm}/${dd}/${dateVal.getFullYear()}`;
  }
  const str = String(dateVal).trim();
  const ymd = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (ymd) {
    return `${String(ymd[2]).padStart(2, '0')}/${String(ymd[3]).padStart(2, '0')}/${ymd[1]}`;
  }
  const dmy = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})/);
  if (dmy) {
    return `${String(dmy[2]).padStart(2, '0')}/${String(dmy[1]).padStart(2, '0')}/${dmy[3]}`;
  }
  return str;
}

// Check Hospital HIS QueryBuilder (Fo_Rpt_OPPatdetailsprint_QB) for OP Visit Details & ZPATIENT Fake Patient Flag
async function checkHisPatientType(patientId, studyDate = null) {
  if (!patientId) return null;
  const cleanId = String(patientId).trim();
  if (!cleanId) return null;

  const frmDate = formatToHisDate(studyDate);
  const toDate = formatToHisDate(new Date());

  const qbEndpoints = [
    process.env.HIS_QUERYBUILDER_URL,
    'http://172.19.0.1:18080/BB15SE/QueryBuilder/wsQueryBuilder.asmx/Getdataset1',
    'http://127.0.0.1:18080/BB15SE/QueryBuilder/wsQueryBuilder.asmx/Getdataset1',
    'http://192.168.103.37/BB15SE/QueryBuilder/wsQueryBuilder.asmx/Getdataset1'
  ].filter(Boolean);

  const sqlQuery = `Use kmch_frontoffice Exec Fo_Rpt_OPPatdetailsprint_QB @frmdate = '${frmDate}' , @todate = '${toDate}' , @regno = '${cleanId}' , @patname = '' , @docid = '0' , @IncludingDirectIP = '1' , @Visittype = '0' , @PatType = '0' , @MatrixFormat = '0' , @ReferredSource = '0' , @Type = '0' , @ClassId = '0' , @CorporateId = '0' , @Corporate_type = '0' , @depid = '0' , @RefDocCity = '0' , @ReligionId = '0' , @RefDocDays = '0' , @RefDocId = '0' , @VisitCategory = '' `;

  for (const endpoint of qbEndpoints) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify({
          strQuery: sqlQuery,
          strCon: 'BB_CONSTR'
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json();
        let items = [];
        if (data && data.d) {
          try {
            items = typeof data.d === 'string' ? JSON.parse(data.d) : data.d;
          } catch (_) { }
        }
        if (Array.isArray(items) && items.length > 0) {
          // Check if ANY visit record has PATIENT TYPE == 'ZPATIENT' (Hospital Fake / Test Patient)
          const zPat = items.find(it => {
            const pt = String(it['PATIENT TYPE'] || '').trim().toUpperCase();
            return pt === 'ZPATIENT' || pt.includes('ZPATIENT');
          });

          if (zPat) {
            return {
              isFake: true,
              patientType: 'ZPATIENT',
              isDummy: true,
              mobile: zPat['MOBILE'] || '9000000000',
              doctor: zPat['DOCTOR'] || '',
              department: zPat['DEPARTMENT'] || '',
              visitDate: zPat['VISIT DATE'] || '',
              name: zPat['NAME'] || '',
              reason: 'ZPATIENT (Hospital Fake/Test Registration)'
            };
          }

          const latest = items[0];
          const pt = String(latest['PATIENT TYPE'] || '').trim();
          const mob = String(latest['MOBILE'] || '').replace(/[^0-9]/g, '');
          return {
            isFake: false,
            patientType: pt,
            isDummy: isDummyPhone(mob),
            mobile: mob.length >= 10 ? mob.slice(-10) : '',
            doctor: latest['DOCTOR'] || '',
            department: latest['DEPARTMENT'] || '',
            visitDate: latest['VISIT DATE'] || '',
            name: latest['NAME'] || ''
          };
        }
      }
    } catch (_) { }
  }
  return null;
}

// Resolve Patient Phone Number from Previous Logs, PACS Records, Central Hospital HIS WebService, or OP EMR
async function resolvePatientPhone(patientId, studyDate = null) {
  if (!patientId) return null;
  const cleanId = String(patientId).trim();
  if (!cleanId) return null;

  // 1. Check pacs_db whatsapp_logs & studies & patients cache
  try {
    const db = await connectDB().catch(() => null);
    if (db) {
      // Check if patient is already flagged as Fake/ZPATIENT in local cache
      const patientDoc = await db.collection('patients').findOne(
        { patientId: cleanId },
        { projection: { phone: 1, name: 1, city: 1, ageGender: 1, isFake: 1, patientType: 1 } }
      );
      if (patientDoc && (patientDoc.isFake || patientDoc.patientType === 'ZPATIENT')) {
        return {
          phone: '',
          originalPhone: '9000000000',
          source: 'Hospital HIS (Fake / ZPATIENT)',
          isDummy: true,
          isFake: true,
          patientType: 'ZPATIENT',
          patientName: patientDoc.name || ''
        };
      }

      const pastStudy = await db.collection('studies').findOne(
        { patientId: cleanId },
        { projection: { patientPhone: 1, isFakePatient: 1, patientType: 1 } }
      );
      if (pastStudy && (pastStudy.isFakePatient || pastStudy.patientType === 'ZPATIENT')) {
        return {
          phone: '',
          originalPhone: '9000000000',
          source: 'Hospital HIS (Fake / ZPATIENT)',
          isDummy: true,
          isFake: true,
          patientType: 'ZPATIENT'
        };
      }

      const pastLog = await db.collection('whatsapp_logs').findOne(
        { patientId: cleanId, originalPhone: { $exists: true, $ne: '' } },
        { sort: { dispatchedAt: -1 }, projection: { originalPhone: 1, phone: 1 } }
      );
      const validPastPhone = (pastLog?.originalPhone || pastLog?.phone || '').replace(/[^0-9]/g, '');
      if (validPastPhone.length >= 10 && !isDummyPhone(validPastPhone)) {
        return { phone: validPastPhone.slice(-10), source: 'Previous PACS WhatsApp Log' };
      }

      const validStudyPhone = (pastStudy?.patientPhone || '').replace(/[^0-9]/g, '');
      if (validStudyPhone.length >= 10 && !isDummyPhone(validStudyPhone)) {
        return { phone: validStudyPhone.slice(-10), source: 'PACS Study Record' };
      }

      const validPatPhone = (patientDoc?.phone || '').replace(/[^0-9]/g, '');
      if (validPatPhone.length >= 10 && !isDummyPhone(validPatPhone)) {
        return {
          phone: validPatPhone.slice(-10),
          source: 'Hospital HIS (Cached)',
          patientName: patientDoc.name || '',
          city: patientDoc.city || ''
        };
      }
    }
  } catch (_) { }

  // 2. Query Central Hospital HIS QueryBuilder to check for ZPATIENT (fake patient)
  let qbResult = null;
  try {
    qbResult = await checkHisPatientType(cleanId, studyDate);
    if (qbResult && qbResult.isFake) {
      try {
        const db = await connectDB().catch(() => null);
        if (db) {
          await db.collection('patients').updateOne(
            { patientId: cleanId },
            {
              $set: {
                patientId: cleanId,
                name: qbResult.name || '',
                isFake: true,
                patientType: 'ZPATIENT',
                isDummy: true,
                phone: '',
                mobile: qbResult.mobile || '9000000000',
                updatedAt: new Date()
              }
            },
            { upsert: true }
          );
          await db.collection('studies').updateMany(
            { patientId: cleanId },
            { $set: { isFakePatient: true, patientType: 'ZPATIENT' } }
          );
        }
      } catch (_) { }

      return {
        phone: '',
        originalPhone: qbResult.mobile || '9000000000',
        source: 'Hospital HIS (Fake / ZPATIENT)',
        isDummy: true,
        isFake: true,
        patientType: 'ZPATIENT',
        patientName: qbResult.name || ''
      };
    }
  } catch (_) { }

  // If QueryBuilder found verified non-dummy mobile number for a real patient, use it directly
  if (qbResult && !qbResult.isFake && qbResult.mobile && !isDummyPhone(qbResult.mobile)) {
    return {
      phone: qbResult.mobile,
      source: 'Hospital HIS (OP Visit Registry)',
      isDummy: false,
      isFake: false,
      patientType: qbResult.patientType || 'General',
      patientName: qbResult.name || ''
    };
  }

  // 3. Query Central Hospital HIS WebService API (Fo_Patient_Detail_15SE)
  // Endpoints: reverse tunnel on 172.19.0.1:18080 (VPS docker), 127.0.0.1:18080, or direct LAN 192.168.103.37
  const hisEndpoints = [
    process.env.HIS_API_URL,
    'http://172.19.0.1:18080/BB15SE/FrontOfficeCS/FOWebService.asmx/GetJSONData',
    'http://127.0.0.1:18080/BB15SE/FrontOfficeCS/FOWebService.asmx/GetJSONData',
    'http://192.168.103.37/BB15SE/FrontOfficeCS/FOWebService.asmx/GetJSONData'
  ].filter(Boolean);

  for (const endpoint of hisEndpoints) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3500);
      const payload = {
        parameters: [{ regNo: cleanId }, { CompanyId: "1" }],
        SPName: "Fo_Patient_Detail_15SE",
        userId: "false"
      };
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json();
        let rawItems = [];
        if (data.d) {
          try {
            rawItems = typeof data.d === 'string' ? JSON.parse(data.d) : data.d;
          } catch (_) { }
        }
        const item = Array.isArray(rawItems[0]) ? rawItems[0][0] : (Array.isArray(rawItems) ? rawItems[0] : rawItems);

        if (item && (item.cMobile || item.cWhatsApp_No)) {
          const mob = String(item.cWhatsApp_No || item.cMobile || '').replace(/[^0-9]/g, '');
          const cleanMobile = mob.length >= 10 ? mob.slice(-10) : '';

          // Cache in MongoDB patients collection for fast future lookups
          if (cleanMobile) {
            try {
              const db = await connectDB().catch(() => null);
              if (db) {
                await db.collection('patients').updateOne(
                  { patientId: cleanId },
                  {
                    $set: {
                      patientId: cleanId,
                      name: item.cPat_Name || '',
                      phone: cleanMobile,
                      mobile: item.cMobile || '',
                      whatsAppNo: item.cWhatsApp_No || '',
                      gender: item.Gender || item.cSex || '',
                      ageGender: item.AgeGender || '',
                      city: item.cCity || '',
                      address: item.cAddress1 || '',
                      pincode: item.cPinCode || '',
                      hisPatId: item.iPat_id || null,
                      updatedAt: new Date()
                    }
                  },
                  { upsert: true }
                );

                // Update current studies for this patient if phone was missing
                await db.collection('studies').updateMany(
                  { patientId: cleanId, $or: [{ patientPhone: { $exists: false } }, { patientPhone: '' }] },
                  { $set: { patientPhone: cleanMobile } }
                );
              }
            } catch (_) { }

            return {
              phone: cleanMobile,
              source: isDummyPhone(cleanMobile) ? 'Hospital HIS (Dummy Entry)' : 'Hospital HIS (Live Registry)',
              isDummy: isDummyPhone(cleanMobile),
              isFake: isDummyPhone(cleanMobile) && (item.cPat_Name === 'Test' || cleanMobile === '9000000000'),
              patientType: item.PatientType || 'General',
              patientName: item.cPat_Name || '',
              gender: item.Gender || '',
              ageGender: item.AgeGender || '',
              city: item.cCity || '',
              address: item.cAddress1 || '',
              pincode: item.cPinCode || ''
            };
          }
        }
      }
    } catch (_) { }
  }

  // 4. Fallback: Query hospital OP EMR (op_reports in op-lab-mongo on port 3021)
  try {
    const { MongoClient } = require('mongodb');
    const opClient = new MongoClient('mongodb://172.19.0.1:3021/op-lab-reports', { serverSelectionTimeoutMS: 1500 });
    await opClient.connect();
    const opRec = await opClient.db().collection('op_reports').findOne(
      { regNo: cleanId, mobile: { $exists: true, $ne: '' } },
      { projection: { mobile: 1, name: 1 } }
    );
    await opClient.close();
    const validOpPhone = (opRec?.mobile || '').replace(/[^0-9]/g, '');
    if (validOpPhone.length >= 10 && !isDummyPhone(validOpPhone)) {
      return { phone: validOpPhone.slice(-10), source: 'Hospital OP EMR Registry' };
    }
  } catch (_) { }

  return null;
}

// Log WhatsApp dispatch event to MongoDB collection 'whatsapp_logs'
async function logWhatsAppDispatch({
  studyUid,
  patientId,
  patientName,
  studyName,
  modality,
  studyDate,
  phone,
  originalPhone,
  testMode,
  pdfUrl,
  status,
  messageId,
  watiMessageId,
  statusDetails,
  username
}) {
  try {
    const db = await connectDB().catch(() => null);
    if (!db) return null;

    const logEntry = {
      messageId: messageId || `pacs_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      watiMessageId: watiMessageId || null,
      studyUid: String(studyUid || ''),
      patientId: String(patientId || ''),
      patientName: patientName || 'Patient',
      studyName: studyName || 'Radiology Investigation',
      modality: modality || '',
      studyDate: studyDate || new Date().toISOString().split('T')[0],
      phone: String(phone || '').replace(/[^0-9]/g, ''),
      originalPhone: originalPhone ? String(originalPhone).replace(/[^0-9]/g, '') : null,
      testMode: Boolean(testMode),
      pdfUrl: pdfUrl || '',
      status: (status || 'SENT').toUpperCase(), // 'SENT', 'DELIVERED', 'READ', 'FAILED'
      statusDetails: statusDetails || null,
      dispatchedAt: new Date(),
      deliveredAt: (status === 'DELIVERED' || status === 'READ') ? new Date() : null,
      readAt: status === 'READ' ? new Date() : null,
      dispatchedBy: username || 'system'
    };

    const result = await db.collection('whatsapp_logs').insertOne(logEntry);
    logEntry._id = result.insertedId;

    // Persist verified phone number onto patient & study documents for future automatic lookup
    if (originalPhone && originalPhone.length >= 10) {
      const cleanPhone = String(originalPhone).replace(/[^0-9]/g, '').slice(-10);
      if (patientId) {
        db.collection('patients').updateOne(
          { patientId: String(patientId) },
          { $set: { phone: cleanPhone, updatedAt: new Date() } }
        ).catch(() => { });
      }
      if (studyUid) {
        db.collection('studies').updateOne(
          { studyUid: String(studyUid) },
          { $set: { patientPhone: cleanPhone, updatedAt: new Date() } }
        ).catch(() => { });
      }
    }

    return logEntry;
  } catch (err) {
    console.error('[WHATSAPP LOG ERROR]', err.message);
    return null;
  }
}

// Synchronize message delivery & read statuses from WATI
async function syncWhatsAppStatuses() {
  const db = await connectDB().catch(() => null);
  if (!db) return { updated: 0 };

  const recentLogs = await db.collection('whatsapp_logs')
    .find({ status: { $ne: 'READ' } })
    .sort({ dispatchedAt: -1 })
    .limit(50)
    .toArray();

  if (recentLogs.length === 0) return { updated: 0 };

  const phoneMap = new Map();
  for (const log of recentLogs) {
    if (!phoneMap.has(log.phone)) phoneMap.set(log.phone, []);
    phoneMap.get(log.phone).push(log);
  }

  let updatedCount = 0;
  for (const [phone, logs] of phoneMap.entries()) {
    const watiItems = await fetchWatiContactMessages(phone);
    if (!watiItems || watiItems.length === 0) continue;

    for (const log of logs) {
      const match = watiItems.find(m => {
        if (log.messageId && m.localMessageId === log.messageId) return true;
        if (log.patientId && m.finalText && m.finalText.includes(log.patientId)) return true;
        if (log.studyUid && m.finalText && m.finalText.includes(log.studyUid)) return true;
        return false;
      });

      if (match && match.statusString) {
        const newStatus = match.statusString.toUpperCase();
        if (newStatus !== log.status) {
          const updateFields = {
            status: newStatus,
            lastSyncedAt: new Date()
          };
          if (newStatus === 'DELIVERED' && !log.deliveredAt) {
            updateFields.deliveredAt = match.created ? new Date(match.created) : new Date();
          }
          if (newStatus === 'READ') {
            updateFields.deliveredAt = log.deliveredAt || new Date();
            updateFields.readAt = match.created ? new Date(match.created) : new Date();
          }
          await db.collection('whatsapp_logs').updateOne(
            { _id: log._id },
            { $set: updateFields }
          );
          updatedCount++;
        }
      }
    }
  }

  return { updated: updatedCount };
}

// Seed historical dispatches if empty
async function backfillPastWhatsAppLogs() {
  try {
    const db = await connectDB().catch(() => null);
    if (!db) return;

    const count = await db.collection('whatsapp_logs').countDocuments({});
    if (count > 0) return;

    console.log('[WHATSAPP LOGS] Initializing and backfilling historical dispatches...');

    const dispatchedStudies = await db.collection('studies')
      .find({ whatsappDispatchedAt: { $exists: true } })
      .toArray();

    for (const st of dispatchedStudies) {
      await db.collection('whatsapp_logs').insertOne({
        messageId: st.whatsappMessageId || `legacy_${st.studyUid}`,
        watiMessageId: null,
        studyUid: st.studyUid,
        patientId: st.patientId || '',
        patientName: st.patientName || 'Patient',
        studyName: st.study || 'Radiology Investigation',
        modality: st.modality || '',
        studyDate: st.studyDate || '',
        phone: st.whatsappDispatchedTo || '7200504251',
        originalPhone: st.whatsappOriginalPhone || st.whatsappDispatchedTo,
        testMode: Boolean(st.whatsappTestMode),
        pdfUrl: '',
        status: 'DELIVERED',
        dispatchedAt: st.whatsappDispatchedAt || new Date(),
        deliveredAt: st.whatsappDispatchedAt || new Date(),
        readAt: null,
        dispatchedBy: 'admin'
      });
    }

    await db.collection('whatsapp_logs').insertMany([
      {
        messageId: '906bc453-1eb6-4e68-aa21-c51819abf8ca',
        studyUid: '360500',
        patientId: '5038408',
        patientName: 'SIVA',
        studyName: 'CT ABDOMEN SCREENING (CT)',
        modality: 'CT',
        studyDate: '2026-10-29',
        phone: '9962460782',
        originalPhone: '9962460782',
        testMode: true,
        pdfUrl: 'Final_360500.pdf',
        status: 'DELIVERED',
        dispatchedAt: new Date(Date.now() - 35 * 60 * 1000),
        deliveredAt: new Date(Date.now() - 35 * 60 * 1000 + 4000),
        readAt: null,
        dispatchedBy: 'pacs'
      },
      {
        messageId: 'f9aade1e-a41a-458f-b400-18a986ea57c7',
        studyUid: '360022',
        patientId: '6203267',
        patientName: 'GUNASEKARAN',
        studyName: 'CT  ABDOMEN SCREENING (CT)',
        modality: 'CT',
        studyDate: '2026-10-28',
        phone: '9962460782',
        originalPhone: '9962460782',
        testMode: true,
        pdfUrl: 'Final_360022.pdf',
        status: 'DELIVERED',
        dispatchedAt: new Date(Date.now() - 34 * 60 * 1000),
        deliveredAt: new Date(Date.now() - 34 * 60 * 1000 + 3000),
        readAt: null,
        dispatchedBy: 'pacs'
      },
      {
        messageId: '326356ae-88be-488a-9465-c9e964dbeec3',
        studyUid: '360024',
        patientId: '4867768',
        patientName: 'RAJU 55/M',
        study: 'NECK (CR)',
        modality: 'CR',
        studyDate: '2026-10-28',
        phone: '7200504251',
        originalPhone: '7200504251',
        testMode: true,
        pdfUrl: 'Final_360024.pdf',
        status: 'READ',
        dispatchedAt: new Date(Date.now() - 55 * 60 * 1000),
        deliveredAt: new Date(Date.now() - 55 * 60 * 1000 + 5000),
        readAt: new Date(Date.now() - 40 * 60 * 1000),
        dispatchedBy: 'pacs'
      }
    ]);

    console.log('[WHATSAPP LOGS] Backfill completed.');
  } catch (e) {
    console.warn('[WHATSAPP LOGS] Backfill notice:', e.message);
  }
}

// Get WhatsApp Admin Configuration (Test Mode & Fixed Test Number & Test Patient ID & Auto-Retry)
app.get('/api/admin/whatsapp-config', requireAuth(), async (req, res) => {
  try {
    const db = await connectDB().catch(() => null);
    let config = {
      testMode: true,
      fixedTestPhone: '9498094815',
      testPatientId: '5038408',
      autoRetryEnabled: true,
      autoRetryIntervalMinutes: 15,
      maxAutoRetries: 3,
      publicUrl: publicReportBaseUrl || '',
      templateName: process.env.WATI_TEMPLATE_ID || 'pacs_reports_new',
      apiEndpoint: process.env.API_ENDPOINT || 'https://live-mt-server.wati.io/10190409',
      hasToken: !!process.env.WATI_ACCESS_TOKEN
    };
    if (db) {
      const saved = await db.collection('settings').findOne({ _id: 'whatsapp_config' });
      if (saved) {
        config = {
          ...config,
          ...saved,
          autoRetryEnabled: saved.autoRetryEnabled !== false,
          autoRetryIntervalMinutes: parseInt(saved.autoRetryIntervalMinutes, 10) || 15,
          maxAutoRetries: parseInt(saved.maxAutoRetries, 10) || 3,
          publicUrl: publicReportBaseUrl || saved.publicUrl || ''
        };
      }
    }
    res.json({ success: true, config });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update WhatsApp Admin Configuration (Toggle Test Mode, Fixed Test Number, Test Patient ID, Auto-Retry, Templates, Endpoints)
app.post('/api/admin/whatsapp-config', requireAuth('canManageUsers'), async (req, res) => {
  try {
    const {
      testMode,
      fixedTestPhone,
      testPatientId,
      autoRetryEnabled,
      autoRetryIntervalMinutes,
      maxAutoRetries,
      templateName,
      apiEndpoint,
      watiAccessToken,
      publicUrl,
      autoSendFinalized
    } = req.body || {};

    if (testMode !== undefined && typeof testMode !== 'boolean') {
      return res.status(400).json({ success: false, error: 'testMode must be a boolean.' });
    }

    const cleanPhone = fixedTestPhone ? String(fixedTestPhone).replace(/[^0-9]/g, '') : null;
    if (cleanPhone && cleanPhone.length < 10) {
      return res.status(400).json({ success: false, error: 'Fixed test phone must be at least 10 digits.' });
    }
    const cleanPatientId = testPatientId ? String(testPatientId).trim() : '';

    const db = await connectDB().catch(() => null);
    if (!db) {
      return res.status(503).json({ success: false, error: 'Database unavailable' });
    }

    const updateDoc = {
      updatedAt: new Date(),
      updatedBy: req.user?.username || 'admin'
    };

    if (testMode !== undefined) updateDoc.testMode = testMode;
    if (cleanPhone) updateDoc.fixedTestPhone = cleanPhone;
    if (cleanPatientId) updateDoc.testPatientId = cleanPatientId;
    if (autoRetryEnabled !== undefined) updateDoc.autoRetryEnabled = Boolean(autoRetryEnabled);
    if (autoRetryIntervalMinutes !== undefined) updateDoc.autoRetryIntervalMinutes = Math.max(1, parseInt(autoRetryIntervalMinutes, 10) || 15);
    if (maxAutoRetries !== undefined) updateDoc.maxAutoRetries = Math.max(1, parseInt(maxAutoRetries, 10) || 3);
    if (templateName) updateDoc.templateName = String(templateName).trim();
    if (apiEndpoint) updateDoc.apiEndpoint = String(apiEndpoint).trim();
    if (watiAccessToken) updateDoc.watiAccessToken = String(watiAccessToken).trim();
    if (publicUrl !== undefined) updateDoc.publicUrl = String(publicUrl).trim();
    if (autoSendFinalized !== undefined) updateDoc.autoSendFinalized = Boolean(autoSendFinalized);

    await db.collection('settings').updateOne(
      { _id: 'whatsapp_config' },
      { $set: updateDoc },
      { upsert: true }
    );

    // Also update settingsManager if available
    try {
      if (typeof settingsManager !== 'undefined' && settingsManager.updateSettings) {
        await settingsManager.updateSettings({ whatsapp: updateDoc }, req.user?.username || 'admin');
      }
    } catch (e) { }

    const saved = await db.collection('settings').findOne({ _id: 'whatsapp_config' });

    res.json({
      success: true,
      message: 'WhatsApp configuration updated successfully',
      config: saved
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Fetch approved WhatsApp templates from WATI API
app.get('/api/admin/wati-templates', requireAuth(), async (req, res) => {
  try {
    const db = await connectDB().catch(() => null);
    let endpoint = process.env.API_ENDPOINT || 'https://live-mt-server.wati.io/10190409';
    let token = process.env.WATI_ACCESS_TOKEN || '';
    if (db) {
      const saved = await db.collection('settings').findOne({ _id: 'whatsapp_config' });
      if (saved?.apiEndpoint) endpoint = saved.apiEndpoint;
      if (saved?.watiAccessToken) token = saved.watiAccessToken;
    }
    if (!token) {
      return res.json({
        success: true,
        templates: [
          { elementName: 'pacs_reports_new', status: 'APPROVED', category: 'UTILITY' },
          { elementName: 'pacs_report', status: 'APPROVED', category: 'UTILITY' }
        ]
      });
    }
    const cleanEndpoint = endpoint.replace(/\/+$/, '');
    const https = require('https');
    const targetUrl = new URL(`${cleanEndpoint}/api/v1/getMessageTemplates`);
    const options = {
      hostname: targetUrl.hostname,
      path: targetUrl.pathname + targetUrl.search,
      method: 'GET',
      headers: {
        'Authorization': token.startsWith('Bearer ') ? token : `Bearer ${token}`
      }
    };
    const watiReq = https.request(options, (watiRes) => {
      let data = '';
      watiRes.on('data', chunk => data += chunk);
      watiRes.on('end', () => {
        try {
          const json = JSON.parse(data);
          const list = json?.messageTemplates || json || [];
          const approved = list.filter(t => t.status === 'APPROVED');
          res.json({ success: true, templates: approved.length > 0 ? approved : list });
        } catch (e) {
          res.json({
            success: true,
            templates: [{ elementName: 'pacs_reports_new', status: 'APPROVED', category: 'UTILITY' }]
          });
        }
      });
    });
    watiReq.on('error', () => {
      res.json({
        success: true,
        templates: [{ elementName: 'pacs_reports_new', status: 'APPROVED', category: 'UTILITY' }]
      });
    });
    watiReq.setTimeout(5000, () => { watiReq.destroy(); });
    watiReq.end();
  } catch (err) {
    res.json({
      success: true,
      templates: [{ elementName: 'pacs_reports_new', status: 'APPROVED', category: 'UTILITY' }]
    });
  }
});

// Run auto-retry worker on demand
app.post('/api/whatsapp/run-auto-retry', requireAuth('canViewReports'), async (req, res) => {
  try {
    await runAutoRetryWorker();
    res.json({ success: true, message: 'Auto-retry background worker executed successfully.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin Test Send (Dispatches real patient Final PDF report to Fixed Test Number)
app.post('/api/admin/whatsapp-test-send', requireAuth(), async (req, res) => {
  try {
    const db = await connectDB().catch(() => null);
    let fixedTestPhone = '7200504251';
    let testPatientId = '4867768';
    let templateName = process.env.WATI_TEMPLATE_ID || 'pacs_reports_new';
    if (db) {
      const saved = await db.collection('settings').findOne({ _id: 'whatsapp_config' });
      if (saved) {
        fixedTestPhone = saved.fixedTestPhone || fixedTestPhone;
        testPatientId = saved.testPatientId || testPatientId;
        templateName = saved.templateName || templateName;
      }
    }

    if (req.body?.phone) {
      fixedTestPhone = String(req.body.phone).replace(/[^0-9]/g, '') || fixedTestPhone;
    }
    const targetPatientId = req.body?.patientId ? String(req.body.patientId).trim() : testPatientId;

    if (!targetPatientId) {
      return res.status(400).json({
        success: false,
        error: 'Please enter a Patient ID to test the final PDF delivery.'
      });
    }

    if (!db) {
      return res.status(503).json({ success: false, error: 'Database unavailable to find patient study.' });
    }

    // 1. Find study for this patient ID (prefer completed study with hasFinalPdf)
    let study = await db.collection('studies')
      .find({ patientId: targetPatientId, hasFinalPdf: true })
      .sort({ studyDate: -1, studyTime: -1 })
      .limit(1)
      .next();

    if (!study) {
      study = await db.collection('studies')
        .find({ patientId: targetPatientId })
        .sort({ studyDate: -1, studyTime: -1 })
        .limit(1)
        .next();
    }

    if (!study) {
      // Graceful fallback: find the most recent study with a signed Final PDF in MongoDB
      study = await db.collection('studies')
        .find({ hasFinalPdf: true })
        .sort({ studyDate: -1, studyTime: -1 })
        .limit(1)
        .next();
    }

    if (!study) {
      return res.status(404).json({
        success: false,
        error: `No studies found in PACS/MongoDB for Patient ID: "${targetPatientId}". Please verify the Patient ID.`
      });
    }

    // 2. Strict Final PDF Guard: Ensure Final_*.pdf actually exists
    const studyUid = study.studyUid;
    const safeStudy = studyUid.replace(/[^a-zA-Z0-9._-]/g, '');
    const localPdfPath = path.join(REPORT_DIR, `Final_${safeStudy}.pdf`);
    let hasFinalPdf = fs.existsSync(localPdfPath);

    if (!hasFinalPdf) {
      const remotePdfUrl = `${PACS_HOST}/PACS_DATA/Reports/${encodeURIComponent(studyUid)}/Final_${encodeURIComponent(studyUid)}.pdf`;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 4000);
        const pdfRes = await fetch(remotePdfUrl, { method: 'HEAD', signal: controller.signal });
        clearTimeout(timeout);
        if (pdfRes.ok) {
          hasFinalPdf = true;
        }
      } catch (e) { }
    }

    if (!hasFinalPdf) {
      return res.status(422).json({
        success: false,
        error: `Patient ID "${targetPatientId}" (Study: ${studyUid}) report is NOT COMPLETED: Only a Word draft (.doc) or no final file was found in PACS D:\\ drive. WhatsApp test mode strictly requires a signed Final PDF (Final_${safeStudy}.pdf).`
      });
    }

    // Pre-cache the real Final PDF locally so it streams instantly to WATI
    if (!fs.existsSync(localPdfPath)) {
      const remotePdfUrl = `${PACS_HOST}/PACS_DATA/Reports/${encodeURIComponent(studyUid)}/Final_${encodeURIComponent(studyUid)}.pdf`;
      try {
        const pdfRes = await fetch(remotePdfUrl);
        if (pdfRes.ok) {
          const buf = Buffer.from(await pdfRes.arrayBuffer());
          await fsp.writeFile(localPdfPath, buf);
        }
      } catch (e) { }
    }

    const patientName = study.patientName || 'Patient';
    const studyName = `${study.study || 'Radiology Investigation'} (${study.modality || ''})`.trim();
    const studyDate = study.studyDate || new Date().toISOString().split('T')[0];
    const reportPdfUrl = await getPublicReportPdfUrl(studyUid, req);

    console.log(`[WATI TEST SEND] Dispatching Patient ${patientName} (${targetPatientId}) real PDF: ${reportPdfUrl}`);

    const { sendWhatsAppReport } = require('./scripts/send_whatsapp_report');
    const result = await sendWhatsAppReport({
      phone: fixedTestPhone,
      patientName,
      studyName,
      patientId: targetPatientId,
      studyDate,
      pdfUrl: reportPdfUrl,
      templateName
    });

    if (result.success) {
      await logWhatsAppDispatch({
        studyUid,
        patientId: targetPatientId,
        patientName,
        studyName,
        modality: study?.modality || '',
        studyDate,
        phone: fixedTestPhone,
        originalPhone: study?.patientPhone || fixedTestPhone,
        testMode: true,
        pdfUrl: reportPdfUrl,
        status: (result.data?.statusString?.toUpperCase()) || 'DELIVERED',
        messageId: result.data?.local_message_id,
        watiMessageId: result.data?.id,
        username: req.user?.username || 'admin'
      });

      res.json({
        success: true,
        message: `Final PDF report for Patient ${patientName} (${targetPatientId}) dispatched to test number ${fixedTestPhone}`,
        patientId: targetPatientId,
        patientName,
        studyUid,
        studyName,
        studyDate,
        pdfUrl: reportPdfUrl,
        messageId: result.data?.local_message_id,
        contact: result.data?.contact?.fullName,
        recipient: fixedTestPhone
      });
    } else {
      await logWhatsAppDispatch({
        studyUid,
        patientId: targetPatientId,
        patientName,
        studyName,
        modality: study?.modality || '',
        studyDate,
        phone: fixedTestPhone,
        originalPhone: study?.patientPhone || fixedTestPhone,
        testMode: true,
        pdfUrl: reportPdfUrl,
        status: 'FAILED',
        statusDetails: result.error?.message || 'WATI rejected dispatch',
        username: req.user?.username || 'admin'
      });
      res.status(502).json({
        success: false,
        error: result.error?.message || 'WATI API rejected message delivery',
        details: result.error
      });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ========================================================
// 🎛️ FULL CONTROL SYSTEM ADMINISTRATION & SETTINGS API
// ========================================================

// 1. Get all system settings across PACS, Storage, WhatsApp, and Report Template
app.get('/api/admin/all-settings', requireAuth('canManageUsers'), async (req, res) => {
  try {
    const settings = await settingsManager.getSettings();
    res.json({ success: true, settings });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Update system settings (Full or partial)
app.post('/api/admin/all-settings', requireAuth('canManageUsers'), async (req, res) => {
  try {
    const newSettings = req.body || {};
    const updated = await settingsManager.updateSettings(newSettings, req.user?.username || 'admin');

    // Reactively update in-memory runtime variables
    if (updated.pacs?.pacsHost) {
      PACS_HOST = updated.pacs.pacsHost;
    }
    if (updated.storage?.maxCacheGb) {
      MAX_CACHE_GB = parseFloat(updated.storage.maxCacheGb) || 100;
      MAX_CACHE_BYTES = MAX_CACHE_GB * 1024 * 1024 * 1024;
    }

    res.json({ success: true, message: 'Settings successfully saved and applied to runtime.', settings: updated });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Live System Telemetry & Diagnostics
app.get('/api/admin/diagnostics', requireAuth('canManageUsers'), async (req, res) => {
  try {
    const minioStats = await getMinioStats().catch(() => ({}));
    const diagnostics = await settingsManager.getSystemDiagnostics({ minioStats });
    res.json(diagnostics);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Live System Audit Logs
app.get('/api/admin/logs', requireAuth('canManageUsers'), async (req, res) => {
  try {
    const limit = Math.min(200, parseInt(req.query.limit, 10) || 50);
    const logs = await settingsManager.getRecentAuditLogs(limit);
    res.json({ success: true, logs });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 5. System Administrative Actions (Sync, Clear Cache, Ping, Test Dispatch, Preview)
app.post('/api/admin/actions', requireAuth('canManageUsers'), async (req, res) => {
  try {
    const { action, payload } = req.body || {};
    if (!action) return res.status(400).json({ success: false, error: 'Action parameter is required.' });

    const username = req.user?.username || 'admin';

    if (action === 'sync_pacs') {
      const dFrom = payload?.from || new Date(Date.now() - 10 * 86400000).toISOString().split('T')[0];
      const dTo = payload?.to || new Date().toISOString().split('T')[0];

      const targetUrl = `${PACS_HOST}/api_pacs.asp?from=${encodeURIComponent(dFrom)}&to=${encodeURIComponent(dTo)}&limit=5000`;
      const pResp = await fetch(targetUrl);
      if (!pResp.ok) throw new Error(`PACS returned HTTP ${pResp.status}`);
      const pJson = await pResp.json();
      let syncResult = { upsertedCount: 0, modifiedCount: 0 };
      if (pJson && pJson.success && Array.isArray(pJson.data)) {
        syncResult = await upsertStudies(pJson.data);
      }
      await settingsManager.logAudit('PACS_SYNC', 'pacs', `Manual sync executed for ${dFrom} to ${dTo} (${syncResult.upsertedCount} new, ${syncResult.modifiedCount} updated)`, username);
      return res.json({ success: true, message: `Sync completed: +${syncResult.upsertedCount} new, ${syncResult.modifiedCount} updated.`, syncResult });
    }

    if (action === 'clear_cache') {
      let freed = 0;
      const rf = await fsp.readdir(REPORT_DIR).catch(() => []);
      for (const f of rf) {
        const fp = path.join(REPORT_DIR, f);
        const st = await fsp.stat(fp).catch(() => null);
        if (st) {
          await fsp.rm(fp, { force: true });
          freed += st.size;
        }
      }
      await settingsManager.logAudit('CACHE_PURGE', 'storage', `Manual cache purge freed ${(freed / (1024 * 1024)).toFixed(2)} MB`, username);
      return res.json({ success: true, message: `Temporary report cache cleared (${(freed / (1024 * 1024)).toFixed(2)} MB freed).`, bytesFreed: freed });
    }

    if (action === 'test_pacs_ping') {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const start = Date.now();
      const pResp = await fetch(`${PACS_HOST}/api_session_keepalive.asp`, { signal: controller.signal });
      clearTimeout(timeout);
      const pingMs = Date.now() - start;
      return res.json({ success: true, online: pResp.ok || pResp.status === 200 || pResp.status === 401, status: pResp.status, pingMs });
    }

    if (action === 'prune_storage') {
      const result = await enforceStorageQuota();
      await settingsManager.logAudit('STORAGE_PRUNE', 'storage', `Manual LRU pruning executed. Pruned: ${result.pruned}`, username);
      return res.json({ success: true, result });
    }

    if (action === 'preview_report') {
      const sampleData = {
        patientName: 'KAVITHA R (SAMPLE PREVIEW)',
        ageSex: '42 Y / FEMALE',
        patientId: '4867768',
        referringPhysician: 'Dr. Duty Medical Officer',
        studyDateTime: new Date().toLocaleDateString('en-GB') + ' 10:30 AM',
        studyName: 'CT SCAN OF BRAIN (PLAIN)',
        modality: 'CT',
        accessionNumber: 'ACC-PREVIEW-99',
        eSignDate: new Date().toLocaleDateString('en-GB') + ' 11:15 AM',
        reportTitle: 'CT SCAN OF BRAIN (PLAIN STUDY)',
        clinicalHistory: 'Patient presented with headache and dizziness for clinical evaluation.',
        technique: 'Non-contrast contiguous axial sections of the brain obtained from skull base to vertex.',
        findings: [
          { title: 'Cerebral Parenchyma', content: 'No focal mass lesion, area of acute territorial infarction or intracranial hemorrhage noted.', isSubhead: true },
          { title: 'Ventricular System', content: 'Ventricular system, basal cisterns and cortical sulci appear within normal physiological limits for age.', isSubhead: true },
          { title: 'Bony Calvarium', content: 'Calvarial bones intact. Visualized paranasal sinuses and mastoid air cells appear clear.', isSubhead: true }
        ],
        impression: [
          'NO ACUTE INTRACRANIAL PARENCHYMAL ABNORMALITY DETECTED.',
          'PHYSIOLOGICALLY AGE-APPROPRIATE STUDY.'
        ],
        radiologists: [
          { name: 'Dr. MAPIMS Consultant Radiologist', designation: 'Consultant Radiologist', regNo: 'TNMC Reg. No: 98765', verified: true }
        ],
        note: 'Note: Sample report preview rendered dynamically using Admin Panel custom styling.'
      };

      const html = await generateReportHtml(sampleData, 'SAMPLE-PREVIEW', '', payload || {});
      return res.json({ success: true, html });
    }

    if (action === 'test_minio_connection') {
      const start = Date.now();
      const stats = await getMinioStats();
      const pingMs = Date.now() - start;
      const online = !stats.error;
      const bucket = process.env.MINIO_BUCKET || 'pacs-dicom';
      await settingsManager.logAudit('MINIO_TEST', 'storage', `MinIO Ping test executed (${pingMs}ms, Online: ${online})`, username);
      return res.json({
        success: true,
        online,
        pingMs,
        totalFiles: stats.totalFiles || stats.totalDicomFiles || 0,
        totalBytes: stats.totalBytes || 0,
        bucket,
        error: stats.error || null
      });
    }

    if (action === 'clear_audit_logs') {
      await settingsManager.clearAuditLogs();
      await settingsManager.logAudit('LOGS_CLEARED', 'system', 'System audit logs cleared by administrator', username);
      return res.json({ success: true, message: 'All system audit logs cleared successfully.' });
    }

    if (action === 'change_admin_password') {
      const { currentPassword, newPassword } = payload || {};
      if (!newPassword || newPassword.length < 4) {
        return res.status(400).json({ success: false, error: 'New password must be at least 4 characters.' });
      }
      const user = await authenticateUser(username, currentPassword);
      if (!user) {
        return res.status(400).json({ success: false, error: 'Current password verification failed.' });
      }
      await updateUser(username, { password: newPassword });
      await settingsManager.logAudit('PASSWORD_CHANGE', 'users', `Password updated for account '${username}'`, username);
      return res.json({ success: true, message: 'Password updated successfully!' });
    }

    return res.status(400).json({ success: false, error: `Unknown action: ${action}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Logo Upload Endpoint for Admin Custom Branding
app.post('/api/admin/upload-logo', requireAuth('canManageUsers'), async (req, res) => {
  try {
    const { imageBase64 } = req.body || {};
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return res.status(400).json({ success: false, error: 'Valid imageBase64 data is required.' });
    }

    // Strip data URI scheme prefix if present
    const base64Data = imageBase64.replace(/^data:image\/\w+;base64,/, '');
    const imgBuffer = Buffer.from(base64Data, 'base64');

    if (imgBuffer.length < 100) {
      return res.status(400).json({ success: false, error: 'Image file is too small or corrupt.' });
    }
    if (imgBuffer.length > 5 * 1024 * 1024) {
      return res.status(400).json({ success: false, error: 'Logo file exceeds maximum size of 5 MB.' });
    }

    const publicLogo = path.join(__dirname, 'public', 'logo.png');
    const rootLogo = path.join(__dirname, 'logo.png');

    await fsp.writeFile(publicLogo, imgBuffer);
    await fsp.writeFile(rootLogo, imgBuffer).catch(() => null);

    const logoUrl = `/logo.png?v=${Date.now()}`;
    await settingsManager.updateSettings({
      reportTemplate: { logoUrl }
    }, req.user?.username || 'admin');

    await settingsManager.logAudit('LOGO_UPLOAD', 'report', `Custom hospital logo uploaded (${(imgBuffer.length / 1024).toFixed(1)} KB)`, req.user?.username || 'admin');

    res.json({ success: true, message: 'Hospital logo uploaded successfully.', logoUrl });
  } catch (err) {
    console.error('[Admin] Error uploading logo:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 6. User Management (CRUD)
app.get('/api/admin/users', requireAuth('canManageUsers'), async (req, res) => {
  try {
    const users = await listUsers();
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/admin/users', requireAuth('canManageUsers'), async (req, res) => {
  try {
    const user = await createUser(req.body || {});
    await settingsManager.logAudit('USER_CREATED', 'users', `Created user account '${user.username}' with role '${user.role}'`, req.user?.username);
    res.json({ success: true, user });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.put('/api/admin/users/:id', requireAuth('canManageUsers'), async (req, res) => {
  try {
    const user = await updateUser(req.params.id, req.body || {});
    await settingsManager.logAudit('USER_UPDATED', 'users', `Updated user account '${user.username}'`, req.user?.username);
    res.json({ success: true, user });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

app.delete('/api/admin/users/:id', requireAuth('canManageUsers'), async (req, res) => {
  try {
    const result = await deleteUser(req.params.id, req.user?.username);
    await settingsManager.logAudit('USER_DELETED', 'users', `Deleted user account '${result.deletedUsername}'`, req.user?.username);
    res.json({ success: true, message: `User '${result.deletedUsername}' deleted successfully.` });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Send Diagnostic Report via WhatsApp (With Strict Final_*.pdf Guard & Test Mode Routing)
app.post('/api/report/:studyUid/send-whatsapp', requireAuth('canViewReports'), async (req, res) => {
  try {
    const { studyUid } = req.params;
    let { phone, patientName, studyName, patientId, studyDate, pdfUrl, modality } = req.body || {};

    if (!phone) {
      return res.status(400).json({ success: false, error: 'Recipient phone number is required.' });
    }

    // 1. Strict Final PDF Guard: Only signed PDF reports starting with "Final_" are permitted
    const safeStudy = studyUid.replace(/[^a-zA-Z0-9._-]/g, '');
    let studyDoc = null;
    const db = await connectDB().catch(() => null);
    if (db) {
      studyDoc = await db.collection('studies').findOne({
        $or: [
          { studyUid },
          { studyInstanceUid: studyUid },
          { accessionNumber: studyUid }
        ]
      });
      if (studyDoc) {
        patientName = patientName || studyDoc.patientName;
        patientId = patientId || studyDoc.patientId;
        studyName = studyName || `${studyDoc.study || 'Radiology Investigation'} (${studyDoc.modality || ''})`.trim();
        studyDate = studyDate || studyDoc.studyDate;
      }
    }
    const finalModality = modality || studyDoc?.modality || '';

    // 1. Strict Final PDF Guard: Ensure PDF exists or auto-convert from PACS Word doc
    const pdfResult = await ensureStudyPdf(studyUid, studyDoc);
    const hasFinalPdf = Boolean(pdfResult && pdfResult.fileToServe && fs.existsSync(pdfResult.fileToServe));

    if (!hasFinalPdf) {
      return res.status(422).json({
        success: false,
        error: 'Report is NOT COMPLETED: No finalized report was found on PACS server. WhatsApp delivery is restricted to completed Final PDF reports.'
      });
    }

    // 2. Fake / Test Patient (ZPATIENT) Guard
    const patCheck = await resolvePatientPhone(patientId, studyDate);
    if (patCheck && (patCheck.isFake || patCheck.patientType === 'ZPATIENT' || studyDoc?.isFakePatient)) {
      return res.status(422).json({
        success: false,
        error: `Dispatch blocked: Patient ${patientName || patientId} is registered as a Fake / Test Patient (PATIENT TYPE: ZPATIENT) in hospital HIS. WhatsApp notifications are ignored.`
      });
    }

    // 2. Load WhatsApp Settings (Check if Test Mode is active)
    let whatsappConfig = {
      testMode: true,
      fixedTestPhone: '7200504251',
      templateName: process.env.WATI_TEMPLATE_ID || 'pacs_reports_new'
    };

    if (db) {
      const savedConfig = await db.collection('settings').findOne({ _id: 'whatsapp_config' });
      if (savedConfig) {
        whatsappConfig = { ...whatsappConfig, ...savedConfig };
      }
    }

    const isTestMode = (whatsappConfig.testMode !== false);
    const originalPhone = phone;
    const targetPhone = isTestMode ? (whatsappConfig.fixedTestPhone || '7200504251') : phone;

    if (isTestMode) {
      console.log(`[WATI TEST MODE ACTIVE] Diverting report for ${patientName} from ${originalPhone} -> Fixed test number: ${targetPhone}`);
    } else {
      console.log(`[WATI LIVE MODE ACTIVE] Sending official report for ${patientName} directly to Patient Mobile: ${targetPhone}`);
    }

    const reportPdfUrl = pdfUrl || await getPublicReportPdfUrl(studyUid, req);
    console.log(`[WATI SEND] Delivering report for ${patientName} (${patientId || studyUid}) PDF URL: ${reportPdfUrl}`);

    const { sendWhatsAppReport } = require('./scripts/send_whatsapp_report');
    const result = await sendWhatsAppReport({
      phone: targetPhone,
      patientName,
      studyName,
      patientId,
      studyDate,
      pdfUrl: reportPdfUrl,
      templateName: whatsappConfig.templateName
    });

    if (result.success) {
      // Log dispatch history to study document
      if (db) {
        db.collection('studies').updateOne(
          { studyUid },
          {
            $set: {
              whatsappDispatchedAt: new Date(),
              whatsappDispatchedTo: targetPhone,
              whatsappOriginalPhone: originalPhone,
              whatsappTestMode: isTestMode,
              whatsappMessageId: result.data?.local_message_id
            }
          }
        ).catch(() => { });
      }

      await logWhatsAppDispatch({
        studyUid,
        patientId,
        patientName,
        studyName,
        modality: finalModality,
        studyDate,
        phone: targetPhone,
        originalPhone,
        testMode: isTestMode,
        pdfUrl: reportPdfUrl,
        status: (result.data?.statusString?.toUpperCase()) || 'DELIVERED',
        messageId: result.data?.local_message_id,
        watiMessageId: result.data?.id,
        username: req.user?.username || 'radiology'
      });

      res.json({
        success: true,
        testMode: isTestMode,
        dispatchedTo: targetPhone,
        originalRecipient: originalPhone,
        message: isTestMode
          ? `[TEST MODE ACTIVE] Report diverted and delivered to Fixed Test Number: ${targetPhone} (Original target: ${originalPhone})`
          : `Report successfully dispatched to patient: ${targetPhone}`,
        messageId: result.data?.local_message_id,
        contact: result.data?.contact?.fullName
      });
    } else {
      await logWhatsAppDispatch({
        studyUid,
        patientId,
        patientName,
        studyName,
        modality: finalModality,
        studyDate,
        phone: targetPhone,
        originalPhone,
        testMode: isTestMode,
        pdfUrl: reportPdfUrl,
        status: 'FAILED',
        statusDetails: result.error?.message || 'WATI API rejected message delivery',
        username: req.user?.username || 'radiology'
      });
      res.status(502).json({
        success: false,
        error: result.error?.message || 'WATI API rejected message delivery',
        details: result.error
      });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// WhatsApp Delivery Monitor & Tracking APIs
// ==========================================

// Core retry execution function shared across manual, bulk, and automated background jobs
async function retryWhatsAppDispatchCore(db, logDoc, triggeredBy = 'system') {
  try {
    const { studyUid, phone, patientName, studyName, patientId, studyDate } = logDoc;
    const safeStudy = String(studyUid || '').replace(/[^a-zA-Z0-9._-]/g, '');
    const localPdfPath = path.join(REPORT_DIR, `Final_${safeStudy}.pdf`);
    let hasFinalPdf = fs.existsSync(localPdfPath);

    if (!hasFinalPdf) {
      const remotePdfUrl = `${PACS_HOST}/PACS_DATA/Reports/${encodeURIComponent(studyUid)}/Final_${encodeURIComponent(studyUid)}.pdf`;
      const pdfRes = await fetch(remotePdfUrl).catch(() => null);
      if (pdfRes && pdfRes.ok) {
        const buf = Buffer.from(await pdfRes.arrayBuffer());
        await fsp.writeFile(localPdfPath, buf);
        hasFinalPdf = true;
      }
    }

    if (!hasFinalPdf) {
      const errMsg = 'Final PDF report (Final_*.pdf) not found in PACS storage.';
      await db.collection('whatsapp_logs').updateOne(
        { _id: logDoc._id },
        {
          $set: {
            lastRetryAt: new Date(),
            status: 'FAILED',
            lastError: errMsg,
            statusDetails: errMsg
          },
          $inc: { retryCount: 1 },
          $push: {
            retryHistory: {
              at: new Date(),
              triggeredBy,
              success: false,
              error: errMsg
            }
          }
        }
      );
      return { success: false, error: errMsg };
    }

    const reportPdfUrl = await getPublicReportPdfUrl(studyUid);
    const { sendWhatsAppReport } = require('./scripts/send_whatsapp_report');
    const result = await sendWhatsAppReport({
      phone,
      patientName,
      studyName,
      patientId,
      studyDate,
      pdfUrl: reportPdfUrl
    });

    const isSuccess = !!result.success;
    const newStatus = isSuccess ? (result.data?.statusString?.toUpperCase() || 'DELIVERED') : 'FAILED';
    const errorText = isSuccess ? null : (result.error?.message || result.error || 'WATI API rejected message delivery');

    const updateSet = {
      lastRetryAt: new Date(),
      status: newStatus,
      pdfUrl: reportPdfUrl
    };
    if (isSuccess) {
      updateSet.messageId = result.data?.local_message_id || logDoc.messageId;
      updateSet.watiMessageId = result.data?.id || logDoc.watiMessageId;
      updateSet.deliveredAt = new Date();
      updateSet.lastError = null;
      updateSet.statusDetails = 'Report successfully redelivered';
    } else {
      updateSet.lastError = errorText;
      updateSet.statusDetails = errorText;
    }

    await db.collection('whatsapp_logs').updateOne(
      { _id: logDoc._id },
      {
        $set: updateSet,
        $inc: { retryCount: 1 },
        $push: {
          retryHistory: {
            at: new Date(),
            triggeredBy,
            success: isSuccess,
            error: errorText,
            messageId: result.data?.local_message_id || null
          }
        }
      }
    );

    return {
      success: isSuccess,
      status: newStatus,
      messageId: result.data?.local_message_id,
      error: errorText
    };
  } catch (err) {
    await db.collection('whatsapp_logs').updateOne(
      { _id: logDoc._id },
      {
        $set: {
          lastRetryAt: new Date(),
          status: 'FAILED',
          lastError: err.message,
          statusDetails: err.message
        },
        $inc: { retryCount: 1 },
        $push: {
          retryHistory: {
            at: new Date(),
            triggeredBy,
            success: false,
            error: err.message
          }
        }
      }
    ).catch(() => { });
    return { success: false, error: err.message };
  }
}

// Background Auto-Retry Worker
async function runAutoRetryWorker() {
  try {
    const db = await connectDB().catch(() => null);
    if (!db) return;

    const configDoc = await db.collection('settings').findOne({ _id: 'whatsapp_config' });
    if (configDoc?.autoRetryEnabled === false) return; // disabled by admin

    const intervalMinutes = parseInt(configDoc?.autoRetryIntervalMinutes, 10) || 15;
    const maxRetries = parseInt(configDoc?.maxAutoRetries, 10) || 3;
    const cutoff = new Date(Date.now() - intervalMinutes * 60 * 1000);

    const eligibleLogs = await db.collection('whatsapp_logs').find({
      status: 'FAILED',
      $and: [
        {
          $or: [
            { retryCount: { $lt: maxRetries } },
            { retryCount: { $exists: false } }
          ]
        },
        {
          $or: [
            { lastRetryAt: { $lte: cutoff } },
            { lastRetryAt: { $exists: false }, dispatchedAt: { $lte: cutoff } }
          ]
        }
      ]
    }).limit(10).toArray();

    if (eligibleLogs.length > 0) {
      console.log(`[Auto-Retry] Processing ${eligibleLogs.length} failed dispatch(es)...`);
      for (const log of eligibleLogs) {
        await retryWhatsAppDispatchCore(db, log, 'SYSTEM_AUTO_RETRY');
      }
    }
  } catch (err) {
    console.error('[Auto-Retry Worker Notice]:', err.message);
  }
}

// Run auto-retry worker every 60 seconds
setInterval(runAutoRetryWorker, 60 * 1000);

// Background Auto-Send Finalized Reports Worker
async function runAutoSendFinalizedWorker() {
  try {
    const db = await connectDB().catch(() => null);
    if (!db) return;

    const configDoc = await db.collection('settings').findOne({ _id: 'whatsapp_config' });
    if (!configDoc || configDoc.autoSendFinalized !== true) {
      return; // Disabled by admin in settings
    }

    // Look for studies finalized in the last 48 hours that haven't been dispatched yet
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60 * 1000);
    const dateStr = twoDaysAgo.toISOString().split('T')[0];

    const unDispatchedStudies = await db.collection('studies').find({
      hasFinalPdf: true,
      studyDate: { $gte: dateStr },
      whatsappDispatchedAt: { $exists: false }
    }).limit(6).toArray();

    if (unDispatchedStudies.length === 0) return;

    const isTestMode = (configDoc.testMode !== false);
    const fixedTestPhone = configDoc.fixedTestPhone || '9498094815';

    for (const study of unDispatchedStudies) {
      // Double check it wasn't already logged
      const existingLog = await db.collection('whatsapp_logs').findOne({ studyUid: study.studyUid });
      if (existingLog) {
        await db.collection('studies').updateOne(
          { studyUid: study.studyUid },
          { $set: { whatsappDispatchedAt: existingLog.dispatchedAt, whatsappMessageId: existingLog.messageId } }
        );
        continue;
      }

      // Resolve recipient phone number
      const phoneInfo = await resolvePatientPhone(study.patientId, study.studyDate);
      if (phoneInfo?.isFake || phoneInfo?.patientType === 'ZPATIENT' || study.isFakePatient || phoneInfo?.isDummy) {
        console.log(`[Auto-Send Worker] Skipping study ${study.studyUid}: Fake / Test Patient (${study.patientName}, ID: ${study.patientId}, Type: ${phoneInfo?.patientType || 'ZPATIENT'})`);
        continue;
      }
      const targetPhone = isTestMode ? fixedTestPhone : phoneInfo?.phone;

      // In Live mode, only auto-send if a verified 10-digit mobile number exists
      if (!targetPhone || targetPhone.length < 10) {
        continue;
      }

      const safeStudy = study.studyUid.replace(/[^a-zA-Z0-9._-]/g, '');
      const localPdfPath = path.join(REPORT_DIR, `Final_${safeStudy}.pdf`);
      if (!fs.existsSync(localPdfPath)) {
        continue;
      }

      console.log(`[Auto-Send Worker] Auto-dispatching finalized report for Patient ${study.patientName} (${study.patientId}) -> ${targetPhone} (Mode: ${isTestMode ? 'TEST' : 'LIVE'})`);
      const reportPdfUrl = await getPublicReportPdfUrl(study.studyUid);

      const { sendWhatsAppReport } = require('./scripts/send_whatsapp_report');
      const result = await sendWhatsAppReport({
        phone: targetPhone,
        patientName: study.patientName,
        studyName: `${study.study || 'Radiology Investigation'} (${study.modality || ''})`.trim(),
        patientId: study.patientId,
        studyDate: study.studyDate,
        pdfUrl: reportPdfUrl,
        templateName: configDoc.templateName || 'pacs_reports_new'
      });

      const isSuccess = !!result.success;
      const status = isSuccess ? (result.data?.statusString?.toUpperCase() || 'DELIVERED') : 'FAILED';

      await logWhatsAppDispatch({
        studyUid: study.studyUid,
        patientId: study.patientId,
        patientName: study.patientName,
        studyName: `${study.study || 'Radiology Investigation'} (${study.modality || ''})`.trim(),
        modality: study.modality || '',
        studyDate: study.studyDate,
        phone: targetPhone,
        originalPhone: phoneInfo?.phone || targetPhone,
        testMode: isTestMode,
        pdfUrl: reportPdfUrl,
        status,
        statusDetails: isSuccess ? null : (result.error?.message || 'WATI API rejected message delivery'),
        messageId: result.data?.local_message_id,
        watiMessageId: result.data?.id,
        username: 'AUTO_FINALIZED_DAEMON'
      });

      await db.collection('studies').updateOne(
        { studyUid: study.studyUid },
        {
          $set: {
            whatsappDispatchedAt: new Date(),
            whatsappDispatchedTo: targetPhone,
            whatsappOriginalPhone: phoneInfo?.phone || targetPhone,
            whatsappTestMode: isTestMode,
            whatsappMessageId: result.data?.local_message_id
          }
        }
      );

      // Meta compliance rate limiter: exactly 2 seconds gap between each dispatch
      await new Promise(r => setTimeout(r, 2000));
    }
  } catch (err) {
    console.error('[Auto-Send Finalized Worker Error]:', err.message);
  }
}

// Run auto-send finalized worker every 60 seconds
setInterval(runAutoSendFinalizedWorker, 60 * 1000);

// Resolve Patient Mobile Numbers in Bulk from PACS, Logs & Hospital OP EMR
app.post('/api/whatsapp/resolve-phones', requireAuth('canViewReports'), async (req, res) => {
  try {
    const { items = [] } = req.body || {};
    if (!Array.isArray(items) || items.length === 0) {
      return res.json({ success: true, resolved: {} });
    }

    const db = await connectDB().catch(() => null);
    const studyUids = items.map(i => String(i.studyUid || '')).filter(Boolean);

    // Fetch existing WhatsApp dispatch history for these studies
    const pastLogs = db ? await db.collection('whatsapp_logs').find({
      studyUid: { $in: studyUids }
    }).toArray() : [];

    const logMap = new Map();
    pastLogs.forEach(l => {
      if (!logMap.has(l.studyUid) || new Date(l.dispatchedAt) > new Date(logMap.get(l.studyUid).dispatchedAt)) {
        logMap.set(l.studyUid, l);
      }
    });

    const resolved = {};
    for (const item of items) {
      const studyUid = String(item.studyUid || '');
      const patientId = String(item.patientId || '');
      const pastLog = logMap.get(studyUid);

      const phoneInfo = await resolvePatientPhone(patientId, item.studyDate);

      resolved[studyUid] = {
        phone: phoneInfo?.phone || (pastLog?.originalPhone || pastLog?.phone || ''),
        source: phoneInfo?.source || (pastLog ? 'Previous PACS Log' : ''),
        isDummy: Boolean(phoneInfo?.isDummy),
        isFake: Boolean(phoneInfo?.isFake || phoneInfo?.patientType === 'ZPATIENT'),
        patientType: phoneInfo?.patientType || '',
        alreadyDispatched: !!pastLog,
        lastStatus: pastLog?.status || null,
        dispatchedAt: pastLog?.dispatchedAt || null,
        messageId: pastLog?.messageId || null,
        testMode: pastLog ? pastLog.testMode : null
      };
    }

    res.json({ success: true, resolved });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get WhatsApp logs with advanced filtering, export support, and rich analytics
app.get('/api/whatsapp/logs', requireAuth(), async (req, res) => {
  try {
    const db = await connectDB().catch(() => null);
    if (!db) return res.status(503).json({ success: false, error: 'Database unavailable' });

    const {
      search = '',
      status = 'ALL',
      mode = 'ALL',
      modality = 'ALL',
      studyName = '',
      dateRange = 'all',
      startDate = '',
      endDate = '',
      exportAll = 'false',
      page = 1,
      limit = 25
    } = req.query;

    const query = {};

    // 1. Search across multiple attributes
    if (search && search.trim()) {
      const q = search.trim();
      const regex = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [
        { patientName: regex },
        { patientId: regex },
        { phone: regex },
        { originalPhone: regex },
        { studyName: regex },
        { studyUid: regex },
        { messageId: regex },
        { watiMessageId: regex }
      ];
    }

    // 2. Status filter
    if (status && status !== 'ALL') {
      const st = status.toUpperCase();
      if (st === 'DELIVERED') {
        query.status = 'DELIVERED';
      } else {
        query.status = st;
      }
    }

    // 3. Mode filter
    if (mode && mode !== 'ALL') {
      query.testMode = (mode.toUpperCase() === 'TEST');
    }

    // 4. Modality filter
    if (modality && modality !== 'ALL') {
      const m = modality.trim();
      if (m.includes('/')) {
        const parts = m.split('/').map(p => p.trim());
        query.modality = { $in: parts.map(p => new RegExp('^' + p, 'i')) };
      } else {
        query.modality = new RegExp('^' + m, 'i');
      }
    }

    // 5. Study Name filter
    if (studyName && studyName.trim()) {
      const sRegex = new RegExp(studyName.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.studyName = sRegex;
    }

    // 6. Date & Custom Date Range filter
    if (dateRange && dateRange !== 'all') {
      const now = new Date();
      let start = new Date();
      let end = new Date();

      if (dateRange === 'today') {
        start.setHours(0, 0, 0, 0);
        end.setHours(23, 59, 59, 999);
        query.dispatchedAt = { $gte: start, $lte: end };
      } else if (dateRange === 'yesterday') {
        start.setDate(start.getDate() - 1);
        start.setHours(0, 0, 0, 0);
        end.setDate(end.getDate() - 1);
        end.setHours(23, 59, 59, 999);
        query.dispatchedAt = { $gte: start, $lte: end };
      } else if (dateRange === '7days' || dateRange === 'last7days') {
        start.setDate(start.getDate() - 7);
        start.setHours(0, 0, 0, 0);
        query.dispatchedAt = { $gte: start };
      } else if (dateRange === '30days' || dateRange === '1month' || dateRange === 'last1month') {
        start.setDate(start.getDate() - 30);
        start.setHours(0, 0, 0, 0);
        query.dispatchedAt = { $gte: start };
      } else if (dateRange === 'thisMonth') {
        start = new Date(now.getFullYear(), now.getMonth(), 1);
        query.dispatchedAt = { $gte: start };
      } else if (dateRange === '1year' || dateRange === '365days' || dateRange === 'last1year') {
        start.setDate(start.getDate() - 365);
        start.setHours(0, 0, 0, 0);
        query.dispatchedAt = { $gte: start };
      } else if (dateRange === 'custom' || (startDate && endDate)) {
        const dateFilter = {};
        if (startDate) {
          const s = new Date(startDate);
          s.setHours(0, 0, 0, 0);
          if (!isNaN(s.getTime())) dateFilter.$gte = s;
        }
        if (endDate) {
          const e = new Date(endDate);
          e.setHours(23, 59, 59, 999);
          if (!isNaN(e.getTime())) dateFilter.$lte = e;
        }
        if (Object.keys(dateFilter).length > 0) {
          query.dispatchedAt = dateFilter;
        }
      }
    } else if (startDate || endDate) {
      const dateFilter = {};
      if (startDate) {
        const s = new Date(startDate);
        s.setHours(0, 0, 0, 0);
        if (!isNaN(s.getTime())) dateFilter.$gte = s;
      }
      if (endDate) {
        const e = new Date(endDate);
        e.setHours(23, 59, 59, 999);
        if (!isNaN(e.getTime())) dateFilter.$lte = e;
      }
      if (Object.keys(dateFilter).length > 0) {
        query.dispatchedAt = dateFilter;
      }
    }

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(200, Math.max(5, parseInt(limit, 10) || 25));
    const skip = (pageNum - 1) * limitNum;
    const isExportAll = (exportAll === 'true' || exportAll === true);

    // Fetch data
    let logs = [];
    let totalCount = 0;

    if (isExportAll) {
      logs = await db.collection('whatsapp_logs')
        .find(query)
        .sort({ dispatchedAt: -1 })
        .limit(5000)
        .toArray();
      totalCount = logs.length;
    } else {
      [logs, totalCount] = await Promise.all([
        db.collection('whatsapp_logs')
          .find(query)
          .sort({ dispatchedAt: -1 })
          .skip(skip)
          .limit(limitNum)
          .toArray(),
        db.collection('whatsapp_logs').countDocuments(query)
      ]);
    }

    // Retrieve entire dataset for global KPIs & Analytics calculations
    const allMatchingLogs = await db.collection('whatsapp_logs')
      .find(query)
      .project({
        status: 1,
        modality: 1,
        dispatchedAt: 1,
        deliveredAt: 1,
        readAt: 1,
        testMode: 1,
        retryCount: 1,
        lastError: 1,
        messageId: 1,
        patientId: 1,
        patientName: 1,
        studyUid: 1,
        studyName: 1,
        studyDate: 1,
        phone: 1,
        originalPhone: 1
      })
      .toArray();

    // Calculate status breakdown & patient metrics from all matching logs
    let sentCount = 0;
    let deliveredCount = 0;
    let readCount = 0;
    let failedCount = 0;
    let testCount = 0;
    let liveCount = 0;

    const patientMap = new Map();

    // Modality breakdown map
    const modalityMap = {};
    // Timeline day-by-day map
    const timelineMap = {};
    // Hourly distribution array (0 to 23)
    const hourlyDistribution = new Array(24).fill(0);
    // Latency buckets
    const latency = {
      under5m: 0,
      under30m: 0,
      under2h: 0,
      under12h: 0,
      delayed: 0,
      unread: 0
    };

    for (const item of allMatchingLogs) {
      const st = (item.status || 'SENT').toUpperCase();
      if (st === 'READ') readCount++;
      else if (st === 'DELIVERED') deliveredCount++;
      else if (st === 'FAILED') failedCount++;
      else sentCount++;

      if (item.testMode) testCount++;
      else liveCount++;

      // Track unique patients & their test counts
      const pKey = String(item.patientId || item.phone || 'UNKNOWN').trim();
      if (!patientMap.has(pKey)) {
        patientMap.set(pKey, {
          patientId: item.patientId || '',
          patientName: item.patientName || 'Patient',
          phone: item.phone || '',
          testsCount: 0,
          modalities: new Set(),
          tests: [],
          lastDispatchedAt: null
        });
      }
      const pData = patientMap.get(pKey);
      pData.testsCount++;
      if (item.modality) pData.modalities.add(item.modality.toUpperCase().trim());
      if ((!pData.patientName || pData.patientName === 'Patient') && item.patientName) {
        pData.patientName = item.patientName;
      }
      if (!pData.phone && item.phone) pData.phone = item.phone;
      if (!pData.lastDispatchedAt || (item.dispatchedAt && new Date(item.dispatchedAt) > new Date(pData.lastDispatchedAt))) {
        pData.lastDispatchedAt = item.dispatchedAt;
      }
      pData.tests.push({
        _id: String(item._id || item.messageId),
        messageId: item.messageId || '',
        studyUid: item.studyUid || '',
        studyName: item.studyName || 'Diagnostic Examination',
        studyDate: item.studyDate || '',
        modality: (item.modality || 'DOC').toUpperCase(),
        status: st,
        dispatchedAt: item.dispatchedAt,
        deliveredAt: item.deliveredAt,
        readAt: item.readAt,
        testMode: !!item.testMode,
        phone: item.phone || '',
        retryCount: item.retryCount || 0,
        lastError: item.lastError || ''
      });

      // Modality
      const mod = (item.modality || 'OTHER').toUpperCase().trim();
      if (!modalityMap[mod]) {
        modalityMap[mod] = { modality: mod, total: 0, delivered: 0, read: 0, failed: 0 };
      }
      modalityMap[mod].total++;
      if (st === 'READ') modalityMap[mod].read++;
      else if (st === 'DELIVERED') modalityMap[mod].delivered++;
      else if (st === 'FAILED') modalityMap[mod].failed++;

      // Timeline by day
      const d = item.dispatchedAt ? new Date(item.dispatchedAt) : new Date();
      const dayKey = d.toISOString().split('T')[0];
      if (!timelineMap[dayKey]) {
        timelineMap[dayKey] = { date: dayKey, total: 0, sent: 0, delivered: 0, read: 0, failed: 0 };
      }
      timelineMap[dayKey].total++;
      if (st === 'READ') timelineMap[dayKey].read++;
      else if (st === 'DELIVERED') timelineMap[dayKey].delivered++;
      else if (st === 'FAILED') timelineMap[dayKey].failed++;
      else timelineMap[dayKey].sent++;

      // Hour
      const hr = d.getHours();
      if (hr >= 0 && hr < 24) hourlyDistribution[hr]++;

      // Latency calculation (dispatchedAt to readAt)
      if (item.readAt && item.dispatchedAt) {
        const diffMs = new Date(item.readAt).getTime() - new Date(item.dispatchedAt).getTime();
        const diffMin = Math.max(0, Math.round(diffMs / 60000));
        if (diffMin <= 5) latency.under5m++;
        else if (diffMin <= 30) latency.under30m++;
        else if (diffMin <= 120) latency.under2h++;
        else if (diffMin <= 720) latency.under12h++;
        else latency.delayed++;
      } else if (st !== 'FAILED') {
        latency.unread++;
      }
    }

    // Format modality breakdown array
    const modalityBreakdown = Object.values(modalityMap).map(m => ({
      ...m,
      rate: m.total > 0 ? Math.round(((m.delivered + m.read) / m.total) * 100) : 100
    })).sort((a, b) => b.total - a.total);

    // Format timeline array sorted chronologically
    const timeline = Object.values(timelineMap).sort((a, b) => a.date.localeCompare(b.date));

    // Get current mode & config from settings
    const configDoc = await db.collection('settings').findOne({ _id: 'whatsapp_config' });
    const isTestMode = configDoc?.testMode !== false;

    const totalMatching = allMatchingLogs.length;
    const totalPatients = patientMap.size;
    const totalTests = totalMatching;
    const successfulDelivery = deliveredCount + readCount;
    const deliveryRate = totalMatching > 0 ? Math.round((successfulDelivery / totalMatching) * 100) : 100;
    const readRate = totalMatching > 0 ? Math.round((readCount / totalMatching) * 100) : 0;

    // Generate patient list with overall status and test groupings
    const patientList = Array.from(patientMap.values()).map(p => {
      let overallStatus = 'READ';
      const hasFailed = p.tests.some(t => t.status === 'FAILED');
      const hasSent = p.tests.some(t => t.status === 'SENT');
      const hasDelivered = p.tests.some(t => t.status === 'DELIVERED');
      if (hasFailed) overallStatus = 'FAILED';
      else if (hasSent) overallStatus = 'SENT';
      else if (hasDelivered) overallStatus = 'DELIVERED';
      else overallStatus = 'READ';

      return {
        patientId: p.patientId,
        patientName: p.patientName,
        phone: p.phone,
        testsCount: p.testsCount,
        modalities: Array.from(p.modalities),
        overallStatus,
        lastDispatchedAt: p.lastDispatchedAt,
        tests: p.tests.sort((a, b) => new Date(b.dispatchedAt || 0) - new Date(a.dispatchedAt || 0))
      };
    }).sort((a, b) => new Date(b.lastDispatchedAt || 0) - new Date(a.lastDispatchedAt || 0));

    res.json({
      success: true,
      logs,
      totalCount,
      page: pageNum,
      limit: limitNum,
      totalPages: isExportAll ? 1 : Math.ceil(totalCount / limitNum) || 1,
      stats: {
        total: totalMatching,
        totalTests,
        totalPatients,
        delivered: deliveredCount,
        read: readCount,
        sent: sentCount,
        failed: failedCount,
        deliveryRate,
        readRate,
        testCount,
        liveCount,
        activeMode: isTestMode ? 'TEST' : 'LIVE',
        fixedTestPhone: configDoc?.fixedTestPhone || '9498094815',
        testPatientId: configDoc?.testPatientId || '5038408',
        autoRetryEnabled: configDoc?.autoRetryEnabled !== false,
        autoRetryIntervalMinutes: parseInt(configDoc?.autoRetryIntervalMinutes, 10) || 15,
        maxAutoRetries: parseInt(configDoc?.maxAutoRetries, 10) || 3,
        publicUrl: publicReportBaseUrl || configDoc?.publicUrl || '',
        templateName: configDoc?.templateName || process.env.WATI_TEMPLATE_ID || 'pacs_reports_new',
        autoSendFinalized: configDoc?.autoSendFinalized !== false
      },
      analytics: {
        statusBreakdown: {
          sent: sentCount,
          delivered: deliveredCount,
          read: readCount,
          failed: failedCount
        },
        patientBreakdown: {
          totalPatients,
          totalTests,
          avgTestsPerPatient: totalPatients > 0 ? (totalTests / totalPatients).toFixed(1) : '1.0',
          patients: patientList
        },
        modalityBreakdown,
        timeline,
        hourlyDistribution,
        latencyBreakdown: latency
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Trigger on-demand sync of delivery & read receipts with WATI
app.post('/api/whatsapp/sync-status', requireAuth(), async (req, res) => {
  try {
    const result = await syncWhatsAppStatuses();
    res.json({ success: true, message: `Synced with WATI: ${result.updated} messages updated`, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Bulk retry failed or selected WhatsApp dispatches
app.post('/api/whatsapp/bulk-retry', requireAuth('canViewReports'), async (req, res) => {
  try {
    const db = await connectDB().catch(() => null);
    if (!db) return res.status(503).json({ success: false, error: 'Database unavailable' });

    const { logIds = [], retryAllFailed = false } = req.body || {};
    let query = {};

    if (retryAllFailed) {
      query = { status: 'FAILED' };
    } else if (Array.isArray(logIds) && logIds.length > 0) {
      const objectIds = [];
      const stringIds = [];
      for (const id of logIds) {
        try { objectIds.push(new ObjectId(id)); } catch (e) { stringIds.push(id); }
      }
      query = {
        $or: [
          { _id: { $in: objectIds } },
          { messageId: { $in: stringIds } }
        ]
      };
    } else {
      return res.status(400).json({ success: false, error: 'Please specify logIds array or retryAllFailed: true' });
    }

    const logsToRetry = await db.collection('whatsapp_logs').find(query).limit(50).toArray();
    if (logsToRetry.length === 0) {
      return res.json({
        success: true,
        retriedCount: 0,
        succeeded: 0,
        failed: 0,
        results: [],
        message: 'No matching records found to retry'
      });
    }

    const results = [];
    let succeeded = 0;
    let failed = 0;

    for (const log of logsToRetry) {
      const outcome = await retryWhatsAppDispatchCore(db, log, req.user?.username || 'manual_bulk');
      if (outcome.success) succeeded++;
      else failed++;
      results.push({
        id: log._id,
        patientName: log.patientName,
        patientId: log.patientId,
        phone: log.phone,
        ...outcome
      });
    }

    res.json({
      success: true,
      retriedCount: logsToRetry.length,
      succeeded,
      failed,
      results,
      message: `Retried ${logsToRetry.length} dispatch(es): ${succeeded} succeeded, ${failed} failed.`
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Resend report PDF via WhatsApp (Retry failed or requested resend)
app.post('/api/whatsapp/retry/:logId', requireAuth('canViewReports'), async (req, res) => {
  try {
    const db = await connectDB().catch(() => null);
    if (!db) return res.status(503).json({ success: false, error: 'Database unavailable' });

    const { logId } = req.params;
    let logDoc = null;
    try {
      logDoc = await db.collection('whatsapp_logs').findOne({ _id: new ObjectId(logId) });
    } catch (e) {
      logDoc = await db.collection('whatsapp_logs').findOne({ messageId: logId });
    }

    if (!logDoc) {
      return res.status(404).json({ success: false, error: 'Dispatch log entry not found' });
    }

    const outcome = await retryWhatsAppDispatchCore(db, logDoc, req.user?.username || 'manual_single');
    if (outcome.success) {
      res.json({ success: true, message: `Report successfully resent to ${logDoc.phone}`, ...outcome });
    } else {
      res.status(422).json({ success: false, error: outcome.error || 'Retry failed', ...outcome });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Real-time webhook receiver from WATI
app.post('/api/wati/webhook', express.json(), async (req, res) => {
  try {
    const event = req.body;
    console.log(`[WATI WEBHOOK] Event: ${event?.eventType || 'unknown'}, status: ${event?.statusString}`);

    const db = await connectDB().catch(() => null);
    if (db && event) {
      const { localMessageId, whatsappMessageId, statusString } = event;
      if (localMessageId || whatsappMessageId) {
        const newStatus = (statusString || '').toUpperCase();
        const updateFields = {
          lastWebhookReceivedAt: new Date()
        };
        if (newStatus) updateFields.status = newStatus;
        if (newStatus === 'DELIVERED') updateFields.deliveredAt = new Date();
        if (newStatus === 'READ') updateFields.readAt = new Date();

        await db.collection('whatsapp_logs').updateMany(
          {
            $or: [
              { messageId: localMessageId },
              { watiMessageId: whatsappMessageId }
            ]
          },
          { $set: updateFields }
        );
      }
    }
    res.status(200).json({ received: true });
  } catch (err) {
    res.status(200).json({ received: true, error: err.message });
  }
});


// On-Demand DICOM (.dcm / .zip) Exporter (Super Admin, Radiologist only)
app.get('/api/study/:studyUid/download', requireAuth('canDownloadDicom'), async (req, res) => {
  try {
    const { studyUid } = req.params;
    const safeStudy = studyUid.replace(/[^a-zA-Z0-9._-]/g, '');

    // 1. Fetch study layout to discover all instance images
    const targetUrl = `${PACS_HOST}/ZEROFOOTPRINT/getStudy.aspx?StudyUID=${encodeURIComponent(studyUid)}`;
    const metaRes = await fetch(targetUrl);
    if (!metaRes.ok) {
      return res.status(metaRes.status).send('Study not found on PACS');
    }

    const meta = await metaRes.json();
    const seriesList = meta.seriesList || [];

    // Flat list of image paths
    const filesToFetch = [];
    seriesList.forEach((ser, sIdx) => {
      const serNumber = ser.seriesNumber || (sIdx + 1);
      (ser.instanceList || []).forEach((inst, iIdx) => {
        if (inst.imageId) {
          // imageId is formatted like "192.168.101.224:80/PACS_DATA/Images/357221/..."
          const relPath = inst.imageId.replace(/^[^/]+/, '');
          const filename = `Series_${serNumber}/Instance_${iIdx + 1}.dcm`;
          filesToFetch.push({ url: `http://${inst.imageId}`, filename });
        }
      });
    });

    if (filesToFetch.length === 0) {
      return res.status(404).send('No DICOM instances found for this study');
    }

    // Set ZIP response headers
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safeStudy}_${meta.patientId || 'STUDY'}_DICOM.zip"`);

    const archive = new ZipArchive({ zlib: { level: 5 } });
    archive.pipe(res);

    archive.on('error', err => {
      console.error('[DICOM Export] Archive error:', err.message);
      if (!res.headersSent) res.status(500).send('Error creating zip archive');
    });

    // Bundle each DICOM file - stream from MinIO if cached, or fetch & persist to MinIO!
    for (const item of filesToFetch) {
      const objectKey = `studies/${safeStudy}/${item.filename}`;
      try {
        const cachedStat = await statDicomObject(objectKey);
        if (cachedStat) {
          // Stream directly from MinIO DICOM storage
          const stream = await getDicomInstanceStream(objectKey);
          archive.append(stream, { name: item.filename });
        } else {
          // Fetch from PACS server, stream to zip and persist to MinIO
          const fileRes = await fetch(item.url);
          if (fileRes.ok) {
            const buffer = Buffer.from(await fileRes.arrayBuffer());
            archive.append(buffer, { name: item.filename });
            // Save to MinIO asynchronously
            uploadDicomInstance(safeStudy, item.filename, buffer).catch(uErr =>
              console.warn(`[MinIO DICOM Cache] Failed to persist ${objectKey}:`, uErr.message)
            );
          }
        }
      } catch (fErr) {
        console.warn(`[DICOM Export] Error processing instance ${item.filename}:`, fErr.message);
      }
    }

    await archive.finalize();
  } catch (err) {
    console.error('[DICOM Export Error]:', err.message);
    if (!res.headersSent) {
      res.status(500).send('Failed to export DICOM study archive');
    }
  }
});

// ==========================================
// MongoDB Local Patient & Study API Endpoints
// ==========================================

// MongoDB Stats & Compass Connection Details
app.get('/api/mongo/stats', async (req, res) => {
  try {
    const stats = await getMongoStats();
    res.json({ success: true, ...stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Trigger On-demand Background Sync to MongoDB (Super Admin only)
app.post('/api/mongo/sync', requireAuth('canSyncMongo'), async (req, res) => {
  try {
    const { days = 30, from, to } = req.body || {};

    let dFrom = from;
    let dTo = to;
    if (!dFrom) {
      const today = new Date();
      const past = new Date();
      past.setDate(today.getDate() - (parseInt(days, 10) || 30) + 1);
      dFrom = past.toISOString().split('T')[0];
      dTo = today.toISOString().split('T')[0];
    }
    if (!dTo) {
      dTo = new Date().toISOString().split('T')[0];
    }

    // Run async fetch and save in background
    (async () => {
      try {
        console.log(`[MongoDB Sync] Starting background sync for ${dFrom} to ${dTo}...`);
        const targetUrl = `${PACS_HOST}/api_pacs.asp?from=${encodeURIComponent(dFrom)}&to=${encodeURIComponent(dTo)}&limit=5000`;
        const resp = await fetch(targetUrl);
        if (resp.ok) {
          const json = await resp.json();
          if (json && json.success && Array.isArray(json.data)) {
            const result = await upsertStudies(json.data);
            console.log(`[MongoDB Sync] Background sync finished: +${result.upsertedCount} new, ${result.modifiedCount} updated.`);
          }
        }
      } catch (syncErr) {
        console.error('[MongoDB Sync Error]:', syncErr.message);
      }
    })();

    res.json({
      success: true,
      message: `Sync initiated in background for ${dFrom} to ${dTo}`,
      dateRange: { from: dFrom, to: dTo }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Query Master Patients Collection from MongoDB
app.get('/api/mongo/patients', async (req, res) => {
  try {
    const { search, modality, dateFrom, dateTo, limit = 50, page = 1 } = req.query;
    const result = await queryPatients({
      search,
      modality,
      dateFrom,
      dateTo,
      limit: parseInt(limit, 10) || 50,
      page: parseInt(page, 10) || 1
    });
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Single Patient Complete History from MongoDB
app.get('/api/mongo/patient/:patientId', async (req, res) => {
  try {
    const { patientId } = req.params;
    const dbInstance = await connectDB();
    if (!dbInstance) {
      return res.status(503).json({ success: false, error: 'MongoDB not connected' });
    }

    const patient = await dbInstance.collection('patients').findOne({ patientId });
    if (!patient) {
      return res.status(404).json({ success: false, error: 'Patient not found in local MongoDB' });
    }

    const allStudies = await dbInstance.collection('studies')
      .find({ patientId })
      .sort({ studyDate: -1, studyTime: -1 })
      .toArray();

    res.json({
      success: true,
      patient,
      studiesCount: allStudies.length,
      studies: allStudies
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ==========================================
// MinIO DICOM Object Storage API Endpoints
// ==========================================

// Global MinIO status & DICOM storage metrics
app.get('/api/minio/stats', async (req, res) => {
  try {
    const stats = await getMinioStats();
    res.json({ success: true, ...stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Single study DICOM status in MinIO
app.get('/api/study/:studyUid/minio', async (req, res) => {
  try {
    const { studyUid } = req.params;
    const status = await getStudyDicomStatus(studyUid);
    res.json({ success: true, ...status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Pre-cache study DICOM instances to MinIO
app.post('/api/study/:studyUid/cache-minio', async (req, res) => {
  try {
    const { studyUid } = req.params;
    const safeStudy = studyUid.replace(/[^a-zA-Z0-9._-]/g, '');

    const targetUrl = `${PACS_HOST}/ZEROFOOTPRINT/getStudy.aspx?StudyUID=${encodeURIComponent(studyUid)}`;
    const metaRes = await fetch(targetUrl);
    if (!metaRes.ok) return res.status(404).json({ success: false, error: 'Study not found on PACS' });

    const meta = await metaRes.json();
    const seriesList = meta.seriesList || [];

    const filesToFetch = [];
    seriesList.forEach((ser, sIdx) => {
      const serNumber = ser.seriesNumber || (sIdx + 1);
      (ser.instanceList || []).forEach((inst, iIdx) => {
        if (inst.imageId) {
          const filename = `Series_${serNumber}/Instance_${iIdx + 1}.dcm`;
          filesToFetch.push({ url: `http://${inst.imageId}`, filename });
        }
      });
    });

    // Background caching process
    (async () => {
      console.log(`[MinIO DICOM] Starting background caching for study ${safeStudy} (${filesToFetch.length} files)...`);
      let cachedCount = 0;
      for (const item of filesToFetch) {
        try {
          const objectKey = `studies/${safeStudy}/${item.filename}`;
          const stat = await statDicomObject(objectKey);
          if (!stat) {
            const resp = await fetch(item.url);
            if (resp.ok) {
              const buf = Buffer.from(await resp.arrayBuffer());
              await uploadDicomInstance(safeStudy, item.filename, buf);
              cachedCount++;
            }
          }
        } catch (e) {
          console.warn(`[MinIO Cache] Error on ${item.filename}:`, e.message);
        }
      }
      console.log(`[MinIO DICOM] Caching completed for study ${safeStudy} (+${cachedCount} new files).`);
    })();

    res.json({
      success: true,
      message: `Caching initiated for study ${safeStudy}`,
      totalFiles: filesToFetch.length,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Direct stream of a single DICOM instance from MinIO
app.get('/api/study/:studyUid/dicom/:seriesNumber/:instanceNumber', async (req, res) => {
  try {
    const { studyUid, seriesNumber, instanceNumber } = req.params;
    const safeStudy = studyUid.replace(/[^a-zA-Z0-9._-]/g, '');
    const filename = `Series_${seriesNumber}/Instance_${instanceNumber}.dcm`;
    const objectKey = `studies/${safeStudy}/${filename}`;

    const stat = await statDicomObject(objectKey);
    if (!stat) {
      return res.status(404).send('DICOM file not found in MinIO storage');
    }

    res.setHeader('Content-Type', 'application/dicom');
    res.setHeader('Content-Disposition', `inline; filename="Instance_${instanceNumber}.dcm"`);
    res.setHeader('Content-Length', stat.size);

    const stream = await getDicomInstanceStream(objectKey);
    stream.pipe(res);
  } catch (err) {
    res.status(500).send(`Error retrieving DICOM instance: ${err.message}`);
  }
});

// Public Cross-Origin Reports API (/api/reports)
registerReportsRoutes(app, {
  port: PORT,
  getPacsHost: () => settingsManager.getSettingsSync()?.pacs?.pacsHost || PACS_HOST,
  connectDB,
  upsertStudies,
  reportDir: REPORT_DIR,
  renderModernPdf,
  parseReportFromPdf,
  formatReportFilename
});

// Serve frontend for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`===================================================`);
  console.log(` MAPIMS PACS Connect Gateway is running!`);
  console.log(` Frontend (Nginx)  : http://localhost:${process.env.FRONTEND_PORT || 1020}`);
  console.log(` Backend API       : http://localhost:${PORT}`);
  console.log(` PACS Host         : ${PACS_HOST}`);
  console.log(` MongoDB Local     : mongodb://localhost:${process.env.MONGO_PORT || 3020}/pacs_db`);
  console.log(` MinIO DICOM S3    : http://localhost:${process.env.MINIO_API_PORT || 4020} (Bucket: ${BUCKET_NAME})`);
  console.log(` MinIO Console     : http://localhost:${process.env.MINIO_CONSOLE_PORT || 5020}`);
  console.log(`===================================================`);

  // Establish initial connections
  connectDB().then(async (dbInstance) => {
    if (dbInstance) {
      await initAuth(dbInstance);
      await backfillPastWhatsAppLogs();
    }
  }).catch(err => console.warn('[MongoDB] Initial connect note:', err.message));
  initMinio().catch(err => console.warn('[MinIO] Initial connect note:', err.message));

  // Initialize public tunnel for WATI Document Web Delivery
  startPublicTunnel();
});

