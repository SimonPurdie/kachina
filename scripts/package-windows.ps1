param(
  [switch]$SkipBuild,
  [switch]$CreateDesktopShortcut
)

$ErrorActionPreference = 'Stop'

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')
$projectRootPath = $projectRoot.Path

$paths = @{
  electronExe     = Join-Path $projectRootPath 'node_modules\electron\dist\electron.exe'
  sourceSvgIcon   = Join-Path $projectRootPath 'src\renderer\assets\kachina-twirly-icon.svg'
  rendererOut     = Join-Path $projectRootPath 'dist'
  mainOut         = Join-Path $projectRootPath 'dist-electron'
  releaseRoot     = Join-Path $projectRootPath 'release\win-unpacked'
  appRoot         = Join-Path $projectRootPath 'release\win-unpacked\Kachina'
  appResources    = Join-Path $projectRootPath 'release\win-unpacked\Kachina\resources\app'
  appAssets       = Join-Path $projectRootPath 'release\win-unpacked\Kachina\resources\assets'
  packagedExe     = Join-Path $projectRootPath 'release\win-unpacked\Kachina\Kachina.exe'
  packagedIcon    = Join-Path $projectRootPath 'release\win-unpacked\Kachina\resources\assets\kachina.ico'
  releaseShortcut = Join-Path $projectRootPath 'release\win-unpacked\Kachina.lnk'
  localIcon       = Join-Path $projectRootPath 'build\icons\kachina.ico'
}

if (-not (Test-Path -LiteralPath $paths.electronExe)) {
  throw "Electron binary not found at '$($paths.electronExe)'. Run 'npm install' first."
}

$magick = Get-Command -Name 'magick' -ErrorAction SilentlyContinue
if (-not $magick) {
  throw "ImageMagick ('magick') is required to generate the .ico file."
}

if (Test-Path -LiteralPath $paths.releaseRoot) {
  Remove-Item -LiteralPath $paths.releaseRoot -Recurse -Force
}

New-Item -ItemType Directory -Path $paths.appRoot -Force | Out-Null
New-Item -ItemType Directory -Path $paths.appResources -Force | Out-Null
New-Item -ItemType Directory -Path $paths.appAssets -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $paths.localIcon) -Force | Out-Null

if (-not $SkipBuild) {
  Write-Host 'Building renderer and main process...'
  & npm run build
  if ($LASTEXITCODE -ne 0) {
    throw "Build failed with exit code $LASTEXITCODE."
  }
} else {
  Write-Host 'Skipping build because -SkipBuild was provided.'
}

if (-not (Test-Path -LiteralPath $paths.rendererOut)) {
  throw "Renderer output '$($paths.rendererOut)' was not produced."
}
if (-not (Test-Path -LiteralPath $paths.mainOut)) {
  throw "Main process output '$($paths.mainOut)' was not produced."
}

Write-Host 'Creating Windows icon (.ico) from SVG...'
& $magick.Source $paths.sourceSvgIcon -background none -define 'icon:auto-resize=16,24,32,48,64,128,256' $paths.packagedIcon
if ($LASTEXITCODE -ne 0) {
  throw "Icon conversion failed with exit code $LASTEXITCODE."
}
Copy-Item -LiteralPath $paths.packagedIcon -Destination $paths.localIcon -Force

Write-Host 'Assembling portable Electron app...'
$electronDist = Join-Path $projectRootPath 'node_modules\electron\dist'
Copy-Item -Path (Join-Path $electronDist '*') -Destination $paths.appRoot -Recurse -Force
Copy-Item -LiteralPath $paths.rendererOut -Destination $paths.appResources -Recurse -Force
Copy-Item -LiteralPath $paths.mainOut -Destination $paths.appResources -Recurse -Force

$rootPackageJson = Get-Content -LiteralPath (Join-Path $projectRootPath 'package.json') -Raw | ConvertFrom-Json
$runtimePackageJson = @{
  name        = $rootPackageJson.name
  version     = $rootPackageJson.version
  main        = 'dist-electron/main/index.js'
  productName = 'Kachina'
}
$runtimePackagePath = Join-Path $paths.appResources 'package.json'
$runtimePackageJsonText = $runtimePackageJson | ConvertTo-Json -Depth 4
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($runtimePackagePath, $runtimePackageJsonText, $utf8NoBom)

if (Test-Path -LiteralPath (Join-Path $paths.appRoot 'electron.exe')) {
  Rename-Item -LiteralPath (Join-Path $paths.appRoot 'electron.exe') -NewName 'Kachina.exe'
}

$wshShell = New-Object -ComObject WScript.Shell
$releaseShortcut = $wshShell.CreateShortcut($paths.releaseShortcut)
$releaseShortcut.TargetPath = $paths.packagedExe
$releaseShortcut.WorkingDirectory = $paths.appRoot
$releaseShortcut.IconLocation = "$($paths.packagedIcon),0"
$releaseShortcut.Save()

if ($CreateDesktopShortcut) {
  $desktopPath = [Environment]::GetFolderPath('Desktop')
  $desktopShortcutPath = Join-Path $desktopPath 'Kachina.lnk'
  $desktopShortcut = $wshShell.CreateShortcut($desktopShortcutPath)
  $desktopShortcut.TargetPath = $paths.packagedExe
  $desktopShortcut.WorkingDirectory = $paths.appRoot
  $desktopShortcut.IconLocation = "$($paths.packagedIcon),0"
  $desktopShortcut.Save()
}

Write-Host ''
Write-Host 'Packaging complete:'
Write-Host "  EXE: $($paths.packagedExe)"
Write-Host "  Icon: $($paths.packagedIcon)"
Write-Host "  Shortcut: $($paths.releaseShortcut)"
if ($CreateDesktopShortcut) {
  Write-Host "  Desktop shortcut: $([Environment]::GetFolderPath('Desktop'))\\Kachina.lnk"
}
