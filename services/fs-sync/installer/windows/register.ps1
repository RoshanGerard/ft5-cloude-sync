# Registers ft5-sync as a per-user Scheduled Task (runs at logon) with
# LIMITED privileges — no Administrator elevation required.
# Invoked by apps/desktop's electron-builder `afterInstall` hook on Windows.
#
# Usage: register.ps1 -ServicePath "<absolute path to fs-sync.exe>"

param(
    [Parameter(Mandatory=$true)]
    [string]$ServicePath
)

$taskName = "ft5-sync"

# Remove any prior registration so /Create doesn't fail with "task already exists".
schtasks /Delete /TN $taskName /F 2>$null

schtasks /Create `
    /SC ONLOGON `
    /TN $taskName `
    /TR "`"$ServicePath`"" `
    /RL LIMITED `
    /F

if ($LASTEXITCODE -ne 0) {
    Write-Error "schtasks /Create failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}

Write-Host "ft5-sync: registered Scheduled Task with ONLOGON trigger"
