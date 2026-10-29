require('dotenv').config();
const { upsertStudies, getMongoStats, connectDB } = require('../db');

const PACS_HOST = process.env.PACS_HOST || 'http://192.168.101.224';

function formatDate(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Parse CLI flags
function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    days: 30,
    from: null,
    to: null,
    chunkDays: 5,
    limitPerBatch: 2000
  };

  args.forEach(arg => {
    if (arg.startsWith('--days=')) {
      options.days = parseInt(arg.split('=')[1], 10);
    } else if (arg.startsWith('--from=')) {
      options.from = arg.split('=')[1];
    } else if (arg.startsWith('--to=')) {
      options.to = arg.split('=')[1];
    } else if (arg.startsWith('--chunk=')) {
      options.chunkDays = parseInt(arg.split('=')[1], 10);
    } else if (arg === '--all') {
      options.days = 365; // Crawl full year
    }
  });

  if (!options.from) {
    const today = new Date();
    const fromDate = new Date();
    fromDate.setDate(today.getDate() - options.days + 1);
    options.from = formatDate(fromDate);
    options.to = formatDate(today);
  } else if (!options.to) {
    options.to = formatDate(new Date());
  }

  return options;
}

async function fetchPacsChunk(dFrom, dTo, limit) {
  const url = `${PACS_HOST}/api_pacs.asp?from=${encodeURIComponent(dFrom)}&to=${encodeURIComponent(dTo)}&limit=${limit}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    return json;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

async function syncAllPatients() {
  const options = parseArgs();
  console.log('====================================================');
  console.log('   MAPIMS PACS -> MongoDB Patient Metadata Ingest  ');
  console.log('====================================================');
  console.log(`PACS Server Target: ${PACS_HOST}`);
  console.log(`Sync Date Range   : ${options.from} to ${options.to}`);
  console.log(`Batch Chunk Size  : ${options.chunkDays} days per query`);
  console.log('----------------------------------------------------');

  const database = await connectDB();
  if (!database) {
    console.error('ERROR: Could not establish connection to local MongoDB!');
    console.error('Make sure container pacs-mongo-db is running on port 3009.');
    process.exit(1);
  }

  const startDate = new Date(options.from);
  const endDate = new Date(options.to);

  let currentStart = new Date(startDate);
  let totalSaved = 0;
  let totalModified = 0;
  let totalBatches = 0;
  let errorsCount = 0;

  // Split into chunks of chunkDays
  const dateIntervals = [];
  while (currentStart <= endDate) {
    let currentEnd = new Date(currentStart);
    currentEnd.setDate(currentStart.getDate() + options.chunkDays - 1);
    if (currentEnd > endDate) {
      currentEnd = new Date(endDate);
    }
    dateIntervals.push({
      from: formatDate(currentStart),
      to: formatDate(currentEnd)
    });
    currentStart.setDate(currentStart.getDate() + options.chunkDays);
  }

  console.log(`Total query intervals: ${dateIntervals.length}`);

  for (let i = 0; i < dateIntervals.length; i++) {
    const interval = dateIntervals[i];
    process.stdout.write(`[${i + 1}/${dateIntervals.length}] Syncing ${interval.from} to ${interval.to}... `);

    try {
      const response = await fetchPacsChunk(interval.from, interval.to, options.limitPerBatch);
      if (response && response.success && Array.isArray(response.data)) {
        const studies = response.data;
        const res = await upsertStudies(studies);
        totalSaved += res.upsertedCount;
        totalModified += res.modifiedCount;
        totalBatches++;

        console.log(`✓ Fetched ${studies.length} studies (Upserted: +${res.upsertedCount}, Updated: ${res.modifiedCount})`);
      } else {
        console.log(`⚠ No records found or invalid response.`);
      }
    } catch (err) {
      errorsCount++;
      console.log(`✗ Error: ${err.message}`);
    }

    // Small courteous pause to avoid flooding IIS / SQL Server
    await new Promise(r => setTimeout(r, 200));
  }

  // Update sync status record in Mongo
  const syncCol = database.collection('sync_status');
  await syncCol.updateOne(
    { key: 'global_pacs_sync' },
    {
      $set: {
        lastSyncAt: new Date(),
        dateRange: { from: options.from, to: options.to },
        totalSaved,
        totalModified,
        errorsCount,
        status: 'completed'
      }
    },
    { upsert: true }
  );

  // Fetch final stats
  console.log('----------------------------------------------------');
  console.log('Aggregating final MongoDB metrics...');
  const stats = await getMongoStats();
  console.log('====================================================');
  console.log('   🎉 SYNC COMPLETE! MongoDB Database Summary:     ');
  console.log('====================================================');
  console.log(`Total Master Patients Stored : ${stats.totalPatients.toLocaleString()}`);
  console.log(`Total Exam Studies Stored    : ${stats.totalStudies.toLocaleString()}`);
  console.log(`Database Name                : ${stats.database}`);
  console.log(`Local Compass Connection URI : ${stats.compassUri}`);
  console.log(`LAN Compass Connection URI   : ${stats.compassLanUri}`);
  console.log('Modalities in DB:');
  Object.keys(stats.modalities || {}).forEach(m => {
    console.log(`  - ${m}: ${stats.modalities[m].count.toLocaleString()} exams (${stats.modalities[m].images.toLocaleString()} slices)`);
  });
  console.log('====================================================');
  console.log('How to view in MongoDB Compass:');
  console.log('1. Open MongoDB Compass application.');
  console.log(`2. Paste connection string: ${stats.compassUri}`);
  console.log(`3. Click "Connect".`);
  console.log(`4. Open database "pacs_db" -> collections "patients" or "studies".`);
  console.log('====================================================');

  process.exit(0);
}

syncAllPatients().catch(err => {
  console.error('Fatal error during sync:', err);
  process.exit(1);
});
