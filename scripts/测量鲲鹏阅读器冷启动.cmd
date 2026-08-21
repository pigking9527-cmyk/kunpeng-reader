@echo off
pwsh.exe -NoProfile -NoExit -ExecutionPolicy Bypass -File "%~dp0Measure-KunpengReaderColdStartup.ps1" -Samples 10
