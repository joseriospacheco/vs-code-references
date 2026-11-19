param(
  [string]$AngularWorkspace = $env:VS_REFERENCES_ANGULAR_WORKSPACE,
  [string]$AngularFile = $env:VS_REFERENCES_ANGULAR_FILE,
  [string]$AngularMethod = 'load'
)
$ErrorActionPreference = 'Stop'
$projectPath = Split-Path $PSScriptRoot -Parent
$codeExecutable = Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe'
$extensionDirectory = Join-Path $env:USERPROFILE '.vscode\extensions'
$dataDirectory = Join-Path $projectPath '.vscode-test\user-data'
$stdoutPath = Join-Path $projectPath '.vscode-test\host.stdout.log'
$stderrPath = Join-Path $projectPath '.vscode-test\host.stderr.log'
New-Item -ItemType Directory -Force -Path $dataDirectory | Out-Null
$fixtureRoot = Join-Path $projectPath 'test\fixtures'
$workspaceDefinition = Get-Content -LiteralPath (Join-Path $fixtureRoot 'integration.code-workspace') -Raw | ConvertFrom-Json
foreach ($folder in $workspaceDefinition.folders) { $folder.path = Join-Path $fixtureRoot $folder.path }
if ($AngularWorkspace) {
  if (-not $AngularFile) { throw 'Specify -AngularFile relative to -AngularWorkspace, and optionally -AngularMethod.' }
  $workspaceDefinition.folders += @{ path = [IO.Path]::GetFullPath($AngularWorkspace); name = 'Angular integration (read-only)' }
}
$generatedWorkspace = Join-Path $projectPath '.vscode-test\integration.code-workspace'
$workspaceDefinition | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $generatedWorkspace -Encoding UTF8
$launchArguments = @(
  ('"' + $generatedWorkspace + '"'),
  '--new-window',
  '--skip-welcome',
  '--skip-release-notes',
  '--disable-workspace-trust',
  '--user-data-dir', ('"' + $dataDirectory + '"'),
  '--extensions-dir', ('"' + $extensionDirectory + '"'),
  ('--extensionDevelopmentPath="' + $projectPath + '"'),
  ('--extensionTestsPath="' + (Join-Path $projectPath 'test\integration.cjs') + '"')
)
$keepIds = @('redhat.java', 'angular.ng-template', 'bmewburn.vscode-intelephense-client', 'local-dev.reflens')
$enumerateExtensions = @'
const fs = require('fs'), path = require('path'), root = process.argv[2];
for (const dir of fs.readdirSync(root, { withFileTypes: true })) {
  const file = path.join(root, dir.name, 'package.json');
  if (dir.isDirectory() && fs.existsSync(file)) {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(m.publisher + '.' + m.name);
  }
}
'@
$extensionIds = $enumerateExtensions | & node - $extensionDirectory
foreach ($id in $extensionIds) {
  if ($id -notin $keepIds) { $launchArguments += @('--disable-extension', $id) }
}
$previousElectronRunAsNode = $env:ELECTRON_RUN_AS_NODE
$previousAngularWorkspace = $env:VS_REFERENCES_ANGULAR_WORKSPACE
$previousAngularFile = $env:VS_REFERENCES_ANGULAR_FILE
$previousAngularMethod = $env:VS_REFERENCES_ANGULAR_METHOD
try {
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  $env:VS_REFERENCES_ANGULAR_WORKSPACE = $AngularWorkspace
  $env:VS_REFERENCES_ANGULAR_FILE = $AngularFile
  $env:VS_REFERENCES_ANGULAR_METHOD = $AngularMethod
  $hostProcess = Start-Process -FilePath $codeExecutable -ArgumentList $launchArguments -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput $stdoutPath -RedirectStandardError $stderrPath
  Write-Output ('Extension host exit code: ' + $hostProcess.ExitCode)
  if (Test-Path -LiteralPath (Join-Path $projectPath '.vscode-test\integration-result.json')) {
    Get-Content -LiteralPath (Join-Path $projectPath '.vscode-test\integration-result.json')
  }
  exit $hostProcess.ExitCode
} finally {
  if ($null -ne $previousElectronRunAsNode) { $env:ELECTRON_RUN_AS_NODE = $previousElectronRunAsNode }
  $env:VS_REFERENCES_ANGULAR_WORKSPACE = $previousAngularWorkspace
  $env:VS_REFERENCES_ANGULAR_FILE = $previousAngularFile
  $env:VS_REFERENCES_ANGULAR_METHOD = $previousAngularMethod
}
