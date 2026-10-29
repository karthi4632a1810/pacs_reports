# MAPIMS PACS Connect - Implementation & Architecture Plan

## 1. Executive Summary

**Project**: MAPIMS PACS Connect Hub  
**Host Architecture**: Local Gateway / Hub (`localhost:3000`, Linux Docker) connecting to Hospital Core PACS (`http://192.168.101.224`, Windows Server 2016 / IIS 10 / SQL Server 2016).  
**Primary Objectives**:
1. **Solve Local Storage Constraints**: Implement a smart 10-day local retention strategy that respects the local server's disk limit (70 GB free) while daily PACS generation is ~10 GB/day (~100 GB for 10 days).
2. **Feature Parity with Legacy Medsynapse Worklist**: Integrate reporting radiologist tracking, one-click diagnostic report viewing/printing, and series thumbnail previews into the modern responsive dashboard.
3. **High-Reliability Viewer & DICOM Access**: Maintain continuous session keepalive for ZeroFootprint viewer and provide on-demand DICOM (`.dcm` / `.zip`) export.

---

## 2. Current Environment & Data Metrics

### Measured Storage Reality (as of Oct 2026)
* **Daily Ingest Rate**: ~517 studies / day, ~55,314 images / day, **10.00 GB / day**.
  * **Modality Breakdown**:
    * **US** (Ultrasound): 162 studies | 1,813 images | **4.64 GB**
    * **CT** (Computed Tomography): 58 studies | 40,505 images | **2.96 GB**
    * **MR** (Magnetic Resonance): 23 studies | 12,540 images | **1.99 GB**
    * **DX / CR** (X-Rays): 270 studies | 428 images | **~0.25 GB**
    * **XA** (Angiography): 4 studies | 28 images | **~0.17 GB**
* **Local Host Machine (`df -h`)**: `/dev/sda2` has **70 GB available** (67% used).
  * *Constraint*: Storing 10 days of raw DICOMs uncompressed (~100 GB) would exceed available disk and crash local services.
* **Core PACS Server (`192.168.101.224`)**: 6 Storage volumes totaling **5.53 TB capacity** (5.34 TB used, ~96.6% full, 188.27 GB free).

---

## 3. Architecture: 4-Tier Smart Local Storage Engine

```
                          [ Doctor / Client Browser ]
                                       │
                                       ▼
                     [ PACKS_CONNECT Gateway (Node.js) ]
                                       │
        ┌──────────────────────────────┼──────────────────────────────┐
        ▼                              ▼                              ▼
  [ Tier 1: Metadata ]        [ Tier 2: Previews ]          [ Tier 3: LRU DICOM ]
  Last 10 Days in Local       10-Day Series Thumbnails      Bounded Cache (25 GB Cap)
  SQLite / JSON (<10 MB)      ~11 KB each (~1 GB total)     Stores exact raw .dic
  Instant search & filters    Instant card image gallery    Auto-evicts oldest scans
        │                              │                              │
        └──────────────────────────────┼──────────────────────────────┘
                                       │ (Cache Miss / Deep Archive)
                                       ▼
                       [ Core PACS: 192.168.101.224 ]
                         D:\PACS_DATA (IIS / SQL)
```

### Tier 1: 10-Day Metadata Cache
* **Scope**: Complete patient, study, procedure, and status records for the rolling past 10 days.
* **Storage Size**: Under **10 MB** (SQLite or local JSON store).
* **Benefit**: Zero-latency dashboard queries, instant search across patient names/IDs/accessions without hitting the Windows SQL database repeatedly.

### Tier 2: Series Thumbnail Cache (~1 GB)
* **Scope**: The PACS server already maintains pre-rendered 11 KB `.jpeg` thumbnails for every series.
* **Storage Size**: ~1 GB total for 10 days.
* **Benefit**: Doctors can see image previews directly inside the worklist table without waiting for full DICOM downloads.

