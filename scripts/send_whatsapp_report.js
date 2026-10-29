#!/usr/bin/env node
const https = require('https');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config({ path: path.join(__dirname, '../.env') });

const endpoint = (process.env.API_ENDPOINT || 'https://live-mt-server.wati.io/10190409').replace(/\/+$/, '');
const token = process.env.WATI_ACCESS_TOKEN;
const defaultTemplate = process.env.WATI_TEMPLATE_ID || 'pacs_reports_new';

async function sendWhatsAppReport({ phone, patientName, studyName, patientId, studyDate, pdfUrl, templateName }) {
  if (!token) {
    throw new Error('WATI_ACCESS_TOKEN is not defined in .env');
  }

  const activeTemplate = templateName || defaultTemplate;
  let formattedPhone = phone.replace(/[^0-9]/g, '');
  if (formattedPhone.length === 10) {
    formattedPhone = `91${formattedPhone}`;
  }

  if (!pdfUrl) {
    throw new Error(`[WATI ERROR] Cannot dispatch WhatsApp report for Patient ${patientId || '-'}: No PDF URL provided. Strict Final PDF policy prohibits sending empty or fallback documents.`);
  }

  console.log(`[WATI PDF ATTACHMENT] Dispatching actual patient report from: ${pdfUrl}`);

  const payload = {
    template_name: activeTemplate,
    broadcast_name: `pacs_report_${patientId || Date.now()}`,
    parameters: [
      { name: 'pdf', value: pdfUrl },
      { name: '1', value: patientName || 'Patient' },
      { name: '2', value: studyName || 'Radiology Investigation' },
      { name: '3', value: patientId || '-' },
      { name: '4', value: studyDate || new Date().toISOString().split('T')[0] }
    ]
  };

  const postData = JSON.stringify(payload);
  const targetUrl = new URL(`${endpoint}/api/v1/sendTemplateMessage?whatsappNumber=${formattedPhone}`);

  return new Promise((resolve, reject) => {
    const options = {
      hostname: targetUrl.hostname,
      path: targetUrl.pathname + targetUrl.search,
      method: 'POST',
      headers: {
        'Authorization': token.startsWith('Bearer ') ? token : `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300 && json.result) {
            resolve({ success: true, statusCode: res.statusCode, data: json });
          } else {
            resolve({ success: false, statusCode: res.statusCode, error: json });
          }
        } catch (e) {
          resolve({ success: false, statusCode: res.statusCode, raw: data });
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.write(postData);
    req.end();
  });
}

// Direct CLI invocation
if (require.main === module) {
  const args = process.argv.slice(2);
  const phone = args[0] || '9551382296';
  const patientName = args[1] || 'JAYARAJ. R 26-M';
  const studyName = args[2] || 'LOW_EXM (Digital X-Ray)';
  const patientId = args[3] || '6159353';
  const studyDate = args[4] || '28-Oct-2026';

  console.log(`[WATI] Sending PACS Report Notification...`);
  console.log(`  Recipient: ${phone}`);
  console.log(`  Patient: ${patientName} (ID: ${patientId})`);
  console.log(`  Study: ${studyName} on ${studyDate}`);

  sendWhatsAppReport({ phone, patientName, studyName, patientId, studyDate })
    .then((res) => {
      if (res.success) {
        console.log(`✅ Success! WhatsApp message delivered to ${phone}.`);
        console.log(`  Message ID: ${res.data.local_message_id || 'Sent'}`);
        console.log(`  Contact Name: ${res.data.contact?.fullName || '-'}`);
      } else {
        console.error(`❌ Failed (Status ${res.statusCode}):`, res.error || res.raw);
      }
    })
    .catch((err) => {
      console.error(`❌ Error sending WhatsApp message:`, err.message);
    });
}

module.exports = { sendWhatsAppReport };
