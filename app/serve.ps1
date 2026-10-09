# Serves the Lite PDF app on this computer only (127.0.0.1). Nothing is reachable from the network.
# Usage: powershell -ExecutionPolicy Bypass -File serve.ps1 [-Port 8080]
param([int]$Port = 8080)

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$rootFull = [System.IO.Path]::GetFullPath($root)

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

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Lite PDF running at http://localhost:$Port/  (press Ctrl+C to stop)"

try {
  while ($listener.IsListening) {
    $ctx = $listener.GetContext()
    $res = $ctx.Response
    try {
      $urlPath = [System.Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath)
      if ($urlPath -eq "/" -or $urlPath -eq "") { $urlPath = "/index.html" }
      $file = [System.IO.Path]::GetFullPath((Join-Path $root ($urlPath.TrimStart("/") -replace "/", "\")))

      if (-not $file.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase) -or -not (Test-Path -LiteralPath $file -PathType Leaf)) {
        $res.StatusCode = 404
        $bytes = [System.Text.Encoding]::UTF8.GetBytes("Not found")
      } else {
        $ext = [System.IO.Path]::GetExtension($file).ToLowerInvariant()
        $res.ContentType = if ($types.ContainsKey($ext)) { $types[$ext] } else { "application/octet-stream" }
        $bytes = [System.IO.File]::ReadAllBytes($file)
      }
      $res.ContentLength64 = $bytes.Length
      $res.OutputStream.Write($bytes, 0, $bytes.Length)
    } catch {
      $res.StatusCode = 500
    } finally {
      $res.OutputStream.Close()
    }
  }
} finally {
  $listener.Stop()
}
