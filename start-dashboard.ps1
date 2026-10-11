$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

try {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCommand) {
        $nodePath = $nodeCommand.Source
    } else {
        $nodePath = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
        if (-not (Test-Path -LiteralPath $nodePath)) {
            throw 'Node.js was not found. Install Node.js, then double-click start.bat again.'
        }
    }

    # Match this firmware's key even if an older key is set in Windows.
    $secretsPath = Join-Path $PSScriptRoot 'firmware\nodemcu_master\secrets.h'
    if (Test-Path -LiteralPath $secretsPath) {
        $keyMatch = [regex]::Match((Get-Content -LiteralPath $secretsPath -Raw), '(?m)^\s*#define\s+DEVICE_API_KEY\s+"([^"\r\n]+)"')
        if ($keyMatch.Success) {
            $env:DOPPLER_DEVICE_KEY = $keyMatch.Groups[1].Value
        }
    }

    $dashboardPort = 8080
    if ($env:PORT) {
        $dashboardPort = [int]$env:PORT
    }
    if ($dashboardPort -lt 1 -or $dashboardPort -gt 65535) {
        throw 'PORT must be between 1 and 65535.'
    }
    Write-Host "Starting dashboard at http://localhost:$dashboardPort"
    Write-Host 'Keep this window open. Press Ctrl+C to stop the dashboard.'
    Start-Process "http://localhost:$dashboardPort"
    & $nodePath (Join-Path $PSScriptRoot 'server.js')
    exit $LASTEXITCODE
} catch {
    Write-Host $_.Exception.Message -ForegroundColor Red
    exit 1
}
