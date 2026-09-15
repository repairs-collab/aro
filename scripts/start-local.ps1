$ErrorActionPreference = 'Stop'
$pluginRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$nodePath = $env:AROFLO_NODE_PATH

if (-not $nodePath) {
    $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCommand) { $nodePath = $nodeCommand.Source }
}

if (-not $nodePath -and $env:USERPROFILE) {
    $bundledNode = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $bundledNode -PathType Leaf) { $nodePath = $bundledNode }
}

if (-not $nodePath -or -not (Test-Path -LiteralPath $nodePath -PathType Leaf)) {
    [Console]::Error.WriteLine('A Node.js 20+ runtime was not found. Set AROFLO_NODE_PATH or install Node.js.')
    exit 1
}

& $nodePath (Join-Path $pluginRoot 'dist\src\transports\stdio.js')
exit $LASTEXITCODE
