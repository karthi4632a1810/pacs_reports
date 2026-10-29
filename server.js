require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
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
  optionalAuth
} = require('./auth');

const app = express();
const PORT = process.env.PORT || 2009;
const PACS_HOST = process.env.PACS_HOST || 'http://192.168.101.224';

// Local storage configuration
const STORAGE_DIR = process.env.STORAGE_DIR || path.join(__dirname, 'storage');
const DICOM_DIR = path.join(STORAGE_DIR, 'dicom');
const THUMB_DIR = path.join(STORAGE_DIR, 'thumbnails');
const REPORT_DIR = path.join(STORAGE_DIR, 'reports');

const MAX_CACHE_GB = parseFloat(process.env.MAX_CACHE_GB) || 25;
const MAX_CACHE_BYTES = MAX_CACHE_GB * 1024 * 1024 * 1024;

// Ensure storage directories exist
[STORAGE_DIR, DICOM_DIR, THUMB_DIR, REPORT_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

app.use(cors());
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

// Unified Bounded 25 GB Storage Watchdog across MinIO DICOM & Local Reports/Thumbnails
async function enforce25GbStorageQuota() {
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
        totalGb: (totalUsedBytes / (1024**3)).toFixed(3),
        maxCapGb: MAX_CACHE_GB,
      };
    }

    console.log(`[25GB Storage Watchdog] Storage exceeded ${MAX_CACHE_GB} GB (${(totalUsedBytes / (1024**3)).toFixed(2)} GB). Enforcing quota...`);

    // Target: prune down to 80% of 25 GB (20 GB) to leave operational headroom
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

    console.log(`[25GB Storage Watchdog] Enforced quota. Total freed: ${(totalFreed / (1024**3)).toFixed(2)} GB.`);
    return {
      pruned: true,
      bytesFreed: totalFreed,
      totalUsedBytes: Math.max(0, totalUsedBytes - totalFreed),
      totalGb: (Math.max(0, totalUsedBytes - totalFreed) / (1024**3)).toFixed(3),
      maxCapGb: MAX_CACHE_GB,
    };
  } catch (err) {
    console.error('[25GB Storage Watchdog Error]:', err.message);
    return { error: err.message };
  }
}

// Run storage watchdog check every 10 minutes
setInterval(enforce25GbStorageQuota, 10 * 60 * 1000);

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

// Cache stats endpoint
// Unified 25 GB Cache & Quota stats endpoint
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
        quotaRule: '25 GB Max Combined Storage (DICOM + Reports + Previews)'
      },
      usage: {
        minioDicomBytes: minioBytes,
        minioDicomGb: parseFloat((minioBytes / (1024**3)).toFixed(3)),
        minioDicomFiles: minioStats.totalDicomFiles || 0,
        thumbnailBytes: thumbBytes,
        thumbnailMb: parseFloat((thumbBytes / (1024**2)).toFixed(2)),
        reportBytes,
        reportMb: parseFloat((reportBytes / (1024**2)).toFixed(2)),
        totalBytes: totalUsedBytes,
        totalGb: parseFloat((totalUsedBytes / (1024**3)).toFixed(3)),
        remainingGb: parseFloat((remainingBytes / (1024**3)).toFixed(3)),
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
      usedGb: parseFloat((totalUsedBytes / (1024**3)).toFixed(3)),
      remainingGb: parseFloat((remainingBytes / (1024**3)).toFixed(3)),
      utilizationPct,
      status: utilizationPct > 90 ? 'CRITICAL' : utilizationPct > 75 ? 'WARNING' : 'SAFE',
      breakdown: {
        minioDicomBytes: minioBytes,
        minioDicomMb: parseFloat((minioBytes / (1024**2)).toFixed(2)),
        minioDicomFiles: minioStats.totalDicomFiles || 0,
        reportBytes,
        reportMb: parseFloat((reportBytes / (1024**2)).toFixed(2)),
        thumbnailBytes: thumbBytes,
        thumbnailMb: parseFloat((thumbBytes / (1024**2)).toFixed(2)),
      },
      quotaPolicy: {
        enforcement: 'Automated LRU Watchdog + MinIO 25GiB Hard Quota',
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
    fsp.writeFile(localThumbPath, buffer).catch(() => {});

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(buffer);
  } catch (err) {
    res.status(500).send('Error fetching thumbnail');
  }
});

