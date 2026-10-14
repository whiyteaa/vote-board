@echo off
chcp 65001 >nul
title 交通大模型大赛-双渠道投票实时看板
cd /d "%~dp0"
echo 正在启动投票监控服务（首次采集约30-60秒）...
echo 启动后请用浏览器打开 http://127.0.0.1:3456
node server.mjs
pause
