const Minio = require('minio');

const MINIO_ENDPOINT = process.env.MINIO_ENDPOINT || '127.0.0.1';
const MINIO_PORT = parseInt(process.env.MINIO_PORT || '4009', 10);
const MINIO_USE_SSL = process.env.MINIO_USE_SSL === 'true';
const MINIO_ACCESS_KEY = process.env.MINIO_ACCESS_KEY || 'minioadmin';
const MINIO_SECRET_KEY = process.env.MINIO_SECRET_KEY || 'minioadmin123';
const BUCKET_NAME = process.env.MINIO_BUCKET || 'pacs-dicom';

let minioClient = null;
let isInitialized = false;

function getClient() {
  if (!minioClient) {
    minioClient = new Minio.Client({
      endPoint: MINIO_ENDPOINT,
      port: MINIO_PORT,
      useSSL: MINIO_USE_SSL,
      accessKey: MINIO_ACCESS_KEY,
      secretKey: MINIO_SECRET_KEY,
    });
  }
  return minioClient;
}

// Ensure the target DICOM bucket exists
async function initMinio() {
  try {
    const client = getClient();
    const exists = await client.bucketExists(BUCKET_NAME);
    if (!exists) {
      await client.makeBucket(BUCKET_NAME, 'us-east-1');
      console.log(`[MinIO DICOM] Created bucket '${BUCKET_NAME}' successfully.`);
    } else {
      console.log(`[MinIO DICOM] Verified bucket '${BUCKET_NAME}' exists.`);
    }
    isInitialized = true;
    return true;
  } catch (err) {
    console.warn(`[MinIO DICOM] Init note: ${err.message}`);
    return false;
  }
}

// Upload a single DICOM instance buffer
async function uploadDicomInstance(studyUid, relativeFilename, buffer, meta = {}) {
  try {
    const client = getClient();
    await initMinio();
    const objectKey = `studies/${studyUid}/${relativeFilename}`;
    const metadata = {
      'Content-Type': 'application/dicom',
      'X-Study-Uid': String(studyUid),
      ...meta,
    };
    await client.putObject(BUCKET_NAME, objectKey, buffer, buffer.length, metadata);
    return { success: true, objectKey, size: buffer.length };
  } catch (err) {
    console.error(`[MinIO DICOM] Upload error for ${relativeFilename}:`, err.message);
    throw err;
  }
}

// Stream a single DICOM instance
async function getDicomInstanceStream(objectKey) {
  const client = getClient();
  await initMinio();
  return client.getObject(BUCKET_NAME, objectKey);
}

// Check if an object exists in MinIO
async function statDicomObject(objectKey) {
  try {
    const client = getClient();
    return await client.statObject(BUCKET_NAME, objectKey);
  } catch (err) {
    if (err.code === 'NotFound') return null;
    return null;
  }
}

// List all DICOM objects for a specific study
async function listStudyDicomObjects(studyUid) {
  const client = getClient();
  await initMinio();
  const prefix = `studies/${studyUid}/`;
  const objects = [];

  return new Promise((resolve, reject) => {
    const stream = client.listObjectsV2(BUCKET_NAME, prefix, true);
    stream.on('data', item => objects.push(item));
    stream.on('error', err => reject(err));
    stream.on('end', () => resolve(objects));
  });
}

// Get study DICOM storage summary in MinIO
async function getStudyDicomStatus(studyUid) {
  try {
    const objects = await listStudyDicomObjects(studyUid);
    const totalBytes = objects.reduce((sum, obj) => sum + (obj.size || 0), 0);
    return {
      cached: objects.length > 0,
      studyUid,
      objectCount: objects.length,
      totalBytes,
      totalMb: (totalBytes / (1024 * 1024)).toFixed(2),
      bucket: BUCKET_NAME,
      files: objects.map(o => ({
        name: o.name.replace(`studies/${studyUid}/`, ''),
        size: o.size,
        lastModified: o.lastModified,
      })),
    };
  } catch (err) {
    return {
      cached: false,
      studyUid,
      objectCount: 0,
      totalBytes: 0,
      totalMb: '0.00',
      bucket: BUCKET_NAME,
      error: err.message,
    };
  }
}

