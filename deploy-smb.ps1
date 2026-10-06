# ============================================================
#  SMB Fleet — Build (per-mode web) + Install + Device Owner
#  Output -> deploy-smb.log. JDK 21 (JBR). Tracker lalu Master.
# ============================================================
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root
$log = Join-Path $root "deploy-smb.log"
try { Start-Transcript -Path $log -Force | Out-Null } catch {}
$ErrorActionPreference = "Continue"
function Step($m){ Write-Host "`n==== $m ====" }
Step "MULAI $(Get-Date -Format o)"
Write-Host "Folder: $root"

# ---- JDK 21+ ----
Step "CARI JDK 21"
function JavacVersion($javac){ try { $o = & $javac -version 2>&1; if ($o -match '(\d+)') { return [int]$Matches[1] } } catch {} ; return 0 }
$jdkHome=$null; $cands=@("C:\Program Files\Android\Android Studio\jbr","$env:LOCALAPPDATA\Programs\Android Studio\jbr",$env:JAVA_HOME)
foreach($sr in @("C:\Program Files\Android","C:\Program Files\Java","C:\Program Files\Eclipse Adoptium","$env:LOCALAPPDATA\Programs")){ if(Test-Path $sr){ Get-ChildItem -Path $sr -Recurse -Depth 3 -Filter "javac.exe" -ErrorAction SilentlyContinue | ForEach-Object { $cands += (Split-Path -Parent (Split-Path -Parent $_.FullName)) } } }
$cands=$cands|Where-Object{$_}|Select-Object -Unique
foreach($c in $cands){ $j=Join-Path $c "bin\javac.exe"; if(Test-Path $j){ $v=JavacVersion $j; Write-Host ("  kandidat: {0} (javac {1})" -f $c,$v); if($v -ge 21 -and -not $jdkHome){ $jdkHome=$c } } }
if(-not $jdkHome){ Write-Host "[GAGAL] JDK 21 tak ketemu. Buka Android Studio sekali."; try{Stop-Transcript|Out-Null}catch{}; exit 10 }
Write-Host "JDK dipakai: $jdkHome"
$env:JAVA_HOME=$jdkHome; $env:Path="$jdkHome\bin;$env:Path"

# ---- npm ----
$npm=(Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if(-not $npm){ foreach($n in @("C:\Program Files\nodejs\npm.cmd","$env:APPDATA\npm\npm.cmd")){ if(Test-Path $n){ $npm=$n; break } } }
Write-Host "npm = $npm"
if(-not $npm){ Write-Host "[GAGAL] npm tak ketemu. Pasang Node.js."; try{Stop-Transcript|Out-Null}catch{}; exit 11 }

# ---- adb ----
$adb=$null; foreach($c in @("$env:ANDROID_HOME\platform-tools\adb.exe","$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe","$env:USERPROFILE\AppData\Local\Android\Sdk\platform-tools\adb.exe")){ if($c -and (Test-Path $c)){ $adb=$c; break } }
if(-not $adb){ $g=Get-Command adb.exe -ErrorAction SilentlyContinue; if($g){ $adb=$g.Source } }
Write-Host "adb = $adb"

# ---- BUILD TRACKER (vite --mode tracker + cap sync + assembleTrackerDebug) ----
Step "BUILD TRACKER (web mode=tracker)"
cmd /c "set `"JAVA_HOME=$jdkHome`" && `"$npm`" run android:build:tracker 2>&1"
$exTracker=$LASTEXITCODE; Write-Host "tracker build exit = $exTracker"
if($exTracker -ne 0){ Write-Host "[GAGAL] Build tracker gagal."; try{Stop-Transcript|Out-Null}catch{}; exit 3 }

# ---- BUILD MASTER (vite --mode master-live + cap sync + assembleMasterDebug) ----
Step "BUILD MASTER (web mode=master-live)"
cmd /c "set `"JAVA_HOME=$jdkHome`" && `"$npm`" run android:build:master-live 2>&1"
$exMaster=$LASTEXITCODE; Write-Host "master build exit = $exMaster"

# ---- salin apk ----
Step "SALIN APK"
$trackerApk="$root\android\app\build\outputs\apk\tracker\debug\app-tracker-debug.apk"
$masterApk="$root\android\app\build\outputs\apk\master\debug\app-master-debug.apk"
New-Item -ItemType Directory -Force -Path "$root\artifacts" | Out-Null
if(Test-Path $trackerApk){ Copy-Item $trackerApk "$root\artifacts\SMB-Lacak.apk" -Force; Write-Host "OK tracker -> artifacts\SMB-Lacak.apk" } else { Write-Host "[GAGAL] tracker apk tak ada"; try{Stop-Transcript|Out-Null}catch{}; exit 4 }
if(Test-Path $masterApk){ Copy-Item $masterApk "$root\artifacts\SMB-Master.apk" -Force; Write-Host "OK master -> artifacts\SMB-Master.apk" }

# ---- install tracker + device owner ----
if($adb){
  Step "ADB DEVICES"; & $adb devices -l 2>&1 | Out-Host
  Step "INSTALL tracker"; & $adb install -r "$root\artifacts\SMB-Lacak.apk" 2>&1 | Out-Host
  Step "SET DEVICE OWNER (abaikan jika sudah)"; & $adb shell dpm set-device-owner com.smbbotlacak.tracker/.FleetDeviceAdminReceiver 2>&1 | Out-Host
  Step "STATUS"; & $adb shell dumpsys device_policy 2>&1 | Select-String -Pattern "Device Owner","admin=" | Out-Host
  & $adb shell monkey -p com.smbbotlacak.tracker -c android.intent.category.LAUNCHER 1 2>&1 | Out-Null
} else { Write-Host "[INFO] adb tak ketemu; APK tetap tersedia di folder artifacts." }
Step "SELESAI $(Get-Date -Format o)"
try { Stop-Transcript | Out-Null } catch {}
