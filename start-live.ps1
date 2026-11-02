# Start the Chanh Dien LIVE server + a Cloudflare quick tunnel on Windows, and open the control panel.
# Run:  powershell -ExecutionPolicy Bypass -File .\start-live.ps1
# The tunnel URL changes every run: paste the printed link into the TikTok LIVE Studio Link source.
# Voice through a rotating proxy:  .\start-live.ps1 -ProxyKey <TopProxy key>   (or a fixed one: -Proxy host:port:user:pass)
param(
    [string]$Cloudflared = 'D:\_DROPSHIPPING\_DOLA_DATA\tools\cloudflared.exe',
    [string]$ProxyKey = $env:TTS_PROXY_KEY,
    [string]$Proxy = $env:TTS_PROXY
)
Set-Location (Join-Path $PSScriptRoot 'live')
$env:Path = [Environment]::GetEnvironmentVariable('Path', 'User') + ';' + [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + $env:Path

if (-not (Test-Path 'node_modules')) {
    Write-Host 'Installing dependencies...'
    if (Get-Command bun -ErrorAction SilentlyContinue) { bun install --no-save } else { npm install }
}

if ($ProxyKey) { $env:TTS_PROXY_KEY = $ProxyKey }
if ($Proxy) { $env:TTS_PROXY = $Proxy }
$server = Start-Process node -ArgumentList 'server.mjs' -NoNewWindow -PassThru
$tunnel = $null
try {
    Start-Sleep 2
    Start-Process 'http://localhost:3000/live/control.html'

    if (Test-Path $Cloudflared) {
        $log = Join-Path $env:TEMP 'chanh-dien-cloudflared.log'
        Remove-Item $log -ErrorAction SilentlyContinue
        $tunnel = Start-Process $Cloudflared -ArgumentList 'tunnel', '--no-autoupdate', '--url', 'http://127.0.0.1:3000', '--logfile', $log -WindowStyle Hidden -PassThru
        $url = $null
        for ($i = 0; $i -lt 60 -and -not $url; $i++) {
            Start-Sleep 1
            if (Test-Path $log) {
                $m = Select-String -Path $log -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1
                if ($m) { $url = $m.Matches[0].Value }
            }
        }
        if ($url) {
            $overlay = "$url/live/overlay.html?autoplay=1"
            Set-Clipboard $overlay
            Write-Host ''
            Write-Host '=== LIVE Studio Link source (already copied, just paste) ==='
            Write-Host $overlay
            Write-Host '============================================================'
        } else {
            Write-Host "Cloudflare tunnel did not start, see $log"
        }
    } else {
        Write-Host "cloudflared not found at $Cloudflared"
    }
    Write-Host 'Control panel: http://localhost:3000/live/control.html'
    Write-Host 'Keep this window open during the LIVE. Ctrl+C to stop.'
    Wait-Process -Id $server.Id
} finally {
    if ($tunnel -and -not $tunnel.HasExited) { Stop-Process -Id $tunnel.Id -Force }
    if (-not $server.HasExited) { Stop-Process -Id $server.Id -Force }
}
