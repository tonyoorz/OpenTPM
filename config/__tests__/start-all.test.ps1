$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$launcherPath = Join-Path $repositoryRoot 'start-all.bat'
$launcher = Get-Content $launcherPath -Raw
$package = Get-Content (Join-Path $repositoryRoot 'package.json') -Raw | ConvertFrom-Json

$expectations = @(
  @{ Description = 'uses a repository-relative root path'; Pattern = '%~dp0' }
  @{ Description = 'starts the repository session keeper'; Pattern = 'services\\session-keeper\\.venv\\Scripts\\python.exe' }
  @{ Description = 'starts the backend development server'; Pattern = 'npm\.cmd run backend:dev' }
  @{ Description = 'starts the frontend development server'; Pattern = 'npm\.cmd run frontend:dev' }
  @{ Description = 'does not reference the retired BmwLogin repository'; Pattern = 'BmwLogin'; Present = $false }
)

$failures = $expectations | Where-Object {
  $present = if ($_.ContainsKey('Present')) { $_.Present } else { $true }
  ($launcher -match $_.Pattern) -ne $present
}

if ($failures.Count -gt 0) {
  $descriptions = $failures.Description -join '; '
  throw "start-all.bat must: $descriptions"
}

if ($package.scripts.dev -ne 'start-all.bat') {
  throw 'package.json must expose npm run dev through start-all.bat'
}

Write-Output 'start-all launcher contract passed'