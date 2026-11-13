#!/usr/bin/env node
/**
 * MAPIMS PACS Connect - Bulk Report Regenerator
 * Regenerates modern colourful PDF reports for yesterday, today, or a custom date range
 * with the latest hospital branding, NABL logo, clean patient card, and approved disclaimers.
 *
 * Usage:
 *   node scripts/regenerate_reports.js                # Regenerates yesterday & today
 *   node scripts/regenerate_reports.js --days=3       # Last 3 days
 *   node scripts/regenerate_reports.js --from=2026-11-12 --to=2026-11-13
 *   node scripts/regenerate_reports.js --all          # All cached reports
 *   node scripts/regenerate_reports.js --clean        # Only wipe cached modern PDFs/HTMLs
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { connectDB } = require('../db');
const { renderModernPdf, parseReportFromPdf } = require('../reportGenerator');

const REPORT_DIR = path.join(__dirname, '../storage/reports');

function formatDate(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    days: 2, // Yesterday + today by default
    from: null,
    to: null,
    all: false,
    cleanOnly: false,
    cleanFirst: true
  };

  args.forEach(arg => {
    if (arg.startsWith('--days=')) {
      options.days = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--from=')) {
      options.from = arg.split('=')[1];
    } else if (arg.startsWith('--to=')) {
      options.to = arg.split('=')[1];
    } else if (arg === '--all') {
      options.all = true;
    } else if (arg === '--clean' || arg === '--clean-only') {
      options.cleanOnly = true;
    } else if (arg === '--no-clean') {
      options.cleanFirst = false;
    }
  });

  if (!options.from && !options.all) {
    const today = new Date();
    const fromDate = new Date();
    fromDate.setDate(today.getDate() - (options.days - 1));
    options.from = formatDate(fromDate);
    options.to = formatDate(today);
  } else if (!options.to && !options.all) {
    options.to = formatDate(new Date());
  }

  return options;
}

async function main() {
  const opts = parseArgs();
  console.log('================================================================');
  console.log('  MAPIMS PACS Connect - Modern PDF Report Bulk Regenerator');
  console.log('================================================================');
  console.log(`[Config] Scope: ${opts.all ? 'ALL Reports' : `${opts.from} to ${opts.to} (${opts.days} days)`}`);
  console.log(`[Config] Storage directory: ${REPORT_DIR}`);

  if (!fs.existsSync(REPORT_DIR)) {
    console.warn(`[WARN] Reports directory not found at ${REPORT_DIR}`);
    process.exit(0);
  }

  // Find all existing Modern_Final files
  const existingFiles = fs.readdirSync(REPORT_DIR);
  const modernPdfs = existingFiles.filter(f => f.startsWith('Modern_Final_') && f.endsWith('.pdf'));
  const modernHtmls = existingFiles.filter(f => f.startsWith('Modern_Final_') && f.endsWith('.html'));

  console.log(`[Cache] Found ${modernPdfs.length} cached modern PDF(s) and ${modernHtmls.length} HTML(s).`);

  if (opts.cleanFirst || opts.cleanOnly) {
    let removedCount = 0;
    for (const f of [...modernPdfs, ...modernHtmls]) {
      try {
        fs.unlinkSync(path.join(REPORT_DIR, f));
        removedCount++;
      } catch (err) {
        console.warn(`Could not remove ${f}:`, err.message);
      }
    }
    console.log(`[Cache] Cleaned ${removedCount} cached modern report file(s).`);

    if (opts.cleanOnly) {
      console.log('[Done] Cache cleaned. All future requests will re-render automatically on-the-fly.');
      process.exit(0);
    }
  }

  // Find studies to recompile
  const rawPdfs = existingFiles.filter(f => f.startsWith('Final_') && !f.startsWith('Modern_Final_') && f.endsWith('.pdf'));
  console.log(`[Raw] Found ${rawPdfs.length} raw PACS Final PDF(s) stored locally.`);

  // Connect to DB for metadata if available
  let db = null;
  try {
    db = await connectDB().catch(() => null);
  } catch (_) {}

  // Filter studies by date if DB is available, or by file mtime
  const targetUids = new Set();

  if (db && !opts.all && opts.from && opts.to) {
    try {
      const dbStudies = await db.collection('studies').find({
        studyDate: { $gte: opts.from, $lte: opts.to }
      }).toArray();

      for (const s of dbStudies) {
        if (s.studyUid) targetUids.add(s.studyUid);
      }
      console.log(`[DB] Found ${dbStudies.length} study record(s) in MongoDB for ${opts.from} to ${opts.to}.`);
    } catch (dbErr) {
      console.warn('[DB] Could not query MongoDB for study dates:', dbErr.message);
    }
  }

  // Also include raw PDFs in storage whose mtime falls within the date range
  const now = Date.now();
  const maxAgeMs = opts.days * 24 * 60 * 60 * 1000 + (12 * 60 * 60 * 1000); // with buffer
  for (const rawFile of rawPdfs) {
    const rawPath = path.join(REPORT_DIR, rawFile);
    try {
      const stat = fs.statSync(rawPath);
      const uid = rawFile.replace(/^Final_/, '').replace(/\.pdf$/, '');
      if (opts.all) {
        targetUids.add(uid);
      } else if (now - stat.mtimeMs <= maxAgeMs) {
        targetUids.add(uid);
      }
    } catch (_) {}
  }

  const uidsToCompile = Array.from(targetUids);
  console.log(`[Target] Total unique studies to regenerate: ${uidsToCompile.length}`);

  if (uidsToCompile.length === 0) {
    console.log('[Notice] No reports matched the requested date range.');
    console.log('[Notice] When new reports arrive or are requested via /api/reports, they will automatically use the latest template.');
    process.exit(0);
  }

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < uidsToCompile.length; i++) {
    const uid = uidsToCompile[i];
    const safeStudy = String(uid).replace(/[^a-zA-Z0-9._-]/g, '');
    const rawPdfPath = path.join(REPORT_DIR, `Final_${safeStudy}.pdf`);

    if (!fs.existsSync(rawPdfPath)) {
      console.log(`[${i + 1}/${uidsToCompile.length}] Skipping ${uid} (raw PDF not cached on local disk)`);
      continue;
    }

    try {
      let studyDoc = {};
      if (db) {
        studyDoc = (await db.collection('studies').findOne({ studyUid: uid })) || {};
      }

      const modernPdfPath = await renderModernPdf(uid, studyDoc, true);
      const stat = fs.statSync(modernPdfPath);
      const parsed = parseReportFromPdf(rawPdfPath, studyDoc);
      const patientLabel = parsed.patientName ? `${parsed.patientName} (${parsed.patientId || 'UHID'})` : uid;

      console.log(`[${i + 1}/${uidsToCompile.length}] OK: ${patientLabel} -> Modern_Final_${safeStudy}.pdf (${stat.size} bytes)`);
      successCount++;
    } catch (err) {
      console.error(`[${i + 1}/${uidsToCompile.length}] FAIL: ${uid} -> ${err.message}`);
      failCount++;
    }
  }

  console.log('================================================================');
  console.log(`[Complete] Successfully regenerated ${successCount} report(s). (${failCount} errors)`);
  console.log('All reports now feature:');
  console.log('  ✔ Official NABL accreditation logo');
  console.log('  ✔ Clean 2-row patient card (Accession No. and Verification Status removed)');
  console.log('  ✔ Reference ID removed from header sub-bar');
  console.log('  ✔ MD-approved Tamil disclaimer with preserved English legal notice');
  console.log('================================================================');
  process.exit(0);
}

main().catch(err => {
  console.error('[Fatal Error]', err);
  process.exit(1);
});
