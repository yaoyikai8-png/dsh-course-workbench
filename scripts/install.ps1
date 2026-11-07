# Installs the parts of the workbench that live outside the DSH plugin package:
#   ~/.dsh/skills/<skill>/SKILL.md   the five study skills
#   ~/.dsh/tools/md2pdf.py           Markdown -> PDF converter used by the skills
#   ~/.dsh/tools/pypdf/              fpdf2, so the converter runs without a venv
#
# The panel itself is installed through DSH's plugin manager; this script prints
# the exact command at the end.
#
# Usage:  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/install.ps1
#         ... -SkipPdf     (skills only; PDF export will not work)

param([switch]$SkipPdf)

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' }
$skillsDir = Join-Path $dshHome 'skills'
$toolsDir = Join-Path $dshHome 'tools'
$pypdfDir = Join-Path $toolsDir 'pypdf'

Write-Host "DSH home : $dshHome"
Write-Host "repo     : $repo"
Write-Host ''

# --- 1. skills -------------------------------------------------------------
New-Item -ItemType Directory -Force -Path $skillsDir | Out-Null
$skills = Get-ChildItem (Join-Path $repo 'skills') -Directory
foreach ($skill in $skills) {
  $dest = Join-Path $skillsDir $skill.Name
  New-Item -ItemType Directory -Force -Path $dest | Out-Null
  Copy-Item (Join-Path $skill.FullName '*') $dest -Recurse -Force
  Write-Host ("skill    : {0}" -f $skill.Name)
}

# --- 2. converter ----------------------------------------------------------
New-Item -ItemType Directory -Force -Path $toolsDir | Out-Null
Copy-Item (Join-Path $repo 'tools\md2pdf.py') (Join-Path $toolsDir 'md2pdf.py') -Force
Write-Host "tool     : md2pdf.py"

# --- 3. fpdf2 --------------------------------------------------------------
$python = $null
foreach ($candidate in @('python', 'py')) {
  $cmd = Get-Command $candidate -ErrorAction SilentlyContinue
  if ($cmd -and $candidate -eq 'python') { $python = $cmd.Source; break }
  if ($cmd -and $candidate -eq 'py') { $python = "$($cmd.Source) -3"; break }
}

if ($SkipPdf) {
  Write-Host "pdf      : skipped (-SkipPdf)"
} elseif (-not $python) {
  Write-Warning "Python not found on PATH. Install Python 3.9+ then re-run this script,"
  Write-Warning "or install fpdf2 manually:  pip install --target `"$pypdfDir`" fpdf2"
} else {
  $probe = & cmd /c "`"$python`" -c `"import sys; sys.path.insert(0, r'$pypdfDir'); import fpdf; print(fpdf.__version__)`" 2>nul"
  if ($LASTEXITCODE -eq 0 -and $probe) {
    Write-Host "pdf      : fpdf2 $probe (already installed)"
  } else {
    Write-Host "pdf      : installing fpdf2 into $pypdfDir ..."
    & cmd /c "`"$python`" -m pip install --target `"$pypdfDir`" fpdf2 --quiet --disable-pip-version-check"
    if ($LASTEXITCODE -ne 0) {
      Write-Warning "pip install failed. Retry manually:"
      Write-Warning "  `"$python`" -m pip install --target `"$pypdfDir`" fpdf2"
    } else {
      Write-Host "pdf      : fpdf2 installed"
    }
  }

  # --- 4. end-to-end check of the converter --------------------------------
  $tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("md2pdf-check-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null
  try {
    $md = Join-Path $tmp 'check.md'
    $pdf = Join-Path $tmp 'check.pdf'
    $utf8 = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($md, "# Check`n`nChinese text 中文检查 / table:`n`n| a | b |`n|---|---|`n| 1 | 2 |`n", $utf8)
    & cmd /c "`"$python`" `"$toolsDir\md2pdf.py`" `"$md`" `"$pdf`"" | Out-Null
    if ((Test-Path $pdf) -and ((Get-Item $pdf).Length -gt 1000)) {
      Write-Host "verify   : md2pdf.py works"
    } else {
      Write-Warning "verify   : md2pdf.py produced no PDF; check the Python setup"
    }
  } finally {
    Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
  }
}

Write-Host ''
Write-Host 'Next steps'
Write-Host '  1. install the panel in DSH (plugin manager, target = this folder):'
Write-Host ("     {0}" -f $repo)
Write-Host '  2. open cordis.patch.yml and set courseRoot to the folder holding your courses'
Write-Host '  3. hard-refresh the DSH web UI (Ctrl+Shift+R) and look for the graduation-cap icon'
