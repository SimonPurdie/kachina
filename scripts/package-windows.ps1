param(
  [switch]$SkipBuild,
  [switch]$CreateDesktopShortcut
)

$ErrorActionPreference = 'Stop'

$projectRoot = Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')
$projectRootPath = $projectRoot.Path

$paths = @{
  electronExe     = Join-Path $projectRootPath 'node_modules\electron\dist\electron.exe'
  sourceIcoIcon   = Join-Path $projectRootPath 'build\icons\kachina.ico'
  sourcePngIcon   = Join-Path $projectRootPath 'src\renderer\assets\kachina-twirly-icon.png'
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

function Get-MagickCommand {
  $magick = Get-Command -Name 'magick' -ErrorAction SilentlyContinue
  if (-not $magick) {
    throw "ImageMagick ('magick') is required when no prebuilt .ico exists."
  }
  return $magick
}

function Resolve-IconPath {
  if (Test-Path -LiteralPath $paths.sourceIcoIcon) {
    Write-Host "Using existing icon: $($paths.sourceIcoIcon)"
    return $paths.sourceIcoIcon
  }

  $magick = Get-MagickCommand
  New-Item -ItemType Directory -Path (Split-Path -Parent $paths.sourceIcoIcon) -Force | Out-Null

  if (Test-Path -LiteralPath $paths.sourcePngIcon) {
    Write-Host 'Creating Windows icon (.ico) from PNG...'
    & $magick.Source $paths.sourcePngIcon -background none -define 'icon:auto-resize=16,24,32,48,64,128,256' $paths.sourceIcoIcon
    if ($LASTEXITCODE -ne 0) {
      throw "Icon conversion from PNG failed with exit code $LASTEXITCODE."
    }
    return $paths.sourceIcoIcon
  }

  if (Test-Path -LiteralPath $paths.sourceSvgIcon) {
    Write-Host 'Creating Windows icon (.ico) from SVG...'
    & $magick.Source $paths.sourceSvgIcon -background none -define 'icon:auto-resize=16,24,32,48,64,128,256' $paths.sourceIcoIcon
    if ($LASTEXITCODE -ne 0) {
      throw "Icon conversion from SVG failed with exit code $LASTEXITCODE."
    }
    return $paths.sourceIcoIcon
  }

  throw "No icon source found. Provide '$($paths.sourceIcoIcon)' or '$($paths.sourcePngIcon)' or '$($paths.sourceSvgIcon)'."
}

function Set-ExecutableIcon {
  param(
    [Parameter(Mandatory = $true)]
    [string]$ExecutablePath,
    [Parameter(Mandatory = $true)]
    [string]$IconPath
  )

  if (-not ("Kachina.ExeIconUpdater" -as [type])) {
    Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;

namespace Kachina
{
    public static class ExeIconUpdater
    {
        private const int RT_ICON = 3;
        private const int RT_GROUP_ICON = 14;
        private const int GROUP_ICON_ID_PRIMARY = 1;
        private const int GROUP_ICON_ID_FALLBACK = 32512;
        private const int ICON_BASE_ID = 5001;

        [StructLayout(LayoutKind.Sequential)]
        private struct IconDirEntry
        {
            public byte Width;
            public byte Height;
            public byte ColorCount;
            public byte Reserved;
            public ushort Planes;
            public ushort BitCount;
            public uint BytesInRes;
            public uint ImageOffset;
        }

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
        private static extern IntPtr BeginUpdateResource(string pFileName, bool bDeleteExistingResources);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool UpdateResource(
            IntPtr hUpdate,
            IntPtr lpType,
            IntPtr lpName,
            ushort wLanguage,
            byte[] lpData,
            uint cbData);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool EndUpdateResource(IntPtr hUpdate, bool fDiscard);

        private static IntPtr MakeIntResource(int id)
        {
            return (IntPtr)id;
        }

        public static void ApplyIcon(string exePath, string icoPath)
        {
            if (!File.Exists(exePath))
            {
                throw new FileNotFoundException("Executable not found.", exePath);
            }
            if (!File.Exists(icoPath))
            {
                throw new FileNotFoundException("Icon file not found.", icoPath);
            }

            byte[] iconFile = File.ReadAllBytes(icoPath);
            IconDirEntry[] entries;
            byte[][] iconImages;
            ParseIco(iconFile, out entries, out iconImages);

            IntPtr updateHandle = BeginUpdateResource(exePath, false);
            if (updateHandle == IntPtr.Zero)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "BeginUpdateResource failed.");
            }

            bool discardChanges = true;
            try
            {
                ushort[] languages = new ushort[] { 0, 1033 };
                foreach (ushort language in languages)
                {
                    for (int i = 0; i < iconImages.Length; i++)
                    {
                        int iconId = ICON_BASE_ID + i;
                        UpdateResourceChecked(
                            updateHandle,
                            RT_ICON,
                            iconId,
                            language,
                            iconImages[i],
                            "RT_ICON/" + iconId + "/lang" + language);
                    }

                    byte[] groupData = BuildGroupIconData(entries);
                    UpdateResourceChecked(
                        updateHandle,
                        RT_GROUP_ICON,
                        GROUP_ICON_ID_PRIMARY,
                        language,
                        groupData,
                        "RT_GROUP_ICON/" + GROUP_ICON_ID_PRIMARY + "/lang" + language);

                    UpdateResourceChecked(
                        updateHandle,
                        RT_GROUP_ICON,
                        GROUP_ICON_ID_FALLBACK,
                        language,
                        groupData,
                        "RT_GROUP_ICON/" + GROUP_ICON_ID_FALLBACK + "/lang" + language);
                }

                discardChanges = false;
            }
            finally
            {
                if (!EndUpdateResource(updateHandle, discardChanges))
                {
                    throw new Win32Exception(Marshal.GetLastWin32Error(), "EndUpdateResource failed.");
                }
            }
        }

        private static void ParseIco(byte[] iconFile, out IconDirEntry[] entries, out byte[][] iconImages)
        {
            using (MemoryStream stream = new MemoryStream(iconFile))
            using (BinaryReader reader = new BinaryReader(stream))
            {
                ushort reserved = reader.ReadUInt16();
                ushort type = reader.ReadUInt16();
                ushort count = reader.ReadUInt16();
                if (reserved != 0 || type != 1 || count == 0)
                {
                    throw new InvalidDataException("Invalid ICO header.");
                }

                entries = new IconDirEntry[count];
                for (int i = 0; i < count; i++)
                {
                    IconDirEntry entry = new IconDirEntry();
                    entry.Width = reader.ReadByte();
                    entry.Height = reader.ReadByte();
                    entry.ColorCount = reader.ReadByte();
                    entry.Reserved = reader.ReadByte();
                    entry.Planes = reader.ReadUInt16();
                    entry.BitCount = reader.ReadUInt16();
                    entry.BytesInRes = reader.ReadUInt32();
                    entry.ImageOffset = reader.ReadUInt32();
                    entries[i] = entry;
                }

                iconImages = new byte[count][];
                for (int i = 0; i < count; i++)
                {
                    IconDirEntry entry = entries[i];
                    if ((entry.ImageOffset + entry.BytesInRes) > iconFile.Length)
                    {
                        throw new InvalidDataException("ICO entry points outside file bounds.");
                    }

                    byte[] image = new byte[entry.BytesInRes];
                    Buffer.BlockCopy(iconFile, (int)entry.ImageOffset, image, 0, (int)entry.BytesInRes);
                    iconImages[i] = image;
                }
            }
        }

        private static byte[] BuildGroupIconData(IconDirEntry[] entries)
        {
            using (MemoryStream stream = new MemoryStream())
            using (BinaryWriter writer = new BinaryWriter(stream))
            {
                writer.Write((ushort)0);
                writer.Write((ushort)1);
                writer.Write((ushort)entries.Length);

                for (int i = 0; i < entries.Length; i++)
                {
                    IconDirEntry entry = entries[i];
                    writer.Write(entry.Width);
                    writer.Write(entry.Height);
                    writer.Write(entry.ColorCount);
                    writer.Write(entry.Reserved);
                    writer.Write(entry.Planes);
                    writer.Write(entry.BitCount);
                    writer.Write(entry.BytesInRes);
                    writer.Write((ushort)(ICON_BASE_ID + i));
                }

                writer.Flush();
                return stream.ToArray();
            }
        }

        private static void UpdateResourceChecked(
            IntPtr updateHandle,
            int typeId,
            int nameId,
            ushort language,
            byte[] data,
            string label)
        {
            bool success = UpdateResource(
                updateHandle,
                MakeIntResource(typeId),
                MakeIntResource(nameId),
                language,
                data,
                (uint)data.Length);

            if (!success)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error(), "UpdateResource failed for " + label + ".");
            }
        }
    }
}
'@
  }

  [Kachina.ExeIconUpdater]::ApplyIcon($ExecutablePath, $IconPath)
}

