const crypto = require('crypto');

const JWT_SECRET = process.env.JWT_SECRET || 'mapims-pacs-connect-secret-jwt-key-2026';
const TOKEN_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

// Role definitions
const ROLES = {
  SUPER_ADMIN: 'super_admin',
  RADIOLOGIST: 'radiologist',
  DOCTOR: 'doctor',
  TECHNICIAN: 'technician',
  STAFF: 'staff',
};

// Granular permissions mapped to each role
const ROLE_PERMISSIONS = {
  super_admin: {
    canViewWorklist: true,
    canOpenViewer: true,
    canViewReports: true,
    canDownloadDicom: true,
    canViewSeriesThumbs: true,
    canAccessStorageStats: true,
    canPruneStorage: true,
    canSyncMongo: true,
    canManageUsers: true,
    badgeColor: '#f59e0b', // Amber
    badgeText: 'SUPER ADMIN',
    title: 'Super Administrator',
    description: 'Full unconstrained administrative and clinical access across PACS, storage, reports, and sync engines.'
  },
  radiologist: {
    canViewWorklist: true,
    canOpenViewer: true,
    canViewReports: true,
    canDownloadDicom: true,
    canViewSeriesThumbs: true,
    canAccessStorageStats: false,
    canPruneStorage: false,
    canSyncMongo: false,
    canManageUsers: false,
    badgeColor: '#a855f7', // Purple
    badgeText: 'RADIOLOGIST',
    title: 'Consultant Radiologist',
    description: 'Full diagnostic imaging access, ZeroFootprint web viewer, diagnostic reports, and DICOM downloads.'
  },
  doctor: {
    canViewWorklist: true,
    canOpenViewer: true,
    canViewReports: true,
    canDownloadDicom: false,
    canViewSeriesThumbs: true,
    canAccessStorageStats: false,
    canPruneStorage: false,
    canSyncMongo: false,
    canManageUsers: false,
    badgeColor: '#10b981', // Emerald
    badgeText: 'DOCTOR / PHYSICIAN',
    title: 'Referring Physician',
    description: 'Clinical patient review, ZeroFootprint viewer, and finalized diagnostic report inspection.'
  },
  technician: {
    canViewWorklist: true,
    canOpenViewer: true,
    canViewReports: false,
    canDownloadDicom: false,
    canViewSeriesThumbs: true,
    canAccessStorageStats: false,
    canPruneStorage: false,
    canSyncMongo: false,
    canManageUsers: false,
    badgeColor: '#06b6d4', // Cyan
    badgeText: 'TECHNICIAN',
    title: 'Radiographer / Technician',
    description: 'Modality intake, slice verification, image count inspection, and scan quality viewer checks.'
  },
  staff: {
    canViewWorklist: true,
    canOpenViewer: false,
    canViewReports: false,
    canDownloadDicom: false,
    canViewSeriesThumbs: false,
    canAccessStorageStats: false,
    canPruneStorage: false,
    canSyncMongo: false,
    canManageUsers: false,
    badgeColor: '#64748b', // Slate
    badgeText: 'STAFF / RECEPTION',
    title: 'Hospital Staff / View Only',
    description: 'Worklist inquiry, patient search, and report completion status overview.'
  }
};

