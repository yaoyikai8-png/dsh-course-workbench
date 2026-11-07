# Removes what scripts/install.ps1 put under ~/.dsh (skills + converter).
# The DSH plugin itself is removed through the plugin manager, and the panel's
# own state file (~/.dsh/tongji-course-workbench.json) is left alone unless -Purge.
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/uninstall.ps1 [-Purge]

param([switch]$Purge)

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }

foreach ($skill in (Get-ChildItem (Join-Path $repo 'skills') -Directory)) {
  $dest = Join-Path (Join-Path $dshHome 'skills') $skill.Name
  if (Test-Path $dest) {
    Remove-Item $dest -Recurse -Force
    Write-Host ("removed  : skills\{0}" -f $skill.Name)
  }
}

$tool = Join-Path (Join-Path $dshHome 'tools') 'md2pdf.py'
if (Test-Path $tool) {
  Remove-Item $tool -Force
  Write-Host 'removed  : tools\md2pdf.py'
}

$pypdf = Join-Path (Join-Path $dshHome 'tools') 'pypdf'
if (Test-Path $pypdf) {
  Remove-Item $pypdf -Recurse -Force
  Write-Host 'removed  : tools\pypdf'
}

if ($Purge) {
  $state = Join-Path $dshHome 'tongji-course-workbench.json'
  if (Test-Path $state) {
    Remove-Item $state -Force
    Write-Host 'removed  : tongji-course-workbench.json'
  }
}

Write-Host ''
Write-Host 'Remember to remove the bundle too: plugin_manager remove_bundle target=tongji-course-workbench'
