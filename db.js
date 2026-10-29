const { MongoClient } = require('mongodb');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:3009/pacs_db';
const DB_NAME = 'pacs_db';

let client = null;
let db = null;
let isConnecting = false;

// Initialize MongoDB Connection & Indexes
async function connectDB() {
  if (db) return db;
  if (isConnecting) {
    // Wait for connection
    while (isConnecting) {
      await new Promise(r => setTimeout(r, 100));
    }
    return db;
  }

  isConnecting = true;
  try {
    client = new MongoClient(MONGODB_URI, {
      maxPoolSize: 20,
      minPoolSize: 2,
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000
    });

    await client.connect();
    db = client.db(DB_NAME);
    console.log(`[MongoDB] Connected successfully to ${DB_NAME} at ${MONGODB_URI.split('@').pop()}`);

    // Create Indexes
    await initIndexes(db);
    isConnecting = false;
    return db;
  } catch (err) {
    isConnecting = false;
    console.error(`[MongoDB] Connection failed (${MONGODB_URI}):`, err.message);
    db = null;
    return null;
  }
}

async function initIndexes(database) {
  try {
    const studiesCol = database.collection('studies');
    const patientsCol = database.collection('patients');
    const syncCol = database.collection('sync_status');

    // Studies collection indexes
    await studiesCol.createIndex({ studyUid: 1 }, { unique: true });
    await studiesCol.createIndex({ patientId: 1 });
    await studiesCol.createIndex({ patientName: 1 });
    await studiesCol.createIndex({ studyDate: -1 });
    await studiesCol.createIndex({ modality: 1 });
    await studiesCol.createIndex({ status: 1 });
    await studiesCol.createIndex({ accessionNumber: 1 });
    await studiesCol.createIndex({ studyDate: -1, modality: 1 });

    // Patients collection indexes
    await patientsCol.createIndex({ patientId: 1 }, { unique: true });
    await patientsCol.createIndex({ patientName: 1 });
    await patientsCol.createIndex({ lastStudyDate: -1 });
    await patientsCol.createIndex({ totalImages: -1 });

    // Sync status index
    await syncCol.createIndex({ key: 1 }, { unique: true });

    console.log('[MongoDB] Schema indexes verified and ready.');
  } catch (err) {
    console.warn('[MongoDB] Index creation warning:', err.message);
  }
}

// Bulk Upsert Studies from PACS metadata
async function upsertStudies(studiesList) {
  if (!Array.isArray(studiesList) || studiesList.length === 0) {
    return { upsertedCount: 0, modifiedCount: 0, matchedCount: 0, total: 0 };
  }

  const database = await connectDB();
  if (!database) {
    throw new Error('MongoDB is not connected');
  }

  const studiesCol = database.collection('studies');
  const now = new Date();
  const patientIdsToUpdate = new Set();

  const operations = [];

  for (const s of studiesList) {
    if (!s || !s.studyUid) continue;

    const studyUid = String(s.studyUid).trim();
    const patientId = String(s.patientId || '').trim();
    if (patientId) {
      patientIdsToUpdate.add(patientId);
    }

    const doc = {
      studyUid,
      patientId: patientId || 'UNKNOWN',
      patientName: (s.patientName || 'ANONYMOUS').trim(),
      age: (s.age || '').trim(),
      sex: (s.sex || '').toUpperCase().trim(),
      studyDate: (s.studyDate || '').trim(),
      studyTime: (s.studyTime || '').trim(),
      receivingDate: (s.receivingDate || '').trim(),
      accessionNumber: (s.accessionNumber || '').trim(),
      study: (s.study || '').trim(),
      modality: (s.modality || 'OTHER').toUpperCase().trim(),
      status: (s.status || 'NEW').toUpperCase().trim(),
      referringPhysician: (s.referringPhysician || '').trim(),
      finalizedBy: (s.finalizedBy || '').trim(),
      images: parseInt(s.images, 10) || 1,
      series: parseInt(s.series, 10) || 1,
      institution: (s.institution || 'MAPIMS').trim(),
      manufacturer: (s.manufacturer || '').trim(),
      model: (s.model || '').trim(),
      station: (s.station || '').trim(),
      hasFinalPdf: !!s.hasFinalPdf,
      hasFinalDoc: !!s.hasFinalDoc,
      updatedAt: now
    };

    operations.push({
      updateOne: {
        filter: { studyUid },
        update: {
          $set: doc,
          $setOnInsert: { firstSavedAt: now }
        },
        upsert: true
      }
    });
  }

  let result = { upsertedCount: 0, modifiedCount: 0, matchedCount: 0, total: operations.length };

  if (operations.length > 0) {
    const bulkRes = await studiesCol.bulkWrite(operations, { ordered: false });
    result = {
      upsertedCount: bulkRes.upsertedCount || 0,
      modifiedCount: bulkRes.modifiedCount || 0,
      matchedCount: bulkRes.matchedCount || 0,
      total: operations.length
    };

    // Update patient master profiles asynchronously
    updatePatientProfiles(Array.from(patientIdsToUpdate)).catch(err => {
      console.warn('[MongoDB] Patient profile aggregation notice:', err.message);
    });
  }

  return result;
}

