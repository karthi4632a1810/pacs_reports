const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execSync, spawn } = require('child_process');
const QRCode = require('qrcode');

const REPORT_DIR = path.join(__dirname, 'storage/reports');

// Pre-load official hospital logo as Base64 Data URI for instant zero-latency embedding
let LOGO_DATA_URI = '';
function getLogoDataUri() {
  if (LOGO_DATA_URI) return LOGO_DATA_URI;
  const logoCandidates = [
    path.join(__dirname, 'logo.png'),
    path.join(__dirname, 'public/logo.png'),
    path.join(__dirname, '../logo.png'),
    '/app/logo.png',
    '/app/public/logo.png',
    '/usr/share/nginx/html/logo.png'
  ];
  for (const candidate of logoCandidates) {
    try {
      if (fs.existsSync(candidate)) {
        const logoBuf = fs.readFileSync(candidate);
        LOGO_DATA_URI = `data:image/png;base64,${logoBuf.toString('base64')}`;
        console.log(`[ReportGen] Loaded hospital logo from ${candidate} (${logoBuf.length} bytes)`);
        return LOGO_DATA_URI;
      }
    } catch (e) {
      console.warn(`[ReportGen] Could not read logo at ${candidate}:`, e.message);
    }
  }
  return '';
}
getLogoDataUri();

// Pre-load official NABL logo as Base64 Data URI for instant zero-latency embedding
let NABL_DATA_URI = '';
function getNablDataUri() {
  if (NABL_DATA_URI) return NABL_DATA_URI;
  const nablCandidates = [
    path.join(__dirname, 'nabl.png'),
    path.join(__dirname, 'public/nabl.png'),
    path.join(__dirname, '../nabl.png'),
    '/app/nabl.png',
    '/app/public/nabl.png',
    '/home/itmapims/KARTHI APPS/OP lab reports/server/src/assets/nabl.png'
  ];
  for (const candidate of nablCandidates) {
    try {
      if (fs.existsSync(candidate)) {
        const nablBuf = fs.readFileSync(candidate);
        NABL_DATA_URI = `data:image/png;base64,${nablBuf.toString('base64')}`;
        console.log(`[ReportGen] Loaded NABL logo from ${candidate} (${nablBuf.length} bytes)`);
        return NABL_DATA_URI;
      }
    } catch (e) {
      console.warn(`[ReportGen] Could not read NABL logo at ${candidate}:`, e.message);
    }
  }
  return '';
}
getNablDataUri();

// Pre-load Noto Sans Tamil font as Base64 Data URI for instant offline Tamil rendering
let TAMIL_FONT_BASE64 = '';
try {
  const fontCandidates = [
    path.join(__dirname, 'fonts/NotoSansTamil-Regular.ttf'),
    '/usr/share/fonts/truetype/noto/NotoSansTamil-Regular.ttf'
  ];
  for (const candidate of fontCandidates) {
    if (fs.existsSync(candidate)) {
      TAMIL_FONT_BASE64 = fs.readFileSync(candidate).toString('base64');
      break;
    }
  }
} catch (e) {
  console.warn('[ReportGen] Could not load NotoSansTamil font:', e.message);
}

let settingsManager = null;
try {
  settingsManager = require('./settingsManager');
} catch (e) {}

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
 * Format standard patient PDF download filename: PatientName_PatientID.pdf
 */
function formatReportFilename(patientName, patientId, defaultStudy = 'Document') {
  let name = (patientName || '')
    .trim()
    .replace(/\^/g, ' ')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '_');

  let id = (patientId || '')
    .trim()
    .replace(/[^\w-]/g, '');

  if (name && id) {
    return `${name}_${id}.pdf`;
  } else if (name) {
    return `${name}.pdf`;
  } else if (id) {
    return `Patient_${id}.pdf`;
  }
  const cleanStudy = String(defaultStudy).replace(/[^a-zA-Z0-9_-]/g, '');
  return `Report_${cleanStudy || 'Patient'}.pdf`;
}

/**
 * Generate a colourful, hospital-grade HTML template for printing / viewing / PDF export.
 */
