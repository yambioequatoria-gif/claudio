# Serves the Lite PDF app on this computer only (127.0.0.1). Nothing is reachable from the network.
# Uses a plain TCP listener, so it needs no administrator rights or URL reservations.
# Usage: powershell -ExecutionPolicy Bypass -File serve.ps1 [-Port 8080]
param([int]$Port = 8080)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootFull = [System.IO.Path]::GetFullPath($root)

$logDir = Join-Path $env:LOCALAPPDATA "LitePDF"
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$logFile = Join-Path $logDir "server.log"

function Write-Log($message) {
  try {
    Add-Content -LiteralPath $logFile -Value ("{0}  {1}" -f (Get-Date -Format "s"), $message)
  } catch {
    # Logging must never stop the server.
  }
}

$types = @{
  ".html" = "text/html; charset=utf-8"
  ".js"   = "text/javascript; charset=utf-8"
  ".mjs"  = "text/javascript; charset=utf-8"
  ".css"  = "text/css; charset=utf-8"
  ".json" = "application/json; charset=utf-8"
  ".webmanifest" = "application/manifest+json; charset=utf-8"
  ".svg"  = "image/svg+xml"
  ".png"  = "image/png"
  ".gif"  = "image/gif"
  ".wasm" = "application/wasm"
  ".bcmap" = "application/octet-stream"
  ".pfb"  = "application/octet-stream"
  ".ttf"  = "font/ttf"
  ".pdf"  = "application/pdf"
}

function Send-Response($stream, [int]$status, $contentType, [byte[]]$body, [bool]$headOnly) {
  $reason = if ($status -eq 200) { "OK" } elseif ($status -eq 404) { "Not Found" } else { "Bad Request" }
  $header = "HTTP/1.1 $status $reason`r`nContent-Type: $contentType`r`nContent-Length: $($body.Length)`r`nCache-Control: no-cache`r`nConnection: close`r`n`r`n"
  $headerBytes = [System.Text.Encoding]::ASCII.GetBytes($header)
  $stream.Write($headerBytes, 0, $headerBytes.Length)
  if (-not $headOnly) { $stream.Write($body, 0, $body.Length) }
}

try {
  $listener = New-Object System.Net.Sockets.TcpListener ([System.Net.IPAddress]::Loopback), $Port
  $listener.Start()
} catch {
  Write-Log "Could not start on port $Port : $($_.Exception.Message)"
  throw
}
Write-Log "Listening on http://localhost:$Port/ from $rootFull"
Write-Host "Lite PDF running at http://localhost:$Port/  (press Ctrl+C to stop)"

try {
  while ($true) {
    $client = $listener.AcceptTcpClient()
    try {
      $client.ReceiveTimeout = 5000
      $client.SendTimeout = 10000
      $stream = $client.GetStream()
      $reader = New-Object System.IO.StreamReader($stream, [System.Text.Encoding]::ASCII, $false, 1024, $true)

      $requestLine = $reader.ReadLine()
      while ($true) {
        $line = $reader.ReadLine()
        if ([string]::IsNullOrEmpty($line)) { break }
      }
      if ([string]::IsNullOrEmpty($requestLine)) { continue }

      $parts = $requestLine -split " "
      $method = $parts[0]
      $target = if ($parts.Count -ge 2) { $parts[1] } else { "/" }
      $urlPath = [System.Uri]::UnescapeDataString(($target -split "\?")[0])
      if ($urlPath -eq "/" -or $urlPath -eq "") { $urlPath = "/index.html" }

      $relative = $urlPath.TrimStart("/").Replace("/", [System.IO.Path]::DirectorySeparatorChar)
      $file = [System.IO.Path]::GetFullPath((Join-Path $root $relative))
      $headOnly = ($method -eq "HEAD")

      if (($method -ne "GET" -and -not $headOnly) -or
          -not $file.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase) -or
          -not (Test-Path -LiteralPath $file -PathType Leaf)) {
        Write-Log "Not found: $urlPath"
        Send-Response $stream 404 "text/plain; charset=utf-8" ([System.Text.Encoding]::UTF8.GetBytes("Not found")) $headOnly
      } else {
        $ext = [System.IO.Path]::GetExtension($file).ToLowerInvariant()
        $contentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { "application/octet-stream" }
        Send-Response $stream 200 $contentType ([System.IO.File]::ReadAllBytes($file)) $headOnly
      }
      $stream.Flush()
    } catch {
      Write-Log "Request failed: $($_.Exception.Message)"
    } finally {
      $client.Close()
    }
  }
} finally {
  $listener.Stop()
  Write-Log "Stopped"
}