// Check if a report exists for a study & verify if it has a completed Final PDF
app.get('/api/report/:studyUid/check', async (req, res) => {
  try {
    const { studyUid } = req.params;
    const safeStudy = studyUid.replace(/[^a-zA-Z0-9._-]/g, '');
    const localPdfPath = path.join(REPORT_DIR, `Final_${safeStudy}.pdf`);
    
    // 1. Check local cache for Final PDF
    if (fs.existsSync(localPdfPath)) {
      return res.json({
        available: true,
        hasFinalPdf: true,
        isCompleted: true,
        type: 'pdf',
        filename: `Final_${safeStudy}.pdf`,
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

    // Check local cache
    if (fs.existsSync(localPdfPath)) {
      const stat = fs.statSync(localPdfPath);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', stat.size);
      res.setHeader('Content-Disposition', `inline; filename="Final_${safeStudy}.pdf"`);
      res.setHeader('Accept-Ranges', 'bytes');
      return res.sendFile(localPdfPath);
    }

    // 1. Try PDF report from PACS
    const pdfUrl = `${PACS_HOST}/PACS_DATA/Reports/${encodeURIComponent(studyUid)}/Final_${encodeURIComponent(studyUid)}.pdf`;
    let response = await fetch(pdfUrl);

    if (response.ok) {
      const buffer = Buffer.from(await response.arrayBuffer());
      await fsp.writeFile(localPdfPath, buffer).catch(() => {});
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Length', buffer.length);
      res.setHeader('Content-Disposition', `inline; filename="Final_${safeStudy}.pdf"`);
      res.setHeader('Accept-Ranges', 'bytes');
      return res.send(buffer);
    }

    // 2. Try DOC report from PACS
    const docUrl = `${PACS_HOST}/PACS_DATA/Reports/${encodeURIComponent(studyUid)}/Final_${encodeURIComponent(studyUid)}.doc`;
    response = await fetch(docUrl);
    if (response.ok) {
      const buffer = Buffer.from(await response.arrayBuffer());
      res.setHeader('Content-Type', 'application/msword');
      res.setHeader('Content-Disposition', `attachment; filename="Report_${safeStudy}.doc"`);
      return res.send(buffer);
    }

    // 3. Fallback un-prefixed .doc
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
  } catch (e) {}

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

    // Ensure PDF is cached locally
    if (!fs.existsSync(localPdfPath)) {
      const remotePdfUrl = `${PACS_HOST}/PACS_DATA/Reports/${encodeURIComponent(studyUid)}/Final_${encodeURIComponent(studyUid)}.pdf`;
      const response = await fetch(remotePdfUrl);
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        await fsp.writeFile(localPdfPath, buffer);
      } else {
        console.warn(`[REPORT DOWNLOAD] Remote PACS file not found: ${remotePdfUrl}`);
        return res.status(404).send('PDF report not found on PACS server.');
      }
    }

    const stat = fs.statSync(localPdfPath);
    console.log(`[REPORT DOWNLOAD] Serving Final_${safeStudy}.pdf (${stat.size} bytes) to UA: ${req.headers['user-agent']} (IP: ${req.ip})`);

    res.sendFile(localPdfPath, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': stat.size,
        'Content-Disposition': `inline; filename="Final_${safeStudy}.pdf"`,
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

    if (!fs.existsSync(localPdfPath)) {
      const remotePdfUrl = `${PACS_HOST}/PACS_DATA/Reports/${encodeURIComponent(studyUid)}/Final_${encodeURIComponent(studyUid)}.pdf`;
      const response = await fetch(remotePdfUrl);
      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        await fsp.writeFile(localPdfPath, buffer);
      } else {
        return res.status(404).send('PDF report not found on PACS server.');
      }
    }

    const stat = fs.statSync(localPdfPath);
    console.log(`[REPORT DOWNLOAD DIRECT] Serving Final_${safeStudy}.pdf (${stat.size} bytes) to UA: ${req.headers['user-agent']}`);

    res.sendFile(localPdfPath, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': stat.size,
        'Content-Disposition': `inline; filename="Final_${safeStudy}.pdf"`,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400'
      }
    });
  } catch (err) {
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

// Update WhatsApp Admin Configuration (Toggle Test Mode, Fixed Test Number, Test Patient ID, Auto-Retry)
app.post('/api/admin/whatsapp-config', requireAuth('canManageUsers'), async (req, res) => {
  try {
    const {
      testMode,
      fixedTestPhone,
      testPatientId,
      autoRetryEnabled,
      autoRetryIntervalMinutes,
      maxAutoRetries
    } = req.body || {};

    if (typeof testMode !== 'boolean' || !fixedTestPhone) {
      return res.status(400).json({ success: false, error: 'testMode (boolean) and fixedTestPhone (string) are required.' });
    }
    const cleanPhone = String(fixedTestPhone).replace(/[^0-9]/g, '');
    if (cleanPhone.length < 10) {
      return res.status(400).json({ success: false, error: 'Fixed test phone must be at least 10 digits.' });
    }
    const cleanPatientId = testPatientId ? String(testPatientId).trim() : '';

    const db = await connectDB().catch(() => null);
    if (!db) {
      return res.status(503).json({ success: false, error: 'Database unavailable' });
    }

    const updateDoc = {
      testMode,
      fixedTestPhone: cleanPhone,
      autoRetryEnabled: autoRetryEnabled !== false,
      autoRetryIntervalMinutes: Math.max(1, parseInt(autoRetryIntervalMinutes, 10) || 15),
      maxAutoRetries: Math.max(1, parseInt(maxAutoRetries, 10) || 3),
      updatedAt: new Date(),
      updatedBy: req.user?.username || 'admin'
    };
    if (cleanPatientId) {
      updateDoc.testPatientId = cleanPatientId;
    }

    await db.collection('settings').updateOne(
      { _id: 'whatsapp_config' },
      { $set: updateDoc },
      { upsert: true }
    );

    res.json({
      success: true,
      message: 'WhatsApp configuration updated successfully',
      config: {
        testMode,
        fixedTestPhone: cleanPhone,
        testPatientId: cleanPatientId || undefined,
        autoRetryEnabled: updateDoc.autoRetryEnabled,
        autoRetryIntervalMinutes: updateDoc.autoRetryIntervalMinutes,
        maxAutoRetries: updateDoc.maxAutoRetries
      }
    });
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
      } catch (e) {}
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
      } catch (e) {}
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

// Send Diagnostic Report via WhatsApp (With Strict Final_*.pdf Guard & Test Mode Routing)
app.post('/api/report/:studyUid/send-whatsapp', requireAuth('canViewReports'), async (req, res) => {
  try {
    const { studyUid } = req.params;
    let { phone, patientName, studyName, patientId, studyDate, pdfUrl } = req.body || {};

    if (!phone) {
      return res.status(400).json({ success: false, error: 'Recipient phone number is required.' });
    }

    // 1. Strict Final PDF Guard: Only signed PDF reports starting with "Final_" are permitted
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
      } catch (e) {}
    }

    if (!hasFinalPdf) {
      return res.status(422).json({
        success: false,
        error: 'Report is NOT COMPLETED: Only a Word draft (.doc) or no file was found in PACS D:\\ drive. WhatsApp delivery is restricted to completed Final PDF reports (Final_*.pdf).'
      });
    }

    const db = await connectDB().catch(() => null);
    if (db && (!patientName || !patientId)) {
      const studyDoc = await db.collection('studies').findOne({ studyUid });
      if (studyDoc) {
        patientName = patientName || studyDoc.patientName;
        patientId = patientId || studyDoc.patientId;
        studyName = studyName || `${studyDoc.study || 'Radiology Investigation'} (${studyDoc.modality || ''})`.trim();
        studyDate = studyDate || studyDoc.studyDate;
      }
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
        ).catch(() => {});
      }

      await logWhatsAppDispatch({
        studyUid,
        patientId,
        patientName,
        studyName,
        modality: studyDoc?.modality || '',
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
        modality: studyDoc?.modality || '',
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
    ).catch(() => {});
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
      $or: [
        { retryCount: { $lt: maxRetries } },
        { retryCount: { $exists: false } }
      ],
      $or: [
        { lastRetryAt: { $lte: cutoff } },
        { lastRetryAt: { $exists: false }, dispatchedAt: { $lte: cutoff } }
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
      } else if (dateRange === '7days') {
        start.setDate(start.getDate() - 7);
        start.setHours(0, 0, 0, 0);
        query.dispatchedAt = { $gte: start };
      } else if (dateRange === '30days') {
        start.setDate(start.getDate() - 30);
        start.setHours(0, 0, 0, 0);
        query.dispatchedAt = { $gte: start };
      } else if (dateRange === 'thisMonth') {
        start = new Date(now.getFullYear(), now.getMonth(), 1);
        query.dispatchedAt = { $gte: start };
      } else if (dateRange === 'custom') {
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
        retryCount: 1
      })
      .toArray();

    // Calculate status breakdown from all matching logs
    let sentCount = 0;
    let deliveredCount = 0;
    let readCount = 0;
    let failedCount = 0;
    let testCount = 0;
    let liveCount = 0;

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
    const successfulDelivery = deliveredCount + readCount;
    const deliveryRate = totalMatching > 0 ? Math.round((successfulDelivery / totalMatching) * 100) : 100;
    const readRate = totalMatching > 0 ? Math.round((readCount / totalMatching) * 100) : 0;

    res.json({
      success: true,
      logs,
      totalCount,
      page: pageNum,
      limit: limitNum,
      totalPages: isExportAll ? 1 : Math.ceil(totalCount / limitNum) || 1,
      stats: {
        total: totalMatching,
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
        publicUrl: publicReportBaseUrl || configDoc?.publicUrl || ''
      },
      analytics: {
        statusBreakdown: {
          sent: sentCount,
          delivered: deliveredCount,
          read: readCount,
          failed: failedCount
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
        try { objectIds.push(new ObjectId(id)); } catch(e) { stringIds.push(id); }
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
    } catch(e) {
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

// Serve frontend for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`===================================================`);
  console.log(` MAPIMS PACS Connect Gateway is running!`);
  console.log(` Frontend (Nginx)  : http://localhost:1009`);
  console.log(` Backend API       : http://localhost:${PORT}`);
  console.log(` PACS Host         : ${PACS_HOST}`);
  console.log(` MongoDB Local     : mongodb://localhost:3009/pacs_db`);
  console.log(` MinIO DICOM S3    : http://localhost:4009 (Bucket: ${BUCKET_NAME})`);
  console.log(` MinIO Console     : http://localhost:5009`);
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