async function generateReportHtml(data, studyUid, publicViewUrl = '', customOptions = null) {
  const globalTpl = settingsManager ? settingsManager.getSettingsSync().reportTemplate : {};
  const opts = { ...globalTpl, ...(customOptions || {}) };

  const hospitalName = opts.hospitalName || 'Melmaruvathur Adhiparasakthi';
  const hospitalSubtitle = opts.departmentName || 'Institute of Medical Sciences & Research (MAPIMS)';
  const primaryColor = opts.primaryColor || '#991b1b';
  const accentColor = opts.accentColor || '#fbb714';
  const showDisclaimerCard = opts.showDisclaimerCard !== false;
  const showQrCode = opts.showQrCode === true;
  const disclaimerEn = opts.disclaimerEn || 'CONFIDENTIAL MEDICAL DOCUMENT: This diagnostic imaging report and associated clinical impressions are prepared solely for the designated patient and referring medical practitioner. The interpretations are based on radio-pathological imaging findings at the time of examination and must be clinically correlated with patient symptoms, physical examination, laboratory investigations, and clinical history. Not valid for medico-legal purposes unless countersigned by an authorized medical authority.';
  const disclaimerTa = opts.disclaimerTa || 'இது கணினி மூலம் உருவாக்கப்பட்ட பரிசோதனை அறிக்கைச் சுருக்கம்; தகவலுக்காக மட்டுமே வாட்ஸ்அப் மூலம் அனுப்பப்படுகிறது. இது சட்டப்பூர்வ ஆவணம் அல்ல. அங்கீகரிக்கப்பட்ட மருத்துவரால் கையொப்பமிடப்பட்ட அறிக்கையே இறுதியானது. முடிவுகளை உங்கள் சிகிச்சை மருத்துவரிடம் கலந்தாலோசித்து அறிந்து கொள்ளவும். இந்த டிஜிட்டல் பிரதியை சட்ட, காப்பீடு அல்லது வேறு எந்த கோரிக்கைகளுக்கும் பயன்படுத்த இயலாது';

  const currentLogo = getLogoDataUri() || LOGO_DATA_URI;
  const currentNabl = getNablDataUri() || NABL_DATA_URI;

  // Modality colors tuned to MAPIMS Crimson & Gold theme
  const modalityColors = {
    CT: { bg: '#fff1f2', text: '#991b1b', border: '#fecdd3', label: 'Computed Tomography (CT)' },
    MR: { bg: '#fef3c7', text: '#92400e', border: '#fde68a', label: 'Magnetic Resonance Imaging (MRI)' },
    CR: { bg: '#fffbeb', text: '#78350f', border: '#fcd34d', label: 'Digital Radiography (X-Ray)' },
    DX: { bg: '#fffbeb', text: '#78350f', border: '#fcd34d', label: 'Digital Radiography (DX)' },
    US: { bg: '#fff7ed', text: '#c2410c', border: '#fed7aa', label: 'Ultrasound Sonography (USG)' }
  };
  const modStyle = modalityColors[data.modality] || { bg: '#fffdfa', text: '#78350f', border: '#fde68a', label: data.modality || 'Diagnostic Imaging' };

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

  const downloadPdfFilename = formatReportFilename(data.patientName, data.patientId, studyUid);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Diagnostic Report - ${escapeHtml(data.patientName || 'Patient')} (${escapeHtml(data.patientId || studyUid)})</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+Tamil:wght@400;500;600;700&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap');

    ${TAMIL_FONT_BASE64 ? `
    @font-face {
      font-family: 'Noto Sans Tamil Local';
      src: url('data:font/truetype;charset=utf-8;base64,${TAMIL_FONT_BASE64}') format('truetype');
      font-weight: 400 700;
      font-style: normal;
    }
    ` : ''}

    :root {
      --primary: #991b1b;         /* Deep MAPIMS Crimson */
      --primary-dark: #7f1d1d;    /* Imperial Maroon */
      --primary-crimson: #ed0c1a; /* Logo Sacred Flame Red */
      --accent-gold: #fbb714;     /* Logo Caduceus & Sun Gold */
      --accent-amber: #d97706;    /* Warm Amber */
      --accent-honey: #b45309;    /* Deep Honey Gold */
      --surface: #ffffff;
      --bg-page: #fafaf9;
      --border-light: #fde68a;
      --text-main: #1c1917;       /* Warm Charcoal */
      --text-muted: #57534e;
      --text-sub: #78716c;
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
      background: #f5f5f4;
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
      box-shadow: 0 10px 30px rgba(127, 29, 29, 0.08);
      overflow: hidden;
      border: 1px solid #fed7aa;
      position: relative;
    }

    /* Hospital Header Banner - MAPIMS Sacred Red & Gold */
    .hospital-header {
      background: linear-gradient(135deg, #450a0a 0%, #7f1d1d 38%, #991b1b 72%, #b45309 100%);
      color: #ffffff;
      padding: 18px 24px 14px;
      position: relative;
      border-bottom: 3.5px solid #fbb714;
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
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.25);
      flex-shrink: 0;
      border: 1.5px solid #fbb714;
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
      font-weight: 700;
      color: #fde047;
      margin-top: 2px;
      letter-spacing: 0.1px;
    }

    .hospital-title p {
      font-size: 10.5px;
      color: #fef08a;
      margin-top: 2px;
      opacity: 0.95;
    }

    .header-badges {
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 5px;
      flex-shrink: 0;
    }

    .badge-nabl-wrap {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      background: #ffffff;
      padding: 2px 6px;
      border-radius: 6px;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
    }

    .badge-nabl-img {
      height: 38px;
      width: auto;
      object-fit: contain;
      display: block;
    }

    .badge-nabh,
    .badge-nabl {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: rgba(251, 183, 20, 0.22);
      backdrop-filter: blur(8px);
      border: 1px solid #fbb714;
      padding: 3px 9px;
      border-radius: 999px;
      font-size: 10.5px;
      font-weight: 700;
      color: #fef08a;
    }

    .badge-official {
      background: #fbb714;
      color: #7f1d1d;
      padding: 3px 8px;
      border-radius: 5px;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.2);
    }

    /* Sub-header Bar */
    .header-sub-bar {
      margin-top: 12px;
      padding-top: 10px;
      border-top: 1px solid rgba(251, 183, 20, 0.35);
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-size: 11px;
      color: #fef08a;
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
      background: #fffdfa;
      border: 1px solid #fde68a;
      border-left: 4.5px solid #b91c1c;
      border-radius: 10px;
      padding: 12px 18px;
      margin-bottom: 16px;
      box-shadow: 0 2px 8px rgba(180, 83, 9, 0.05);
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
      color: #78716c;
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
      color: #991b1b;
    }

    .id-pill {
      background: #fef3c7;
      color: #92400e;
      border: 1px solid #fcd34d;
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
      background: linear-gradient(90deg, #fff1f2 0%, #fffbeb 55%, #ffffff 100%);
      border-left: 4.5px solid #b91c1c;
      border-radius: 0 8px 8px 0;
      padding: 10px 16px;
      margin-bottom: 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      box-shadow: 0 1px 4px rgba(185, 28, 28, 0.04);
    }

    .exam-title {
      font-size: 16px;
      font-weight: 800;
      color: #7f1d1d;
      letter-spacing: 0.2px;
      text-transform: uppercase;
    }

    .exam-modality-desc {
      font-size: 11.5px;
      font-weight: 700;
      color: #b45309;
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
      color: #991b1b;
      margin-top: 20px;
      margin-bottom: 10px;
      border-bottom: 1.5px solid #fecdd3;
      padding-bottom: 5px;
    }

    .section-title svg {
      width: 17px;
      height: 17px;
      color: #ed0c1a;
    }

    /* Callout Boxes (History / Technique) */
    .callout-box {
      background: #fffbeb;
      border: 1px solid #fde68a;
      border-left: 3.5px solid #f59e0b;
      border-radius: 4px 8px 8px 4px;
      padding: 10px 14px;
      margin-bottom: 16px;
      font-size: 12.5px;
      color: #78350f;
      line-height: 1.5;
    }

    .technique-box {
      background: #fffdfa;
      border: 1px solid #fed7aa;
      border-left: 3.5px solid #ea580c;
      border-radius: 4px 8px 8px 4px;
      padding: 10px 14px;
      margin-bottom: 16px;
      font-size: 12.5px;
      color: #431407;
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
      border: 1px solid #fed7aa;
      border-left: 3.5px solid #d97706;
      border-radius: 8px;
      padding: 9px 13px;
      box-shadow: 0 1px 4px rgba(217, 119, 6, 0.04);
      page-break-inside: avoid;
    }

    .finding-card.plain {
      border-left: 3.5px solid #b91c1c;
    }

    .finding-tag {
      display: inline-block;
      font-size: 11.5px;
      font-weight: 800;
      color: #991b1b;
      text-transform: uppercase;
      letter-spacing: 0.3px;
      background: #fff1f2;
      border: 1px solid #fecdd3;
      padding: 2px 8px;
      border-radius: 5px;
      margin-bottom: 4px;
    }

    .finding-body {
      font-size: 12.5px;
      color: #1c1917;
      line-height: 1.5;
    }

    /* Clinical Terms Highlight */
    .hl-abnormal {
      background: #fef2f2;
      color: #991b1b;
      font-weight: 700;
      padding: 1px 4px;
      border-radius: 3px;
    }

    .hl-normal {
      color: #15803d;
      font-weight: 600;
    }

    .hl-measurement {
      font-family: 'JetBrains Mono', monospace;
      font-weight: 700;
      color: #b91c1c;
    }

    /* ========================================= */
    /* THE HERO DIAGNOSTIC IMPRESSION CALLOUT    */
    /* ========================================= */
    .impression-container {
      background: linear-gradient(135deg, #fffbeb 0%, #fff7ed 60%, #fff1f2 100%);
      border: 2px solid #f59e0b;
      border-left: 5px solid #b91c1c;
      border-radius: 10px;
      padding: 12px 16px;
      margin: 14px 0;
      box-shadow: 0 4px 16px rgba(185, 28, 28, 0.08);
      page-break-inside: avoid;
    }

    .impression-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 8px;
      padding-bottom: 6px;
      border-bottom: 1.5px solid #fed7aa;
    }

    .impression-title {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 13.5px;
      font-weight: 800;
      color: #7f1d1d;
      text-transform: uppercase;
      letter-spacing: 0.4px;
    }

    .impression-title svg {
      width: 18px;
      height: 18px;
      color: #ed0c1a;
    }

    .impression-badge {
      background: #b91c1c;
      color: #ffffff;
      font-size: 9.5px;
      font-weight: 800;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 2px 8px;
      border-radius: 999px;
      box-shadow: 0 2px 4px rgba(185, 28, 28, 0.25);
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
      color: #451a03;
    }

    .impression-bullet {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: #ed0c1a;
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
      border-top: 1.5px solid #fed7aa;
      page-break-inside: avoid;
    }

    .doctors-wrap {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      width: 100%;
      gap: 20px;
    }

    .doctor-seal-card {
      min-width: 220px;
    }

    .doctor-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: #fffbeb;
      color: #b45309;
      border: 1px solid #fde68a;
      padding: 2px 7px;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 700;
      margin-bottom: 5px;
    }

    .verified-icon {
      width: 12px;
      height: 12px;
      color: #b45309;
    }

    .doctor-name {
      font-size: 13.5px;
      font-weight: 800;
      color: #1c1917;
    }

    .doctor-designation {
      font-size: 11.5px;
      font-weight: 600;
      color: #57534e;
      margin-top: 1px;
    }

    .doctor-reg {
      font-size: 11px;
      font-weight: 700;
      color: #b91c1c;
      font-family: 'JetBrains Mono', monospace;
      margin-top: 2px;
    }

    .doctor-seal-card.resident-seal {
      border-left: 2px dashed #fed7aa;
      padding-left: 14px;
    }

    .resident-title {
      font-size: 10px;
      font-weight: 700;
      color: #78716c;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 3px;
    }

    .resident-names {
      font-size: 11.5px;
      font-weight: 600;
      color: #57534e;
    }

    /* Bilingual WhatsApp Diagnostic Disclaimer Card */
    .disclaimer-card {
      background: #ffffff;
      border: 1px solid #fecaca;
      border-left: 4.5px solid #db2a2a;
      border-radius: 8px;
      padding: 9px 13px 8px;
      margin-top: 14px;
      page-break-inside: avoid;
      box-shadow: 0 1px 4px rgba(219, 42, 42, 0.04);
    }

    .disclaimer-head {
      display: flex;
      align-items: center;
      gap: 7px;
      margin-bottom: 5px;
    }

    .disclaimer-pill {
      background: #fee2e2;
      color: #db2a2a;
      border: 1px solid #fca5a5;
      padding: 1.5px 7px;
      border-radius: 4px;
      font-size: 10px;
      font-weight: 800;
      letter-spacing: 0.5px;
      text-transform: uppercase;
      line-height: 1.2;
    }

    .disclaimer-bullet {
      color: #982121;
      font-size: 11px;
      font-weight: 700;
    }

    .disclaimer-title {
      color: #982121;
      font-size: 10.5px;
      font-weight: 800;
      letter-spacing: 0.4px;
      text-transform: uppercase;
      line-height: 1.2;
    }

    .disclaimer-en {
      font-size: 10px;
      color: #4a576a;
      line-height: 1.45;
      margin: 0;
    }

    .disclaimer-divider {
      border: none;
      border-top: 1px dashed #fca5a5;
      margin: 6px 0 5px;
    }

    .disclaimer-ta {
      font-size: 9.5px;
      color: #802626;
      line-height: 1.5;
      font-family: 'Noto Sans Tamil Local', 'Noto Sans Tamil', 'Plus Jakarta Sans', system-ui, sans-serif;
      margin: 0;
    }

    /* Disclaimer & Footer */
    .report-footer {
      margin-top: 14px;
      padding-top: 10px;
      border-top: 1px dashed #fed7aa;
      font-size: 11px;
      color: #78716c;
      line-height: 1.45;
      display: flex;
      flex-direction: column;
      gap: 5px;
      page-break-inside: avoid;
    }

    .footer-note {
      font-style: italic;
    }

    .footer-bottom {
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: #a8a29e;
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
      background: #b91c1c;
      color: #ffffff;
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 12.5px;
      font-weight: 700;
      text-decoration: none;
      cursor: pointer;
      border: none;
      box-shadow: 0 4px 12px rgba(185, 28, 28, 0.25);
      transition: all 0.2s ease;
    }

    .btn-action:hover {
      background: #991b1b;
      transform: translateY(-1px);
    }

    .btn-action.secondary {
      background: #ffffff;
      color: #1c1917;
      border: 1px solid #fed7aa;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.05);
    }

    .btn-action.secondary:hover {
      background: #fffdfa;
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
        padding: 11px 18px 8px !important;
      }
      .hospital-logo {
        width: 38px !important;
        height: 46px !important;
        padding: 2px !important;
      }
      .hospital-logo-img {
        max-width: 100% !important;
        max-height: 100% !important;
      }
      .badge-nabl-img {
        height: 32px !important;
      }
      .report-watermark {
        opacity: 0.032 !important;
        width: 250px !important;
      }

      .hospital-title h1 {
        font-size: 13.5px !important;
      }
      .hospital-title h2 {
        font-size: 11px !important;
      }
      .report-body {
        padding: 9px 18px 10px !important;
      }
      .patient-card {
        padding: 6px 12px !important;
        margin-bottom: 6px !important;
      }
      .patient-grid {
        gap: 4px 12px !important;
      }
      .meta-label {
        font-size: 9px !important;
      }
      .meta-val {
        font-size: 11.5px !important;
      }
      .exam-ribbon {
        padding: 5px 10px !important;
        margin-bottom: 6px !important;
      }
      .exam-title {
        font-size: 13px !important;
      }
      .section-title {
        font-size: 11px !important;
        margin-top: 6px !important;
        margin-bottom: 4px !important;
      }
      .findings-container {
        gap: 4px !important;
        margin-bottom: 6px !important;
      }
      .finding-card {
        padding: 4px 8px !important;
      }
      .finding-body {
        font-size: 11px !important;
      }
      .impression-container {
        padding: 6px 10px !important;
        margin: 6px 0 !important;
      }
      .impression-title {
        font-size: 12px !important;
      }
      .impression-item {
        font-size: 11px !important;
        gap: 5px !important;
      }
      .signature-section {
        margin-top: 6px !important;
        padding-top: 4px !important;
      }
      .disclaimer-card {
        padding: 6px 10px 5px !important;
        margin-top: 8px !important;
        border-radius: 6px !important;
        border-left-width: 4px !important;
      }
      .disclaimer-head {
        gap: 5px !important;
        margin-bottom: 3px !important;
      }
      .disclaimer-pill {
        font-size: 8.5px !important;
        padding: 1px 5px !important;
      }
      .disclaimer-bullet {
        font-size: 9px !important;
      }
      .disclaimer-title {
        font-size: 9px !important;
      }
      .disclaimer-en {
        font-size: 8.5px !important;
        line-height: 1.35 !important;
      }
      .disclaimer-divider {
        margin: 4px 0 !important;
      }
      .disclaimer-ta {
        font-size: 8px !important;
        line-height: 1.38 !important;
      }
      .report-footer {
        margin-top: 6px !important;
        padding-top: 5px !important;
        font-size: 9px !important;
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
    <a class="btn-action" href="/reports/study/${encodeURIComponent(studyUid)}/${encodeURIComponent(downloadPdfFilename)}?download=1" download="${escapeHtml(downloadPdfFilename)}" title="Download ${escapeHtml(downloadPdfFilename)}">
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
            ${currentLogo ? `
              <img src="${currentLogo}" alt="MAPIMS Logo" class="hospital-logo-img">
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
            <h1>${escapeHtml(hospitalName)}</h1>
            <h2>${escapeHtml(hospitalSubtitle)}</h2>
            <p>Melmaruvathur - 603319, Chengalpattu Dist, Tamil Nadu • Ph: 044-27528300</p>
          </div>
        </div>
        <div class="header-badges">
          ${currentNabl ? `
            <div class="badge-nabl-wrap" title="NABL Accredited">
              <img src="${currentNabl}" alt="NABL Accredited" class="badge-nabl-img">
            </div>
          ` : `
            <div class="badge-nabl">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/>
              </svg>
              NABL ACCREDITED
            </div>
          `}
          <div class="badge-official">Department of Radio-Diagnosis</div>
        </div>
      </div>

      <div class="header-sub-bar">
        <div class="sub-bar-item">
          <span>Official Diagnostic Radio-Imaging Center</span>
        </div>
      </div>
    </header>

    <div class="report-body">
      ${currentLogo ? `<img src="${currentLogo}" alt="" class="report-watermark" aria-hidden="true">` : ''}
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
            <span class="meta-label">Study Date & Time</span>
            <div class="meta-val">${escapeHtml(data.studyDateTime || '-')}</div>
            ${data.eSignDate && data.eSignDate !== data.studyDateTime ? `
              <div style="font-size: 11px; color: #b91c1c; font-weight: 700; margin-top: 2px;">
                Verified: ${escapeHtml(data.eSignDate)}
              </div>
            ` : ''}
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
          <strong style="color: #b91c1c; text-transform: uppercase; font-size: 11.5px; display: block; margin-bottom: 2px;">Protocol & Technique</strong>
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

      <!-- Signature & Authenticity Block -->
      <section class="signature-section">
        <div class="doctors-wrap">
          ${doctorsHtml}
        </div>
      </section>

      ${showDisclaimerCard ? `
      <!-- Bilingual WhatsApp Diagnostic Disclaimer Card -->
      <aside class="disclaimer-card">
        <div class="disclaimer-head">
          <span class="disclaimer-pill">DISCLAIMER</span>
          <span class="disclaimer-bullet">&bull;</span>
          <span class="disclaimer-title">DIAGNOSTIC NOTICE &amp; LEGAL ADVISORY</span>
        </div>
        <p class="disclaimer-en">
          ${escapeHtml(disclaimerEn)}
        </p>
        <div class="disclaimer-divider"></div>
        <p class="disclaimer-ta">
          ${escapeHtml(disclaimerTa)}
        </p>
      </aside>
      ` : ''}

      <!-- Footer & Note -->
      <footer class="report-footer">
        <p class="footer-note">${escapeHtml(data.note)}</p>
        <div class="footer-bottom">
          <span>Melmaruvathur Adhiparasakthi Institute of Medical Sciences &amp; Research</span>
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
  renderModernPdf,
  formatReportFilename
};
