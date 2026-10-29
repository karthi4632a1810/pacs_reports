# MAPIMS Medsynapse PACS Worklist & Analytics Hub

A Node.js and Dockerized web application for real-time visualization, filtering, and analytics of PACS imaging studies from the Medsynapse PACS server (`192.168.101.224`).

---

## Features

- **Live Default View**: Automatically displays today's incoming PACS studies and real-time statistics on launch.
- **Executive KPIs**: Live counters for Total Studies, NEW/Pending reviews, In-Reading, and Finalized reports.
- **Modality Breakdown**: Dynamic filter pills with counts for Ultrasound (US), Digital X-Ray (DX), CT, MRI (MR), and Computed Radiography (CR).
- **Date Filtering**:
  - One-click presets: *Today*, *Yesterday*, *Last 3 Days*, *Last 7 Days*, *This Month*.
  - Custom date pickers (*From Date* and *To Date*).
- **Instant Search**: Search across Patient Name, Patient ID, Accession Number, Modality, Procedure/Study, Referring Doctor, and Institution.
- **Direct DICOM Viewer**: One-click launch to the Medsynapse ZeroFootprint web viewer in a new tab.
- **Live Auto-Refresh**: Configurable timer (15s, 30s, 60s, or Off) with live clock.
- **Export & Details**:
  - Export filtered studies directly to CSV.
  - Interactive study details modal showing equipment manufacturer, model, and DICOM metadata.
  - Dark / Light mode toggle.

---

## Quick Start with Docker (Recommended)

### 1. Start the Container
```bash
docker compose up -d
```

The application is accessible at:
👉 **http://localhost:3000** (or `http://<your-ip>:3000` from any device on your local network).

### 2. View Container Logs
```bash
docker compose logs -f
```

### 3. Check Container Health
```bash
docker ps -f name=pacs-connect-app
```

### 4. Stop the Container
```bash
docker compose down
```

### 5. Rebuild after Changes
```bash
docker compose up -d --build
```

---

## Running Locally with Node.js (Without Docker)

### Prerequisites
- Node.js >= 18

### Installation & Run
```bash
# Install dependencies
npm install

# Start production server
npm start

# Or start development server with auto-reload
npm run dev
```

Open **http://localhost:3000** in your browser.

---

## Configuration (`.env`)

You can customize the port and PACS host by creating a `.env` file:

```env
PORT=3000
PACS_HOST=http://192.168.101.224
NODE_ENV=production
```

---

## Project Structure

```
PACKS_CONNECT/
├── server.js              # Express.js API backend & static file server
├── package.json           # Node.js dependencies and scripts
├── Dockerfile             # Multi-stage production Docker container definition
├── docker-compose.yml     # Docker compose service definition
├── .dockerignore          # Docker build exclusion rules
├── .env.example           # Environment template
├── README.md              # Project documentation
└── public/                # Frontend application
    └── index.html         # Responsive PACS dashboard & analytics UI
```
# pacs_reports
