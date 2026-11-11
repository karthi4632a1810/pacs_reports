/**
 * Public Cross-Origin Reports API (/api/reports)
 *
 * Provides universal REST endpoints for external portals, HIS/EMR integrations,
 * and mobile/web apps to query CT, MR, US, DX, CR, XA, MG, and all other
 * modality reports by Patient UHID, date range (from/to), modality, and status.
 *
 * Selection Rule:
 *   - If study status is FINAL  -> fetches Final PDF (with fallback to DOCX/DOC if PDF not yet generated)
 *   - If study status != FINAL  -> fetches DOCX / DOC draft if available
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const MIME_MAP = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc: 'application/msword',
  rtf: 'application/rtf',
};

/**
 * Current calendar date (YYYY-MM-DD) in Asia/Kolkata timezone.
 */
function getTodayIST() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
}

/**
 * Normalize flexible date inputs (YYYY-MM-DD, DD-MM-YYYY, DD/MM/YYYY, YYYY/MM/DD, YYYYMMDD)
 * into YYYY-MM-DD for PACS ASP API compatibility. Returns null if malformed.
 */
function normalizeDateParam(raw) {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  if (!trimmed) return undefined;

  // YYYY-MM-DD or YYYY/MM/DD
  let m = trimmed.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
  if (m) {
    return validateYmd(m[1], m[2], m[3]);
  }

  // DD-MM-YYYY or DD/MM/YYYY
  m = trimmed.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) {
    return validateYmd(m[3], m[2], m[1]);
  }

  // YYYYMMDD
  m = trimmed.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) {
    return validateYmd(m[1], m[2], m[3]);
  }

  return null;
}