// Global MinIO status and storage telemetry
async function getMinioStats() {
  try {
    const client = getClient();
    const isReady = await initMinio();
    if (!isReady) {
      return {
        connected: false,
        endpoint: `${MINIO_ENDPOINT}:${MINIO_PORT}`,
        bucket: BUCKET_NAME,
        totalDicomFiles: 0,
        totalBytes: 0,
        totalMb: '0.00',
      };
    }

    let totalFiles = 0;
    let totalBytes = 0;

    await new Promise((resolve) => {
      const stream = client.listObjectsV2(BUCKET_NAME, 'studies/', true);
      stream.on('data', item => {
        totalFiles++;
        totalBytes += item.size || 0;
      });
      stream.on('error', () => resolve());
      stream.on('end', () => resolve());
    });

    return {
      connected: true,
      endpoint: `${MINIO_ENDPOINT}:${MINIO_PORT}`,
      apiUri: `http://localhost:4009`,
      lanApiUri: `http://192.168.101.130:4009`,
      consoleUri: `http://localhost:5009`,
      lanConsoleUri: `http://192.168.101.130:5009`,
      bucket: BUCKET_NAME,
      totalDicomFiles: totalFiles,
      totalBytes,
      totalMb: (totalBytes / (1024 * 1024)).toFixed(2),
      totalGb: (totalBytes / (1024 * 1024 * 1024)).toFixed(3),
    };
  } catch (err) {
    return {
      connected: false,
      error: err.message,
      endpoint: `${MINIO_ENDPOINT}:${MINIO_PORT}`,
      bucket: BUCKET_NAME,
      totalDicomFiles: 0,
      totalBytes: 0,
    };
  }
}

// Evict oldest DICOM studies in MinIO when quota is exceeded
async function pruneMinioOldestStudies(bytesToFree) {
  try {
    const client = getClient();
    await initMinio();

    const objects = [];
    await new Promise((resolve, reject) => {
      const stream = client.listObjectsV2(BUCKET_NAME, 'studies/', true);
      stream.on('data', item => objects.push(item));
      stream.on('error', err => reject(err));
      stream.on('end', () => resolve());
    });

    if (objects.length === 0) return { studiesPruned: 0, bytesFreed: 0 };

    // Group objects by study UID: studies/<studyUid>/...
    const studyMap = {};
    for (const obj of objects) {
      const parts = obj.name.split('/');
      if (parts.length >= 2) {
        const studyUid = parts[1];
        if (!studyMap[studyUid]) {
          studyMap[studyUid] = {
            studyUid,
            objects: [],
            totalBytes: 0,
            oldestTime: obj.lastModified ? new Date(obj.lastModified).getTime() : Date.now(),
          };
        }
        studyMap[studyUid].objects.push(obj.name);
        studyMap[studyUid].totalBytes += obj.size || 0;
        const mTime = obj.lastModified ? new Date(obj.lastModified).getTime() : Date.now();
        if (mTime < studyMap[studyUid].oldestTime) {
          studyMap[studyUid].oldestTime = mTime;
        }
      }
    }

    // Sort studies oldest first
    const sortedStudies = Object.values(studyMap).sort((a, b) => a.oldestTime - b.oldestTime);

    let freedBytes = 0;
    let prunedCount = 0;

    for (const s of sortedStudies) {
      if (freedBytes >= bytesToFree) break;
      await client.removeObjects(BUCKET_NAME, s.objects);
      freedBytes += s.totalBytes;
      prunedCount++;
      console.log(`[MinIO Quota Eviction] Pruned oldest study ${s.studyUid}: ${s.objects.length} files (${(s.totalBytes / (1024 * 1024)).toFixed(2)} MB freed)`);
    }

    return { studiesPruned: prunedCount, bytesFreed: freedBytes };
  } catch (err) {
    console.error('[MinIO Quota Eviction Error]:', err.message);
    return { studiesPruned: 0, bytesFreed: 0, error: err.message };
  }
}

module.exports = {
  getClient,
  initMinio,
  uploadDicomInstance,
  getDicomInstanceStream,
  statDicomObject,
  listStudyDicomObjects,
  getStudyDicomStatus,
  getMinioStats,
  pruneMinioOldestStudies,
  BUCKET_NAME,
};
