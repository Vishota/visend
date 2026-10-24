$tokens = $null
$errs = $null
$ast = [System.Management.Automation.Language.Parser]::ParseFile(
    (Join-Path $PSScriptRoot '..\powershell\visend.ps1'), [ref]$tokens, [ref]$errs)
if ($errs.Count -gt 0) {
    $errs | ForEach-Object { Write-Output ("PARSE ERROR: " + $_.Message + " @ line " + $_.Extent.StartLineNumber) }
    exit 1
}
Write-Output 'PS_PARSE_OK'
