# Read-only owner health check. Never prints or places the credential in a URL.
$ErrorActionPreference = 'Stop'
$credentialPath = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'MAG\owner-admin\worker-admin.dpapi.xml'
$secureValue = Import-Clixml -LiteralPath $credentialPath
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
try {
  $plainValue = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  $response = Invoke-RestMethod -Method Get -Uri 'https://mavverick-scout.magai.workers.dev/admin/config' -Headers @{Authorization='Bearer '+$plainValue} -TimeoutSec 20
  [PSCustomObject]@{ authenticated=$true; received_configuration=[bool]$response; checked_at=[DateTime]::UtcNow.ToString('o') } | ConvertTo-Json
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  $plainValue = $null
  $secureValue = $null
}

