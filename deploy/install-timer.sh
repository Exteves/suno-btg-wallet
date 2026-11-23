#!/bin/sh
# Instala o timer systemd de usuário para a coleta diária da Suno.
# Uso: npm run schedule:install [-- HH:MM]   (padrão 19:30, horário local)
set -eu
TIME="${1:-19:30}"
case "$TIME" in [0-2][0-9]:[0-5][0-9]) ;; *) echo "Horário inválido: $TIME (use HH:MM)"; exit 1 ;; esac
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
mkdir -p "$UNIT_DIR"

cat > "$UNIT_DIR/suno-daily.service" <<UNIT
[Unit]
Description=Coleta diária Suno (relatórios, carteiras, cobertura, fundos) - somente consulta
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$PROJECT
ExecStart=$NODE $PROJECT/src/daily.js --trigger timer
# Cloudflare bloqueia o Chromium headless na Suno: a janela usa o WSLg.
Environment=DISPLAY=${DISPLAY:-:0}
Environment=WAYLAND_DISPLAY=${WAYLAND_DISPLAY:-wayland-0}
Environment=XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
Environment=DBUS_SESSION_BUS_ADDRESS=${DBUS_SESSION_BUS_ADDRESS:-unix:path=/run/user/$(id -u)/bus}
# 2 = coleta parcial (dados gravados com avisos). 3 = login necessário.
SuccessExitStatus=2
TimeoutStartSec=60min
Nice=10
UNIT

cat > "$UNIT_DIR/suno-daily.timer" <<UNIT
[Unit]
Description=Agenda diária da coleta Suno

[Timer]
OnCalendar=*-*-* $TIME:00
# Se o WSL estava desligado no horário, roda ao iniciar.
Persistent=true
RandomizedDelaySec=10min

[Install]
WantedBy=timers.target
UNIT

systemctl --user daemon-reload
systemctl --user enable --now suno-daily.timer
systemctl --user list-timers suno-daily.timer --no-pager
