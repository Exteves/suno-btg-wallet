#!/bin/sh
# Cria no Agendador de Tarefas do Windows uma tarefa que, ao fazer logon,
# inicia esta distribuição WSL e a mantém ativa (um `sleep infinity` sem
# janela). Assim o timer systemd da coleta diária roda mesmo sem terminal
# aberto. Somente usuário atual, sem privilégio de administrador.
# Uso: npm run schedule:windows            (instala/atualiza e inicia agora)
#      npm run schedule:windows -- remover (remove a tarefa)
set -eu
TASK='Suno - manter WSL ativo'
DISTRO="${WSL_DISTRO_NAME:?Rode dentro do WSL}"
PS=/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe
case "$DISTRO" in *[!A-Za-z0-9._-]*) echo "Nome de distribuição inesperado: $DISTRO"; exit 1 ;; esac

if [ "${1:-}" = remover ]; then
  "$PS" -NoProfile -NonInteractive -Command "Unregister-ScheduledTask -TaskName '$TASK' -Confirm:\$false"
  echo "Tarefa removida: $TASK"
  exit 0
fi

"$PS" -NoProfile -NonInteractive -Command "
\$ErrorActionPreference = 'Stop'
\$user = \"\$env:USERDOMAIN\\\$env:USERNAME\"
# conhost --headless: sem janela de console no logon.
\$action = New-ScheduledTaskAction -Execute \"\$env:SystemRoot\\System32\\conhost.exe\" -Argument '--headless wsl.exe -d $DISTRO --exec /bin/sleep infinity'
\$trigger = New-ScheduledTaskTrigger -AtLogOn -User \$user
\$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
\$principal = New-ScheduledTaskPrincipal -UserId \$user -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName '$TASK' -Description 'Mantém o WSL ($DISTRO) ativo para a coleta diária da Suno (timer systemd). Remover: npm run schedule:windows -- remover' -Action \$action -Trigger \$trigger -Settings \$settings -Principal \$principal -Force | Out-Null
Start-ScheduledTask -TaskName '$TASK'
Get-ScheduledTask -TaskName '$TASK' | Select-Object TaskName, State | Format-Table -HideTableHeaders
"
