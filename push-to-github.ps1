# Push extension-only changes to GitHub.
# Do NOT use: git push language-tool-origin master
# (local master is the whole OpenClaw workspace, not this extension repo)

$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path $PSScriptRoot -Parent

Push-Location $workspaceRoot
try {
    git branch -D language-tool-alternative-extension-publish 2>$null
    git subtree split --prefix=language-tool-alternative-extension -b language-tool-alternative-extension-publish
    git push -u language-tool-origin language-tool-alternative-extension-publish:master
    Write-Host 'Done. GitHub master updated from extension subtree.' -ForegroundColor Green
}
finally {
    Pop-Location
}
