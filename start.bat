@echo off
echo ==============================================================
echo Starting SaanSLive...
echo ==============================================================
echo.

echo [1/2] Starting Next.js Frontend Development Server...
start "SaanSLive Frontend" cmd /c "cd frontend\saanslive && npm run dev"

echo [2/2] Running Data Ingestion & Forecast Pipeline...
start "SaanSLive Backend Ingestion" cmd /k "ingestion\.venv\Scripts\python ingestion\run_ingestion.py"

echo.
echo ==============================================================
echo All services started!
echo Frontend will be available at: http://localhost:3000
echo Check the new terminal windows for logs.
echo ==============================================================
pause