// Default seed users (Hybrid: Existing PACS server credentials + hospital role accounts)
const DEFAULT_USERS = [
  {
    username: 'pacs',
    password: 'PacsMed12@#',
    name: 'PACS Super Admin',
    role: 'super_admin',
    department: 'PACS & IT Administration',
    email: 'pacsadmin@mapims.com'
  },
  {
    username: 'admin',
    password: 'admin123',
    name: 'Hospital IT Administrator',
    role: 'super_admin',
    department: 'Hospital IT Operations',
    email: 'admin@mapims.com'
  },
  {
    username: 'mapims',
    password: 'MAPIMS',
    name: 'MAPIMS Hospital Admin',
    role: 'super_admin',
    department: 'Hospital Administration',
    email: 'mapims@mapims.com'
  },
  {
    username: 'radiology',
    password: '1234',
    name: 'Dr. MAPIMS Radiologist',
    role: 'radiologist',
    department: 'Department of Radiodiagnosis',
    email: 'radiology@mapims.com'
  },
  {
    username: 'ortho',
    password: '12345',
    name: 'Dr. Orthopedics Specialist',
    role: 'doctor',
    department: 'Orthopedics & Trauma Care',
    email: 'ortho@mapims.com'
  },
  {
    username: 'casualty',
    password: '12345',
    name: 'Casualty Medical Officer',
    role: 'doctor',
    department: 'Emergency & Casualty Services',
    email: 'casualty@mapims.com'
  },
  {
    username: 'surgery',
    password: '1234',
    name: 'General Surgery Team',
    role: 'doctor',
    department: 'Department of Surgery',
    email: 'surgery@mapims.com'
  },
  {
    username: 'technician',
    password: 'tech123',
    name: 'Radiology Modality Technician',
    role: 'technician',
    department: 'Radiology Imaging Suite (CT/MRI/XR)',
    email: 'technician@mapims.com'
  },
  {
    username: 'staff',
    password: 'staff123',
    name: 'Front Desk / Patient Reception',
    role: 'staff',
    department: 'Patient Care & Reception',
    email: 'staff@mapims.com'
  }
];

// Cryptographic Password Hashing (PBKDF2 with unique salt)
function hashPassword(password, salt = null) {
  const userSalt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, userSalt, 10000, 64, 'sha512').toString('hex');
  return { hash, salt: userSalt };
}

function verifyPassword(password, storedHash, storedSalt) {
  try {
    const hash = crypto.pbkdf2Sync(password, storedSalt, 10000, 64, 'sha512').toString('hex');
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(storedHash, 'hex'));
  } catch (err) {
    return false;
  }
}

// Lightweight Standard JWT Generation (HMAC-SHA256)
function base64UrlEncode(str) {
  return Buffer.from(str)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecode(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) base64 += '=';
  return Buffer.from(base64, 'base64').toString('utf8');
}

function generateToken(payload) {
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const exp = Date.now() + TOKEN_EXPIRY_MS;
  const body = base64UrlEncode(JSON.stringify({ ...payload, exp }));
  const signature = base64UrlEncode(
    crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest()
  );
  return `${header}.${body}.${signature}`;
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, body, signature] = parts;
  const expectedSignature = base64UrlEncode(
    crypto.createHmac('sha256', JWT_SECRET).update(`${header}.${body}`).digest()
  );

  try {
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expectedSignature);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
      return null;
    }

    const payload = JSON.parse(base64UrlDecode(body));
    if (payload.exp && Date.now() > payload.exp) {
      return null; // Expired token
    }
    return payload;
  } catch (err) {
    return null;
  }
}

// MongoDB Database Authentication Initializer
let authDb = null;

async function initAuth(dbInstance) {
  authDb = dbInstance;
  if (!authDb) return;

  try {
    const usersCol = authDb.collection('users');
    await usersCol.createIndex({ username: 1 }, { unique: true });

    // Seed default accounts if missing
    for (const defUser of DEFAULT_USERS) {
      const existing = await usersCol.findOne({ username: defUser.username.toLowerCase() });
      if (!existing) {
        const { hash, salt } = hashPassword(defUser.password);
        await usersCol.insertOne({
          username: defUser.username.toLowerCase(),
          displayName: defUser.username,
          name: defUser.name,
          role: defUser.role,
          department: defUser.department,
          email: defUser.email,
          passwordHash: hash,
          passwordSalt: salt,
          createdAt: new Date(),
          updatedAt: new Date(),
          active: true,
          isSystemDefault: true
        });
        console.log(`[Auth] Seeded default user: ${defUser.username} (${defUser.role})`);
      }
    }
    console.log('[Auth] Role-based user authentication engine ready.');
  } catch (err) {
    console.error('[Auth Init Error]:', err.message);
  }
}