function Stop-RunningPackagedProcesses {
  param(
    [Parameter(Mandatory = $true)]
    [string]$AppRootPath
  )

  $runningProcesses = @()
  Get-Process -ErrorAction SilentlyContinue | ForEach-Object {
    $processPath = $null
    try {
      $processPath = $_.Path
    } catch {
      $processPath = $null
    }

    if ($processPath -and $processPath.StartsWith($AppRootPath, [System.StringComparison]::OrdinalIgnoreCase)) {
      $runningProcesses += $_
    }
  }

  if ($runningProcesses.Count -eq 0) {
    return
  }

  Write-Host "Stopping running packaged app processes: $($runningProcesses.Count)"
  $runningProcesses | ForEach-Object {
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Milliseconds 500
}

Stop-RunningPackagedProcesses -AppRootPath $paths.appRoot
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

$resolvedIconPath = Resolve-IconPath

Write-Host 'Assembling portable Electron app...'
$electronDist = Join-Path $projectRootPath 'node_modules\electron\dist'
Copy-Item -Path (Join-Path $electronDist '*') -Destination $paths.appRoot -Recurse -Force
Copy-Item -LiteralPath $paths.rendererOut -Destination $paths.appResources -Recurse -Force
Copy-Item -LiteralPath $paths.mainOut -Destination $paths.appResources -Recurse -Force
Copy-Item -LiteralPath $resolvedIconPath -Destination $paths.packagedIcon -Force

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

Write-Host 'Stamping icon into Kachina.exe resources...'
Set-ExecutableIcon -ExecutablePath $paths.packagedExe -IconPath $paths.packagedIcon

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
