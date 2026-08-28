param(
  [Parameter(Mandatory=$true)][string]$NodePath,
  [Parameter(Mandatory=$true)][string]$BuildDirectory
)
$ErrorActionPreference = 'Stop'
$workerName = 'mavverick-scout'
$secretName = 'SCOUT_ADMIN_TOKEN'
$buildPath = (Resolve-Path -LiteralPath $BuildDirectory).Path
$wranglerPath = Join-Path $buildPath 'node_modules\wrangler\bin\wrangler.js'
$configPath = Join-Path $buildPath 'wrangler.jsonc'
if (-not (Test-Path -LiteralPath $wranglerPath) -or -not (Test-Path -LiteralPath $configPath)) { throw 'Validated Wrangler build is required.' }
$settings = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
if ($settings.name -ne $workerName) { throw 'Unexpected Worker target; no credential changed.' }
Set-Location -LiteralPath $buildPath
$names = & $NodePath $wranglerPath secret list --name $workerName --config $configPath
if ($LASTEXITCODE -ne 0) { throw 'Could not inspect existing secret names.' }
$existing = @($names | ConvertFrom-Json) | Where-Object { $_.name -eq $secretName }
$credentialDirectory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'MAG\owner-admin'
$credentialPath = Join-Path $credentialDirectory 'worker-admin.dpapi.xml'
if ($existing) {
  if (Test-Path -LiteralPath $credentialPath) { Write-Output 'Owner credential already configured. No rotation performed.'; exit 0 }
  throw 'An owner credential already exists without this local recovery record. Refusing to overwrite it.'
}
if (-not (Test-Path -LiteralPath $credentialDirectory)) { New-Item -ItemType Directory -Path $credentialDirectory | Out-Null }
$ownerSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($ownerSid)
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($ownerSid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))
Set-Acl -LiteralPath $credentialDirectory -AclObject $acl
if (Test-Path -LiteralPath $credentialPath) {
  $secureValue = Import-Clixml -LiteralPath $credentialPath
} else {
  $randomBytes = New-Object byte[] 48
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($randomBytes) } finally { $rng.Dispose() }
  $generatedValue = [Convert]::ToBase64String($randomBytes)
  $secureValue = ConvertTo-SecureString $generatedValue -AsPlainText -Force
  $secureValue | Export-Clixml -LiteralPath $credentialPath
  $generatedValue = $null
  [Array]::Clear($randomBytes,0,$randomBytes.Length)
}
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureValue)
try {
  $plainValue = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  $processInfo = New-Object Diagnostics.ProcessStartInfo
  $processInfo.FileName = (Resolve-Path -LiteralPath $NodePath).Path
  $processInfo.Arguments = '"'+$wranglerPath+'" secret put '+$secretName+' --name '+$workerName+' --config "'+$configPath+'"'
  $processInfo.WorkingDirectory = $buildPath
  $processInfo.UseShellExecute = $false
  $processInfo.CreateNoWindow = $true
  $processInfo.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
  $processInfo.RedirectStandardInput = $true
  $processInfo.RedirectStandardOutput = $true
  $processInfo.RedirectStandardError = $true
  $child = New-Object Diagnostics.Process
  $child.StartInfo = $processInfo
  [void]$child.Start()
  $stdoutTask = $child.StandardOutput.ReadToEndAsync()
  $stderrTask = $child.StandardError.ReadToEndAsync()
  $child.StandardInput.WriteLine($plainValue)
  $child.StandardInput.Close()
  $plainValue = $null
  if (-not $child.WaitForExit(60000)) { $child.Kill(); throw 'Secret upload timed out. Inspect secret names before retrying.' }
  $output = $stdoutTask.GetAwaiter().GetResult()
  $diagnostic = $stderrTask.GetAwaiter().GetResult()
  if ($child.ExitCode -ne 0) { throw 'Secret upload failed. Raw CLI output was withheld to protect credentials; inspect secret names before retrying.' }
  Write-Output ('Owner credential configured for '+$workerName+'. Recovery is DPAPI-encrypted for this Windows user outside Git.')
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  $plainValue = $null
  $secureValue = $null
}

