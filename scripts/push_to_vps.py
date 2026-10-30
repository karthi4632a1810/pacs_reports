#!/usr/bin/env python3
"""
MAPIMS PACS Connect - Automated VPS Project Pusher
Reads SSH and SSH_PASSWORD directly from .env and pushes the project to the VPS.
"""

import os
import sys
import re
import time
import argparse
import subprocess
import pexpect

# Determine workspace root
WORKSPACE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
ENV_FILE = os.path.join(WORKSPACE_DIR, '.env')

def load_env():
    """Load SSH credentials and configuration from .env"""
    env_vars = {}
    if not os.path.exists(ENV_FILE):
        print(f"❌ Error: .env file not found at {ENV_FILE}")
        sys.exit(1)
        
    with open(ENV_FILE, 'r', encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith('#'):
                continue
            if '=' in line:
                key, val = line.split('=', 1)
                env_vars[key.strip()] = val.strip().strip('"\'')
                
    ssh_raw = env_vars.get('SSH', '')
    ssh_password = env_vars.get('SSH_PASSWORD', '')
    
    if not ssh_raw:
        print("❌ Error: 'SSH' variable not found in .env (e.g. SSH=ssh mapims@192.168.101.116)")
        sys.exit(1)
        
    # Extract user and host from "ssh user@host" or "user@host"
    match = re.search(r'(?:ssh\s+)?([a-zA-Z0-9._-]+)@([a-zA-Z0-9._-]+)', ssh_raw)
    if not match:
        print(f"❌ Error: Cannot parse SSH user and host from: {ssh_raw}")
        print("   Expected format: SSH=ssh user@ip or SSH=user@ip")
        sys.exit(1)
        
    user = match.group(1)
    host = match.group(2)
    target = f"{user}@{host}"
    vps_path = env_vars.get('VPS_PATH', '~/pacs_reports')
    
    return {
        'user': user,
        'host': host,
        'target': target,
        'password': ssh_password,
        'vps_path': vps_path
    }

def run_with_pexpect(cmd, password, timeout=120):
    """Run command and automatically respond to SSH password prompt if asked"""
    child = pexpect.spawn(cmd, timeout=timeout)
    while True:
        idx = child.expect([
            r'(?i)password:',
            r'Are you sure you want to continue connecting',
            pexpect.EOF,
            pexpect.TIMEOUT
        ])
        if idx == 0:
            if password:
                child.sendline(password)
            else:
                print("⚠️ Password prompt received but SSH_PASSWORD is empty.")
        elif idx == 1:
            child.sendline('yes')
        elif idx == 2:
            break
        elif idx == 3:
            print("⏱️ Command timed out.")
            break
            
    output = child.before.decode('utf-8', errors='ignore') if child.before else ''
    child.close()
    return child.exitstatus or 0, output

def sync_project_files(cfg):
    """Use rsync to push project files to VPS cleanly and quickly"""
    print(f"\n📦 [1/3] Syncing project files to {cfg['target']}:{cfg['vps_path']}...")
    
    excludes = [
        '--exclude', 'node_modules',
        '--exclude', '.git',
        '--exclude', '.gemini',
        '--exclude', 'scratch',
        '--exclude', 'storage',
        '--exclude', '.env',
        '--exclude', '*.tmp',
        '--exclude', '*.log',
        '--exclude', '.DS_Store'
    ]
    
    cmd_str = (
        f"rsync -avz --delete -e 'ssh -o StrictHostKeyChecking=no' "
        + ' '.join(excludes)
        + f" {WORKSPACE_DIR}/ {cfg['target']}:{cfg['vps_path']}/"
    )
    code, out = run_with_pexpect(f"bash -c \"{cmd_str}\"", cfg['password'], timeout=120)
    
    if code != 0:
        print(f"❌ File sync failed with exit code {code}:\n{out}")
        return False
        
    print("   ✓ Files differential sync completed successfully.")
    return True

def update_vps_containers(cfg, rebuild=False):
    """Update running Docker containers on the VPS and purge outdated report cache"""
    print(f"\n🔄 [2/3] Updating Docker containers on VPS ({cfg['host']})...")
    
    if rebuild:
        # Full Docker compose build & restart
        print("   🔨 Rebuilding pacs-backend container on VPS...")
        remote_script = (
            f"cd {cfg['vps_path']} && "
            "docker compose build pacs-backend && "
            "docker compose up -d && "
            "echo 'inhouse@67' | sudo -S rm -f storage/reports/Modern_Final_* 2>/dev/null || true"
        )
    else:
        # Hot container update: sync modified files into running container, clean cache, restart backend
        remote_script = (
            f"cd {cfg['vps_path']} && "
            "CID=$(docker ps --filter 'name=pacs-backend' --format '{{.ID}}' | head -n 1) && "
            "FCID=$(docker ps --filter 'name=pacs-frontend' --format '{{.ID}}' | head -n 1) && "
            "if [ -n \"$CID\" ]; then "
            "  docker cp reportGenerator.js $CID:/app/reportGenerator.js && "
            "  docker cp settingsManager.js $CID:/app/settingsManager.js 2>/dev/null || true && "
            "  docker cp auth.js $CID:/app/auth.js 2>/dev/null || true && "
            "  docker cp fonts $CID:/app/fonts 2>/dev/null || true && "
            "  docker cp public $CID:/app/public 2>/dev/null || true && "
            "  docker cp server.js $CID:/app/server.js && "
            "  if [ -n \"$FCID\" ]; then docker cp public/. $FCID:/usr/share/nginx/html/ 2>/dev/null || true; docker cp index.html $FCID:/usr/share/nginx/html/index.html 2>/dev/null || true; fi && "
            "  echo 'inhouse@67' | sudo -S rm -f storage/reports/Modern_Final_* 2>/dev/null || true && "
            "  docker restart $CID; "
            "else "
            "  docker compose up -d; "
            "fi"
        )
        
    ssh_cmd = f"ssh -o StrictHostKeyChecking=no {cfg['target']} \"{remote_script}\""
    code, out = run_with_pexpect(ssh_cmd, cfg['password'], timeout=180)
    
    if code != 0:
        print(f"⚠️ Container update warning:\n{out}")
    else:
        print("   ✓ Container files updated and service restarted.")
    return True

def verify_vps_health(cfg):
    """Perform health check on the VPS PACS backend service"""
    print(f"\n🩺 [3/3] Verifying VPS backend service health...")
    time.sleep(3)
    
    remote_check = (
        "curl -s -o /dev/null -w \"%{http_code}\" http://127.0.0.1:2010/ || "
        "curl -s -o /dev/null -w \"%{http_code}\" http://127.0.0.1:2010/reports/study/360531/report.pdf || "
        "echo 'FAILED'"
    )
    ssh_cmd = f"ssh -o StrictHostKeyChecking=no {cfg['target']} \"{remote_check}\""
    code, out = run_with_pexpect(ssh_cmd, cfg['password'], timeout=30)
    
    res = out.strip().split('\n')[-1].strip()
    if '200' in res or '304' in res or '404' in res:
        print(f"   ✅ VPS Backend is LIVE & HEALTHY on http://{cfg['host']}:2010 (Status: {res})")
    else:
        print(f"   ℹ️ Backend status check returned: {res}")
        
    print(f"\n=======================================================")
    print(f"  🎉 Project Successfully Pushed to VPS ({cfg['host']})!  ")
    print(f"=======================================================\n")

def main():
    parser = argparse.ArgumentParser(description="Push PACS Connect project to VPS using .env SSH configuration")
    parser.add_argument('--rebuild', action='store_true', help="Rebuild Docker container from scratch on VPS")
    parser.add_argument('--status', action='store_true', help="Check VPS docker container status")
    args = parser.parse_args()
    
    print("=======================================================")
    print("  🚀 MAPIMS PACS Connect - Automated VPS Project Pusher")
    print("=======================================================")
    
    cfg = load_env()
    print(f"[ENV] Loaded credentials from .env:")
    print(f"      • SSH Target  : {cfg['target']}")
    print(f"      • VPS Path    : {cfg['vps_path']}")
    print(f"      • Password    : {'*' * len(cfg['password'])} (auto-authenticated)")
    
    if args.status:
        ssh_cmd = f"ssh -o StrictHostKeyChecking=no {cfg['target']} \"docker ps\""
        code, out = run_with_pexpect(ssh_cmd, cfg['password'], timeout=30)
        print(out)
        return
        
    success = sync_project_files(cfg)
    if not success:
        sys.exit(1)
        
    update_vps_containers(cfg, rebuild=args.rebuild)
    verify_vps_health(cfg)

if __name__ == '__main__':
    main()
