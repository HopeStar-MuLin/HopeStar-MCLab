# 只停本项目的壳和它的核心。
#
# 不要用 `taskkill /IM HMCL.exe`：这台机器上还有另一个 HMCL 装在 E:\HMCL，
# 进程名一样，一杀就误伤。壳的核心是 java.exe，命令行里带 hmcl.web.http=true。
$killed = @()

Get-Process -Name hmcl-shell -ErrorAction SilentlyContinue | ForEach-Object {
    $killed += "shell:$($_.Id)"
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}

# 早先这里还要求命令行同时含 `webui-shell`，实测那个参数已经不在命令行里了，
# 于是每次都只停掉壳、核心留着——越积越多，还会占着 HMCL.jar 让目录删不掉。
# 现在只认 hmcl.web.http=true；Gradle 守护进程也是 java.exe，额外排除掉。
# 条件必须写在一行：Windows PowerShell 5.1 不会在行尾的 -and 之后自动续行，
# 拆行之后整个 Where-Object 会静默筛掉所有进程（表现为 stopped: nothing）。
Get-CimInstance Win32_Process -Filter "name='java.exe' or name='javaw.exe'" |
    Where-Object { $_.CommandLine -and $_.CommandLine -like '*hmcl.web.http=true*' -and $_.CommandLine -notlike '*GradleDaemon*' } |
    ForEach-Object {
        $killed += "core:$($_.ProcessId)"
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }

Write-Output ("stopped: " + ($(if ($killed.Count) { $killed -join ', ' } else { 'nothing' })))
