@echo off

:: Run programs

cd "C:\Users\Lucas Mini Pc\Documents\backup em Node" && pm2 start backup.js --name backup && pm2 monit