function validateYmd(y, m, d) {
  const year = parseInt(y, 10);
  const month = parseInt(m, 10);
  const day = parseInt(d, 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() + 1 !== month ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Parse comma-separated filter string (e.g. "CT,MR") into uppercase array.
 * Returns empty array for empty or "ALL".
 */
function parseCsvFilter(raw) {
  if (!raw) return [];
  const items = String(raw)
    .split(',')
    .map(v => v.trim().toUpperCase())
    .filter(v => v && v !== 'ALL');
  return Array.from(new Set(items));
}

/**
 * Resolve caller-facing base URL (honoring reverse proxy headers like Host/X-Forwarded-Proto).
 */
function getPublicBaseUrl(req, fallbackPort) {
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0].trim();
  const host = (req.headers['x-forwarded-host'] || req.get('host') || `127.0.0.1:${fallbackPort}`).split(',')[0].trim();
  return `${proto}://${host}`;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pick best matching filename from discovered files according to priority rules.
 */
function pickBestFile(files, extList, studyUid, preferFinal = true) {
  const candidates = files.filter(f => {
    const ext = path.extname(f).toLowerCase().replace('.', '');
    return extList.includes(ext);
  });
  if (candidates.length === 0) return null;

  const exactFinal = extList.map(e => `Final_${studyUid}.${e}`.toLowerCase());
  const exactPlain = extList.map(e => `${studyUid}.${e}`.toLowerCase());
  const exactDraft = extList.map(e => `Draft_${studyUid}.${e}`.toLowerCase());

  const order = preferFinal
    ? [
        f => exactFinal.includes(f.toLowerCase()),
        f => f.toLowerCase().startsWith('final_'),
        f => exactPlain.includes(f.toLowerCase()),
        f => exactDraft.includes(f.toLowerCase()),
      ]
    : [
        f => exactDraft.includes(f.toLowerCase()),
        f => exactPlain.includes(f.toLowerCase()),
        f => f.toLowerCase().startsWith('draft_'),
        f => exactFinal.includes(f.toLowerCase()),
      ];

  for (const matcher of order) {
    const hit = candidates.find(matcher);
    if (hit) return hit;
  }
  return candidates[0];
}

/**
 * Probe PACS study report folder (plus local PDF cache) in a single HTTP request,
 * falling back to parallel HEAD probes only if IIS directory listing is disabled.
 */
async function discoverPacsReportFiles(pacsHost, studyUid, reportDir) {
  const cleanHost = String(pacsHost).replace(/\/+$/, '');
  const encodedUid = encodeURIComponent(studyUid);
  const safeStudy = String(studyUid).replace(/[^a-zA-Z0-9._-]/g, '');
  const localFinalPdf = `Final_${safeStudy}.pdf`;
  const hasLocalFinalPdf = fs.existsSync(path.join(reportDir, localFinalPdf));

  let remoteFiles = [];
  const folderUrl = `${cleanHost}/PACS_DATA/Reports/${encodedUid}/`;

  try {
    const res = await fetchWithTimeout(folderUrl, {}, 4000);
    if (res.ok) {
      const html = await res.text();
      const found = new Set();
      for (const match of html.matchAll(/<A\s+HREF="([^"]+)"/gi)) {
        const href = match[1];
        if (!href || href.endsWith('/')) continue;
        let decodedHref = href;
        try {
          decodedHref = decodeURIComponent(href);
        } catch (_) {}
        const fname = decodedHref.split('/').pop();
        if (fname && /\.(pdf|docx?|rtf)$/i.test(fname)) {
          found.add(fname);
        }
      }
      remoteFiles = Array.from(found);
    } else if (res.status !== 404) {
      // Directory listing disabled (e.g. 403): probe standard report filenames
      const probeNames = [
        `Final_${studyUid}.pdf`,
        `${studyUid}.pdf`,
        `Final_${studyUid}.docx`,
        `${studyUid}.docx`,
        `Draft_${studyUid}.docx`,
        `Final_${studyUid}.doc`,
        `${studyUid}.doc`,
        `Draft_${studyUid}.doc`,
      ];
      const checks = await Promise.all(
        probeNames.map(async name => {
          try {
            const r = await fetchWithTimeout(
              `${cleanHost}/PACS_DATA/Reports/${encodedUid}/${encodeURIComponent(name)}`,
              { method: 'HEAD' },
              3000
            );
            return r.ok ? name : null;
          } catch (_) {
            return null;
          }
        })
      );
      remoteFiles = checks.filter(Boolean);
    }
  } catch (_) {
    // Ignore transient directory probe timeouts; local cache may still hold Final PDF
  }

  return {
    hasLocalFinalPdf,
    localFinalPdfName: localFinalPdf,
    remoteFiles,
    pdfFile: pickBestFile(remoteFiles, ['pdf'], studyUid, true) || (hasLocalFinalPdf ? localFinalPdf : null),
    pdfRemoteFile: pickBestFile(remoteFiles, ['pdf'], studyUid, true),
    docxFile: pickBestFile(remoteFiles, ['docx'], studyUid, false),
    docFile: pickBestFile(remoteFiles, ['doc'], studyUid, false),
    finalDocxFile: pickBestFile(remoteFiles, ['docx'], studyUid, true),
    finalDocFile: pickBestFile(remoteFiles, ['doc'], studyUid, true),
  };
}

/**
 * Build a descriptor object for a chosen filename on PACS or local cache.
 */
function makeSelection(selectedType, filename, source, isFinal) {
  const ext = path.extname(filename).toLowerCase().replace('.', '') || 'pdf';
  return {
    available: true,
    isFinal: !!isFinal,
    selectedType,
    format: ext,
    filename,
    source, // 'pacs' | 'local_cache'
    contentType: MIME_MAP[ext] || 'application/octet-stream',
  };
}

/**
 * Core report selection rule:
 *   1. If explicit forcedFormat (pdf | docx | doc | word) is requested -> pick that format if available.
 *   2. If status === FINAL -> pick Final PDF; if PDF not yet written, fallback to DOCX then DOC.
 *   3. If status !== FINAL -> pick DOCX if available, else DOC if available.
 */
function selectReportByStatus(filesInfo, status, forcedFormat = null) {
  const upperStatus = String(status || '').toUpperCase().trim();
  const isFinal = upperStatus === 'FINAL';
  const reqFmt = forcedFormat ? String(forcedFormat).toLowerCase().trim() : null;

  if (reqFmt === 'pdf') {
    if (filesInfo.pdfFile) {
      const src = filesInfo.pdfRemoteFile ? 'pacs' : 'local_cache';
      return makeSelection(isFinal ? 'FINAL_PDF' : 'PDF', filesInfo.pdfFile, src, isFinal);
    }
    return { available: false, isFinal, selectedType: 'NOT_FOUND', format: null, filename: null, contentType: null };
  }

  if (reqFmt === 'docx') {
    const f = isFinal ? filesInfo.finalDocxFile : filesInfo.docxFile;
    if (f) return makeSelection(isFinal ? 'FINAL_DOCX' : 'DRAFT_DOCX', f, 'pacs', isFinal);
    return { available: false, isFinal, selectedType: 'NOT_FOUND', format: null, filename: null, contentType: null };
  }

  if (reqFmt === 'doc') {
    const f = isFinal ? filesInfo.finalDocFile : filesInfo.docFile;
    if (f) return makeSelection(isFinal ? 'FINAL_DOC' : 'DRAFT_DOC', f, 'pacs', isFinal);
    return { available: false, isFinal, selectedType: 'NOT_FOUND', format: null, filename: null, contentType: null };
  }

  if (reqFmt === 'word') {
    const docx = isFinal ? filesInfo.finalDocxFile : filesInfo.docxFile;
    const doc = isFinal ? filesInfo.finalDocFile : filesInfo.docFile;
    if (docx) return makeSelection(isFinal ? 'FINAL_DOCX' : 'DRAFT_DOCX', docx, 'pacs', isFinal);
    if (doc) return makeSelection(isFinal ? 'FINAL_DOC' : 'DRAFT_DOC', doc, 'pacs', isFinal);
    return { available: false, isFinal, selectedType: 'NOT_FOUND', format: null, filename: null, contentType: null };
  }

  // Default automatic rule based on study status
  if (isFinal) {
    if (filesInfo.pdfFile) {
      const src = filesInfo.pdfRemoteFile ? 'pacs' : 'local_cache';
      return makeSelection('FINAL_PDF', filesInfo.pdfFile, src, true);
    }
    // Fallback if PACS marked status FINAL while only Word report exists
    if (filesInfo.finalDocxFile) return makeSelection('FINAL_DOCX', filesInfo.finalDocxFile, 'pacs', true);
    if (filesInfo.finalDocFile) return makeSelection('FINAL_DOC', filesInfo.finalDocFile, 'pacs', true);
    return { available: false, isFinal: true, selectedType: 'NOT_FOUND', format: null, filename: null, contentType: null };
  }

  // Non-final statuses (READ, NEW, etc.): fetch DOCX (or Word DOC) if available
  if (filesInfo.docxFile) return makeSelection('DRAFT_DOCX', filesInfo.docxFile, 'pacs', false);
  if (filesInfo.docFile) return makeSelection('DRAFT_DOC', filesInfo.docFile, 'pacs', false);

  return {
    available: false,
    isFinal: false,
    selectedType: upperStatus === 'NEW' ? 'PENDING' : 'NOT_FOUND',
    format: null,
    filename: null,
    contentType: null,
  };
}

/**
 * Format patient-friendly download filename with dynamic extension (.pdf / .docx / .doc).
 */
function buildDownloadFilename(formatReportFilename, study, ext, status) {
  const basePdf = formatReportFilename(study.patientName, study.patientId, study.studyUid);
  const cleanExt = String(ext || 'pdf').replace(/^\./, '');
  if (cleanExt === 'pdf') return basePdf;
  const stem = basePdf.replace(/\.pdf$/i, '');
  const tag = status && String(status).toUpperCase() !== 'FINAL' ? `_${String(status).toUpperCase()}` : '';
  return `${stem}${tag}.${cleanExt}`;
}

/**
 * Run async worker over array in bounded batches so PACS IIS isn't overloaded.
 */
async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  for (let i = 0; i < items.length; i += concurrency) {
    const slice = items.slice(i, i + concurrency);
    const batchOut = await Promise.all(slice.map((item, idx) => fn(item, i + idx)));
    for (let j = 0; j < batchOut.length; j++) {
      results[i + j] = batchOut[j];
    }
  }
  return results;
}

