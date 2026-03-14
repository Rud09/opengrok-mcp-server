@echo off
:: opengrok-mcp-wrapper.cmd
:: Thin launcher that bypasses PowerShell execution policy restrictions.
:: This file is the command configured in MCP clients on Windows.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0opengrok-mcp-wrapper.ps1" %*
