# One-time setup. Makes Lite PDF start by itself each time you sign in to Windows, with no visible window.
# Uses only your own user account, so no admin rights are needed.
$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$serve = Join-Path $appDir "serve.ps1"
$powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$serve`""

$startup = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startup "Lite PDF server.lnk"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $powershell
$shortcut.Arguments = $arguments
$shortcut.WorkingDirectory = $appDir
$shortcut.WindowStyle = 7
$shortcut.Save()
Write-Host "Added sign-in startup: $shortcutPath"

Start-Process -FilePath $powershell -ArgumentList $arguments -WindowStyle Hidden
Write-Host "Server started in the background at http://localhost:8080"
Write-Host "You can now open PDFs with Lite PDF. This only needs to be run once."
