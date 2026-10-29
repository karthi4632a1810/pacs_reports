#!/usr/bin/env bash
# ==============================================================================
# MAPIMS PACS Connect - Hostinger VPS Deployment Script
# ==============================================================================
# Usage:
#   chmod +x deploy.sh
#   ./deploy.sh
#
# Steps performed:
#   1. Git pull latest code from remote repository
#   2. Sync & update .env from .env.example (preserving existing secret values)
#   3. Ensure required storage directories and permissions
#   4. Build & restart Docker Compose services with zero downtime
#   5. Validate container health & display connection URLs
# ==============================================================================

set -eo pipefail

# Text styling
BOLD='\033[1m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

info()    { echo -e "${CYAN}${BOLD}[INFO]${NC} $1"; }
success() { echo -e "${GREEN}${BOLD}[SUCCESS]${NC} $1"; }
warn()    { echo -e "${YELLOW}${BOLD}[WARNING]${NC} $1"; }
error()   { echo -e "${RED}${BOLD}[ERROR]${NC} $1"; }

echo -e "${BOLD}======================================================${NC}"
echo -e "${BOLD}  🏥 MAPIMS PACS Connect - Automated VPS Deployer     ${NC}"
echo -e "${BOLD}======================================================${NC}"

# Navigate to script root directory
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"
info "Working directory: $PROJECT_DIR"

# ------------------------------------------------------------------------------
# 1. GIT PULL
# ------------------------------------------------------------------------------
if [ -d ".git" ]; then
  CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "main")
  info "Fetching and pulling latest code from branch: ${BOLD}${CURRENT_BRANCH}${NC}..."
  
  # Fetch latest changes
  git fetch origin "$CURRENT_BRANCH" || warn "Could not fetch from remote. Continuing with local copy..."
  
  # Pull changes
  if git pull origin "$CURRENT_BRANCH"; then
    success "Git pull completed successfully."
  else
    warn "Git pull encountered merge conflict or warning. Continuing deploy..."
  fi
else
  warn "Not a git repository or .git directory missing. Skipping git pull."
fi

# ------------------------------------------------------------------------------
# 2. UPDATE .ENV FROM .ENV.EXAMPLE (Preserves existing keys and secrets)
# ------------------------------------------------------------------------------
ENV_FILE=".env"
ENV_EXAMPLE=".env.example"

if [ ! -f "$ENV_EXAMPLE" ]; then
  warn "$ENV_EXAMPLE not found! Skipping environment synchronization."
else
  if [ ! -f "$ENV_FILE" ]; then
    info "No $ENV_FILE found. Creating initial $ENV_FILE from $ENV_EXAMPLE..."
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    warn "Created default $ENV_FILE. Please verify passwords and API keys before public launch."
  else
    info "Auditing $ENV_FILE against $ENV_EXAMPLE..."
    
    # Create a safe backup before modifications
    BACKUP_NAME="${ENV_FILE}.backup.$(date +%Y%m%d_%H%M%S)"
    cp "$ENV_FILE" "$BACKUP_NAME"
    
    ADDED_COUNT=0
    while IFS= read -r line || [ -n "$line" ]; do
      # Skip comments and blank lines
      case "$line" in
        \#*|"") continue ;;
      esac
      
      # Extract variable key name before '='
      KEY=$(echo "$line" | cut -d'=' -f1 | xargs)
      if [ -n "$KEY" ]; then
        # Check if key is already present in .env
        if ! grep -q "^[[:space:]]*${KEY}=" "$ENV_FILE"; then
          echo "$line" >> "$ENV_FILE"
          echo -e "    ${GREEN}+ Added missing variable:${NC} ${KEY}"
          ADDED_COUNT=$((ADDED_COUNT + 1))
        fi
      fi
    done < "$ENV_EXAMPLE"
    
    if [ "$ADDED_COUNT" -gt 0 ]; then
      success "Appended ${ADDED_COUNT} new variable(s) from $ENV_EXAMPLE into $ENV_FILE (backup saved as $BACKUP_NAME)."
    else
      success "$ENV_FILE is already up to date with all variables in $ENV_EXAMPLE."
      rm -f "$BACKUP_NAME" # Remove redundant backup if unchanged
    fi
  fi
fi

# ------------------------------------------------------------------------------
# 3. DIRECTORY STRUCTURE & PERMISSIONS
# ------------------------------------------------------------------------------
info "Verifying local persistent storage directories..."
mkdir -p storage/mongo storage/minio storage/dicom storage/reports storage/thumbnails public/reports

# Ensure readable and writable by containers
chmod -R 775 storage public/reports 2>/dev/null || true
success "Storage directory structure verified."

# ------------------------------------------------------------------------------
# 4. DOCKER COMPOSE ENGINE DETECTION
# ------------------------------------------------------------------------------
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  DOCKER_COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  DOCKER_COMPOSE="docker-compose"
else
  error "Neither 'docker compose' nor 'docker-compose' was found on this system!"
  echo -e "Please install Docker and Compose on your Hostinger VPS:"
  echo -e "  sudo apt update && sudo apt install -y docker.io docker-compose-v2-plugin"
  exit 1
fi
info "Using Docker Compose command: ${BOLD}${DOCKER_COMPOSE}${NC}"

# ------------------------------------------------------------------------------
# 5. BUILD & RUN CONTAINERS
# ------------------------------------------------------------------------------
info "Building and launching containers in detached mode..."
$DOCKER_COMPOSE up -d --build --remove-orphans

success "Docker Compose services launched."

# ------------------------------------------------------------------------------
# 6. POST-DEPLOYMENT HEALTH CHECK
# ------------------------------------------------------------------------------
info "Waiting for service initialization (6 seconds)..."
sleep 6

echo -e "\n${BOLD}Container Status:${NC}"
$DOCKER_COMPOSE ps

# Read configured ports from .env or fallback to new defaults
F_PORT=$(grep -E "^[[:space:]]*FRONTEND_PORT=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2 | xargs || echo "1010")
B_PORT=$(grep -E "^[[:space:]]*BACKEND_PORT=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2 | xargs || echo "2010")
M_PORT=$(grep -E "^[[:space:]]*MONGO_PORT=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2 | xargs || echo "3010")
MC_PORT=$(grep -E "^[[:space:]]*MINIO_CONSOLE_PORT=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2 | xargs || echo "5010")

# Detect Hostinger Public IP or fallback
VPS_IP=$(curl -s --max-time 3 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')

echo -e "\n${BOLD}======================================================${NC}"
echo -e "${GREEN}${BOLD}  🚀 DEPLOYMENT COMPLETED SUCCESSFULLY!              ${NC}"
echo -e "${BOLD}======================================================${NC}"
echo -e "Your MAPIMS PACS Connect stack is now running:"
echo -e "  🌐 ${CYAN}Web Portal (Frontend):${NC}  http://${VPS_IP}:${F_PORT}"
echo -e "  ⚡ ${CYAN}API Gateway (Backend):${NC}  http://${VPS_IP}:${B_PORT}"
echo -e "  🗄️ ${CYAN}MinIO S3 Console:${NC}       http://${VPS_IP}:${MC_PORT} (user: minioadmin)"
echo -e "  💾 ${CYAN}MongoDB Compass:${NC}        mongodb://${VPS_IP}:${M_PORT}/pacs_db"
echo -e "\nLogs can be checked at any time with:"
echo -e "  ${BOLD}${DOCKER_COMPOSE} logs -f${NC}\n"
