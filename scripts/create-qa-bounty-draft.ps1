# One operator draft only. Recheck task-title duplication before calling; do not retry an uncertain POST.
$ErrorActionPreference='Stop'
$credentialPath=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'MAG\owner-admin\worker-admin.dpapi.xml'
$secureValue=Import-Clixml -LiteralPath $credentialPath
$pointer=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
try {
 $plainValue=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
 $body=Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot '../agent-state/pending-approval/2026-08-30-three-usdc-evidence-bounty.json')
 $response=Invoke-RestMethod -Method Post -Uri 'https://mavverick-scout.magai.workers.dev/admin/tasks' -ContentType 'application/json' -Body $body -Headers @{Authorization='Bearer '+$plainValue} -TimeoutSec 20
 [pscustomobject]@{created_at=[datetime]::UtcNow.ToString('o');task=$response.task;funding_verified=$false;publication='draft-only'}|ConvertTo-Json -Depth 5 -Compress
} catch {throw 'Draft creation failed or outcome unknown; query the task title before any retry. No credential output is permitted.'}
finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer);$plainValue=$null;$secureValue=$null}
