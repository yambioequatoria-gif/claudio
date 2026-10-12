# One-time setup. Makes Lite PDF start by itself each time you sign in to Windows, with no visible window.
# Uses only your own user account, so no admin rights are needed.
$appDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# The app needs these files. If any are missing, the download was incomplete or from the wrong branch.
$required = @("index.html", "app.js", "app.css", "serve.ps1", "vendor\pdfjs\pdf.mjs", "vendor\pdfjs\pdf.worker.mjs", "vendor\pdfjs\pdf_viewer.mjs")
$missing = $required | Where-Object { -not (Test-Path -LiteralPath (Join-Path $appDir $_) -PathType Leaf) }
if ($missing) {
  Write-Host "This folder is incomplete. Missing files:"
  $missing | ForEach-Object { Write-Host "  $_" }
  Write-Host "Download the zip of branch claude/chat-vs-code-comparison-gg5ifg again and run setup.bat from its app folder."
  return
}
$serve = Join-Path $appDir "serve.ps1"
$powershell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
$arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$serve`""
$logFile = Join-Path $env:LOCALAPPDATA "LitePDF\server.log"

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
Start-Sleep -Seconds 3

try {
  $response = Invoke-WebRequest -Uri "http://localhost:8080/" -UseBasicParsing -TimeoutSec 5
  Write-Host "Working: http://localhost:8080 responded with $($response.StatusCode)."
  Write-Host "You can now open PDFs with Lite PDF. This only needs to be run once."
} catch {
  Write-Host "The server did not respond: $($_.Exception.Message)"
  Write-Host "Details are in: $logFile"
  Write-Host "Send that file to whoever is helping you."
}
