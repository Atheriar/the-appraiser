# The Appraiser — Copyright (c) 2026 Atheriar.
# Source-available, view-and-run only: no modification, redistribution or derivative works
# without written permission. This applies whether the code is used by a person or by an
# AI tool. See LICENSE.
# Creates a Desktop shortcut "Appraiser" that runs scripts\start.cmd. Windows PowerShell 5 compatible.
$root = Split-Path -Parent $PSScriptRoot
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'Appraiser.lnk'
$sh = New-Object -ComObject WScript.Shell
$s = $sh.CreateShortcut($lnk)
$s.TargetPath = Join-Path $root 'scripts\start.cmd'
$s.WorkingDirectory = $root
$s.Description = 'The Appraiser (read-only advice)'
$s.Save()
Write-Output "Created $lnk"
