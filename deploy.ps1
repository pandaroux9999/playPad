param(
    [switch]$SkipNpmInstall,
    [switch]$SkipBackup,
    [string]$Branch
)

$SSH_KEY = "C:\Users\fraise\.ssh\playpad-key.pem"
$HOST = "ubuntu@13.62.225.230"
$REMOTE_PATH = "/home/ubuntu/playPad/Site"
$LOCAL_PATH = "C:\Users\fraise\Documents\playPad1\Site"

if ($Branch) {
    git checkout $Branch
    git pull origin $Branch
}

Write-Host "=== Déploiement PlayPad ===" -ForegroundColor Cyan

if (-not $SkipBackup) {
    Write-Host "[1/5] Backup de la config distante..." -ForegroundColor Yellow
    ssh -i $SSH_KEY $HOST "sudo cp $REMOTE_PATH/server/.env /tmp/.env.backup 2>/dev/null; echo 'Backup OK'"
}

Write-Host "[2/5] Copie des fichiers (index.html + server)..." -ForegroundColor Yellow
scp -i $SSH_KEY -r "$LOCAL_PATH\index.html" "$HOST`:$REMOTE_PATH/index.html"
scp -i $SSH_KEY -r "$LOCAL_PATH\server\server.js" "$HOST`:$REMOTE_PATH/server/server.js"
scp -i $SSH_KEY -r "$LOCAL_PATH\server\package.json" "$HOST`:$REMOTE_PATH/server/package.json"

if ($LASTEXITCODE -ne 0) {
    Write-Host "ERREUR: Copie échouée" -ForegroundColor Red
    exit 1
}

if (-not $SkipNpmInstall) {
    Write-Host "[3/5] Installation des dépendances (si modifiées)..." -ForegroundColor Yellow
    ssh -i $SSH_KEY $HOST "cd $REMOTE_PATH/server && npm install 2>&1 | tail -1"
}

Write-Host "[4/5] Restauration du .env et permissions..." -ForegroundColor Yellow
ssh -i $SSH_KEY $HOST "sudo cp /tmp/.env.backup $REMOTE_PATH/server/.env 2>/dev/null; sudo chown -R root:root $REMOTE_PATH 2>/dev/null; echo 'OK'"

Write-Host "[5/5] Restart PM2..." -ForegroundColor Yellow
ssh -i $SSH_KEY $HOST "sudo pm2 restart playpad --update-env"

Write-Host "=== Déploiement terminé ! ===" -ForegroundColor Green
Write-Host "Site : https://playpad.dedyn.io" -ForegroundColor Cyan