### Tier 3: Bounded 25 GB LRU Raw DICOM Cache
* **Scope**: Store full, uncompressed 16-bit Part 10 DICOM files (`.dic`) for studies that are actually opened by clinicians.
* **Safety Quota**: Hard limit set to **25 GB** (never risks the host's 70 GB disk).
* **Eviction Policy**: Least Recently Used (LRU) automatic pruning when cache exceeds 25 GB.
* **Benefit**: Active in-patient reviews open instantaneously; non-viewed archival scans remain securely on the main PACS.

### Tier 4: On-Demand DICOM Exporter
* Endpoint: `/api/study/:uid/export`
* Allows doctors to download studies packaged as standard `.dcm` files inside a compressed `.zip` on the fly for external consultations.

---

## 4. Dashboard Enhancements (Legacy Medsynapse Parity)

| Feature | Legacy Medsynapse (`Worklist.asp`) | Planned PACKS_CONNECT Upgrade |
| :--- | :--- | :--- |
| **Reporting Doctor** | Listed under "Report Finalized By" | Add dedicated column or sub-badge showing certifying radiologist |
| **Diagnostic Report** | Text report view/print icon | Add "Report" action button with dedicated modal & printable PDF view |
| **Inline Previews** | Expand `+` icon showing basic list | Expandable drawer with interactive thumbnail filmstrip |
| **Lifetime Archive Stats** | Footer: "Total: 724,206 \| FINAL: 696,108" | Add global archive stats badge in header/footer alongside date KPIs |
| **Worklist Workflow Tabs** | "Regular" / "Assigned" / "Study List" | Add quick filters for Assigned Doctor & Reporting workflow status |

---

## 5. Technical Implementation Roadmap

### Phase 1: Local Bounded DICOM & Thumbnail Cache
- [x] Create persistent Docker volume for cache (`./storage:/app/storage`).
- [x] Implement LRU Cache Manager module in `server.js` with 25 GB threshold.
- [x] Implement thumbnail proxy endpoint: `/api/thumbnail/:studyUid/:seriesUid`.
- [x] Implement on-demand DICOM packaging endpoint: `/api/study/:studyUid/download`.

### Phase 2: Diagnostic Radiology Report Integration
- [x] Query and map `Report_Saving_Users` & `User_Reg` from the PACS database in `api_pacs.asp`.
- [x] Add `/api/report/:studyUid` endpoint to fetch formatted PDF/DOC reports.
- [x] Add printable report modal in `public/index.html` with hospital letterhead styling.

### Phase 3: UI Upgrades & Filmstrip Preview
- [x] Add "Report Finalized By" info directly into the worklist table.
- [x] Add inline `+` expandable row to show thumbnail filmstrips for multi-series exams (CT/MR).
- [x] Add "Download DICOM (.zip)" button to the study details modal.
- [x] Add cumulative PACS total badge in the top server info bar.
- [x] Add bottom pagination bar with page navigation buttons (`«`, `‹`, page numbers with smart ellipsis, `›`, `»`), entries tally, and rows-per-page selector (25, 50, 100, 200, All).
- [x] Add Interactive Analytics Hub with Chart.js: Top-level view switcher between "📋 Studies Worklist" and "📊 Modality & Volume Analytics" featuring dual-axis volume vs slice charts, slice share donut, 24-hr hourly influx timelines, modality reporting status stacked bars, and performance matrix table.

### Phase 4: Container Rebuild & Automated Watchdog
- [x] Update `docker-compose.yml` with storage volume and environment variable limits (`MAX_CACHE_GB=25`).
- [x] Rebuild and deploy container `pacs-connect-app`.
- [x] Verify disk safety and end-to-end performance.

### Phase 5: High-Visibility 3-Screen Navigation & Dedicated Advanced Search Console
- [x] Elevated Top Primary Navigation Bar (`.app-main-nav`) positioned directly beneath the header with 3 prominent, high-contrast screens:
  1. **`📋 Studies Worklist`** (with live active studies counter badge)
  2. **`🔍 Advanced Search`** (with `Archive & Worklist` badge)
  3. **`📊 Department Analytics`** (with `Telemetry & Slices` badge)
- [x] Implemented dedicated **Advanced PACS Query Console** screen (`#advancedSearchSection`):
  - Multi-parameter clinical search fields: Patient Name, Patient ID/MRN, Accession Number, Modality multi-select, Date Presets & Custom Pickers (`From`/`To`), Reporting Radiologist dropdown, Referring Physician/Department, Procedure/Study Description, Study Verification Status, Patient Gender, and Image Slices threshold (>= 10, >= 50, >= 100, >= 300, >= 500).
  - Quick Query Preset pills: `CT & MRI Scans`, `Unreported / Pending`, `High Slices (>100)`, `Final Signed Today`, `X-Ray (DX/CR)`.
  - Action Controls: "Search Studies" (Enter hotkey), "Reset Filters", and "Export Results (CSV)".
  - Dedicated search results data table with numbered pagination, direct ZeroFootprint viewer launch, printable report modal, and series preview drawer (`+`).
- [x] Upgraded **Department Analytics Hub** screen (`#analyticsSection`):
  - Header bar with title, telemetry description, and instant refresh button.
  - 4 KPI metric cards: Analyzed Studies, Total DICOM Slices, Primary Slice Generator, and Diagnostic Verification Rate.
  - 4 interactive offline Chart.js visualizations (Dual-axis volume vs slices, Slice share donut, 24-hr hourly exam influx, Modality reporting status stacked bars).
  - Modality performance matrix table with signed rate progress bars.

### Phase 6: Local MongoDB Patient Metadata Storage & MongoDB Compass Integration
- [x] Provisioned local MongoDB instance (`pacs-mongo-db`, image `mongo:7`) bound to dedicated port `3004:27017` with persistent volume (`./storage/mongo:/data/db`).
- [x] Designed normalized dual-collection schema in `db.js`:
  - `pacs_db.patients`: Master patient directory grouping visits by `patientId` (MRN). Indexes on `patientId` (unique), `patientName`, `firstStudyDate`, `lastStudyDate`, and `modalities`.
  - `pacs_db.studies`: Detailed DICOM study records with unique compound index on `studyUid`, plus indexes on `patientId`, `studyDate`, and `modality`.
- [x] Ingested 30 days of hospital data via `scripts/sync_all_patients.js`:
  - **7,709 Master Patients** created and indexed.
  - **11,450 Exam Studies** stored (over 1.25 million DICOM slices indexed).
- [x] Automated auto-save hook in `server.js` ensuring all fetched studies and patient profiles update in MongoDB on every query.
- [x] Implemented REST endpoints:
  - `GET /api/mongo/stats`: Total patients, total studies, modality telemetry, and Compass URI.
  - `POST /api/mongo/sync`: Background batch ingest from PACS to MongoDB.
  - `GET /api/mongo/patients`: Paginated master patient queries.
  - `GET /api/mongo/patient/:patientId`: Patient longitudinal exam history.
- [x] Added MongoDB Compass status badge & modal to frontend UI with one-click URI copy for `mongodb://localhost:3009/pacs_db` and `mongodb://192.168.101.130:3009/pacs_db`.

### Phase 7: Multi-Container Microservices & MinIO DICOM Object Storage
- [x] Architecture decomposed into 4 dedicated Docker containers:
  - **Frontend (Port `1009`)**: Nginx reverse proxy serving responsive SPA dashboard and streaming `/api` requests to backend without CORS friction.
  - **Backend (Port `2009`)**: Express.js gateway managing PACS queries, report rendering, Mongo aggregations, and MinIO S3 streams.
  - **MongoDB (Port `3009`)**: Mongo 7 database engine storing 7,700+ patients and 11,400+ studies, accessible via MongoDB Compass on `mongodb://localhost:3009/pacs_db`.
  - **MinIO Object Storage (Port `4009` API / `5009` Console)**: Dedicated medical imaging S3 store for Part-10 DICOM files in `pacs-dicom` bucket.
- [x] Developed [minioClient.js](file:///home/itmapims/PACKS_CONNECT/minioClient.js):
  - Auto-initialization and bucket verification for `pacs-dicom`.
  - Background async caching and streaming of DICOM slices (`.dcm`).
  - MinIO REST endpoints: `GET /api/minio/stats`, `GET /api/study/:studyUid/minio`, `POST /api/study/:studyUid/cache-minio`, `GET /api/study/:studyUid/dicom/:ser/:inst`.
- [x] Frontend UI integration:
  - Header badges for **Storage Quota (25 GB Max)**, **MongoDB (Port 3009)**, and **MinIO S3 (Port 4009)**.
  - Dedicated MinIO modal with live storage metrics, S3 endpoint copy, and 1-click launch to MinIO Web Console on port 5009.
  - Dedicated **25 GB Storage Quota Modal** with real-time utilization progress bar, breakdown (DICOM vs Reports vs Thumbnails), and manual LRU cleanup trigger.
- [x] Dual-Tier 25 GB Quota Enforcement:
  - **MinIO Hard Bucket Quota**: 25 GiB hard limit configured on `pacs-dicom` bucket (`mc quota set myminio/pacs-dicom --size 25GiB`).
  - **Automated LRU Watchdog**: Background watchdog running every 10 minutes monitors combined storage across MinIO DICOM files, diagnostic reports, and thumbnails. If total storage approaches 25 GB, oldest studies and cached files are automatically evicted down to 20 GB (80%).

---

## 6. Success & Verification Metrics
1. **Strict 25 GB Quota Enforcement**: Total storage across DICOM files (MinIO), diagnostic reports, and thumbnails never exceeds 25 GB.
2. **Microservices Port Separation**:
   - Frontend SPA: `http://localhost:1009` (LAN: `http://192.168.101.130:1009`)
   - Backend API: `http://localhost:2009` (LAN: `http://192.168.101.130:2009`)
   - MongoDB Compass: `mongodb://localhost:3009/pacs_db` (LAN: `mongodb://192.168.101.130:3009/pacs_db`)
   - MinIO DICOM S3 API: `http://localhost:4009` (Console: `http://localhost:5009`)
3. **DICOM Object Storage**: Seamless offloading and streaming of DICOM files through MinIO S3 bucket `pacs-dicom`.
4. **Host Disk Safety**: Total local disk utilization on `/dev/sda2` never exceeds 80%.
5. **Viewer Launch Reliability**: 0% "Session Expired" error rate via automated keepalive.
6. **MongoDB Compass Access**: Instant inspection, filtering, and aggregation of patient metadata in MongoDB Compass.



