param(
  [Parameter(Mandatory=$true)][string]$JavaPath,
  [Parameter(Mandatory=$true)][string]$EmulatorJar,
  [Parameter(Mandatory=$true)][string]$SocketTempDirectory
)
$ErrorActionPreference = 'Stop'
# Use the already verified portable runtime; no download, credentials or deployment.
New-Item -ItemType Directory -Force -Path $SocketTempDirectory | Out-Null
$socketDirectory = (Resolve-Path -LiteralPath $SocketTempDirectory).Path
& $JavaPath '-Duser.language=en' "-Djdk.net.unixdomain.tmpdir=$socketDirectory" -jar $EmulatorJar --host 127.0.0.1 --port 9000
exit $LASTEXITCODE
