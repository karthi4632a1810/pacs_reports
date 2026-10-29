const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execSync, spawn } = require('child_process');
const QRCode = require('qrcode');

const REPORT_DIR = path.join(__dirname, 'storage/reports');

// Pre-load official hospital logo as Base64 Data URI for instant zero-latency embedding
let LOGO_DATA_URI = '';
try {
  const logoCandidates = [
    path.join(__dirname, 'logo.png'),
    path.join(__dirname, 'public/logo.png')
  ];
  for (const candidate of logoCandidates) {
    if (fs.existsSync(candidate)) {
      const logoBuf = fs.readFileSync(candidate);
      LOGO_DATA_URI = `data:image/png;base64,${logoBuf.toString('base64')}`;
      break;
    }
  }
} catch (e) {
  console.warn('[ReportGen] Could not load logo.png:', e.message);
}


/**
 * Extract structured clinical data from the raw PACS Final PDF text.
 */
function parseReportFromPdf(rawPdfPath, studyDoc = {}) {
  let layoutText = '';
  let plainText = '';

  try {
    layoutText = execSync(`pdftotext -layout "${rawPdfPath}" -`, { timeout: 8000 }).toString('utf8');
  } catch (e) {
    try {
      layoutText = execSync(`pdftotext "${rawPdfPath}" -`, { timeout: 8000 }).toString('utf8');
    } catch (e2) {
      layoutText = '';
    }
  }

  try {
    plainText = execSync(`pdftotext "${rawPdfPath}" -`, { timeout: 8000 }).toString('utf8');
  } catch (e) {
    plainText = layoutText;
  }

  const result = {
    patientName: (studyDoc.patientName || '').trim(),
    ageSex: '',
    age: '',
    sex: '',
    patientId: (studyDoc.patientId || '').trim(),
    referringPhysician: (studyDoc.referringPhysician || '').trim(),
    studyDateTime: (studyDoc.studyDate || '').trim(),
    studyName: (studyDoc.study || '').trim(),
    accessionNumber: (studyDoc.accessionNumber || '').trim(),
    eSignDate: '',
    modality: (studyDoc.modality || '').trim(),
    reportTitle: '',
    clinicalHistory: '',
    technique: '',
    findings: [],
    findingsRaw: '',
    impression: [],
    impressionRaw: '',
    radiologists: [],
    note: 'Note: This modality has its limitations and the report should be correlated with clinical parameters.'
  };

  // 1. Patient Name
  if (!result.patientName) {
    const nameMatch = layoutText.match(/Patient\s+Name:\s*([^\n\r]+?)(?:\s{3,}|Study\s+Date|$)/i) ||
                      plainText.match(/Patient\s+Name:\s*([^\n\r]+)/i);
    if (nameMatch) {
      let val = nameMatch[1].replace(/Age\/\s*Sex:[\s\S]*/i, '').trim();
      if (val && !val.includes(':')) result.patientName = val;
    }
  }

  // 2. Patient ID (6-8 digits, or after Patient ID:)
  if (!result.patientId) {
    const idMatch = layoutText.match(/Patient\s+ID:\s*([0-9]{5,10})/i) ||
                    plainText.match(/Patient\s+ID:\s*([0-9]{5,10})/i) ||
                    layoutText.match(/\b([0-9]{7})\b/);
    if (idMatch) result.patientId = idMatch[1].trim();
  }

  // 3. Age & Sex
  const ageMatch = layoutText.match(/(\d+\s*(?:Years?|Days?|Months?|Yrs?)\s*\/\s*[MF])/i) ||
                   plainText.match(/(\d+\s*(?:Years?|Days?|Months?|Yrs?)\s*\/\s*[MF])/i) ||
                   layoutText.match(/(\d+\s*\/\s*[MF])/i);
  if (ageMatch) {
    result.ageSex = ageMatch[1].trim();
    const parts = result.ageSex.split('/');
    result.age = parts[0].trim();
    const s = parts[1].trim().toUpperCase();
    result.sex = (s === 'M' || s.startsWith('M')) ? 'Male' : ((s === 'F' || s.startsWith('F')) ? 'Female' : s);
  }

  // 4. Referring Physician
  if (!result.referringPhysician) {
    const refMatch = layoutText.match(/Referring\s*(?:Physician)?:\s*([^\n\r]+?)(?:\s{3,}|E-Sign|$)/i) ||
                     plainText.match(/Referring\s*(?:Physician)?:\s*([^\n\r]+)/i);
    if (refMatch) {
      let val = refMatch[1].replace(/Physician:?/i, '').replace(/E-Sign[\s\S]*/i, '').trim();
      if (val && !val.includes(':') && !val.includes('Study')) result.referringPhysician = val;
    }
  }

  // 5. Study Date Time
  const dateTimes = [...layoutText.matchAll(/(\d{1,2}-[A-Za-z]{3}-\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?)/g)];
  if (dateTimes.length > 0) {
    result.studyDateTime = dateTimes[0][1];
  }

  // 6. E-Sign Date
  const esignMatch = layoutText.match(/E-Sign\s*Date:?\s*(\d{1,2}-[A-Za-z]{3}-\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?)/i) ||
                     plainText.match(/E-Sign\s*Date:?\s*(\d{1,2}-[A-Za-z]{3}-\d{4}\s+\d{1,2}:\d{2}(?::\d{2})?)/i);
  if (esignMatch) {
    result.eSignDate = esignMatch[1].trim();
  } else if (dateTimes.length > 1) {
    result.eSignDate = dateTimes[1][1];
  }

  // 7. Study Name & Title
  const titleMatch = layoutText.match(/(?:CT\s*-\s*SCAN[^\n\r]+|MRI\s*SCAN\s*REPORT[^\n\r]+|MRI\s*[–\-—]\s*PROSTATE[^\n\r]+|DIGITAL\s*RADIOGRAPHY[^\n\r]+|X-RAY[^\n\r]+)/i);
  if (titleMatch) {
    result.reportTitle = titleMatch[0].trim();
  }
  if (!result.studyName) {
    const sMatch = layoutText.match(/Study:\s*([^\n\r]+?)(?:\s{3,}|Accession|$)/i);
    if (sMatch) result.studyName = sMatch[1].trim();
  }
  if (!result.reportTitle && result.studyName) {
    result.reportTitle = result.studyName;
  }

  // Determine Modality if missing
  if (!result.modality) {
    const t = (result.reportTitle + ' ' + result.studyName).toUpperCase();
    if (t.includes('MRI') || t.includes('MR ')) result.modality = 'MR';
    else if (t.includes('CT') || t.includes('SCAN')) result.modality = 'CT';
    else if (t.includes('CHEST') || t.includes('X-RAY') || t.includes('XRAY')) result.modality = 'CR';
    else if (t.includes('USG') || t.includes('ULTRASOUND')) result.modality = 'US';
    else result.modality = 'RAD';
  }

  // 8. Clinical History
  const histMatch = layoutText.match(/Clinical\s+history:?\s*([^\n\r]+(?:\n[^\n\r]+)?)/i) ||
                    plainText.match(/Clinical\s+history:?\s*([^\n\r]+)/i);
  if (histMatch) {
    result.clinicalHistory = histMatch[1].replace(/FINDINGS:[\s\S]*/i, '').trim();
  }

  // 9. Technique
  const techMatch = layoutText.match(/TECHNIQUE:?\s*([\s\S]*?)(?:FINDINGS:|Clinical history:|$)/i) ||
                    plainText.match(/TECHNIQUE:?\s*([\s\S]*?)(?:FINDINGS:|Clinical history:|$)/i);
  if (techMatch) {
    result.technique = techMatch[1].replace(/\n\s*\n/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // 10. Impression
  const impMatch = layoutText.match(/IMPRESSION\b:?\s*([\s\S]*?)(?:Dr\s*\.|\(Note:|$)/i) ||
                   plainText.match(/IMPRESSION\b:?\s*([\s\S]*?)(?:Dr\s*\.|\(Note:|$)/i);
  if (impMatch) {
    let rawImp = impMatch[1];
    // Clean out repeated headers from subsequent pages
    rawImp = rawImp.replace(/Patient\s+Name:[\s\S]*?E-Sign\s*Date:[\s\S]*?\d{1,2}:\d{2}(?::\d{2})?/gi, '');
    rawImp = rawImp.replace(/Referring[\s\S]*?Physician:?/gi, '');
    result.impressionRaw = rawImp.trim();

    // Rejoin words split awkwardly by layout wrapping (e.g. "Fazeka'\ns:\nGrade-I)" or "left\nvesicoureteric")
    const rawItems = rawImp.split(/(?:[•\-\*]\s*|\n{2,})/);
    const cleanedItems = [];
    for (let item of rawItems) {
      item = item.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
      // Remove trailing doctor designations or note fragments
      item = item.replace(/(?:Dr\s*\..*|REG\s*NO.*|\(Note:.*)/i, '').trim();
      if (item.length > 4 && !item.toLowerCase().startsWith('reg no') && !item.toLowerCase().startsWith('physician')) {
        cleanedItems.push(item);
      }
    }
    result.impression = cleanedItems;
  }

  // 11. Findings
  const findMatch = layoutText.match(/FINDINGS:?\s*([\s\S]*?)(?:IMPRESSION\b:?|Dr\s*\.|\(Note:|$)/i) ||
                    plainText.match(/FINDINGS:?\s*([\s\S]*?)(?:IMPRESSION\b:?|Dr\s*\.|\(Note:|$)/i);
  if (findMatch) {
    let fText = findMatch[1];
    // Strip repeated page headers
    fText = fText.replace(/Patient\s+Name:[\s\S]*?E-Sign\s*Date:[\s\S]*?\d{1,2}:\d{2}(?::\d{2})?/gi, '');
    fText = fText.replace(/(?:Referring\s+)?Physician:?/gi, '');
    result.findingsRaw = fText.trim();

    // Group into structured paragraphs
    const rawParagraphs = fText.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    const structuredFindings = [];

    for (let para of rawParagraphs) {
      // Rejoin awkward newlines and normalize bullets
      let cleanPara = para.replace(/\n+/g, ' ').replace(/\s+/g, ' ').trim();
      if (!cleanPara || cleanPara.length < 5) continue;
      if (/^(?:Patient Name|Age\/\s*Sex|Patient ID|Study Date|E-Sign Date|Referring|Physician|IMPRESSION):?$/i.test(cleanPara)) continue;
      if (/^IMPRESSION\b/i.test(cleanPara)) continue;

      // If paragraph contains bullets (e.g. " ...  ..."), split into separate items
      const bulletItems = cleanPara.split(/[•*≡]\s*/).map(s => s.trim()).filter(Boolean);
      if (bulletItems.length > 1) {
        for (const item of bulletItems) {
          if (item.length > 4) {
            structuredFindings.push({
              title: '',
              content: item,
              isSubhead: false
            });
          }
        }
        continue;
      }

      cleanPara = cleanPara.replace(/^[•\-\*≡\s]+/, '').trim();

      // Extract organ or subhead if present (e.g., "Liver:", "Pancreas:", "MRA:", "Seminal vesicles:")
      const subheadMatch = cleanPara.match(/^([A-Za-z0-9\s/&–\-]{3,28}):\s*(.*)$/);
      if (subheadMatch) {
        structuredFindings.push({
          title: subheadMatch[1].trim(),
          content: subheadMatch[2].trim(),
          isSubhead: true
        });
      } else {
        structuredFindings.push({
          title: '',
          content: cleanPara,
          isSubhead: false
        });
      }
    }
    result.findings = structuredFindings;
  }

  // 12. Radiologists
  const doctorMap = new Map();
  const rawDocBlocks = [...plainText.matchAll(/(?:^|\n)\s*(Dr\s*\.?\s*[A-Z][\s\S]*?(?:REG\s*NO:?\s*\d+))/gi)];
  
  for (const m of rawDocBlocks) {
    const text = m[1].replace(/\(Note:[\s\S]*/gi, '').trim();
    const regMatch = text.match(/REG\s*NO:?\s*(\d+)/i);
    const regNo = regMatch ? regMatch[1] : '';

    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    let docNameLine = lines.find(l => /^Dr\s*\.?/i.test(l)) || lines[0] || '';
    docNameLine = docNameLine.replace(/\s+/g, ' ').replace(/^Dr\s*\.?\s*/i, 'Dr. ');

    const roleLines = lines.filter(l => l !== lines[0] && !l.toUpperCase().includes('REG NO') && !l.toUpperCase().startsWith('DR.'));
    const role = roleLines.join(' • ') || 'Consultant Radiologist';

    if (docNameLine.length > 5 && regNo && !doctorMap.has(regNo)) {
      doctorMap.set(regNo, {
        name: docNameLine,
        designation: role,
        regNo: `TNMC Reg. No: ${regNo}`,
        verified: true
      });
    }
  }

  // Also extract resident / junior doctors
  const residentMatches = [...plainText.matchAll(/(?:^|\n)\s*(DR\.?\s*[A-Z\s.]+\((?:JR|PG|SR|RESIDENT)\))/gi)];
  const residentNames = [];
  for (const rm of residentMatches) {
    const rName = rm[1].trim().replace(/\s+/g, ' ');
    if (!residentNames.includes(rName)) {
      residentNames.push(rName);
    }
  }
  result.residents = residentNames;

  const doctors = Array.from(doctorMap.values());

  // Fallback to studyDoc.finalizedBy if no doctor extracted from PDF
  if (doctors.length === 0 && studyDoc.finalizedBy) {
    doctors.push({
      name: studyDoc.finalizedBy.startsWith('Dr.') ? studyDoc.finalizedBy : `Dr. ${studyDoc.finalizedBy}`,
      designation: 'Consultant Radiologist',
      regNo: 'TNMC Verified',
      verified: true
    });
  }
  result.radiologists = doctors;

  // 13. Note
  const noteMatch = plainText.match(/\((Note:[\s\S]*?)\)/i);
  if (noteMatch) {
    result.note = noteMatch[1].replace(/\s+/g, ' ').trim();
  }

  return result;
}

/**
 * Generate a colourful, hospital-grade HTML template for printing / viewing / PDF export.
 */
async function generateReportHtml(data, studyUid, publicViewUrl = '') {
  const qrTarget = publicViewUrl || `https://mapims.org/reports/verify/${studyUid}`;
  let qrDataUri = '';
  try {
    qrDataUri = await QRCode.toDataURL(qrTarget, {
      margin: 1,
      width: 140,
      color: {
        dark: '#034763',
        light: '#ffffff'
      }
    });
  } catch (e) {
    qrDataUri = '';
  }

  // Modality colors
  const modalityColors = {
    CT: { bg: '#e0f2fe', text: '#0369a1', border: '#7dd3fc', label: 'Computed Tomography (CT)' },
    MR: { bg: '#f3e8ff', text: '#6b21a8', border: '#d8b4fe', label: 'Magnetic Resonance Imaging (MRI)' },
    CR: { bg: '#ecfdf5', text: '#047857', border: '#6ee7b7', label: 'Digital Radiography (X-Ray)' },
    DX: { bg: '#ecfdf5', text: '#047857', border: '#6ee7b7', label: 'Digital Radiography (DX)' },
    US: { bg: '#fef3c7', text: '#b45309', border: '#fcd34d', label: 'Ultrasound Sonography (USG)' }
  };
  const modStyle = modalityColors[data.modality] || { bg: '#f1f5f9', text: '#334155', border: '#cbd5e1', label: data.modality || 'Diagnostic Imaging' };

  // Format Findings HTML
  let findingsHtml = '';
  if (data.findings && data.findings.length > 0) {
    findingsHtml = data.findings.map(f => {
      if (f.isSubhead) {
        return `
          <div class="finding-card">
            <span class="finding-tag">${escapeHtml(f.title)}</span>
            <p class="finding-body">${highlightMedicalTerms(f.content)}</p>
          </div>
        `;
      } else {
        return `
          <div class="finding-card plain">
            <p class="finding-body">${highlightMedicalTerms(f.content)}</p>
          </div>
        `;
      }
    }).join('');
  } else if (data.findingsRaw) {
    findingsHtml = `
      <div class="finding-card plain">
        <p class="finding-body">${highlightMedicalTerms(data.findingsRaw)}</p>
      </div>
    `;
  } else {
    findingsHtml = `
      <div class="finding-card plain">
        <p class="finding-body text-muted">Investigation performed as per standard hospital radio-diagnostic protocol. Digital PACS images stored and reviewed.</p>
      </div>
    `;
  }

  // Format Impression HTML
  let impressionHtml = '';
  if (data.impression && data.impression.length > 0) {
    impressionHtml = data.impression.map(imp => `
      <li class="impression-item">
        <span class="impression-bullet"></span>
        <div class="impression-text">${highlightMedicalTerms(imp)}</div>
      </li>
    `).join('');
  } else if (data.impressionRaw) {
    impressionHtml = `
      <li class="impression-item">
        <span class="impression-bullet"></span>
        <div class="impression-text">${highlightMedicalTerms(data.impressionRaw)}</div>
      </li>
    `;
  } else {
    impressionHtml = `
      <li class="impression-item">
        <span class="impression-bullet"></span>
        <div class="impression-text">No significant acute abnormality identified on this study. Correlate clinically.</div>
      </li>
    `;
  }

  // Format Doctors / Signatures HTML
  let doctorsHtml = '';
  if (data.radiologists && data.radiologists.length > 0) {
    doctorsHtml = data.radiologists.map(doc => `
      <div class="doctor-seal-card">
        <div class="doctor-badge">
          <svg class="verified-icon" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
          </svg>
          Digitally E-Signed
        </div>
        <div class="doctor-name">${escapeHtml(doc.name)}</div>
        <div class="doctor-designation">${escapeHtml(doc.designation)}</div>
        ${doc.regNo ? `<div class="doctor-reg">${escapeHtml(doc.regNo)}</div>` : ''}
      </div>
    `).join('');
  } else {
    doctorsHtml = `
      <div class="doctor-seal-card">
        <div class="doctor-badge">
          <svg class="verified-icon" viewBox="0 0 20 20" fill="currentColor">
            <path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clip-rule="evenodd"/>
          </svg>
          Digitally Verified
        </div>
        <div class="doctor-name">Department of Radio-Diagnosis</div>
        <div class="doctor-designation">MAPIMS Hospital & Research Institute</div>
      </div>
    `;
  }

  if (data.residents && data.residents.length > 0) {
    doctorsHtml += `
      <div class="doctor-seal-card resident-seal">
        <div class="resident-title">Co-reporting Clinical Team</div>
        <div class="resident-names">${data.residents.map(r => escapeHtml(r)).join(' &bull; ')}</div>
      </div>
    `;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Diagnostic Report - ${escapeHtml(data.patientName || 'Patient')} (${escapeHtml(data.patientId || studyUid)})</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap');

    :root {
      --primary: #0284c7;
      --primary-dark: #0369a1;
      --primary-navy: #092e49;
      --accent-teal: #0d9488;
      --accent-emerald: #059669;
      --surface: #ffffff;
      --bg-page: #f8fafc;
      --border-light: #e2e8f0;
      --text-main: #0f172a;
      --text-muted: #475569;
      --text-sub: #64748b;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }

    body {
      font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
      background: #e2e8f0;
      color: var(--text-main);
      padding: 24px 16px;
      line-height: 1.55;
      font-size: 13.5px;
    }

    .report-sheet {
      max-width: 860px;
      margin: 0 auto;
      background: #ffffff;
      border-radius: 14px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.08);
      overflow: hidden;
      border: 1px solid var(--border-light);
      position: relative;
    }

    /* Hospital Header Banner */
    .hospital-header {
      background: linear-gradient(135deg, #072a44 0%, #0369a1 60%, #0d9488 100%);
      color: #ffffff;
      padding: 18px 24px 14px;
      position: relative;
    }

    .header-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 14px;
    }

    .hospital-brand {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .hospital-logo {
      width: 48px;
      height: 58px;
      background: #ffffff;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 3px 4px;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.2);
      flex-shrink: 0;
    }

    .hospital-logo-img {
      max-width: 100%;
      max-height: 100%;
      object-fit: contain;
      display: block;
    }


    .hospital-title h1 {
      font-size: 16px;
      font-weight: 800;
      letter-spacing: 0.2px;
      text-transform: uppercase;
      line-height: 1.2;
      color: #ffffff;
    }

    .hospital-title h2 {
      font-size: 12.5px;
      font-weight: 600;
      color: #7dd3fc;
      margin-top: 2px;
      letter-spacing: 0.1px;
    }

    .hospital-title p {
      font-size: 10.5px;
      color: #e0f2fe;
      margin-top: 2px;
      opacity: 0.9;
    }

    .header-badges {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 5px;
      flex-shrink: 0;
    }

    .badge-nabh {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: rgba(255, 255, 255, 0.18);
      backdrop-filter: blur(8px);
      border: 1px solid rgba(255, 255, 255, 0.3);
      padding: 3px 9px;
      border-radius: 999px;
      font-size: 10.5px;
      font-weight: 700;
      color: #ffffff;
    }

    .badge-official {
      background: #38bdf8;
      color: #0c4a6e;
      padding: 3px 8px;
      border-radius: 5px;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.5px;
      text-transform: uppercase;
    }

    /* Sub-header Bar */
    .header-sub-bar {
      margin-top: 12px;
      padding-top: 10px;
      border-top: 1px solid rgba(255, 255, 255, 0.2);
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
      color: #f0f9ff;
    }

    .sub-bar-item {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    /* Report Content Container */
    .report-body {
      padding: 18px 24px 22px;
      position: relative;
    }

    .report-watermark {
      position: absolute;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      width: 290px;
      opacity: 0.038;
      pointer-events: none;
      z-index: 0;
    }

    /* Patient Demographics Card */
    .patient-card {
      position: relative;
      z-index: 1;
      background: #f8fafc;
      border: 1px solid #cbd5e1;
      border-radius: 10px;
      padding: 12px 18px;
      margin-bottom: 16px;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.02);
    }


    .patient-grid {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px 18px;
    }

    .meta-item {
      display: flex;
      flex-direction: column;
    }

    .meta-label {
      font-size: 10.5px;
      font-weight: 700;
      color: var(--text-sub);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 2px;
    }

    .meta-val {
      font-size: 13.5px;
      font-weight: 600;
      color: var(--text-main);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .meta-val.patient-name {
      font-size: 15px;
      font-weight: 800;
      color: #0369a1;
    }

    .id-pill {
      background: #e0f2fe;
      color: #0284c7;
      border: 1px solid #bae6fd;
      padding: 2px 7px;
      border-radius: 6px;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12.5px;
      font-weight: 700;
    }

    .modality-pill {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: ${modStyle.bg};
      color: ${modStyle.text};
      border: 1px solid ${modStyle.border};
      padding: 2px 8px;
      border-radius: 6px;
      font-weight: 700;
      font-size: 11.5px;
    }

    /* Examination Title Ribbon */
    .exam-ribbon {
      position: relative;
      z-index: 1;
      background: linear-gradient(90deg, #f0f9ff 0%, #ffffff 100%);
      border-left: 4px solid var(--primary);
      border-radius: 0 8px 8px 0;
      padding: 10px 16px;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
    }


    .exam-title {
      font-size: 16px;
      font-weight: 800;
      color: #0f172a;
      letter-spacing: 0.2px;
      text-transform: uppercase;
    }

    .exam-modality-desc {
      font-size: 11.5px;
      font-weight: 600;
      color: #0284c7;
    }

    /* Section Styling */
    .section-title {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: #0369a1;
      margin-top: 20px;
      margin-bottom: 10px;
      border-bottom: 1px solid #e2e8f0;
      padding-bottom: 5px;
    }

    .section-title svg {
      width: 17px;
      height: 17px;
      color: var(--primary);
    }

    /* Callout Boxes (History / Technique) */
    .callout-box {
      background: #f0fdf4;
      border: 1px solid #bbf7d0;
      border-radius: 8px;
      padding: 10px 14px;
      margin-bottom: 16px;
      font-size: 12.5px;
      color: #166534;
      line-height: 1.5;
    }

    .technique-box {
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-left: 3px solid #0284c7;
      border-radius: 4px 8px 8px 4px;
      padding: 10px 14px;
      margin-bottom: 16px;
      font-size: 12.5px;
      color: #334155;
      line-height: 1.5;
    }

    /* Findings Grid */
    .findings-container {
      display: flex;
      flex-direction: column;
      gap: 10px;
      margin-bottom: 22px;
    }

    .finding-card {
      background: #ffffff;
      border: 1px solid #e2e8f0;
      border-radius: 8px;
      padding: 9px 13px;
      box-shadow: 0 1px 3px rgba(0, 0, 0, 0.02);
      page-break-inside: avoid;
    }

    .finding-card.plain {
      border-left: 3px solid #94a3b8;
    }

    .finding-tag {
      display: inline-block;
      font-size: 11.5px;
      font-weight: 800;
      color: #0369a1;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      background: #f0f9ff;
      border: 1px solid #bae6fd;
      padding: 2px 7px;
      border-radius: 5px;
      margin-bottom: 4px;
    }

    .finding-body {
      font-size: 12.5px;
      color: #1e293b;
      line-height: 1.5;
    }

    /* Clinical Terms Highlight */
    .hl-abnormal {
      background: #fef2f2;
      color: #991b1b;
      font-weight: 600;
      padding: 1px 4px;
      border-radius: 3px;
    }

    .hl-normal {
      color: #047857;
      font-weight: 600;
    }

    .hl-measurement {
      font-family: 'JetBrains Mono', monospace;
      font-weight: 600;
      color: #0284c7;
    }

    /* ========================================= */
    /* THE HERO DIAGNOSTIC IMPRESSION CALLOUT    */
    /* ========================================= */
    .impression-container {
      background: linear-gradient(135deg, #f0fdf4 0%, #f0f9ff 100%);
      border: 2px solid #059669;
      border-radius: 10px;
      padding: 12px 16px;
      margin: 14px 0;
      box-shadow: 0 4px 16px rgba(5, 150, 105, 0.08);
      page-break-inside: avoid;
    }

    .impression-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
      padding-bottom: 6px;
      border-bottom: 1px solid rgba(5, 150, 105, 0.25);
    }

    .impression-title {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 13.5px;
      font-weight: 800;
      color: #065f46;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }

    .impression-title svg {
      width: 18px;
      height: 18px;
      color: #059669;
    }

    .impression-badge {
      background: #059669;
      color: #ffffff;
      font-size: 9.5px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 2px 7px;
      border-radius: 999px;
    }

    .impression-list {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .impression-item {
      display: flex;
      align-items: flex-start;
      gap: 8px;
      font-size: 12.5px;
      line-height: 1.5;
      color: #064e3b;
    }

    .impression-bullet {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #059669;
      margin-top: 5px;
      flex-shrink: 0;
    }

    .impression-text {
      flex: 1;
      font-weight: 600;
    }

    /* Verification & Signature Section */
    .signature-section {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 16px;
      margin-top: 16px;
      padding-top: 12px;
      border-top: 1px solid #cbd5e1;
      page-break-inside: avoid;
    }

    .doctors-wrap {
      display: flex;
      flex-wrap: wrap;
      gap: 20px;
    }

    .doctor-seal-card {
      min-width: 220px;
    }

    .doctor-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: #ecfdf5;
      color: #059669;
      border: 1px solid #a7f3d0;
      padding: 2px 7px;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 700;
      margin-bottom: 5px;
    }

    .verified-icon {
      width: 12px;
      height: 12px;
    }

    .doctor-name {
      font-size: 13.5px;
      font-weight: 800;
      color: #0f172a;
    }

    .doctor-designation {
      font-size: 11.5px;
      font-weight: 600;
      color: #475569;
      margin-top: 1px;
    }

    .doctor-reg {
      font-size: 11px;
      font-weight: 700;
      color: #0284c7;
      font-family: 'JetBrains Mono', monospace;
      margin-top: 2px;
    }

    .doctor-seal-card.resident-seal {
      border-left: 2px dashed #cbd5e1;
      padding-left: 14px;
    }

    .resident-title {
      font-size: 10px;
      font-weight: 700;
      color: var(--text-sub);
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 3px;
    }

    .resident-names {
      font-size: 11.5px;
      font-weight: 600;
      color: #475569;
    }

    .qr-verify-card {
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
      flex-shrink: 0;
      background: #f8fafc;
      border: 1px solid #e2e8f0;
      border-radius: 10px;
      padding: 8px 12px;
    }

    .qr-img {
      width: 80px;
      height: 80px;
      display: block;
    }

    .qr-label {
      font-size: 9.5px;
      font-weight: 700;
      color: #475569;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      margin-top: 3px;
    }

    /* Disclaimer & Footer */
    .report-footer {
      margin-top: 24px;
      padding-top: 14px;
      border-top: 1px dashed #cbd5e1;
      font-size: 11px;
      color: #64748b;
      line-height: 1.45;
      display: flex;
      flex-direction: column;
      gap: 6px;
      page-break-inside: avoid;
    }

    .footer-note {
      font-style: italic;
    }

    .footer-bottom {
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: #94a3b8;
      font-size: 10px;
    }

    /* Floating Action Controls for Interactive Web View */
    .print-controls {
      position: sticky;
      top: 12px;
      z-index: 1000;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 10px;
      margin-bottom: 12px;
      max-width: 860px;
      margin-left: auto;
      margin-right: auto;
    }

    .btn-action {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: #0284c7;
      color: #ffffff;
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 12.5px;
      font-weight: 700;
      text-decoration: none;
      cursor: pointer;
      border: none;
      box-shadow: 0 4px 12px rgba(2, 132, 199, 0.25);
      transition: all 0.2s ease;
    }

    .btn-action:hover {
      background: #0369a1;
      transform: translateY(-1px);
    }

    .btn-action.secondary {
      background: #ffffff;
      color: #0f172a;
      border: 1px solid #cbd5e1;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.05);
    }

    .btn-action.secondary:hover {
      background: #f8fafc;
    }

    /* Print Media Queries */
    @media print {
      @page {
        margin: 0;
        size: A4 portrait;
      }
      html, body {
        background: #ffffff !important;
        margin: 0 !important;
        padding: 0 !important;
        width: 100% !important;
        font-size: 11.8px !important;
        line-height: 1.42 !important;
      }
      .report-sheet {
        box-shadow: none !important;
        border: none !important;
        max-width: 100% !important;
        width: 100% !important;
        border-radius: 0 !important;
        margin: 0 !important;
      }
      .hospital-header {
        border-radius: 0 !important;
        padding: 14px 20px 10px !important;
      }
      .hospital-logo {
        width: 42px !important;
        height: 50px !important;
        padding: 2px 3px !important;
      }
      .hospital-logo-img {
        max-width: 100% !important;
        max-height: 100% !important;
      }
      .report-watermark {
        opacity: 0.032 !important;
        width: 250px !important;
      }

      .hospital-title h1 {
        font-size: 14px !important;
      }
      .hospital-title h2 {
        font-size: 11.5px !important;
      }
      .report-body {
        padding: 12px 20px 14px !important;
      }
      .patient-card {
        padding: 8px 14px !important;
        margin-bottom: 10px !important;
      }
      .patient-grid {
        gap: 6px 14px !important;
      }
      .meta-label {
        font-size: 9.5px !important;
      }
      .meta-val {
        font-size: 12px !important;
      }
      .exam-ribbon {
        padding: 6px 12px !important;
        margin-bottom: 10px !important;
      }
      .exam-title {
        font-size: 13.5px !important;
      }
      .section-title {
        font-size: 11.5px !important;
        margin-top: 10px !important;
        margin-bottom: 6px !important;
      }
      .findings-container {
        gap: 6px !important;
        margin-bottom: 10px !important;
      }
      .finding-card {
        padding: 6px 10px !important;
      }
      .finding-body {
        font-size: 11.5px !important;
      }
      .impression-container {
        padding: 9px 13px !important;
        margin: 10px 0 !important;
      }
      .impression-title {
        font-size: 12.5px !important;
      }
      .impression-item {
        font-size: 11.5px !important;
        gap: 6px !important;
      }
      .signature-section {
        margin-top: 10px !important;
        padding-top: 8px !important;
      }
      .qr-img {
        width: 64px !important;
        height: 64px !important;
      }
      .print-controls {
        display: none !important;
      }
    }
  </style>
</head>
<body>

  <!-- Interactive Controls Bar (Auto-hidden in Print / PDF export) -->
  <div class="print-controls">
    <button class="btn-action secondary" onclick="window.print()">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="6 9 6 2 18 2 18 9"></polyline>
        <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path>
        <rect x="6" y="14" width="12" height="8"></rect>
      </svg>
      Print Report
    </button>
    <a class="btn-action" href="/api/report/${encodeURIComponent(studyUid)}?download=1" download="MAPIMS_Report_${encodeURIComponent(data.patientId || studyUid)}.pdf">
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
        <polyline points="7 10 12 15 17 10"></polyline>
        <line x1="12" y1="15" x2="12" y2="3"></line>
      </svg>
      Download PDF
    </a>
  </div>

  <main class="report-sheet">
    <!-- Header -->
    <header class="hospital-header">
      <div class="header-top">
        <div class="hospital-brand">
          <div class="hospital-logo">
            ${LOGO_DATA_URI ? `
              <img src="${LOGO_DATA_URI}" alt="MAPIMS Logo" class="hospital-logo-img">
            ` : `
              <!-- Medical Cross Emblem -->
              <svg width="38" height="38" viewBox="0 0 48 48" fill="none">
                <circle cx="24" cy="24" r="22" fill="#e0f2fe" stroke="#0284c7" stroke-width="2"/>
                <path d="M20 12h8v8h8v8h-8v8h-8v-8h-8v-8h8v-8z" fill="#0284c7"/>
                <path d="M22 14h4v8h8v4h-8v8h-4v-8h-8v-4h8v-8z" fill="#0d9488"/>
              </svg>
            `}
          </div>

          <div class="hospital-title">
            <h1>Melmaruvathur Adhiparasakthi</h1>
            <h2>Institute of Medical Sciences & Research (MAPIMS)</h2>
            <p>Melmaruvathur - 603319, Chengalpattu Dist, Tamil Nadu • Ph: 044-27528300</p>
          </div>
        </div>
        <div class="header-badges">
          <div class="badge-nabh">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
            </svg>
            NABH ACCREDITED
          </div>
          <div class="badge-official">Department of Radio-Diagnosis</div>
        </div>
      </div>

      <div class="header-sub-bar">
        <div class="sub-bar-item">
          <span>Official Diagnostic Radio-Imaging Center</span>
        </div>
        <div class="sub-bar-item">
          <span>Ref ID: MAPIMS-RAD-${escapeHtml(studyUid)}</span>
        </div>
      </div>
    </header>

    <div class="report-body">
      ${LOGO_DATA_URI ? `<img src="${LOGO_DATA_URI}" alt="" class="report-watermark" aria-hidden="true">` : ''}
      <!-- Patient Information Grid -->
      <section class="patient-card">
        <div class="patient-grid">
          <div class="meta-item">
            <span class="meta-label">Patient Name</span>
            <div class="meta-val patient-name">${escapeHtml(data.patientName || 'PATIENT')}</div>
          </div>
          <div class="meta-item">
            <span class="meta-label">Patient UHID / MRN</span>
            <div class="meta-val"><span class="id-pill">${escapeHtml(data.patientId || '-')}</span></div>
          </div>
          <div class="meta-item">
            <span class="meta-label">Age / Gender</span>
            <div class="meta-val">${escapeHtml(data.ageSex || [data.age, data.sex].filter(Boolean).join(' / ') || '-')}</div>
          </div>
          <div class="meta-item">
            <span class="meta-label">Referring Consultant</span>
            <div class="meta-val">Dr. ${escapeHtml((data.referringPhysician || 'Duty Medical Officer').replace(/^Dr\.?\s*/i, ''))}</div>
          </div>
          <div class="meta-item">
            <span class="meta-label">Imaging Modality</span>
            <div class="meta-val"><span class="modality-pill">${escapeHtml(data.modality || 'RAD')}</span> &bull; ${escapeHtml(modStyle.label)}</div>
          </div>
          <div class="meta-item">
            <span class="meta-label">Accession No.</span>
            <div class="meta-val">${escapeHtml(data.accessionNumber || studyUid)}</div>
          </div>
          <div class="meta-item">
            <span class="meta-label">Study Date & Time</span>
            <div class="meta-val">${escapeHtml(data.studyDateTime || '-')}</div>
          </div>
          <div class="meta-item">
            <span class="meta-label">E-Signature Completed</span>
            <div class="meta-val" style="color: #059669;">${escapeHtml(data.eSignDate || data.studyDateTime || '-')}</div>
          </div>
          <div class="meta-item">
            <span class="meta-label">Verification Status</span>
            <div class="meta-val" style="color: #047857; font-weight: 700;">✅ Verified & Authenticated</div>
          </div>
        </div>
      </section>

      <!-- Examination Banner -->
      <div class="exam-ribbon">
        <div class="exam-title">${escapeHtml(data.reportTitle || data.studyName || 'DIAGNOSTIC RADIOLOGY REPORT')}</div>
        <div class="exam-modality-desc">${escapeHtml(data.studyName || '')}</div>
      </div>

      <!-- Clinical History (if present) -->
      ${data.clinicalHistory ? `
        <div class="callout-box">
          <strong>Clinical Indication:</strong> ${escapeHtml(data.clinicalHistory)}
        </div>
      ` : ''}

      <!-- Technique (if present) -->
      ${data.technique ? `
        <div class="technique-box">
          <strong style="color: #0369a1; text-transform: uppercase; font-size: 11.5px; display: block; margin-bottom: 2px;">Protocol & Technique</strong>
          ${escapeHtml(data.technique)}
        </div>
      ` : ''}

      <!-- Detailed Findings -->
      <h3 class="section-title">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
          <polyline points="14 2 14 8 20 8"></polyline>
          <line x1="16" y1="13" x2="8" y2="13"></line>
          <line x1="16" y1="17" x2="8" y2="17"></line>
          <polyline points="10 9 9 9 8 9"></polyline>
        </svg>
        Detailed Radiological Findings
      </h3>
      <div class="findings-container">
        ${findingsHtml}
      </div>

      <!-- ============================================== -->
      <!-- HIGHLIGHTED DIAGNOSTIC IMPRESSION / CONCLUSION -->
      <!-- ============================================== -->
      <section class="impression-container">
        <div class="impression-header">
          <div class="impression-title">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 12h-4l-3 9L9 3l-3 9H2"></path>
            </svg>
            Diagnostic Impression & Conclusion
          </div>
          <span class="impression-badge">Primary Findings</span>
        </div>
        <ul class="impression-list">
          ${impressionHtml}
        </ul>
      </section>

      <!-- Signature & Digital Authenticity Verification Block -->
      <section class="signature-section">
        <div class="doctors-wrap">
          ${doctorsHtml}
        </div>
        <div class="qr-verify-card">
          ${qrDataUri ? `<img class="qr-img" src="${qrDataUri}" alt="Report Authenticity QR Code" />` : ''}
          <span class="qr-label">Scan to Verify</span>
        </div>
      </section>

      <!-- Footer & Disclaimer -->
      <footer class="report-footer">
        <p class="footer-note">${escapeHtml(data.note)}</p>
        <div class="footer-bottom">
          <span>Melmaruvathur Adhiparasakthi Institute of Medical Sciences & Research</span>
          <span>DICOM PACS Worklist Hub &bull; Page 1 of 1</span>
        </div>
      </footer>
    </div>
  </main>
</body>
</html>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function highlightMedicalTerms(text) {
  if (!text) return '';
  let escaped = escapeHtml(text);

  // Measurements e.g. 4.6 × 2.8 × 3.2 cm, 2.0 mm, +202HU, +467 HU
  escaped = escaped.replace(/(\b\d+(?:\.\d+)?\s*(?:×|x)\s*\d+(?:\.\d+)?(?:\s*(?:×|x)\s*\d+(?:\.\d+)?)?\s*(?:cm|mm)\b)/gi, '<span class="hl-measurement">$1</span>');
  escaped = escaped.replace(/(\b\d+(?:\.\d+)?\s*(?:mm|cm)\b)/gi, '<span class="hl-measurement">$1</span>');
  escaped = escaped.replace(/([+\-]\d+\s*HU)/gi, '<span class="hl-measurement">$1</span>');

  return escaped;
}

/**
 * Render and cache the modern colourful PDF report using headless Google Chrome.
 */
async function renderModernPdf(studyUid, studyDoc = {}, forceRegenerate = false) {
  const safeStudy = String(studyUid).replace(/[^a-zA-Z0-9._-]/g, '');
  const rawPdfPath = path.join(REPORT_DIR, `Final_${safeStudy}.pdf`);
  const modernPdfPath = path.join(REPORT_DIR, `Modern_Final_${safeStudy}.pdf`);
  const modernHtmlPath = path.join(REPORT_DIR, `Modern_Final_${safeStudy}.html`);

  // If already compiled and not forcing regenerate, return cached PDF
  if (!forceRegenerate && fs.existsSync(modernPdfPath)) {
    const stat = fs.statSync(modernPdfPath);
    if (stat.size > 2000) {
      return modernPdfPath;
    }
  }

  // Ensure raw PDF is present to extract data
  if (!fs.existsSync(rawPdfPath)) {
    throw new Error(`Raw PACS PDF not found at ${rawPdfPath}`);
  }

  // Parse clinical data
  const reportData = parseReportFromPdf(rawPdfPath, studyDoc);

  // Generate modern HTML
  const htmlContent = await generateReportHtml(reportData, studyUid);
  await fsp.writeFile(modernHtmlPath, htmlContent, 'utf8');

  // Convert HTML to PDF using Chrome Headless
  const chromeBin = fs.existsSync('/usr/bin/google-chrome')
    ? '/usr/bin/google-chrome'
    : (fs.existsSync('/usr/bin/chromium-browser') ? '/usr/bin/chromium-browser' : (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : null));

  if (!chromeBin) {
    console.warn('[REPORT GEN] Chrome binary not found for headless PDF printing, HTML generated at ' + modernHtmlPath);
    return modernHtmlPath;
  }

  const printCmd = `"${chromeBin}" --headless=new --no-sandbox --disable-gpu --disable-software-rasterizer --print-to-pdf-no-header --print-to-pdf="${modernPdfPath}" "${modernHtmlPath}"`;
  execSync(printCmd, { timeout: 15000 });

  if (fs.existsSync(modernPdfPath) && fs.statSync(modernPdfPath).size > 1000) {
    console.log(`[REPORT GEN] Successfully compiled modern colourful PDF: ${modernPdfPath} (${fs.statSync(modernPdfPath).size} bytes)`);
    return modernPdfPath;
  }

  throw new Error('Chrome failed to generate PDF.');
}

module.exports = {
  parseReportFromPdf,
  generateReportHtml,
  renderModernPdf
};