/**
 * Query PACS ASP API with automatic filtering & MongoDB offline fallback.
 */
async function fetchStudiesFromPacsOrMongo({ pacsHost, connectDB, upsertStudies, filters }) {
  const cleanHost = String(pacsHost).replace(/\/+$/, '');
  const { uhid, search, from, to, modalities, statuses, studyUid, limit, offset } = filters;

  let allStudies = [];
  let archiveTotal = null;
  let dataSource = 'pacs_live';

  const params = new URLSearchParams();
  if (from) params.append('from', from);
  if (to) params.append('to', to);

  // PACS api_pacs.asp uses `search` for patientId/name substring filtering
  const pacsSearch = uhid || search || '';
  if (pacsSearch) params.append('search', pacsSearch);

  // api_pacs.asp only accepts single values for modality & status (returns 0 on comma lists)
  if (modalities.length === 1) params.append('modality', modalities[0]);
  if (statuses.length === 1) params.append('status', statuses[0]);

  const pacsFetchLimit = Math.min(20000, Math.max(5000, offset + limit + 500));
  params.append('limit', String(pacsFetchLimit));

  try {
    const targetUrl = `${cleanHost}/api_pacs.asp?${params.toString()}`;
    const resp = await fetchWithTimeout(targetUrl, {}, 15000);
    if (!resp.ok) throw new Error(`PACS returned HTTP ${resp.status}`);
    const json = await resp.json();
    if (!json || !json.success || !Array.isArray(json.data)) {
      throw new Error(json?.error || 'Unexpected payload from PACS api_pacs.asp');
    }

    allStudies = json.data;
    archiveTotal = json.stats?.archiveTotal ?? null;

    if (allStudies.length > 0 && typeof upsertStudies === 'function') {
      upsertStudies(allStudies).catch(() => {});
    }
  } catch (pacsErr) {
    // Graceful MongoDB fallback if PACS host is momentarily unreachable
    const db = await connectDB().catch(() => null);
    if (!db) {
      throw pacsErr;
    }
    dataSource = 'mongodb_fallback';
    const query = {};
    if (from || to) {
      query.studyDate = {};
      if (from) query.studyDate.$gte = from;
      if (to) query.studyDate.$lte = to;
    }
    if (uhid) query.patientId = new RegExp(`^${escapeRegExp(uhid)}$`, 'i');
    if (modalities.length > 0) query.modality = { $in: modalities };
    if (statuses.length > 0) query.status = { $in: statuses };
    if (studyUid) query.studyUid = studyUid;
    if (search) {
      const rx = new RegExp(escapeRegExp(search), 'i');
      query.$or = [{ patientId: rx }, { patientName: rx }, { study: rx }, { accessionNumber: rx }];
    }
    allStudies = await db.collection('studies').find(query).sort({ studyDate: -1, studyTime: -1 }).limit(pacsFetchLimit).toArray();
  }

  // Exact in-memory filtering for UHID, multi-modality, multi-status, studyUid, and search
  const filtered = allStudies.filter(s => {
    if (uhid && String(s.patientId || '').trim().toLowerCase() !== uhid.toLowerCase()) {
      return false;
    }
    if (studyUid && String(s.studyUid || '').trim() !== studyUid) {
      return false;
    }
    if (modalities.length > 0 && !modalities.includes(String(s.modality || '').toUpperCase().trim())) {
      return false;
    }
    if (statuses.length > 0 && !statuses.includes(String(s.status || '').toUpperCase().trim())) {
      return false;
    }
    if (search) {
      const q = search.toLowerCase();
      const hay = [s.patientId, s.patientName, s.study, s.accessionNumber, s.studyUid].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  return { filtered, dataSource, archiveTotal };
}

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Look up a single study's live status and clinical metadata (MongoDB -> getStudy.aspx -> api_pacs.asp).
 */
async function resolveSingleStudyMetadata({ pacsHost, connectDB, upsertStudies, studyUid }) {
  const cleanHost = String(pacsHost).replace(/\/+$/, '');
  let studyDoc = null;

  try {
    const db = await connectDB().catch(() => null);
    if (db) {
      studyDoc = await db.collection('studies').findOne({ studyUid });
    }
  } catch (_) {}

  // If missing from MongoDB or not yet FINAL, check live PACS so newly signed reports reflect immediately
  let patientId = studyDoc?.patientId || '';
  let studyDate = (studyDoc?.studyDate || '').trim();

  if (!patientId || !studyDate) {
    try {
      const gRes = await fetchWithTimeout(`${cleanHost}/ZEROFOOTPRINT/getStudy.aspx?StudyUID=${encodeURIComponent(studyUid)}`, {}, 5000);
      if (gRes.ok) {
        const gJson = await gRes.json();
        patientId = gJson.patientId || patientId;
        studyDate = (gJson.studyDate || '').trim() || studyDate;
        if (!studyDoc) {
          studyDoc = {
            studyUid,
            patientId,
            patientName: gJson.patientName || '',
            studyDate,
            modality: gJson.Modality || '',
            study: gJson.studyDescription || '',
            images: parseInt(gJson.numImages, 10) || 1,
            status: '',
          };
        }
      }
    } catch (_) {}
  }

  const currentStatus = String(studyDoc?.status || '').toUpperCase();
  if (patientId && currentStatus !== 'FINAL') {
    try {
      const normalizedStudyDate = normalizeDateParam(studyDate);
      const from = normalizedStudyDate || '2020-01-01';
      const to = normalizedStudyDate || getTodayIST();
      const pUrl = `${cleanHost}/api_pacs.asp?search=${encodeURIComponent(patientId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=100`;
      const pRes = await fetchWithTimeout(pUrl, {}, 6000);
      if (pRes.ok) {
        const pJson = await pRes.json();
        const exactMatch = (pJson.data || []).find(item => item.studyUid === studyUid);
        if (exactMatch) {
          studyDoc = exactMatch;
          if (typeof upsertStudies === 'function') {
            upsertStudies([exactMatch]).catch(() => {});
          }
        }
      }
    } catch (_) {}
  }

  return studyDoc || { studyUid, status: '' };
}

/**
 * Shape unified study + report JSON item for /api/reports responses.
 */
function buildReportItem({ study, filesInfo, selection, baseUrl, formatReportFilename }) {
  const encodedUid = encodeURIComponent(study.studyUid);
  const reportPath = `/api/reports/${encodedUid}/file`;
  const downloadPath = `/api/reports/${encodedUid}/download`;
  const hasFinalPdf = !!filesInfo.pdfFile;
  const hasDocx = !!(filesInfo.docxFile || filesInfo.finalDocxFile);
  const hasDoc = !!(filesInfo.docFile || filesInfo.finalDocFile);
  const downloadFilename = selection.available
    ? buildDownloadFilename(formatReportFilename, study, selection.format, study.status)
    : null;

  return {
    studyUid: study.studyUid,
    uhid: String(study.patientId || '').trim(),
    patientId: String(study.patientId || '').trim(),
    patientName: (study.patientName || '').trim(),
    age: (study.age || '').trim(),
    sex: (study.sex || '').trim(),
    studyDate: (study.studyDate || '').trim(),
    studyTime: (study.studyTime || '').trim(),
    receivingDate: (study.receivingDate || '').trim(),
    accessionNumber: (study.accessionNumber || '').trim(),
    modality: (study.modality || '').toUpperCase().trim(),
    study: (study.study || '').trim(),
    referringPhysician: (study.referringPhysician || '').trim(),
    status: (study.status || '').toUpperCase().trim(),
    finalizedBy: (study.finalizedBy || '').trim(),
    images: parseInt(study.images, 10) || 0,
    series: parseInt(study.series, 10) || 0,
    institution: (study.institution || 'MAPIMS').trim(),
    report: {
      available: selection.available,
      isFinal: selection.isFinal,
      hasFinalPdf,
      hasDocx,
      hasDoc,
      selectedType: selection.selectedType,
      format: selection.format,
      filename: selection.filename,
      downloadFilename,
      contentType: selection.contentType,
      reportUrl: selection.available ? `${baseUrl}${reportPath}` : null,
      downloadUrl: selection.available ? `${baseUrl}${downloadPath}` : null,
      rawReportUrl: selection.available ? `${baseUrl}${reportPath}?raw=1` : null,
      reportPath: selection.available ? reportPath : null,
      availableFiles: {
        pdf: hasFinalPdf ? `${baseUrl}${reportPath}?format=pdf` : null,
        docx: hasDocx ? `${baseUrl}${reportPath}?format=docx` : null,
        doc: hasDoc ? `${baseUrl}${reportPath}?format=doc` : null,
      },
      rawFilesOnPacs: filesInfo.remoteFiles,
    },
  };
}

/**
 * Stream the selected PDF / DOCX / DOC report binary to the caller.
 */
async function streamReportFile(req, res, deps, forceDownload = false) {
  const { studyUid } = req.params;
  const pacsHost = deps.getPacsHost();
  const { connectDB, upsertStudies, reportDir, renderModernPdf, parseReportFromPdf, formatReportFilename } = deps;

  const isDownload = forceDownload || req.query.download === '1' || req.query.download === 'true';
  const isRaw = req.query.raw === '1' || req.query.raw === 'true';
  const forcedFormat = req.query.format || null;
  const statusOverride = req.query.status || null;

  const studyDoc = await resolveSingleStudyMetadata({ pacsHost, connectDB, upsertStudies, studyUid });
  const effectiveStatus = statusOverride || studyDoc.status || '';
  const filesInfo = await discoverPacsReportFiles(pacsHost, studyUid, reportDir);

  // If study status wasn't determinable externally but Final PDF exists on PACS, treat as FINAL
  const inferredStatus = effectiveStatus || (filesInfo.pdfFile ? 'FINAL' : 'READ');
  const selection = selectReportByStatus(filesInfo, inferredStatus, forcedFormat);

  if (!selection.available) {
    return res.status(404).json({
      success: false,
      studyUid,
      status: effectiveStatus || 'UNKNOWN',
      available: false,
      message: 'No finalized PDF or draft DOCX/DOC report file is available yet for this study.',
      rawFilesOnPacs: filesInfo.remoteFiles,
    });
  }

  const safeStudy = String(studyUid).replace(/[^a-zA-Z0-9._-]/g, '');
  const cleanHost = String(pacsHost).replace(/\/+$/, '');
  const encodedUid = encodeURIComponent(studyUid);

  // Common CORS/download headers so browser clients from any origin can read filename
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition, Content-Length, Content-Type');

  // Serve PDF
  if (selection.format === 'pdf') {
    const localPdfPath = path.join(reportDir, `Final_${safeStudy}.pdf`);

    if (!fs.existsSync(localPdfPath)) {
      const targetName = filesInfo.pdfRemoteFile || selection.filename;
      const pdfUrl = `${cleanHost}/PACS_DATA/Reports/${encodedUid}/${encodeURIComponent(targetName)}`;
      const remoteRes = await fetchWithTimeout(pdfUrl, {}, 12000);
      if (!remoteRes.ok) {
        return res.status(404).json({ success: false, error: `PACS returned ${remoteRes.status} fetching PDF.` });
      }
      const buf = Buffer.from(await remoteRes.arrayBuffer());
      await fsp.writeFile(localPdfPath, buf).catch(() => {});
    }

    if (!studyDoc.patientName || !studyDoc.patientId) {
      try {
        const parsed = parseReportFromPdf(localPdfPath, studyDoc);
        if (!studyDoc.patientName && parsed.patientName) studyDoc.patientName = parsed.patientName;
        if (!studyDoc.patientId && parsed.patientId) studyDoc.patientId = parsed.patientId;
      } catch (_) {}
    }

    const downloadFilename = buildDownloadFilename(formatReportFilename, studyDoc, 'pdf', effectiveStatus);
    const disposition = isDownload ? 'attachment' : 'inline';

    let fileToServe = localPdfPath;
    if (!isRaw) {
      try {
        const modernPdf = await renderModernPdf(studyUid, studyDoc);
        if (fs.existsSync(modernPdf) && fs.statSync(modernPdf).size > 1000) {
          fileToServe = modernPdf;
        }
      } catch (renderErr) {
        console.warn(`[API/REPORTS] Modern PDF render fallback to raw PDF for ${studyUid}:`, renderErr.message);
      }
    }

    const stat = fs.statSync(fileToServe);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Content-Disposition', `${disposition}; filename="${downloadFilename}"`);
    res.setHeader('Accept-Ranges', 'bytes');
    return res.sendFile(fileToServe);
  }

  // Serve DOCX / DOC from PACS
  const wordUrl = `${cleanHost}/PACS_DATA/Reports/${encodedUid}/${encodeURIComponent(selection.filename)}`;
  const wordRes = await fetchWithTimeout(wordUrl, {}, 12000);
  if (!wordRes.ok) {
    return res.status(404).json({ success: false, error: `PACS returned ${wordRes.status} fetching ${selection.filename}.` });
  }

  const wordBuffer = Buffer.from(await wordRes.arrayBuffer());
  const downloadFilename = buildDownloadFilename(formatReportFilename, studyDoc, selection.format, effectiveStatus);

  res.setHeader('Content-Type', selection.contentType);
  res.setHeader('Content-Length', wordBuffer.length);
  res.setHeader('Content-Disposition', `attachment; filename="${downloadFilename}"`);
  return res.send(wordBuffer);
}

/**
 * Register all public /api/reports endpoints on the Express app.
 */
function registerReportsRoutes(app, deps) {
  const port = deps.port || 2020;

  // 1. Search & list studies + live report availability/URLs (CT, MR, and all modalities)
  app.get('/api/reports', async (req, res) => {
    try {
      const pacsHost = deps.getPacsHost();
      const baseUrl = getPublicBaseUrl(req, port);

      const uhidRaw = req.query.uhid || req.query.patientId || req.query.patient_id || req.query.mrn || '';
      const uhid = String(uhidRaw).trim() || null;
      const searchRaw = req.query.search || req.query.q || '';
      const search = String(searchRaw).trim() || null;
      const studyUidRaw = req.query.studyUid || req.query.study_uid || '';
      const studyUid = String(studyUidRaw).trim() || null;

      const rawFrom = req.query.from ?? req.query.fromDate ?? req.query.from_date ?? req.query.startDate ?? req.query.start_date;
      const rawTo = req.query.to ?? req.query.toDate ?? req.query.to_date ?? req.query.endDate ?? req.query.end_date;

      let from = normalizeDateParam(rawFrom);
      let to = normalizeDateParam(rawTo);
      if (from === null || to === null) {
        return res.status(400).json({
          success: false,
          error: 'Invalid date format for `from` or `to`. Expected YYYY-MM-DD (or DD-MM-YYYY).',
        });
      }

      const today = getTodayIST();
      if (!from && !to) {
        // Patient UHID lookups span historical records unless a date window is specified
        from = (uhid || studyUid) ? '2020-01-01' : today;
        to = today;
      } else if (from && !to) {
        to = today;
      } else if (!from && to) {
        from = (uhid || studyUid) ? '2020-01-01' : to;
      }

      if (from > to) {
        [from, to] = [to, from];
      }

      const modalities = parseCsvFilter(req.query.modality || req.query.modalities);
      const statuses = parseCsvFilter(req.query.status);
      const onlyAvailable = ['true', '1', 'yes'].includes(String(req.query.hasReport || req.query.availableOnly || '').toLowerCase());
      const checkFiles = !['false', '0', 'no'].includes(String(req.query.checkFiles || 'true').toLowerCase());

      const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
      const page = Math.max(1, parseInt(req.query.page, 10) || 1);
      const offset = req.query.offset !== undefined
        ? Math.max(0, parseInt(req.query.offset, 10) || 0)
        : (page - 1) * limit;

      const { filtered, dataSource, archiveTotal } = await fetchStudiesFromPacsOrMongo({
        pacsHost,
        connectDB: deps.connectDB,
        upsertStudies: deps.upsertStudies,
        filters: { uhid, search, from, to, modalities, statuses, studyUid, limit, offset },
      });

      // Compute summary breakdowns across all matched studies
      const byStatus = {};
      const byModality = {};
      for (const s of filtered) {
        const st = (s.status || 'UNKNOWN').toUpperCase().trim();
        const mod = (s.modality || 'OTHER').toUpperCase().trim();
        byStatus[st] = (byStatus[st] || 0) + 1;
        byModality[mod] = (byModality[mod] || 0) + 1;
      }

      let items = [];
      let totalMatched = filtered.length;

      if (!onlyAvailable) {
        const pageSlice = filtered.slice(offset, offset + limit);
        items = await mapWithConcurrency(pageSlice, 20, async (study) => {
          const filesInfo = checkFiles
            ? await discoverPacsReportFiles(pacsHost, study.studyUid, deps.reportDir)
            : { remoteFiles: [] };
          const selection = selectReportByStatus(filesInfo, study.status);
          return buildReportItem({
            study,
            filesInfo,
            selection,
            baseUrl,
            formatReportFilename: deps.formatReportFilename,
          });
        });
      } else {
        // Filter incrementally until we collect enough studies with available files for the requested page
        const needed = offset + limit;
        const collected = [];
        for (let i = 0; i < filtered.length && collected.length < needed; i += 25) {
          const batch = filtered.slice(i, i + 25);
          const resolvedBatch = await Promise.all(
            batch.map(async (study) => {
              const filesInfo = await discoverPacsReportFiles(pacsHost, study.studyUid, deps.reportDir);
              const selection = selectReportByStatus(filesInfo, study.status);
              if (!selection.available) return null;
              return buildReportItem({
                study,
                filesInfo,
                selection,
                baseUrl,
                formatReportFilename: deps.formatReportFilename,
              });
            })
          );
          for (const row of resolvedBatch) {
            if (row) collected.push(row);
          }
        }
        totalMatched = collected.length;
        items = collected.slice(offset, offset + limit);
      }

      res.json({
        success: true,
        dataSource,
        pacsHost,
        filters: {
          uhid,
          search,
          studyUid,
          from,
          to,
          modality: modalities.length > 0 ? modalities.join(',') : 'ALL',
          status: statuses.length > 0 ? statuses.join(',') : 'ALL',
          hasReport: onlyAvailable,
        },
        summary: {
          totalMatched,
          returned: items.length,
          limit,
          offset,
          page: Math.floor(offset / limit) + 1,
          totalPages: Math.max(1, Math.ceil(totalMatched / limit)),
          byStatus,
          byModality,
          archiveTotal,
        },
        data: items,
      });
    } catch (err) {
      console.error('[API/REPORTS ERROR]', err.message);
      res.status(502).json({
        success: false,
        error: `Failed to fetch PACS reports: ${err.message}`,
      });
    }
  });

  // 2. Direct file stream / download endpoints (publicly accessible from anywhere)
  app.get('/api/reports/:studyUid/file', async (req, res) => {
    try {
      await streamReportFile(req, res, deps, false);
    } catch (err) {
      console.error('[API/REPORTS FILE ERROR]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/reports/:studyUid/download', async (req, res) => {
    try {
      await streamReportFile(req, res, deps, true);
    } catch (err) {
      console.error('[API/REPORTS DOWNLOAD ERROR]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 3. Single study report metadata (or direct file stream if ?download=1 / ?format=...)
  app.get('/api/reports/:studyUid', async (req, res) => {
    try {
      if (req.query.download === '1' || req.query.download === 'true' || req.query.file === '1' || req.query.format) {
        return await streamReportFile(req, res, deps, req.query.download === '1' || req.query.download === 'true');
      }

      const pacsHost = deps.getPacsHost();
      const baseUrl = getPublicBaseUrl(req, port);
      const { studyUid } = req.params;

      const studyDoc = await resolveSingleStudyMetadata({
        pacsHost,
        connectDB: deps.connectDB,
        upsertStudies: deps.upsertStudies,
        studyUid,
      });
      const filesInfo = await discoverPacsReportFiles(pacsHost, studyUid, deps.reportDir);
      const selection = selectReportByStatus(filesInfo, studyDoc.status || (filesInfo.pdfFile ? 'FINAL' : 'READ'));

      const item = buildReportItem({
        study: studyDoc,
        filesInfo,
        selection,
        baseUrl,
        formatReportFilename: deps.formatReportFilename,
      });

      res.json({
        success: true,
        pacsHost,
        data: item,
      });
    } catch (err) {
      console.error('[API/REPORTS DETAIL ERROR]', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });
}

module.exports = {
  registerReportsRoutes,
  normalizeDateParam,
  selectReportByStatus,
  getTodayIST,
};
