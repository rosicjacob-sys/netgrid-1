# T02 sweep auto-resume wrapper.
# Runs the sweep repeatedly (each pass = STOP_AFTER_MINUTES budget) until all
# affected blogs are processed. Safety contract:
#   - exit 2 (HARD STOP = verification failure) => HALT immediately.
#   - exit 1/other (transient: timeout, dropped connection) => cool down and
#     resume — every post write is atomic and the sweep is idempotent.
#   - 5 consecutive passes with zero new progress => HALT (something is stuck).
param(
  [int]$MaxPasses = 200
)
Set-Location (Join-Path $PSScriptRoot "..")
$stalled = 0
for ($i = 1; $i -le $MaxPasses; $i++) {
  Write-Output "===== PASS $i ====="
  $before = (Get-Content .t02-sweep-progress.json -ErrorAction SilentlyContinue | Measure-Object -Line).Lines
  & cmd /c "npx cross-env NODE_OPTIONS=--dns-result-order=ipv4first tsx scripts/t02-sweep.ts 2>&1"
  $code = $LASTEXITCODE
  $after = (Get-Content .t02-sweep-progress.json -ErrorAction SilentlyContinue | Measure-Object -Line).Lines
  Write-Output "pass $i exit=$code progress=$before->$after"
  if ($code -eq 2) {
    Write-Output "HARD STOP (verification failure). HALTING - investigate before resuming."
    exit 2
  }
  if ($code -ne 0) {
    Write-Output "transient failure (exit=$code) - cooling down 30s and resuming."
    Start-Sleep -Seconds 30
  }
  if ($after -eq $before) {
    $stalled++
    if ($stalled -ge 5) {
      Write-Output "NO PROGRESS FOR 5 CONSECUTIVE PASSES - stopping. Investigate the sweep output."
      exit 3
    }
  } else {
    $stalled = 0
  }
  if (Test-Path .t02-sweep-complete) {
    Write-Output "ALL AFFECTED BLOGS PROCESSED. SWEEP COMPLETE."
    exit 0
  }
  Start-Sleep -Seconds 5
}