// Recompute and Upsert Master Patient Records for given patientIds
async function updatePatientProfiles(patientIds) {
  if (!patientIds || patientIds.length === 0) return;

  const database = await connectDB();
  if (!database) return;

  const studiesCol = database.collection('studies');
  const patientsCol = database.collection('patients');
  const now = new Date();

  // Aggregate in chunks of 500 patient IDs
  const chunkSize = 500;
  for (let i = 0; i < patientIds.length; i += chunkSize) {
    const chunk = patientIds.slice(i, i + chunkSize);

    const pipeline = [
      { $match: { patientId: { $in: chunk } } },
      { $sort: { studyDate: 1, studyTime: 1 } },
      {
        $group: {
          _id: '$patientId',
          patientName: { $last: '$patientName' },
          age: { $last: '$age' },
          sex: { $last: '$sex' },
          studyCount: { $sum: 1 },
          totalImages: { $sum: '$images' },
          totalSeries: { $sum: '$series' },
          modalities: { $addToSet: '$modality' },
          firstStudyDate: { $first: '$studyDate' },
          lastStudyDate: { $last: '$studyDate' },
          latestStudy: { $last: '$study' },
          latestAccession: { $last: '$accessionNumber' },
          latestModality: { $last: '$modality' },
          latestStatus: { $last: '$status' },
          latestFinalizedBy: { $last: '$finalizedBy' },
          studies: {
            $push: {
              studyUid: '$studyUid',
              accessionNumber: '$accessionNumber',
              modality: '$modality',
              study: '$study',
              studyDate: '$studyDate',
              studyTime: '$studyTime',
              images: '$images',
              status: '$status',
              finalizedBy: '$finalizedBy'
            }
          }
        }
      }
    ];

    const aggregated = await studiesCol.aggregate(pipeline).toArray();
    if (aggregated.length > 0) {
      const patientOps = aggregated.map(p => ({
        updateOne: {
          filter: { patientId: p._id },
          update: {
            $set: {
              patientId: p._id,
              patientName: p.patientName,
              age: p.age,
              sex: p.sex,
              studyCount: p.studyCount,
              totalImages: p.totalImages,
              totalSeries: p.totalSeries,
              modalities: p.modalities,
              firstStudyDate: p.firstStudyDate,
              lastStudyDate: p.lastStudyDate,
              latestStudy: p.latestStudy,
              latestAccession: p.latestAccession,
              latestModality: p.latestModality,
              latestStatus: p.latestStatus,
              latestFinalizedBy: p.latestFinalizedBy,
              studies: p.studies.slice(-20), // Store recent 20 studies in patient profile
              updatedAt: now
            },
            $setOnInsert: { createdAt: now }
          },
          upsert: true
        }
      }));

      await patientsCol.bulkWrite(patientOps, { ordered: false });
    }
  }
}

// Fetch MongoDB Stats for Compass & Dashboard
async function getMongoStats() {
  const database = await connectDB();
  if (!database) {
    return {
      connected: false,
      error: 'MongoDB disconnected',
      compassUri: 'mongodb://localhost:3009/pacs_db'
    };
  }

  try {
    const studiesCol = database.collection('studies');
    const patientsCol = database.collection('patients');
    const syncCol = database.collection('sync_status');

    const [totalStudies, totalPatients, syncDoc] = await Promise.all([
      studiesCol.countDocuments(),
      patientsCol.countDocuments(),
      syncCol.findOne({ key: 'global_pacs_sync' })
    ]);

    // Modality breakdown in mongo
    const modAgg = await studiesCol.aggregate([
      { $group: { _id: '$modality', count: { $sum: 1 }, images: { $sum: '$images' } } },
      { $sort: { count: -1 } }
    ]).toArray();

    return {
      connected: true,
      database: DB_NAME,
      hostUri: MONGODB_URI.replace(/\/\/.*@/, '//'),
      compassUri: 'mongodb://localhost:3009/pacs_db',
      compassLanUri: 'mongodb://192.168.101.130:3009/pacs_db',
      totalStudies,
      totalPatients,
      modalities: modAgg.reduce((acc, m) => {
        acc[m._id] = { count: m.count, images: m.images };
        return acc;
      }, {}),
      lastSyncAt: syncDoc?.lastSyncAt || null,
      syncProgress: syncDoc?.progress || null
    };
  } catch (err) {
    return {
      connected: false,
      error: err.message,
      compassUri: 'mongodb://localhost:3009/pacs_db'
    };
  }
}

// Query patients from MongoDB with pagination
async function queryPatients({ search, modality, dateFrom, dateTo, limit = 50, page = 1 }) {
  const database = await connectDB();
  if (!database) throw new Error('MongoDB not connected');

  const patientsCol = database.collection('patients');
  const query = {};

  if (search) {
    const clean = search.trim();
    query.$or = [
      { patientName: { $regex: clean, $options: 'i' } },
      { patientId: { $regex: clean, $options: 'i' } },
      { latestStudy: { $regex: clean, $options: 'i' } },
      { latestAccession: { $regex: clean, $options: 'i' } }
    ];
  }

  if (modality && modality !== 'ALL') {
    query.modalities = modality.toUpperCase();
  }

  if (dateFrom || dateTo) {
    query.lastStudyDate = {};
    if (dateFrom) query.lastStudyDate.$gte = dateFrom;
    if (dateTo) query.lastStudyDate.$lte = dateTo;
  }

  const skip = (Math.max(1, page) - 1) * limit;
  const [total, patients] = await Promise.all([
    patientsCol.countDocuments(query),
    patientsCol.find(query).sort({ lastStudyDate: -1, totalImages: -1 }).skip(skip).limit(limit).toArray()
  ]);

  return {
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    patients
  };
}

module.exports = {
  connectDB,
  upsertStudies,
  updatePatientProfiles,
  getMongoStats,
  queryPatients,
  MONGODB_URI,
  DB_NAME
};
