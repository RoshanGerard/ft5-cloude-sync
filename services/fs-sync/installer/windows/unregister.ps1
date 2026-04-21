# Deregisters the ft5-sync Scheduled Task. Idempotent — absent task is OK.
# Invoked by apps/desktop's electron-builder `afterUninstall` hook.

$taskName = "ft5-sync"
schtasks /Delete /TN $taskName /F 2>$null
Write-Host "ft5-sync: Scheduled Task deregistered (if present)"
exit 0
