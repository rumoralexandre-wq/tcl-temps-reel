#!/bin/bash
set -euo pipefail

APP_DIR="/opt/tcltempsreel/selfservice_app"
VENV_PIP="/opt/tcltempsreel/venv/bin/pip"
LOG="/var/log/tcl-deploy.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

log "=== Déploiement démarré ==="

cd "$APP_DIR"

# Récupère les changements sans toucher aux fichiers locaux non trackés
log "git pull..."
git pull origin master 2>&1 | tee -a "$LOG"

# Met à jour les dépendances Python si requirements.txt a changé
log "pip install..."
"$VENV_PIP" install -r requirements.txt --quiet 2>&1 | tee -a "$LOG"

# Reload gracieux de Gunicorn (SIGHUP — termine les requêtes en cours)
log "Reload gunicorn..."
if sudo systemctl reload tcltempsreel; then
    log "Reload OK"
else
    log "Reload échoué, restart..."
    sudo systemctl restart tcltempsreel
    log "Restart OK"
fi

log "=== Déploiement terminé ==="