// Login verification
async function authenticateUser(username, password) {
  if (!username || !password) {
    return { success: false, error: 'Username and password are required' };
  }

  const cleanUser = String(username).trim().toLowerCase();

  // Try MongoDB first if connected
  let user = null;
  if (authDb) {
    try {
      user = await authDb.collection('users').findOne({ username: cleanUser });
    } catch (dbErr) {
      console.warn('[Auth] Mongo lookup fallback:', dbErr.message);
    }
  }

  // Fallback to in-memory default users if DB is disconnected
  if (!user) {
    const def = DEFAULT_USERS.find(u => u.username.toLowerCase() === cleanUser);
    if (def) {
      if (def.password === password) {
        const roleConfig = ROLE_PERMISSIONS[def.role] || ROLE_PERMISSIONS.staff;
        const payload = {
          username: def.username,
          name: def.name,
          role: def.role,
          department: def.department,
          email: def.email
        };
        const token = generateToken(payload);
        return {
          success: true,
          token,
          user: {
            ...payload,
            permissions: roleConfig
          }
        };
      }
    }
    return { success: false, error: 'Invalid username or password' };
  }

  if (user.active === false) {
    return { success: false, error: 'User account has been deactivated' };
  }

  const isPasswordValid = verifyPassword(password, user.passwordHash, user.passwordSalt);
  if (!isPasswordValid) {
    return { success: false, error: 'Invalid username or password' };
  }

  const roleConfig = ROLE_PERMISSIONS[user.role] || ROLE_PERMISSIONS.staff;
  const payload = {
    id: user._id.toString(),
    username: user.username,
    displayName: user.displayName || user.username,
    name: user.name,
    role: user.role,
    department: user.department,
    email: user.email
  };

  const token = generateToken(payload);

  return {
    success: true,
    token,
    user: {
      ...payload,
      permissions: roleConfig
    }
  };
}

// Express Middleware for Token & Permission Validation
function requireAuth(requiredPermission = null) {
  return (req, res, next) => {
    let token = null;

    // Check Authorization header: Bearer <token>
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      token = authHeader.substring(7).trim();
    } else if (req.query && req.query.auth_token) {
      // Support query parameter for download/iframe endpoints
      token = req.query.auth_token;
    }

    if (!token) {
      return res.status(401).json({
        success: false,
        error: 'Authentication required. Please log in.',
        code: 'AUTH_REQUIRED'
      });
    }

    const payload = verifyToken(token);
    if (!payload) {
      return res.status(401).json({
        success: false,
        error: 'Session expired or invalid token. Please log in again.',
        code: 'TOKEN_INVALID'
      });
    }

    req.user = payload;
    req.permissions = ROLE_PERMISSIONS[payload.role] || ROLE_PERMISSIONS.staff;

    // Check specific required permission if requested
    if (requiredPermission && !req.permissions[requiredPermission]) {
      return res.status(403).json({
        success: false,
        error: `Access Denied: Your role '${payload.role}' lacks permission for '${requiredPermission}'.`,
        code: 'FORBIDDEN',
        requiredPermission,
        role: payload.role
      });
    }

    next();
  };
}

// Optional Auth (populates req.user if token is present, but doesn't block)
function optionalAuth(req, res, next) {
  let token = null;
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7).trim();
  } else if (req.query && req.query.auth_token) {
    token = req.query.auth_token;
  }

  if (token) {
    const payload = verifyToken(token);
    if (payload) {
      req.user = payload;
      req.permissions = ROLE_PERMISSIONS[payload.role] || ROLE_PERMISSIONS.staff;
    }
  }
  next();
}

module.exports = {
  ROLES,
  ROLE_PERMISSIONS,
  DEFAULT_USERS,
  initAuth,
  authenticateUser,
  generateToken,
  verifyToken,
  requireAuth,
  optionalAuth,
  hashPassword,
  verifyPassword
};
