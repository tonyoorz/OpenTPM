$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$launcherPath = Join-Path $repositoryRoot 'start-all.bat'
$launcher = Get-Content $launcherPath -Raw
$package = Get-Content (Join-Path $repositoryRoot 'package.json') -Raw | ConvertFrom-Json

$expectations = @(
  @{ Description = 'uses a repository-relative root path'; Pattern = '%~dp0' }
  @{ Description = 'starts the repository session keeper'; Pattern = 'services\\session-keeper\\.venv\\Scripts\\python.exe' }
  @{ Description = 'starts the session keeper with its delayed-expanded Python path'; Pattern = 'start "OpenTPM Session Keeper"[^\r\n]*"!SESSION_KEEPER_PYTHON!"' }
  @{ Description = 'loads local configuration for the session keeper'; Pattern = '-m uvicorn[^\r\n]*--env-file "%ROOT_DIR%\.env"' }
  @{ Description = 'resolves the Windows system proxy for BMW SSO'; Pattern = 'DefaultWebProxy\.GetProxy' }
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

$proxyParser = [regex]::Match($launcher, '(?m)^\s*node\.exe -e "([^"]+)" "%ROOT_DIR%\.env"\s*$')
if (-not $proxyParser.Success) {
  throw 'start-all.bat must parse proxy overrides with dotenv'
}

$fixturePath = Join-Path $PSScriptRoot ("proxy-config-{0}.tmp" -f [Guid]::NewGuid())
$overrideCases = @(
  @{ Name = 'missing override'; Contents = 'BMW_SSO_ENABLED=true'; ExitCode = 1 }
  @{ Name = 'commented override'; Contents = '# SESSION_KEEPER_PROXY_URL='; ExitCode = 1 }
  @{ Name = 'empty override'; Contents = 'SESSION_KEEPER_PROXY_URL='; ExitCode = 0 }
  @{ Name = 'exported override'; Contents = 'export SESSION_KEEPER_PROXY_URL='; ExitCode = 0 }
  @{ Name = 'tab-prefixed override'; Contents = "`tSESSION_KEEPER_PROXY_URL=http://proxy.example:8080"; ExitCode = 0 }
  @{ Name = 'lowercase override'; Contents = 'session_keeper_proxy_url='; ExitCode = 0 }
)

try {
  foreach ($overrideCase in $overrideCases) {
    [System.IO.File]::WriteAllText($fixturePath, $overrideCase.Contents)
    & node.exe -e $proxyParser.Groups[1].Value $fixturePath
    if ($LASTEXITCODE -ne $overrideCase.ExitCode) {
      throw "start-all.bat must honor $($overrideCase.Name)"
    }
  }
} finally {
  Remove-Item -LiteralPath $fixturePath -ErrorAction SilentlyContinue
}

Write-Output 'start-all launcher contract passed'