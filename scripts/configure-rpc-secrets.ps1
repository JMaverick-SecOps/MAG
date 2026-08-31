#requires -Version 7.0
# Owner-run, hidden-input credential handoff. Never pass secrets as arguments.
# This updates only three Worker secrets, not wallets, payment flags or plans.
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$wranglerPath = Join-Path $taskRoot 'node_modules\wrangler\bin\wrangler.js'
if (-not (Test-Path -LiteralPath $wranglerPath)) { throw 'Use the MAG checkout with its existing Wrangler installation.' }
$runtime = (Get-Command node -CommandType Application | Select-Object -First 1).Source
$keySecure = $null; $endpointSecure = $null; $keyPointer = [IntPtr]::Zero; $endpointPointer = [IntPtr]::Zero
$keyValue = $null; $endpointValue = $null; $payload = $null; $bundle = $null; $child = $null
try {
  Write-Host 'MAG -> mavverick-scout. Use the NEW rotated credentials. Input is hidden.'
  $keySecure = Read-Host 'Alchemy API key from MAG Chain Infrastructure' -AsSecureString
  $endpointSecure = Read-Host 'OnFinality MAG Base Payment Witness: full Base HTTPS endpoint' -AsSecureString
  $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($keySecure)
  $endpointPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($endpointSecure)
  $keyValue = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
  $endpointValue = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($endpointPointer)
  if ($keyValue -cnotmatch '^[A-Za-z0-9_-]{20,128}$') { throw 'Invalid Alchemy key format. Nothing uploaded.' }
  $parsedEndpoint = $null
  if (-not [Uri]::TryCreate($endpointValue,[UriKind]::Absolute,[ref]$parsedEndpoint)) { throw 'Invalid endpoint. Nothing uploaded.' }
  if ($parsedEndpoint.Scheme -ne 'https' -or $parsedEndpoint.Host -ne 'base.api.onfinality.io' -or
      -not $parsedEndpoint.IsDefaultPort -or $parsedEndpoint.UserInfo -or $parsedEndpoint.Fragment -or
      $endpointValue -match '\s' -or $endpointValue.Length -gt 2048 -or $parsedEndpoint.AbsolutePath -eq '/public') {
    throw 'Use the private OnFinality Base mainnet HTTPS endpoint, not public RPC or WebSocket. Nothing uploaded.'
  }
  $bundle = @{
    MAG_ALCHEMY_API_KEY = $keyValue
    MAG_BASE_RPC_PRIMARY_URL = 'https://base-mainnet.g.alchemy.com/v2/' + $keyValue
    MAG_BASE_RPC_SECONDARY_URL = $endpointValue
  }
  $payload = ConvertTo-Json -InputObject $bundle -Compress
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $runtime
  $startInfo.WorkingDirectory = $taskRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardInput = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  foreach ($argument in @($wranglerPath,'secret','bulk','--name','mavverick-scout','--config',(Join-Path $taskRoot 'wrangler.jsonc'))) {
    $startInfo.ArgumentList.Add($argument)
  }
  $startInfo.Environment['CLOUDFLARE_ACCOUNT_ID'] = '94130c1b7160b2b7a6f45a15f026bc6d'
  $startInfo.Environment['WRANGLER_LOG_SANITIZE'] = 'true'
  $startInfo.Environment['WRANGLER_SEND_METRICS'] = 'false'
  $startInfo.Environment['WRANGLER_LOG'] = 'error'
  $child = [Diagnostics.Process]::new()
  $child.StartInfo = $startInfo
  if (-not $child.Start()) { throw 'Could not start the existing Wrangler installation.' }
  $outputTask = $child.StandardOutput.ReadToEndAsync()
  $errorTask = $child.StandardError.ReadToEndAsync()
  $child.StandardInput.WriteLine($payload)
  $child.StandardInput.Close()
  if (-not $child.WaitForExit(60000)) {
    $child.Kill($true)
    throw 'Secret upload timed out; outcome unknown. Verify secret names before retrying.'
  }
  # Never echo child output: errors from a provider can contain submitted data.
  $null = $outputTask.GetAwaiter().GetResult()
  $null = $errorTask.GetAwaiter().GetResult()
  if ($child.ExitCode -ne 0) { throw 'Cloudflare did not confirm the upload. Check Wrangler login and account access; credentials were not printed.' }
  Write-Host 'Cloudflare confirmed the three secret bindings. Payment flags remain unchanged.'
  Write-Host 'Next: verify /admin/payment-rpc-health and /admin/alchemy/health from the deployed Worker.'
} finally {
  if ($keyPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer) }
  if ($endpointPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($endpointPointer) }
  if ($null -ne $keySecure) { $keySecure.Dispose() }
  if ($null -ne $endpointSecure) { $endpointSecure.Dispose() }
  if ($null -ne $child) { $child.Dispose() }
  $bundle = $null; $payload = $null; $keyValue = $null; $endpointValue = $null
}
