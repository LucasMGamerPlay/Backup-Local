@echo off

:: Run programs

npm install && pm2 start backup.js --name backup && pm2 monit